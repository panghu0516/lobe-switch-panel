#!/usr/bin/env node
/**
 * auth-proxy.js —— LobeHub 公网入口 Cookie 登录门卫
 *
 * 监听 DOOR_PORT（默认 8080），对公网流量做统一认证：
 *   - 未登录 / Cookie 无效        → 302 → /login（内嵌极简登录页，无外部资源，几 KB）
 *   - POST /login 动态码错误       → 302 → /login?err=1 回显错误
 *   - POST /login 动态码正确       → Set-Cookie(HMAC 签名, HttpOnly, SameSite=Lax, TTL) → 302 回原路径
 *   - GET  /logout               → 清除 Cookie → 302 /login
 *   - 已登录（Cookie 有效）且 Host 在路由表 → 反代到内网目标（流式透传，支持 SSE）
 *
 * 登录方式：TOTP 动态码（与面板共用同一 TOTP_SECRET，一个码两边通用，无长密码）。
 *
 * 环境变量（真值一律由 Sealos 注入，不进代码/仓库）：
 *   TOTP_SECRET / DOOR_TOTP_SECRET  动态码密钥（DOOR_TOTP_SECRET 优先，缺省回退 TOTP_SECRET；必填，缺失拒绝启动）
 *   DOOR_SECRET      Cookie 签名密钥，>=16 字节（必填，缺失拒绝启动）
 *   DOOR_COOKIE_TTL  Cookie 有效期（秒），默认 604800（7 天）
 *   DOOR_PORT         监听端口，默认 8080
 *   DOOR_ROUTES       JSON: {"host":"target"}，与内置映射合并（内置可被覆盖）
 *   DOOR_DISABLE      "1" 时完全跳过认证直通（仅调试，不推荐）
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const speakeasy = require('speakeasy');

/* ---------------- 配置 ---------------- */
const PORT = parseInt(process.env.DOOR_PORT || '8080', 10);
const TOTP = process.env.DOOR_TOTP_SECRET || process.env.TOTP_SECRET || '';
const SECRET = process.env.DOOR_SECRET || '';
const COOKIE_TTL = parseInt(process.env.DOOR_COOKIE_TTL || String(7 * 24 * 3600), 10);
const COOKIE_NAME = 'door_token';
const DISABLED = process.env.DOOR_DISABLE === '1';

const routes = {
  'lobe.tigerhu.xyz': 'http://lobehub-v2-ceigycuepnks.ns-feotrwac:3210',
  'panel.tigerhu.xyz': 'http://127.0.0.1:3000',
  'opencode.tigerhu.xyz': 'http://my-devbox-qzuwpllzwwkz.ns-feotrwac.svc.cluster.local:4096',
};
try {
  if (process.env.DOOR_ROUTES) {
    Object.assign(routes, JSON.parse(process.env.DOOR_ROUTES));
  }
} catch (e) {
  console.error('[auth-proxy] DOOR_ROUTES JSON 解析失败，仅用内置映射:', e.message);
}

/* ---------------- 启动保护 ---------------- */
if (!DISABLED) {
  if (!TOTP) {
    console.error('[auth-proxy] 缺少动态码密钥（DOOR_TOTP_SECRET / TOTP_SECRET），拒绝启动（请配置环境变量）');
    process.exit(1);
  }
  if (!SECRET || Buffer.byteLength(SECRET) < 16) {
    console.error('[auth-proxy] DOOR_SECRET 缺失或过短（需 >=16 字节），拒绝启动');
    process.exit(1);
  }
}

/* ---------------- 工具 ---------------- */
const app = express();
app.use(cookieParser());
app.use(express.urlencoded({ extended: false }));

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
}

function issueToken() {
  const payload = Buffer.from(JSON.stringify({ t: Date.now() + COOKIE_TTL * 1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return false;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!safeEqual(sig, sign(payload))) return false;
  try {
    const { t } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Boolean(t) && t >= Date.now();
  } catch {
    return false;
  }
}

function sanitizeNext(v) {
  if (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//')) {
    return v.slice(0, 512);
  }
  return '/';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderLogin(next, hasError) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>入口认证</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0b1220; color:#e6edf3; font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
  .card { width:min(92vw,360px); background:#111a2e; border:1px solid #24304a; border-radius:12px; padding:28px 24px; }
  h1 { font-size:18px; margin:0 0 18px; text-align:center; }
  .err { background:#3a1d21; color:#ff9b9b; border:1px solid #6b2a31; border-radius:8px;
         font-size:13px; padding:8px 10px; margin-bottom:14px; }
  input[type=text], input[type=tel] { width:100%; padding:10px 12px; margin-bottom:14px; background:#0d1526;
         border:1px solid #2c3a58; border-radius:8px; color:#e6edf3; font-size:15px; text-align:center;
         letter-spacing:6px; font-family:ui-monospace,SFMono-Regular,monospace; }
  button { width:100%; padding:11px; background:#2f81f7; color:#fff; border:0; border-radius:8px;
         font-size:15px; cursor:pointer; }
  button:active { opacity:.85; }
  .tip { margin-top:14px; text-align:center; font-size:12px; color:#7d8aa3; }
</style>
</head>
<body>
<div class="card">
<h1>入口认证</h1>
${hasError ? '<div class="err">动态码错误或已过期，请重试</div>' : ''}
<form method="post" action="/login">
  <input type="hidden" name="next" value="${esc(next)}">
  <input type="tel" name="token" placeholder="6 位动态码" maxlength="6" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" autofocus>
  <button type="submit">进入</button>
</form>
<div class="tip">输入 Authenticator 里当前 6 位动态码</div>
</div>
</body>
</html>`;
}

/* ---------------- 反代 ---------------- */
function proxy(req, res) {
  const host = (req.headers.host || '').split(':')[0];
  const target = routes[host];
  if (!target) {
    return res.status(404).send('Not Found');
  }
  if ((req.headers.upgrade || '').toLowerCase() === 'websocket') {
    return res.status(501).send('WebSocket upgrade not supported via door proxy');
  }
  let u;
  try { u = new URL(target); } catch { return res.status(500).send('Bad upstream target'); }

  const headers = Object.assign({}, req.headers);
  const hop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade', 'host'];
  hop.forEach((k) => delete headers[k]);
  headers.host = u.host;
  headers['x-forwarded-for'] = req.socket.remoteAddress || '';
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-host'] = host;

  const proxyReq = http.request({
    hostname: u.hostname,
    port: u.port || 80,
    path: req.originalUrl || '/',
    method: req.method,
    headers,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => {
    console.error('[auth-proxy] upstream error:', e.message);
    if (!res.headersSent) res.status(502).send('Bad Gateway');
    else res.destroy();
  });
  req.pipe(proxyReq);
}

/* ---------------- 路由 ---------------- */
app.get('/health', (req, res) => {
  res.status(200).type('text/plain').send('OK');
});

app.get('/login', (req, res) => {
  const next = sanitizeNext(req.query.next);
  const hasError = req.query.err === '1';
  res.status(hasError ? 401 : 200)
    .set('Content-Type', 'text/html; charset=utf-8')
    .set('Cache-Control', 'no-store')
    .send(renderLogin(next, hasError));
});

app.post('/login', (req, res) => {
  const next = sanitizeNext(req.body && req.body.next);
  const token = String((req.body && req.body.token) || '').trim();
  const ok = DISABLED || speakeasy.totp.verify({ secret: TOTP, encoding: 'base32', token, window: 1 });
  if (ok) {
    res.set('Set-Cookie', `${COOKIE_NAME}=${issueToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_TTL}`)
      .redirect(next || '/');
  } else {
    res.redirect(`/login?next=${encodeURIComponent(next || '/')}&err=1`);
  }
});

app.get('/logout', (req, res) => {
  res.set('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
    .redirect('/login');
});

app.use((req, res) => {
  if (DISABLED || verifyToken(req.cookies && req.cookies[COOKIE_NAME])) {
    proxy(req, res);
    return;
  }
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || '/')}`);
});

/* ---------------- 启动 ---------------- */
app.listen(PORT, () => {
  console.log(`[auth-proxy] door listening on :${PORT} (routes: ${Object.keys(routes).join(', ')})`);
});