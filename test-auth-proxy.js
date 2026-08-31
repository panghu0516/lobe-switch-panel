/* 门卫公开前缀冒烟测试：mock 上游 + 断言放行/拦截行为 */
const http = require('http');
const express = require('express');

const up = express();
up.get('/f/:id', (req, res) => res.status(200).send(`IMG:${req.params.id}`));
up.get('/secret', (req, res) => res.status(200).send('SECRET'));
const upSrv = up.listen(18081);

process.env.DOOR_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
process.env.DOOR_SECRET = 'local-test-secret-16bytes!!';
process.env.DOOR_PORT = '18080';
process.env.DOOR_ROUTES = JSON.stringify({ 'test.local': 'http://127.0.0.1:18081' });
require('/config/lobe-switch-panel/src/auth-proxy.js');

let failures = 0;
const assert = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : ' ' + extra}`);
  if (!cond) failures++;
};

const get = (path, headers = {}) =>
  new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 18080, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body }));
    });
    req.on('error', (e) => resolve({ status: -1, body: e.message }));
  });

(async () => {
  await new Promise((r) => setTimeout(r, 300));

  let r = await get('/f/file_abc123', { Host: 'test.local' });
  assert('/f/:id 无 Cookie → 放行到上游', r.status === 200 && r.body === 'IMG:file_abc123', JSON.stringify(r));

  r = await get('/f/file_abc123?token=xx', { Host: 'test.local' });
  assert('/f/:id 带 query → 仍放行', r.status === 200 && r.body === 'IMG:file_abc123', JSON.stringify(r));

  r = await get('/foo/bar', { Host: 'test.local' });
  assert('/foo 前缀不匹配 → 302 /login', r.status === 302 && (r.location || '').startsWith('/login'), JSON.stringify(r));

  r = await get('/secret', { Host: 'test.local' });
  assert('/secret 无 Cookie → 302 /login', r.status === 302 && (r.location || '').startsWith('/login'), JSON.stringify(r));

  r = await get('/secret', { Host: 'unknown.host' });
  assert('未知 Host 未登录 → 先鉴权 302（不泄露路由存在性）', r.status === 302 && (r.location || '').startsWith('/login'), JSON.stringify(r));

  r = await get('/health');
  assert('/health 健康检查 → 200', r.status === 200 && r.body === 'OK', JSON.stringify(r));

  upSrv.close();
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})();
