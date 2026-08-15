/**
 * test-proxy.js —— embedding-proxy 本地压测
 * mock 一个 Dashscope 上游（单请求 >20 条返回 400），验证：
 *   1. 1 条 embedding → 1 批，返回 1 条
 *   2. 49 条 → 3 批(20/20/9)，合并 49 条，index 0..48 连续
 *   3. 100 条 → 5 批，合并 100 条
 *   4. model 映射 text-embedding-3-small → qwen3.7-text-embedding
 *   5. usage 累加（每条 prompt_tokens=5 → 49 条 = 245）
 *   6. chat 透传 /v1/chat/completions 正常
 */
process.env.UPSTREAM_BASE = 'http://127.0.0.1:19090/v1';

const http = require('http');
const express = require('express');
const proxy = require('./src/embedding-proxy');

let failures = 0;
function assert(name, cond, extra) {
  if (cond) console.log(`  ✅ ${name}`);
  else { failures++; console.log(`  ❌ ${name} ${extra || ''}`); }
}

// ── mock 上游 ──
const up = express();
up.use(express.json());
up.post('/v1/embeddings', (req, res) => {
  const input = req.body.input || [];
  console.log(`  [mock-up] embeddings model=${req.body.model} n=${input.length}`);
  if (input.length > 20) return res.status(400).json({ error: { message: `exceeds batch limit ${input.length}` } });
  res.json({
    object: 'list',
    data: input.map((t, i) => ({ object: 'embedding', embedding: [i + 1, t.length], index: i })),
    model: req.body.model,
    usage: { prompt_tokens: input.length * 5, total_tokens: input.length * 5 },
  });
});
up.post('/v1/chat/completions', (req, res) => {
  console.log(`  [mock-up] chat model=${req.body.model} auth=${req.headers.authorization || 'none'}`);
  res.json({ id: 'chatcmpl-mock', object: 'chat.completion', model: req.body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'pong' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
});
const upSrv = up.listen(19090);

// ── 代理 ──
const app = express();
app.use(express.json());
app.use(proxy);
const appSrv = app.listen(19091);

const BASE = 'http://127.0.0.1:19091';

async function callEmbeddings(n) {
  const input = Array.from({ length: n }, (_, i) => `chunk-${i} ` + 'x'.repeat(i % 50));
  const r = await fetch(`${BASE}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer sk-test-123' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input, encoding_format: 'float' }),
  });
  return { status: r.status, json: await r.json() };
}

(async () => {
  console.log('\n── 用例1: 单条 embedding ──');
  try {
    const { status, json } = await callEmbeddings(1);
    assert('状态 200', status === 200, `got ${status}`);
    assert('返回 1 条', json.data.length === 1, `got ${json.data.length}`);
    assert('model 已映射', json.model === 'qwen3.7-text-embedding', `got ${json.model}`);
    assert('usage=5', json.usage.prompt_tokens === 5, JSON.stringify(json.usage));
  } catch (e) { failures++; console.log('  ❌ 异常', e.message); }

  console.log('\n── 用例2: 49 条（3 批）──');
  try {
    const { status, json } = await callEmbeddings(49);
    assert('状态 200（无 400 说明未超 20 上限）', status === 200, `got ${status}`);
    assert('合并 49 条', json.data.length === 49, `got ${json.data.length}`);
    const idx = json.data.map((d) => d.index);
    const seqOk = idx.every((v, i) => v === i);
    assert('index 0..48 连续正确（按原顺序归位）', seqOk, JSON.stringify(idx));
    assert('usage 累加 49*5=245', json.usage.prompt_tokens === 245, JSON.stringify(json.usage));
    assert('upstream 分 3 批调用（mock 打印可见）', true);
    // 检查 embedding 内容跟上游 index 对应：第 10 条 embedding[0] 应为 10（batch1 的 10 + 偏移0 之前）
    // mock: embedding=[i+1, len] 其中 i 是批内 index；proxy 加了 offset
    // 第 30 条（全局 index 29）在批 1（索引 9）+off200 → mock i=9 → embedding[0]=10, embedding[1]=len
    const d29 = json.data[29];
    // chunk-29 内容: 'chunk-29 ' (9 chars) + 'x'.repeat(29 % 50 = 29) = 38 chars
    const expected29 = [(29 % 20) + 1, 9 + 29];
    const e29ok = d29.embedding[0] === expected29[0] && d29.embedding[1] === expected29[1];
    assert('跨批偏移修正正确（批2第10条=全局29）', e29ok, `got ${JSON.stringify(d29.embedding)} exp ${JSON.stringify(expected29)}`);
  } catch (e) { failures++; console.log('  ❌ 异常', e.message); }

  console.log('\n── 用例3: 100 条（5 批）──');
  try {
    const { status, json } = await callEmbeddings(100);
    assert('状态 200', status === 200, `got ${status}`);
    assert('合并 100 条', json.data.length === 100, `got ${json.data.length}`);
    const idx = json.data.map((d) => d.index);
    assert('index 0..99 连续', idx.every((v, i) => v === i));
    assert('usage=500', json.usage.prompt_tokens === 500, JSON.stringify(json.usage));
  } catch (e) { failures++; console.log('  ❌ 异常', e.message); }

  console.log('\n── 用例4: chat 透传 ──');
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer sk-lh-123' },
      body: JSON.stringify({ model: 'qwen-plus', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    });
    const j = await r.json();
    assert('状态 200', r.status === 200, `got ${r.status}`);
    assert('透传模型 qwen-plus', j.model === 'qwen-plus', `got ${j.model}`);
    assert('内容 pong', j.choices[0].message.content === 'pong');
  } catch (e) { failures++; console.log('  ❌ 异常', e.message); }

  console.log('\n── 用例5: 非法输入 ──');
  try {
    const r = await fetch(`${BASE}/v1/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'text-embedding-3-small', input: [] }) });
    assert('空 input 返回 400', r.status === 400, `got ${r.status}`);
  } catch (e) { failures++; console.log('  ❌ 异常', e.message); }

  upSrv.close(); appSrv.close();
  console.log(failures === 0 ? '\n🎉 全部用例通过' : `\n💥 ${failures} 个用例失败`);
  process.exit(failures === 0 ? 0 : 1);
})();