'use strict';

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
    headers: { Authorization: `Bearer ${KUBE_SA_TOKEN}`, Accept: 'application/json' }
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
    body: JSON.stringify({ spec: { replicas: Number(replicas) } })
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
async function load(){const r=await fetch('/status');const s=await r.json();const list=document.getElementById('list');
const anyRunning=s && s.some(x=>x.running===true);
list.innerHTML='<div class=card><div class=row><b>应用</b><b>副本</b><b>状态</b></div>'+s.map(x=>{
const st=x.running===true?'<span class=running>运行中</span>':(x.running===false?'<span class=paused>已暂停</span>':'<span class=err>'+escapeHtml(x.error||'未知')+'</span>');
return '<div class=row><span>'+escapeHtml(x.name)+' ('+x.kind+')</span><span>'+x.replicas+'</span><span>'+st+'</span></div>';}).join('')+'</div>';
}
async function act(kind){const btn=document.querySelectorAll('button');btn.forEach(b=>b.disabled=true);
const msg=document.getElementById('msg');
if(kind==='pause' && !confirm('确认暂停全部服务？正在进行的会话将中断。')){btn.forEach(b=>b.disabled=false);return;}
try{const r=await fetch('/'+kind,{method:'POST'});const s=await r.json();
if(s && s.ok){msg.style.color='#3fb950';msg.textContent=(kind==='pause'?'✅ 已全部暂停':'✅ 已全部恢复');await load();}
else{msg.style.color='#f85149';msg.textContent='操作失败: '+escapeHtml((s&&s.error)||'未知');}}
catch(e){msg.style.color='#f85149';msg.textContent='请求错误: '+escapeHtml(e.message);}
btn.forEach(b=>b.disabled=false);}
window.onload=load;
function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
</script></body></html>`);
});

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

/* ---------- GitHub OAuth ---------- */
app.get('/auth/login', (req, res) => {
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
  req.session.destroy(() => res.redirect('/auth/login'));
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
});
