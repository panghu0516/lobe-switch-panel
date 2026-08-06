'use strict';

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

/* ================= 环境变量 ================= */
const PORT = process.env.PORT || 3000;
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB_CALLBACK_URL = process.env.GITHUB_CALLBACK_URL || '';
const ALLOWED_GITHUB_LOGIN = process.env.ALLOWED_GITHUB_LOGIN || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const KUBE_API_SERVER = (process.env.KUBE_API_SERVER || '').replace(/\/+$/, '');
const KUBE_SA_TOKEN = process.env.KUBE_SA_TOKEN || '';
const KUBE_NAMESPACE = process.env.KUBE_NAMESPACE || 'default';
const APPS_CONFIG = parseApps(process.env.APPS_CONFIG || '[]');
const STATE_FILE = process.env.STATE_FILE || '/data/state.json';

/* ================= K8s TLS Agent =================
 * 集群内 API server 用内部 CA 签发证书：
 * 1) 优先使用 Pod 内挂载的 CA 证书（安全）
 * 2) 未挂载则跳过 TLS 校验（仅限集群内地址，无中间人风险）
 */
const KUBE_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
let kubeAgent;
if (fs.existsSync(KUBE_CA_PATH)) {
  kubeAgent = new https.Agent({ ca: fs.readFileSync(KUBE_CA_PATH) });
  console.log('[kube] TLS: 使用集群内 CA 证书 ' + KUBE_CA_PATH);
} else {
  kubeAgent = new https.Agent({ rejectUnauthorized: false });
  console.log('[kube] TLS: 未找到集群 CA，跳过证书校验（仅限集群内通信）');
}

/* ================= 工具函数 ================= */
function parseApps(str) {
  try {
    const arr = JSON.parse(str);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(a => a && a.name && a.kind)
      .map(a => ({ name: a.name, kind: a.kind, lastReplicas: Number(a.replicas) || 1 }));
  } catch (e) {
    console.error('[config] APPS_CONFIG 解析失败:', e.message);
    return [];
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return { savedReplicas: {}, paused: false };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[state] 状态写入失败:', e.message);
  }
}

/* ================= K8s API ================= */
function kubeUrl(kind, name, sub) {
  const res = kind === 'Deployment' ? 'deployments' : 'statefulsets';
  let u = `${KUBE_API_SERVER}/apis/apps/v1/namespaces/${KUBE_NAMESPACE}/${res}/${name}`;
  if (sub) u += `/${sub}`;
  return u;
}

async function kubeGet(kind, name) {
  const res = await fetch(kubeUrl(kind, name), {
    headers: { Authorization: `Bearer ${KUBE_SA_TOKEN}`, Accept: 'application/json' },
    agent: kubeAgent,
    timeout: 10000
  });
  if (!res.ok) throw new Error(`GET ${name}: ${res.status} ${await safeBody(res)}`);
  const data = await res.json();
  return { desired: data.spec.replicas, ready: data.status && data.status.replicas };
}

async function kubeScale(kind, name, replicas) {
  const res = await fetch(kubeUrl(kind, name, 'scale'), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${KUBE_SA_TOKEN}`,
      'Content-Type': 'application/merge-patch+json'
    },
    body: JSON.stringify({ spec: { replicas: Number(replicas) } }),
    agent: kubeAgent,
    timeout: 10000
  });
  if (!res.ok) throw new Error(`PATCH scale ${name}: ${res.status} ${await safeBody(res)}`);
  return res.json();
}

async function safeBody(res) {
  try { return (await res.text()).slice(0, 300); } catch (e) { return ''; }
}

/* ================= 状态聚合 ================= */
async function getStatuses() {
  const list = [];
  for (const app of APPS_CONFIG) {
    try {
      const st = await kubeGet(app.kind, app.name);
      list.push({ name: app.name, kind: app.kind, replicas: st.ready != null ? st.ready : st.desired, running: st.ready > 0 });
    } catch (e) {
      list.push({ name: app.name, kind: app.kind, replicas: null, running: null, error: e.message });
    }
  }
  return list;
}

/* ================= 应用 ================= */
const app = express();
app.use(cookieParser());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 }
}));

// 简单请求日志（方便排查）
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    console.log(`[req] ${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - t0}ms)`);
  });
  next();
});

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

/* ---------- 前端页面 ---------- */
app.get('/', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.redirect('/auth/login');
  }
  res.status(200).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lobe 开关控制面板</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;background:#0f1115;color:#e6e8eb}h1{font-size:22px}button{font-size:16px;padding:12px 20px;border:none;border-radius:8px;cursor:pointer;margin:8px 8px 8px 0}.pause{background:#d64545;color:#fff}.resume{background:#2ea043;color:#fff}.logout{background:#333;color:#ccc}.card{background:#1c2128;padding:16px;border-radius:10px;margin:12px 0}.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #2a2f38}.running{color:#3fb950}.paused{color:#f85149}.err{color:#d29922}</style></head>
<body><h1>🔌 Lobe 一键开关</h1>
<p>已登录：<b>${escapeHtml(req.session.user.login)}</b></p>
<div id="msg" style="margin:8px 0;font-weight:bold"></div>
<div id="list"></div>
<div>
<button class="pause" onclick="act('pause')">⏸ 一键暂停</button>
<button class="resume" onclick="act('resume')">▶ 一键恢复</button>
<button class="logout" onclick="window.location='/logout'">退出</button>
</div>
<script>
async function load(){const r=await fetch('/status');
if(r.status===401){window.location='/auth/login';return;}
const s=await r.json();const list=document.getElementById('list');
const apps=(s&&s.apps)||[];
const anyErr=apps.length===0;
list.innerHTML='<div class=card><div class=row><b>应用</b><b>副本</b><b>状态</b></div>'+apps.map(x=>{
const st=x.running===true?'<span class=running>运行中</span>':(x.running===false?'<span class=paused>已暂停</span>':'<span class=err>'+escapeHtml(x.error||'查询失败')+'</span>');
return '<div class=row><span>'+escapeHtml(x.name)+' ('+x.kind+')</span><span>'+x.replicas+'</span><span>'+st+'</span></div>';}).join('')+'</div>';
if(anyErr){const m=document.getElementById('msg');m.style.color='#d29922';m.textContent='⚠️ 未获取到应用列表，请检查 KUBE_SA_TOKEN / KUBE_API_SERVER 配置';}
}
async function act(kind){const btn=document.querySelectorAll('button');btn.forEach(b=>b.disabled=true);
const msg=document.getElementById('msg');
if(kind==='pause' && !confirm('确认暂停全部服务？正在进行的会话将中断。')){btn.forEach(b=>b.disabled=false);return;}
try{const r=await fetch('/'+kind,{method:'POST'});
if(r.status===401){msg.style.color='#f85149';msg.textContent='⚠️ 登录已过期，正在跳转登录...';setTimeout(()=>window.location='/auth/login',800);return;}
const s=await r.json();
if(s && s.ok){msg.style.color='#3fb950';msg.textContent=(kind==='pause'?'✅ 已全部暂停':'✅ 已全部恢复');await load();}
else if(s&&s.errors&&s.errors.length){msg.style.color='#f85149';msg.textContent='部分失败: '+escapeHtml(s.errors.join(' | '));}
else{msg.style.color='#f85149';msg.textContent='操作失败: '+escapeHtml((s&&s.error)||'HTTP '+r.status);}}
catch(e){msg.style.color='#f85149';msg.textContent='请求错误: '+escapeHtml(e.message);}
btn.forEach(b=>b.disabled=false);}
window.onload=load;
function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
</script></body></html>`);
});

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

/* ---------- GitHub OAuth ---------- */
app.get('/auth/login', (req, res) => {
  if (!GITHUB_CLIENT_ID || !GITHUB_CALLBACK_URL) {
    return res.status(500).send('<h3>GitHub OAuth 未配置</h3><p>请先在 Sealos 环境变量中设置 GITHUB_CLIENT_ID 和 GITHUB_CALLBACK_URL，然后重新部署。</p>');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({ client_id: GITHUB_CLIENT_ID, redirect_uri: GITHUB_CALLBACK_URL, scope: 'read:user', state });
  res.redirect('https://github.com/login/oauth/authorize?' + params.toString());
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (state !== req.session.oauthState) {
    return res.status(400).send('OAuth state 不匹配，请重试');
  }
  try {
    const tokRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code, redirect_uri: GITHUB_CALLBACK_URL })
    });
    const tok = await tokRes.json();
    if (!tok.access_token) return res.status(400).send('获取 access_token 失败: ' + (tok.error_description || tok.error || ''));
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: 'token ' + tok.access_token, Accept: 'application/vnd.github+json' }
    });
    const user = await userRes.json();
    if (user.login !== ALLOWED_GITHUB_LOGIN) {
      return res.status(403).send('账号 ' + user.login + ' 不在白名单内，禁止访问');
    }
    req.session.user = { login: user.login, name: user.name || user.login };
    res.redirect('/');
  } catch (e) {
    res.status(500).send('OAuth 回调处理失败: ' + e.message);
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/auth/login');
  });
});

/* ---------- 4 个业务端点 ---------- */
app.get('/status', requireAuth, async (req, res) => {
  try {
    const state = readState();
    const statuses = await getStatuses();
    res.json({ paused: state.paused, apps: statuses });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/pause', requireAuth, async (req, res) => {
  if (!APPS_CONFIG.length) return res.status(400).json({ error: 'APPS_CONFIG 为空，无法暂停' });
  const state = readState();
  const saved = {};
  const errors = [];
  for (const app of APPS_CONFIG) {
    try {
      const st = await kubeGet(app.kind, app.name);
      const cur = st.desired != null ? st.desired : 1;
      saved[app.name] = cur;
      await kubeScale(app.kind, app.name, 0);
    } catch (e) {
      errors.push(`${app.name}: ${e.message}`);
    }
  }
  state.savedReplicas = saved;
  state.paused = true;
  writeState(state);
  if (errors.length) return res.status(207).json({ ok: false, errors, partial: true });
  res.json({ ok: true, savedReplicas: saved });
});

app.post('/resume', requireAuth, async (req, res) => {
  const state = readState();
  const errors = [];
  for (const app of APPS_CONFIG) {
    const target = (state.savedReplicas && state.savedReplicas[app.name]) || app.lastReplicas || 1;
    try {
      await kubeScale(app.kind, app.name, target);
    } catch (e) {
      errors.push(`${app.name}: ${e.message}`);
    }
  }
  state.paused = false;
  writeState(state);
  if (errors.length) return res.status(207).json({ ok: false, errors, partial: true });
  res.json({ ok: true });
});

/* ================= 启动 ================= */
app.listen(PORT, () => {
  console.log(`[lobe-switch] listening on :${PORT}`);
  console.log(`[lobe-switch] namespace=${KUBE_NAMESPACE} apps=${APPS_CONFIG.length}`);
  if (!process.env.SESSION_SECRET) {
    console.log('[warn] SESSION_SECRET 未设置，每次重启后需重新登录');
  }
});
