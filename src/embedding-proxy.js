/**
 * embedding-proxy.js —— LobeHub 模型服务商通用代理（拆批增强）
 *
 * 背景：LobeHub 的知识库向量化把文件全部 chunks 一次塞进 input（实测 49 条），
 * 而 Dashscope 单请求最多 20 条 → 之前的 CF Worker 拆批层在荷兰，跨洲握手不稳
 * 导致 ETIMEDOUT。本模块把拆批层移到 switch-panel（与 LobeHub 同集群，内网互访）。
 *
 * 职责：
 *   1. /v1/embeddings：模型映射 text-embedding-3-small → qwen3.7-text-embedding，
 *      拆批（≤20条/批）并发调 Dashscope compatible-mode，按 index 归位合并返回
 *   2. 其它 /v1/*（chat/completions 等）：原样透传 Dashscope compatible-mode
 *
 * 鉴权（透传模式，零密钥落地）：
 *   - 请求的 Authorization（Dashscope key）原样转发给上游，本模块不存储任何密钥
 *   - 可选 EMBEDDING_PROXY_TOKEN：LobeHub 需带 X-Proxy-Token 头才放行（防公网滥用）
 *
 * 加固（比原 Worker 多的一层）：
 *   - 单批失败自动重试 2 次（300ms 指数退避），整批仍失败才返回错误
 */

const express = require('express');

/* ================= 配置 ================= */
const UPSTREAM_BASE = (process.env.UPSTREAM_BASE || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
const EMBEDDING_BATCH_LIMIT = parseInt(process.env.EMBEDDING_BATCH_LIMIT || '20', 10); // Dashscope 单请求上限
const EMBEDDING_RETRIES = parseInt(process.env.EMBEDDING_RETRIES || '2', 10);
const EMBEDDING_RETRY_DELAY_MS = parseInt(process.env.EMBEDDING_RETRY_DELAY_MS || '300', 10);
const PROXY_TOKEN = process.env.EMBEDDING_PROXY_TOKEN || ''; // 可选：第二道门
const MODEL_MAP = { 'text-embedding-3-small': 'qwen3.7-text-embedding' }; // 与服务商配置一致

const router = express.Router();

/* ================= 工具 ================= */
function splitBatches(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 单批调 Dashscope，重试 retries 次（指数退避）
async function fetchEmbeddingBatch(batch, authHeader, model, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let lastErr = null;
  try {
    for (let attempt = 0; attempt <= EMBEDDING_RETRIES; attempt++) {
      try {
        const resp = await fetch(`${UPSTREAM_BASE}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader || 'Bearer ' + (process.env.DASHSCOPE_API_KEY || ''),
          },
          body: JSON.stringify({ model, input: batch }),
          signal: ctrl.signal,
        });
        const json = await resp.json().catch(() => ({}));
        if (resp.ok) return json;
        lastErr = new Error(`upstream ${resp.status}: ${JSON.stringify(json).slice(0, 400)}`);
      } catch (e) {
        lastErr = e;
      }
      if (attempt < EMBEDDING_RETRIES) {
        await sleep(EMBEDDING_RETRY_DELAY_MS * Math.pow(2, attempt));
      }
    }
    throw lastErr || new Error('embedding batch failed');
  } finally {
    clearTimeout(timer);
  }
}

/* ================= 处理器 ================= */

// /v1/embeddings：映射模型 → 拆批 → 并发 → 按 index 归位合并
async function handleEmbeddings(req, res) {
  const rawModel = (req.body && req.body.model) || 'text-embedding-3-small';
  const model = MODEL_MAP[rawModel] || rawModel;
  const input = (req.body && req.body.input) || [];
  if (!Array.isArray(input) || input.length === 0) {
    return res.status(400).json({ error: { message: 'input must be a non-empty array', type: 'invalid_request_error' } });
  }
  const inputIsStrings = typeof input[0] === 'string';
  const encodingFormat = req.body.encoding_format;
  const dims = req.body.dimensions; // 若请求带 dimensions（暂不支持则忽略）

  // 单条也走标准化路径，保证响应结构统一
  const batches = splitBatches(input, EMBEDDING_BATCH_LIMIT);
  console.log(`[embed-proxy] ${input.length} inputs -> ${batches.length} batch(es) (limit ${EMBEDDING_BATCH_LIMIT}), model ${rawModel} -> ${model}`);

  const authHeader = req.headers.authorization || '';

  // 并发调各批，统一收集响应
  const batchResponses = await Promise.all(
    batches.map((batch, bi) => fetchEmbeddingBatch(batch, authHeader, model, 60000).then((json) => ({ bi, json })))
  );

  const results = [];
  const usage = { prompt_tokens: 0, total_tokens: 0 };
  for (const { bi, json } of batchResponses) {
    const data = (json && json.data) || [];
    // Dashscope 每批返回的 index 从 0 开始，加上本批的全局偏移
    const offset = bi * EMBEDDING_BATCH_LIMIT;
    for (const item of data) {
      results.push({ ...item, index: offset + (item.index || 0) });
    }
    // usage 在响应顶层，逐批累加
    const u = (json && json.usage) || {};
    usage.prompt_tokens += u.prompt_tokens || 0;
    usage.total_tokens += u.total_tokens || 0;
  }

  // 按全局 index 归位
  results.sort((a, b) => a.index - b.index);
  const dataOut = results.map((item) => ({ object: 'embedding', embedding: item.embedding, index: item.index }));

  res.json({
    object: 'list',
    data: dataOut,
    model: MODEL_MAP[rawModel] ? model : rawModel,
    usage,
  });
}

// 其它 /v1/*：原样透传上游（chat/completions、rerank、audio 等）
async function handlePassThrough(req, res) {
  const targetPath = req.originalUrl.replace(/^\/v1/, '');
  const upstreamUrl = `${UPSTREAM_BASE}${targetPath}`;
  const authHeader = req.headers.authorization || 'Bearer ' + (process.env.DASHSCOPE_API_KEY || '');
  const body = Object.keys(req.body || {}).length ? JSON.stringify(req.body) : undefined;

  console.log(`[embed-proxy] passthrough ${req.method} ${req.originalUrl} -> ${upstreamUrl}`);

  // 对 SSE 流（chat 流式）不做整体转发处理，交给 fetch 流式读取
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
        ...(req.headers.accept ? { 'Accept': req.headers.accept } : {}),
      },
      body,
      signal: ctrl.signal,
    });
    const contentType = upstream.headers.get('content-type') || '';
    res.status(upstream.status);
    // 流式透传
    if (upstream.body) {
      const reader = upstream.body.getReader();
      const passthrough = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) { controller.close(); return; }
          controller.enqueue(value);
        },
        cancel() { reader.cancel(); },
      });
      return passthrough.pipeTo(new WritableStream({
        write(chunk) { res.write(chunk); },
        close() { res.end(); },
        abort(err) { res.destroy(err); },
      }));
    }
    const text = await upstream.text();
    res.setHeader('Content-Type', contentType || 'application/json');
    res.send(text);
  } catch (e) {
    if (e.name === 'AbortError') {
      res.status(504).json({ error: { message: 'upstream timeout', type: 'upstream_error' } });
    } else {
      res.status(502).json({ error: { message: `upstream error: ${e.message}`, type: 'upstream_error' } });
    }
  } finally {
    clearTimeout(timer);
  }
}

/* ================= 路由 ================= */
// 鉴权门：可选 X-Proxy-Token
router.use((req, res, next) => {
  if (PROXY_TOKEN && req.headers['x-proxy-token'] !== PROXY_TOKEN) {
    return res.status(401).json({ error: { message: 'invalid proxy token', type: 'auth_error' } });
  }
  next();
});

router.post('/v1/embeddings', handleEmbeddings);
router.use('/v1', handlePassThrough); // 其余 /v1/* 全透传

module.exports = router;