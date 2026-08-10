const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const cron = require('node-cron');

/* ================= 配置 ================= */
const PORT = parseInt(process.env.PORT || '3000', 10);
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB_CALLBACK_URL = process.env.GITHUB_CALLBACK_URL || '';
const ALLOWED_GITHUB_LOGIN = (process.env.ALLOWED_GITHUB_LOGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const TOTP_SECRET = process.env.TOTP_SECRET || '';
const AUTH_MODE = process.env.AUTH_MODE || 'both';
const KUBE_API_SERVER = (process.env.KUBE_API_SERVER || '').replace(/\/+$/, '');
const KUBE_SA_TOKEN = process.env.KUBE_SA_TOKEN || '';
const KUBE_NAMESPACE = process.env.KUBE_NAMESPACE || 'default';
const APPS_CONFIG = parseApps(process.env.APPS_CONFIG || '[]');
const STATE_FILE = process.env.STATE_FILE || '/data/state.json';
const BACKUP_CRONJOB = process.env.BACKUP_CRONJOB || 'pg17-backup-1-2';
const BACKUP_NAMESPACE = process.env.BACKUP_NAMESPACE || KUBE_NAMESPACE;
// 备份调度的环境变量兜底（state.json 缺失时作为默认值；页面保存后以 state.json 为准）
const BACKUP_ENABLED_ENV = process.env.BACKUP_ENABLED;
const BACKUP_TIMES_ENV = (process.env.BACKUP_TIMES || '').split(',').map(s => s.trim()).filter(Boolean);
// 面板自备备份配置（优先）：配了就不再依赖 CronJob 动态读取
const BACKUP_IMAGE = process.env.BACKUP_IMAGE || '';
const BACKUP_PULL_SECRET = process.env.BACKUP_PULL_SECRET || '';
// 面板自备备份环境变量（在 Sealos 环境变量里逐条配置，与 CronJob 同款命名）
const PANEL_BACKUP_ENV = [
  ['PG_URI', process.env.PG_URI],
  ['S3_URI', process.env.S3_URI],
  ['S3_BUCK', process.env.S3_BUCK],
  ['S3_NAME', process.env.S3_NAME],
  ['TZ', process.env.TZ || 'Asia/Shanghai']
].filter(([k, v]) => v).map(([name, value]) => ({ name, value }));

// 模式切换针对的三个维度应用（lobe 主服务 + devbox + paradedb 数据库）
const MODE_TARGETS = [
  { kind: 'StatefulSet', name: 'lobehub-v2', label: 'LobeHub' },
  { kind: 'StatefulSet', name: 'my-devbox', label: 'Devbox' },
  { kind: 'StatefulSet', name: 'lobehub-paradedb', label: 'ParadeDB' }
];

// 三套默认模式（cpu / mem 均指 requests 与 limits 一致）
// 支持环境变量覆盖默认值：MODE_<KEY>_<TARGET>_<FIELD>
//   KEY: DAILY | PRO | DEVELOP，TARGET: LOBEHUB | DEVBOX | PARADEDB，FIELD: CPU | MEM
//   例：MODE_DEVELOP_DEVBOX_MEM=3Gi  MODE_DAILY_LOBE_CPU=300m  MODE_PRO_PARADEDB_MEM=2Gi
function defaultModesFromEnv() {
  const defaults = {
    // 注：paradedb 为数据库，建议三套模式保持一致或接近实际配置，避免切换触发滚动重启
    daily: { label: '日常', desc: '轻量日常运维', configs: { lobehub: { cpu: '200m', mem: '2Gi' }, devbox: { cpu: '200m', mem: '0.5Gi' }, paradedb: { cpu: '500m', mem: '1Gi' } } },
    pro:   { label: '并发 Pro', desc: '高并发运行', configs: { lobehub: { cpu: '500m', mem: '2Gi' }, devbox: { cpu: '500m', mem: '1Gi' }, paradedb: { cpu: '500m', mem: '1Gi' } } },
    develop: { label: '开发 Max', desc: '开发编译模式', configs: { lobehub: { cpu: '1', mem: '2Gi' }, devbox: { cpu: '1', mem: '2Gi' }, paradedb: { cpu: '500m', mem: '1Gi' } } }
  };
  const out = JSON.parse(JSON.stringify(defaults));
  for (const k of Object.keys(out)) {
    for (const t of Object.keys(out[k].configs)) {
      for (const f of Object.keys(out[k].configs[t])) {
        const envKey = 'MODE_' + k.toUpperCase() + '_' + t.toUpperCase() + '_' + f.toUpperCase();
        const v = process.env[envKey];
        if (v && String(v).trim()) out[k].configs[t][f] = String(v).trim();
      }
    }
  }
  return out;
}
const DEFAULT_MODES = defaultModesFromEnv();

let kubeAgent = null;
const KUBE_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
if (fs.existsSync(KUBE_CA_PATH)) {
  kubeAgent = new https.Agent({ ca: fs.readFileSync(KUBE_CA_PATH) });
  console.log('[kube] TLS: 使用集群内 CA 证书 ' + KUBE_CA_PATH);
} else {
  console.log('[kube] TLS: 未找到集群 CA，将跳过证书校验（开发环境）');
  kubeAgent = new https.Agent({ rejectUnauthorized: false });
}

function parseApps(str) {
  try {
    const arr = JSON.parse(str);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('[config] APPS_CONFIG 解析失败:', e.message);
    return [];
  }
}

/* ================= 状态文件 ================= */
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}
function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// 判断模式配置是否完整（三套模式 × lobehub/devbox/paradedb × cpu/mem 齐全）
function modesComplete(modes) {
  if (!modes || typeof modes !== 'object') return false;
  for (const k of ['daily', 'pro', 'develop']) {
    const m = modes[k];
    if (!m || !m.configs || !m.configs.lobehub || !m.configs.devbox || !m.configs.paradedb) return false;
    for (const t of ['lobehub', 'devbox', 'paradedb']) {
      const c = m.configs[t];
      if (!c || !String(c.cpu || '').trim() || !String(c.mem || '').trim()) return false;
    }
  }
  return true;
}

// 读取或初始化模式配置（存于 state.json）
function getModeConfig() {
  const s = readState();
  if (!modesComplete(s.modes)) {
    s.modes = JSON.parse(JSON.stringify(DEFAULT_MODES));
    s.activeMode = s.activeMode || 'daily';
    writeState(s);
  }
  if (!s.activeMode) { s.activeMode = 'daily'; writeState(s); }
  return { modes: s.modes, activeMode: s.activeMode };
}
function saveModeConfig(modes, activeMode) {
  const s = readState();
  s.modes = modes;
  if (activeMode) s.activeMode = activeMode;
  writeState(s);
}

/* ================= K8s API ================= */
function kubeUrl(kind, name, sub) {
  const res = kind === 'Deployment' ? 'deployments' : 'statefulsets';
  let u = `${KUBE_API_SERVER}/apis/apps/v1/namespaces/${KUBE_NAMESPACE}/${res}/${name}`;
  if (sub) u += `/${sub}`;
  return u;
}

async function kubeRequest(method, url, bodyObj) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${KUBE_SA_TOKEN}`,
      'Content-Type': 'application/json-patch+json',
      Accept: 'application/json'
    },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
    agent: kubeAgent,
    timeout: 15000
  });
  if (!res.ok) throw new Error(`${method} ${url.split('/apis/')[1]}: ${res.status} ${await safeBody(res)}`);
  return res.json();
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

// 读取应用完整 spec（用于模式切换前的存档 + 资源展示）
async function kubeGetFull(kind, name) {
  const data = await kubeRequest('GET', kubeUrl(kind, name));
  const c = data.spec && data.spec.template && data.spec.template.spec && data.spec.template.spec.containers;
  const container = c && c[0];
  return {
    name: data.metadata.name,
    kind,
    replicas: data.spec.replicas,
    ready: data.status && data.status.replicas,
    resources: (container && container.resources) || null,
    image: container && container.image
  };
}

// 读取 PVC 容量/用量（按实际名）
async function kubeGetPVC(pvcName) {
  const url = `${KUBE_API_SERVER}/api/v1/namespaces/${KUBE_NAMESPACE}/persistentvolumeclaims/${pvcName}`;
  const data = await kubeRequest('GET', url);
  const cap = data.status && data.status.capacity;
  return {
    name: data.metadata.name,
    capacity: cap && cap.storage ? cap.storage : (data.spec.resources && data.spec.resources.requests && data.spec.resources.requests.storage),
    phase: data.status && data.status.phase
  };
}

// 从 StatefulSet 的 volumeClaimTemplates 动态推导 PVC 名（Sealos 会给 claimName 加 vn- 前缀）
// PVC 实际名 = {claimTemplate.name}-{statefulset.name}-{ordinal}，ordinal 取 0
async function kubeGetPVCFromSTS(kind, name) {
  const data = await kubeRequest('GET', kubeUrl(kind, name));
  const templates = (data.spec && data.spec.volumeClaimTemplates) || [];
  const pvcs = [];
  for (const tpl of templates) {
    const claim = tpl.metadata.name;
    const pvcName = `${claim}-${name}-0`;
    try {
      const pvc = await kubeGetPVC(pvcName);
      pvcs.push(pvc);
    } catch (e) {
      pvcs.push({ name: pvcName, error: e.message });
    }
  }
  return pvcs;
}

// 精细 patch 单个容器的 resources
async function kubePatchResources(kind, name, resources) {
  const patch = [{
    op: 'replace',
    path: '/spec/template/spec/containers/0/resources',
    value: resources
  }];
  const res = await fetch(kubeUrl(kind, name), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${KUBE_SA_TOKEN}`,
      'Content-Type': 'application/json-patch+json'
    },
    body: JSON.stringify(patch),
    agent: kubeAgent,
    timeout: 15000
  });
  if (!res.ok) throw new Error(`PATCH resources ${name}: ${res.status} ${await safeBody(res)}`);
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

/* ================= 模式切换（分步确认 + 回滚） ================= */
function buildResources(mem, cpu) {
  return {
    requests: { cpu: cpu, memory: mem },
    limits: { cpu: cpu, memory: mem }
  };
}

// key: 'lobehub' | 'devbox' | 'paradedb' -> 对应 MODE_TARGETS 里 name
function targetFor(key) {
  const nameMap = { lobehub: 'lobehub-v2', devbox: 'my-devbox', paradedb: 'lobehub-paradedb' };
  return MODE_TARGETS.find(t => t.name === nameMap[key]);
}

async function switchMode(modeKey) {
  const { modes } = getModeConfig();
  const mode = modes[modeKey];
  if (!mode) throw new Error('未知模式: ' + modeKey);
  const cfg = mode.configs; // { lobehub: {cpu,mem}, devbox: {cpu,mem}, paradedb: {cpu,mem} }

  // 1. 存档当前 resources（用于回滚）
  const saved = {};
  for (const key of ['lobehub', 'devbox', 'paradedb']) {
    const t = targetFor(key);
    const cur = await kubeGetFull(t.kind, t.name);
    saved[key] = cur.resources;
  }

  const errors = [];
  const applied = {};
  try {
    // 2. 依次应用（与当前值一致则跳过 patch，避免无谓滚动重启）
    for (const key of ['lobehub', 'devbox', 'paradedb']) {
      const t = targetFor(key);
      const c = cfg[key];
      const target = buildResources(c.mem, c.cpu);
      const cur = saved[key];
      const same = cur && cur.requests && cur.limits &&
        cur.requests.cpu === target.requests.cpu &&
        cur.requests.memory === target.requests.memory &&
        cur.limits.cpu === target.limits.cpu &&
        cur.limits.memory === target.limits.memory;
      if (same) { applied[key] = true; continue; }
      await kubePatchResources(t.kind, t.name, target);
      applied[key] = true;
    }
  } catch (e) {
    errors.push(e.message);
  }

  // 3. 验证（轮询确认生效）
  if (errors.length === 0) {
    for (const key of ['lobehub', 'devbox', 'paradedb']) {
      try {
        const t = targetFor(key);
        const verify = await kubeVerifyResources(t.kind, t.name, cfg[key]);
        if (!verify) {
          errors.push(`${targetFor(key).label} resources 未生效`);
        }
      } catch (e) {
        errors.push(`${targetFor(key).label} 验证失败: ${e.message}`);
      }
    }
  }

  // 4. 失败则回滚
  if (errors.length > 0) {
    const rollbackErrs = [];
    for (const key of Object.keys(saved)) {
      if (saved[key]) {
        try {
          const t = targetFor(key);
          await kubePatchResources(t.kind, t.name, saved[key]);
        } catch (e) {
          rollbackErrs.push(`${key}: ${e.message}`);
        }
      }
    }
    const s = readState();
    s.activeMode = s.activeMode || 'daily';
    writeState(s);
    throw new Error(`模式切换失败已回滚: ${errors.join('; ')}${rollbackErrs.length ? ' | 回滚异常: ' + rollbackErrs.join('; ') : ''}`);
  }

  // 5. 记录 activeMode
  const s = readState();
  s.activeMode = modeKey;
  writeState(s);
  return { ok: true, mode: modeKey, applied, saved };
}

// 验证某个 target 的 resources 是否等于期望值
async function kubeVerifyResources(kind, name, expect) {
  const cur = await kubeGetFull(kind, name);
  const r = cur.resources;
  if (!r || !r.requests || !r.limits) return false;
  const ok = r.requests.cpu === expect.cpu && r.requests.memory === expect.mem &&
             r.limits.cpu === expect.cpu && r.limits.memory === expect.mem;
  return ok;
}

/* ================= 数据库备份（内化调度） ================= */
// 备份时间配置存于 state.json: { backup: { enabled, times: ['12:00','15:00','19:00','23:00'] } }
function getBackupConfig() {
  const s = readState();
  if (!s.backup) {
    const envEnabled = BACKUP_ENABLED_ENV === undefined ? true : (BACKUP_ENABLED_ENV !== 'false' && BACKUP_ENABLED_ENV !== '0');
    s.backup = {
      enabled: envEnabled,
      times: BACKUP_TIMES_ENV.length ? BACKUP_TIMES_ENV.slice() : ['12:00', '15:00', '19:00', '23:00']
    };
    writeState(s);
  }
  return s.backup;
}
function saveBackupConfig(bc) {
  const s = readState();
  s.backup = bc;
  writeState(s);
}

// 读取现有 CronJob 的 env（复用它，凭证不落地面板存储）
async function getBackupCronJobEnv() {
  // 优先：面板自备配置（BACKUP_IMAGE + 面板环境变量 PG_URI/S3_URI/S3_BUCK/S3_NAME/TZ）
  if (BACKUP_IMAGE) {
    return {
      image: BACKUP_IMAGE,
      env: PANEL_BACKUP_ENV,
      command: undefined,
      args: undefined,
      imagePullSecrets: BACKUP_PULL_SECRET ? [{ name: BACKUP_PULL_SECRET }] : [],
      serviceAccountName: undefined
    };
  }
  // 兜底：从 CronJob 动态读取
  const url = `${KUBE_API_SERVER}/apis/batch/v1/namespaces/${BACKUP_NAMESPACE}/cronjobs/${BACKUP_CRONJOB}`;
  const data = await kubeRequest('GET', url);
  const podSpec = data.spec && data.spec.jobTemplate && data.spec.jobTemplate.spec && data.spec.jobTemplate.spec.template && data.spec.jobTemplate.spec.template.spec;
  const container = podSpec && podSpec.containers && podSpec.containers[0];
  if (!container) throw new Error('未找到 CronJob 容器定义');
  return {
    image: container.image,
    env: container.env || [],
    command: container.command,
    args: container.args,
    imagePullSecrets: (podSpec.imagePullSecrets || []).map(s => ({ name: s.name })),
    serviceAccountName: podSpec.serviceAccountName
  };
}

// 触发一次备份（创建一次性 Job）
async function triggerBackup() {
  const tpl = await getBackupCronJobEnv();
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '.') + '-panel';
  const jobName = `pg-backup-${ts}`.replace(/\./g, '-').toLowerCase();
  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: jobName, namespace: BACKUP_NAMESPACE, labels: { app: 'lobe-switch-backup', 'app.kubernetes.io/managed-by': 'lobe-switch-panel' } },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 600,
      template: {
        spec: {
          restartPolicy: 'Never',
          imagePullSecrets: tpl.imagePullSecrets,
          serviceAccountName: tpl.serviceAccountName,
          containers: [{
            name: 'backup',
            image: tpl.image,
            env: tpl.env,
            resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '100m', memory: '128Mi' } }
          }]
        }
      }
    }
  };
  const url = `${KUBE_API_SERVER}/apis/batch/v1/namespaces/${BACKUP_NAMESPACE}/jobs`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KUBE_SA_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(job),
    agent: kubeAgent,
    timeout: 15000
  });
  if (!res.ok) throw new Error(`创建备份 Job ${jobName}: ${res.status} ${await safeBody(res)}`);
  return jobName;
}

// 列出最近备份 Job 状态
async function listBackupJobs(limit = 8) {
  const url = `${KUBE_API_SERVER}/apis/batch/v1/namespaces/${BACKUP_NAMESPACE}/jobs?labelSelector=app%3Dlobe-switch-backup`;
  const data = await kubeRequest('GET', url);
  const items = (data.items || []).slice().sort((a, b) => (b.metadata.creationTimestamp || '').localeCompare(a.metadata.creationTimestamp || ''));
  return items.slice(0, limit).map(j => {
    const cond = (j.status && j.status.conditions && j.status.conditions[0]) || {};
    let state = 'pending';
    if (j.status && j.status.succeeded) state = 'success';
    else if (j.status && j.status.failed) state = 'failed';
    return {
      name: j.metadata.name,
      created: j.metadata.creationTimestamp,
      state,
      condition: cond.type,
      reason: cond.reason,
      message: cond.message
    };
  });
}

// 备份调度：node-cron 按北京时间执行
let backupCronTasks = [];
function scheduleBackups() {
  for (const t of backupCronTasks) t.stop();
  backupCronTasks = [];
  const bc = getBackupConfig();
  if (!bc.enabled || !bc.times || !bc.times.length) return;
  for (const timeStr of bc.times) {
    const m = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const [ , hh, mm ] = m;
    const hour = parseInt(hh, 10), minute = parseInt(mm, 10);
    if (hour > 23 || minute > 59) continue;
    // node-cron 表达式：分 时 * * *，容器 TZ 需为 Asia/Shanghai（启动时设置 TZ=Asia/Shanghai）
    const expr = `${minute} ${hour} * * *`;
    try {
      const task = cron.schedule(expr, async () => {
        console.log(`[backup] 触发定时备份 ${timeStr} (北京时间)`);
        try {
          const name = await triggerBackup();
          console.log(`[backup] 已创建 Job: ${name}`);
        } catch (e) {
          console.error(`[backup] 定时备份失败: ${e.message}`);
        }
      }, { timezone: 'Asia/Shanghai' });
      backupCronTasks.push(task);
      console.log(`[backup] 已调度 ${timeStr} (cron: ${expr} @Asia/Shanghai)`);
    } catch (e) {
      console.error(`[backup] 调度失败 ${timeStr}: ${e.message}`);
    }
  }
}

/* ================= 应用 ================= */
const app = express();
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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

function authModeOk() {
  if (AUTH_MODE === 'totp') return !!TOTP_SECRET;
  if (AUTH_MODE === 'github') return true;
  return false;
}

function requireAuth(req, res, next) {
  if (AUTH_MODE === 'totp') {
    if (req.session && req.session.totpVerified) return next();
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'unauthorized' });
  if (TOTP_SECRET && !req.session.totpVerified) return res.status(401).json({ error: 'totp required' });
  next();
}

function requireTotp(req, res, next) {
  if (TOTP_SECRET && !(req.session && req.session.totpVerified)) return res.status(401).json({ error: 'totp required' });
  next();
}

/* ================= TOTP ================= */
app.get('/totp/setup', async (req, res) => {
  if (TOTP_SECRET) {
    return res.status(200).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>TOTP 已启用</title></head><body style="font-family:system-ui;background:#0f1115;color:#e6e8eb;padding:40px"><h2>🔐 TOTP 已启用</h2><p>如需重新绑定，请改环境变量 TOTP_SECRET 后重新部署。</p><a href="/">返回</a></body></html>`);
  }
  const secret = speakeasy.generateSecret({ length: 20, name: 'Lobe-Switch-Panel' });
  const otpauth = speakeasy.otpauthURL({ secret: secret.base32, label: 'Lobe-Switch-Panel', issuer: 'Lobe', encoding: 'base32' });
  const qr = await QRCode.toDataURL(otpauth);
  res.status(200).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>绑定TOTP</title><style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e8eb;padding:40px;max-width:480px;margin:auto}h2{font-size:20px}img{background:#fff;padding:12px;border-radius:8px}.key{background:#1c2128;padding:16px;border-radius:8px;font-family:monospace;word-break:break-all;color:#3fb950}.warn{color:#d29922;font-weight:bold}</style></head><body><h2>🔐 绑定 TOTP 动态码</h2><p>用微软 Authenticator 扫码，或手动输入密钥：</p><img src="${qr}" alt="QR"><p class="key">${secret.base32}</p><p class="warn">⚠️ 扫码/复制后请勿刷新本页，否则密钥会更换。</p><p>把上面的 base32 密钥填入 Sealos 环境变量 <code>TOTP_SECRET</code> 后重新部署。</p><a href="/">返回</a></body></html>`);
});

app.get('/totp/verify', (req, res) => {
  res.status(200).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>动态码验证</title><style>body{font-family:system-ui;background:#0f1115;color:#e6e8eb;padding:40px;max-width:360px;margin:auto}input{font-size:20px;padding:10px;width:100%;margin:8px 0;border-radius:6px;border:1px solid #333;background:#1c2128;color:#e6e8eb}button{font-size:16px;padding:12px;width:100%;border:none;border-radius:8px;background:#2ea043;color:#fff;cursor:pointer}label{display:block;margin-top:12px}</style></head><body><h2>🔐 输入动态码</h2><form method="post" action="/totp/verify"><label>6 位动态码</label><input type="text" name="token" maxlength="6" autocomplete="one-time-code" required><button type="submit">验证</button></form><p id="msg" style="color:#f85149"></p><script>const q=new URLSearchParams(location.search);if(q.get('e'))document.getElementById('msg').textContent='动态码错误，请重试';</script></body></html>`);
});

app.post('/totp/verify', (req, res) => {
  const token = String(req.body.token || '').trim();
  const ok = speakeasy.totp.verify({ secret: TOTP_SECRET, encoding: 'base32', token, window: 1 });
  if (ok) {
    req.session.totpVerified = true;
    return res.redirect('/');
  }
  res.redirect('/totp/verify?e=1');
});

/* ================= 首页 ================= */
app.get('/', (req, res) => {
  if (!authModeOk()) return res.status(503).send('认证模式未配置或无效，禁止访问');
  if (AUTH_MODE === 'totp') {
    if (!req.session || !req.session.totpVerified) return res.redirect('/totp/verify');
  } else {
    if (!req.session || !req.session.user) return res.redirect('/auth/login');
    if (TOTP_SECRET && !req.session.totpVerified) return res.redirect('/totp/verify');
  }
  res.status(200).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lobe 开关控制面板</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;background:#0f1115;color:#e6e8eb}h1{font-size:22px}button{font-size:15px;padding:10px 16px;border:none;border-radius:8px;cursor:pointer;margin:6px 6px 6px 0}.pause{background:#d64545;color:#fff}.resume{background:#2ea043;color:#fff}.logout{background:#333;color:#ccc}.card{background:#1c2128;padding:16px;border-radius:10px;margin:12px 0}.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #2a2f38;gap:8px}.running{color:#3fb950}.paused{color:#f85149}.err{color:#d29922}.ok{color:#3fb950}.mode-btn{background:#21262d;border:1px solid #30363d;color:#e6e8eb}.mode-btn[data-active="1"]{background:#1f6feb;border-color:#1f6feb;color:#fff}select,input[type=text],input[type=number]{background:#0d1117;border:1px solid #30363d;color:#e6e8eb;padding:6px;border-radius:6px;margin:2px}h2{font-size:17px;margin:16px 0 8px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.mono{font-family:monospace}.small{font-size:13px;color:#8b949e}.tag{display:inline-block;background:#161b22;border:1px solid #30363d;padding:2px 8px;border-radius:20px;font-size:12px;margin:2px}</style></head>
<body><h1>🔌 Lobe 一键开关</h1>
<p>已验证：<b>${escapeHtml(AUTH_MODE === 'totp' ? '动态码' : (req.session.user ? req.session.user.login : ''))}</b></p>
<div id="msg" style="margin:8px 0;font-weight:bold"></div>

<div class="card">
<h2>📊 资源状态</h2>
<div id="res"></div>
</div>

<div class="card">
<h2>🎛 模式切换</h2>
<div id="modes"></div>
<div id="modeMsg" class="small" style="margin-top:8px"></div>
<div style="margin-top:10px"><button class="mode-btn" onclick="toggleModeEdit()">⚙️ 编辑模式数值</button></div>
<div id="modeEdit" style="display:none;margin-top:10px"></div>
</div>

<div class="card">
<h2>🚦 应用控制</h2>
<div id="list"></div>
<div>
<button class="pause" onclick="act('pause')">⏸ 一键暂停</button>
<button class="resume" onclick="act('resume')">▶ 一键恢复</button>
</div>
</div>

<div class="card">
<h2>💾 数据库备份</h2>
<div id="bk"></div>
</div>

<div><button class="logout" onclick="window.location='/logout'">退出登录</button></div>
<script>
const LOGIN_URL='${AUTH_MODE === 'totp' ? '/totp/verify' : '/auth/login'}';
async function j(url,opts){const r=await fetch(url,opts);if(r.status===401){window.location=LOGIN_URL;return null;}return r.json();}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}

async function load(){await loadStatus();await loadResources();await loadModes();await loadBackup();}
async function loadStatus(){
const s=await j('/status');if(!s)return;const list=document.getElementById('list');
const apps=(s&&s.apps)||[];const anyErr=apps.length===0;
list.innerHTML='<div class=row><b>应用</b><b>副本</b><b>状态</b></div>'+apps.map(x=>{
const st=x.running===true?'<span class=running>运行中</span>':(x.running===false?'<span class=paused>已暂停</span>':'<span class=err>'+esc(x.error||'查询失败')+'</span>');
return '<div class=row><span>'+esc(x.name)+' ('+x.kind+')</span><span>'+x.replicas+'</span><span>'+st+'</span></div>';}).join('')+'</div>';
if(anyErr){const m=document.getElementById('msg');m.style.color='#d29922';m.textContent='⚠️ 未获取到应用列表，请检查 KUBE_SA_TOKEN / KUBE_API_SERVER 配置';}
}
async function loadResources(){
const d=await j('/resources');if(!d)return;const el=document.getElementById('res');
if(d.error){el.innerHTML='<span class=err>'+esc(d.error)+'</span>';return;}
const r=(d.resources||[]).map(x=>{
const rc=x.resources||{};
const req=rc.requests||{},lim=rc.limits||{};
return '<div class=row><span><b>'+esc(x.label)+'</b> <span class=small>('+esc(x.name)+')</span></span><span class=mono>CPU '+esc(lim.cpu||req.cpu||'-')+' · MEM '+esc(lim.memory||req.memory||'-')+'</span></div>';
}).join('');
const pVs=(d.pvcs||[]).map(p=>'<span class=tag>'+esc(p.name)+' 容量 '+esc(p.capacity||'-')+'</span>').join('');
el.innerHTML=r+(pVs?'<div class=small style="margin-top:8px">持久卷: '+pVs+'</div>':'');
}
let MODE_META={};
async function loadModes(){
const d=await j('/modes');if(!d||!d.modes)return;const el=document.getElementById('modes');
const keys=Object.keys(d.modes);MODE_META={};
const btns=keys.map(k=>{
const m=d.modes[k];const c=m.configs;
MODE_META[k]={label:m.label,desc:m.desc};
const cpuL=c.lobehub?c.lobehub.cpu:'-',memL=c.lobehub?c.lobehub.mem:'-';
const cpuD=c.devbox?c.devbox.cpu:'-',memD=c.devbox?c.devbox.mem:'-';
const cpuP=c.paradedb?c.paradedb.cpu:'-',memP=c.paradedb?c.paradedb.mem:'-';
return '<button class="mode-btn" data-active="'+(d.activeMode===k?1:0)+'" data-mode="'+esc(k)+'" onclick="switchMode(this.dataset.mode)" title="'+esc(m.desc)+'">'+esc(m.label)+'<br><span class=small>Lobe '+esc(cpuL)+'/'+esc(memL)+' · Dev '+esc(cpuD)+'/'+esc(memD)+' · DB '+esc(cpuP)+'/'+esc(memP)+'</span></button>';
}).join('');
el.innerHTML=btns+'<div id="modeMsg" class=small></div>';
renderModeEdit(d.modes);
}
function renderModeEdit(modes){
const el=document.getElementById('modeEdit');if(!el)return;
const keys=Object.keys(modes);
const field=(k,t,f)=>{const c=modes[k].configs[t]||{};return '<input data-me="'+k+'-'+t+'-'+f+'" type="text" value="'+esc(c[f]||'')+'" style="width:76px" title="'+esc(k+'/'+t+'/'+f)+'">';};
el.innerHTML='<div class="small" style="margin-bottom:6px">调整各模式 LobeHub / Devbox / ParadeDB 的 CPU 与内存（requests=limits）。保存后点击对应模式按钮即生效；若面板重启丢失，请用环境变量 MODE_DAILY_LOBE_CPU 等设置默认值。</div>'+
keys.map(k=>{const m=modes[k];return '<div class="row"><span><b>'+esc(m.label)+'</b> <span class=small>'+esc(m.desc)+'</span></span>'+
'<span class="small mono">Lobe CPU '+field(k,'lobehub','cpu')+' MEM '+field(k,'lobehub','mem')+'</span>'+
'<span class="small mono">Dev CPU '+field(k,'devbox','cpu')+' MEM '+field(k,'devbox','mem')+'</span>'+
'<span class="small mono">DB CPU '+field(k,'paradedb','cpu')+' MEM '+field(k,'paradedb','mem')+'</span></div>';}).join('')+
'<div style="margin-top:8px"><button class="mode-btn" onclick="saveModes()">💾 保存模式配置</button> <button class="mode-btn" onclick="resetModes()">↩️ 恢复默认</button></div>'+
'<div id="modeEditMsg" class="small" style="margin-top:6px"></div>';
}
function toggleModeEdit(){
const el=document.getElementById('modeEdit');if(!el)return;
el.style.display=el.style.display==='none'?'block':'none';
}
async function saveModes(){
const modes={};
document.querySelectorAll('[data-me]').forEach(el=>{
const p=el.dataset.me.split('-');const k=p[0],t=p[1],f=p[2];
if(!modes[k]){const meta=MODE_META[k]||{};modes[k]={label:meta.label||k,desc:meta.desc||'',configs:{}};}
if(!modes[k].configs[t])modes[k].configs[t]={};
modes[k].configs[t][f]=el.value.trim();
});
const m=document.getElementById('modeEditMsg');if(!m)return;
m.style.color='#d29922';m.textContent='⏳ 保存中...';
const d=await j('/modes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({modes})});
if(!d)return;
if(d.ok){m.style.color='#3fb950';m.textContent='✅ 模式配置已保存（点击对应模式按钮即应用）';await loadModes();}
else{m.style.color='#f85149';m.textContent='❌ '+esc(d.error||'保存失败');}
}
async function resetModes(){
const m=document.getElementById('modeEditMsg');if(!m)return;
if(!confirm('恢复为环境变量/内置默认模式数值？'))return;
m.style.color='#d29922';m.textContent='⏳ 恢复中...';
const d=await j('/modes/reset',{method:'POST'});
if(!d)return;
if(d.ok){m.style.color='#3fb950';m.textContent='✅ 已恢复默认模式配置';await loadModes();}
else{m.style.color='#f85149';m.textContent='❌ '+esc(d.error||'恢复失败');}
}
async function switchMode(k){
const m=document.getElementById('modeMsg');if(!m)return;
if(!confirm('切换到该模式将调整 LobeHub / Devbox / ParadeDB 的 CPU 内存配额（数据库可能触发滚动重启），确认？'))return;
m.style.color='#d29922';m.textContent='⏳ 切换中...';
const d=await j('/mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:k})});
if(!d)return;
if(d.ok){m.style.color='#3fb950';m.textContent='✅ 已切换到 '+esc(d.mode);await loadResources();await loadModes();}
else{m.style.color='#f85149';m.textContent=esc(d.error||'切换失败'+(d.rollback?'（已回滚）':''));}
}
async function loadBackup(){
const d=await j('/backup');if(!d)return;const el=document.getElementById('bk');
if(d.error){el.innerHTML='<span class=err>'+esc(d.error)+'</span>';return;}
const bc=d.config||{};
el.innerHTML='<div class=row><span>定时备份</span><label><input type="checkbox" id="bkEnabled" '+(bc.enabled?'checked':'')+' onchange="saveBk()"> 启用</label></div>'+
'<div class=row><span>执行时间（北京时间，每行一个 时:分）</span></div>'+
'<textarea id="bkTimes" rows="4" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#e6e8eb;border-radius:6px;padding:6px">'+esc((bc.times||[]).join('\\n'))+'</textarea>'+
'<div style="margin-top:8px"><button onclick="saveBk()">💾 保存备份配置</button> <button onclick="runBk()">▶ 立即备份</button></div>'+
'<div id="bkMsg" class=small style="margin-top:8px"></div>'+
'<div id="bkJobs" style="margin-top:8px"></div>';
loadBkJobs();
}
async function saveBk(){
const d=await j('/backup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
enabled:document.getElementById('bkEnabled').checked,
times:document.getElementById('bkTimes').value.split('\\n').map(s=>s.trim()).filter(Boolean)
})});
const m=document.getElementById('bkMsg');if(!d||!m)return;
if(d.ok){m.style.color='#3fb950';m.textContent='✅ 备份配置已保存：'+esc((d.config&&d.config.times||[]).join(', '));await loadBackup();}
else{m.style.color='#f85149';m.textContent='❌ '+esc(d.error||'保存失败');}
}
async function runBk(){
const m=document.getElementById('bkMsg');if(!m)return;
m.style.color='#d29922';m.textContent='⏳ 正在触发备份...';
const d=await j('/backup/run',{method:'POST'});
if(!d)return;
if(d.ok){m.style.color='#3fb950';m.textContent='✅ 已创建备份 Job: '+esc(d.jobName);loadBkJobs();}
else{m.style.color='#f85149';m.textContent='❌ '+esc(d.error||'触发失败');}
}
async function loadBkJobs(){
const d=await j('/backup/jobs');if(!d||!d.jobs)return;const el=document.getElementById('bkJobs');
if(!el)return;
const rows=d.jobs.map(x=>{
const st=x.state==='success'?'<span class=ok>成功</span>':(x.state==='failed'?'<span class=err>失败</span>':'<span class=small>进行中</span>');
return '<div class=row><span class=small>'+esc((x.name||'').slice(0,30))+'</span><span class=small>'+esc((x.created||'').slice(0,16).replace('T',' '))+'</span>'+st+'</div>';
}).join('');
el.innerHTML='<div class=small style="margin-top:6px">最近备份：</div>'+rows;
}
async function act(kind){const btn=document.querySelectorAll('button');btn.forEach(b=>b.disabled=true);
const msg=document.getElementById('msg');
if(kind==='pause' && !confirm('确认暂停全部服务？正在进行的会话将中断。')){btn.forEach(b=>b.disabled=false);return;}
try{const r=await fetch('/'+kind,{method:'POST'});
if(r.status===401){msg.style.color='#f85149';msg.textContent='⚠️ 登录已过期，正在跳转登录...';setTimeout(()=>window.location=LOGIN_URL,800);return;}
const s=await r.json();
if(s && s.ok){msg.style.color='#3fb950';msg.textContent=(kind==='pause'?'✅ 已全部暂停':'✅ 已全部恢复');await load();}
else if(s&&s.errors&&s.errors.length){msg.style.color='#f85149';msg.textContent='部分失败: '+esc(s.errors.join(' | '));}
else{msg.style.color='#f85149';msg.textContent='操作失败: '+esc((s&&s.error)||'HTTP '+r.status);}}
catch(e){msg.style.color='#f85149';msg.textContent='请求错误: '+esc(e.message);}
btn.forEach(b=>b.disabled=false);}
window.onload=load;
function escapeHtml(s){return String(s==null?'':s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
</script></body></html>`);
});

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

/* ---------- GitHub OAuth ---------- */
app.get('/auth/login', (req, res) => {
  if (!GITHUB_CLIENT_ID || !GITHUB_CALLBACK_URL) {
    return res.status(500).send('GitHub OAuth 未配置（GITHUB_CLIENT_ID / CALLBACK_URL）');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({ client_id: GITHUB_CLIENT_ID, redirect_uri: GITHUB_CALLBACK_URL, scope: 'read:user', state });
  res.redirect('https://github.com/login/oauth/authorize?' + params.toString());
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('缺少 code');
  if (state && req.session && req.session.oauthState && state !== req.session.oauthState) {
    return res.status(400).send('state 不匹配，可能被 CSRF');
  }
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code, redirect_uri: GITHUB_CALLBACK_URL })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('获取 token 失败: ' + (tokenData.error_description || tokenData.error));
    const userRes = await fetch('https://api.github.com/user', { headers: { Authorization: 'Bearer ' + tokenData.access_token } });
    const user = await userRes.json();
    if (!ALLOWED_GITHUB_LOGIN.includes(user.login)) {
      return res.status(403).send('账号 ' + user.login + ' 不在白名单内');
    }
    req.session.user = { login: user.login, name: user.name };
    res.redirect('/');
  } catch (e) {
    res.status(500).send('GitHub 登录失败: ' + e.message);
  }
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/logged-out'));
});

app.get('/logged-out', (req, res) => {
  res.status(200).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>已退出</title></head><body style="font-family:system-ui;background:#0f1115;color:#e6e8eb;padding:40px"><h2>已退出登录</h2><p><a href="/" style="color:#3fb950">重新登录</a></p></body></html>`);
});

/* ================= API: 资源展示 ================= */
app.get('/status', requireAuth, requireTotp, async (req, res) => {
  try {
    const state = readState();
    const statuses = await getStatuses();
    res.json({ paused: state.paused, apps: statuses });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/resources', requireAuth, requireTotp, async (req, res) => {
  try {
    const resources = [];
    for (const t of MODE_TARGETS) {
      try {
        const full = await kubeGetFull(t.kind, t.name);
        resources.push({ label: t.label, name: full.name, kind: full.kind, resources: full.resources, replicas: full.ready });
      } catch (e) {
        resources.push({ label: t.label, name: t.name, kind: t.kind, resources: null, error: e.message });
      }
    }
    // PVC：从 StatefulSet volumeClaimTemplates 动态推导
    const pvcs = [];
    for (const t of MODE_TARGETS) {
      try {
        const list = await kubeGetPVCFromSTS(t.kind, t.name);
        pvcs.push(...list);
      } catch (e) { /* 忽略单个 StatefulSet PVC 失败 */ }
    }
    res.json({ resources, pvcs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= API: 模式配置与管理 ================= */
app.get('/modes', requireAuth, requireTotp, async (req, res) => {
  const { modes, activeMode } = getModeConfig();
  res.json({ modes, activeMode });
});

// 保存模式配置（页面可编辑各模式数值）
app.post('/modes', requireAuth, requireTotp, async (req, res) => {
  try {
    const { modes, activeMode } = req.body || {};
    if (!modes || typeof modes !== 'object') return res.status(400).json({ error: 'modes 参数缺失' });
    // 只允许三类 key，且要求三套都完整（否则下次读取会被重置为默认）
    const allowed = ['daily', 'pro', 'develop'];
    const clean = {};
    for (const k of allowed) {
      const m = modes[k];
      if (!m) return res.status(400).json({ error: '模式 ' + k + ' 缺失，请提供完整三套模式' });
      const cfg = {};
      for (const tkey of ['lobehub', 'devbox', 'paradedb']) {
        const c = m.configs && m.configs[tkey];
        if (!c || !String(c.cpu || '').trim() || !String(c.mem || '').trim()) {
          return res.status(400).json({ error: '模式 ' + k + ' 的 ' + tkey + ' CPU/内存 不能为空' });
        }
        cfg[tkey] = { cpu: String(c.cpu).trim(), mem: String(c.mem).trim() };
      }
      clean[k] = { label: m.label || k, desc: m.desc || '', configs: cfg };
    }
    saveModeConfig(clean, activeMode || undefined);
    res.json({ ok: true, modes: clean });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 恢复默认模式配置（回到环境变量/内置默认值）
app.post('/modes/reset', requireAuth, requireTotp, async (req, res) => {
  try {
    const s = readState();
    delete s.modes;
    delete s.activeMode;
    writeState(s);
    const { modes, activeMode } = getModeConfig();
    res.json({ ok: true, modes, activeMode });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 切换模式（分步确认 + 失败回滚）
app.post('/mode', requireAuth, requireTotp, async (req, res) => {
  try {
    const { mode } = req.body || {};
    if (!mode) return res.status(400).json({ error: 'mode 参数缺失' });
    const result = await switchMode(mode);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message, rollback: true });
  }
});

/* ================= API: 数据库备份 ================= */
app.get('/backup', requireAuth, requireTotp, async (req, res) => {
  try {
    const config = getBackupConfig();
    res.json({ config });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/backup', requireAuth, requireTotp, async (req, res) => {
  try {
    const { enabled, times } = req.body || {};
    const cur = getBackupConfig();
    let cleanTimes = cur.times;
    if (times !== undefined) {
      if (!Array.isArray(times)) return res.status(400).json({ error: 'times 必须是数组' });
      const t = times.map(s => String(s).trim()).filter(Boolean);
      const bad = t.filter(x => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(x);
        if (!m) return true;
        return parseInt(m[1], 10) > 23 || parseInt(m[2], 10) > 59;
      });
      if (bad.length) return res.status(400).json({ error: '时间格式错误（应为 00:00-23:59，如 03:30）：' + bad.join(', ') });
      cleanTimes = t;
    }
    const bc = {
      enabled: typeof enabled === 'boolean' ? enabled : cur.enabled,
      times: cleanTimes
    };
    saveBackupConfig(bc);
    scheduleBackups();
    res.json({ ok: true, config: bc });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/backup/run', requireAuth, requireTotp, async (req, res) => {
  try {
    const jobName = await triggerBackup();
    res.json({ ok: true, jobName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/backup/jobs', requireAuth, requireTotp, async (req, res) => {
  try {
    const jobs = await listBackupJobs();
    res.json({ jobs });
  } catch (e) {
    res.json({ jobs: [], error: e.message });
  }
});

/* ================= 暂停/恢复 ================= */
app.post('/pause', requireAuth, requireTotp, async (req, res) => {
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

app.post('/resume', requireAuth, requireTotp, async (req, res) => {
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
  // 初始化 & 调度备份
  getModeConfig();
  getBackupConfig();
  scheduleBackups();
});
