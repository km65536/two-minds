// サーバーを実際に起動し、Gemini API の代わりにモックサーバーへ接続して動作を確認する。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requests = [];
const queue = [];
const servers = [];
let mock;

const geminiOk = (obj, finishReason = 'STOP') => ({
  status: 200,
  json: {
    candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(obj) }] }, finishReason, index: 0 }],
    usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 30, totalTokenCount: 330 },
  },
});
const geminiErr = (code, status, message) => ({ status: code, json: { error: { code, message, status } } });
const turn = (utterance, extra = {}) => ({ utterance, expression: 'smile', intent: 'develop', topic: '雨', genre: 'nature', after: 'pass', tempo: 'normal', note: '', ...extra });

const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function startServer(env) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${mock.address().port}`, GEMINI_MODEL: 'test-model', IP_MIN_INTERVAL_MS: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(proc);
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => String(d).includes('TWO MINDS') && resolve());
    proc.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
  return `http://127.0.0.1:${port}`;
}

let base;
before(async () => {
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
      const next = queue.shift() || geminiOk(turn(`デフォルトの応答です${requests.length}`));
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next.json));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  base = await startServer({ GEMINI_API_KEY: 'test-key' });
});
after(() => { for (const s of servers) s.kill(); mock?.close(); });

const H = { 'content-type': 'application/json', 'x-two-minds': '1' };
const post = async (b, p, body, headers = H) => {
  const r = await fetch(b + p, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};

test('status reports AI availability without leaking the key', async () => {
  const j = await (await fetch(base + '/api/status')).json();
  assert.equal(j.ai, true);
  assert.equal(j.model, 'test-model');
  assert.ok(!JSON.stringify(j).includes('test-key'));
});

test('serves the page with security headers; health check; blocks traversal', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await r.text(), /TWO&nbsp;MINDS/);
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.notEqual((await fetch(base + '/..%2F.env.example')).status, 200);
});

test('turn: calls Gemini with JSON schema and system instruction; key stays server-side', async () => {
  requests.length = 0;
  queue.push(geminiOk(turn('雨の音って、なぜ落ち着くんだろう。', { expression: 'thinking' })));
  const r = await post(base, '/api/turn', { speaker: 'A', log: [{ kind: 'say', speaker: 'B', text: '雨だねえ', topic: '雨' }], context: { topics: [{ label: '雨の日', genre: 'nature' }], notes: { A: ['ミナは理由を聞きたがる'], B: ['秘密のメモ'] } } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { text: '雨の音って、なぜ落ち着くんだろう。', expression: 'thinking', intent: 'develop', topic: '雨', genre: 'nature', after: 'pass', tempo: 'normal', note: '', calls: 1, demo: false });
  const req = requests[0];
  assert.match(req.url, /models\/test-model:generateContent/);
  assert.equal(req.headers['x-goog-api-key'], 'test-key');
  assert.equal(req.body.generationConfig.responseMimeType, 'application/json');
  assert.ok(req.body.generationConfig.responseJsonSchema.properties.utterance);
  assert.match(JSON.stringify(req.body.systemInstruction), /あなたは「レオ」/);
  assert.match(req.body.contents[0].parts[0].text, /雨だねえ/);
  assert.match(req.body.contents[0].parts[0].text, /雨の日/);
  assert.match(req.body.contents[0].parts[0].text, /ミナは理由を聞きたがる/);
  assert.doesNotMatch(req.body.contents[0].parts[0].text, /秘密のメモ/);
  assert.equal(req.body.generationConfig.maxOutputTokens, 2048);
  assert.equal(req.body.generationConfig.thinkingConfig, undefined);
});

test('turn: truncated output (MAX_TOKENS) is a retryable error, not a crash', async () => {
  queue.push(geminiOk(turn('途中で'), 'MAX_TOKENS'));
  const r = await post(base, '/api/turn', { speaker: 'A', log: [] });
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'max_tokens');
  assert.equal(r.json.error.retryable, true);
});

test('turn: network failure to Gemini maps to a retryable error', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k', GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:9' });
  const r = await post(b, '/api/turn', { speaker: 'A', log: [] });
  assert.ok(r.status >= 500);
  assert.equal(r.json.error.retryable, true);
});

test('turn: optional thinking level is sent when configured', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k', GEMINI_THINKING_LEVEL: 'low' });
  requests.length = 0;
  await post(b, '/api/turn', { speaker: 'A', log: [] });
  assert.deepEqual(requests[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'LOW' });
});

test('turn: duplicate utterance triggers exactly one regeneration', async () => {
  requests.length = 0;
  queue.push(geminiOk(turn('雨だねえ')));
  queue.push(geminiOk(turn('パン屋さんの匂いがしてきた。')));
  const r = await post(base, '/api/turn', { speaker: 'B', log: [{ kind: 'say', speaker: 'B', text: '雨だねえ' }] });
  assert.equal(r.status, 200);
  assert.equal(r.json.text, 'パン屋さんの匂いがしてきた。');
  assert.equal(r.json.calls, 2);
  assert.equal(requests.length, 2);
});

test('turn: safety block is reported as a retryable 422', async () => {
  queue.push(geminiOk(turn(''), 'SAFETY'));
  const r = await post(base, '/api/turn', { speaker: 'A', log: [] });
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, 'blocked');
});

test('turn: Gemini 429 is not retried; daily vs per-minute quota are distinguished', async () => {
  requests.length = 0;
  queue.push(geminiErr(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 500, quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier'));
  const r = await post(base, '/api/turn', { speaker: 'A', log: [] });
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, 'upstream_quota');
  assert.equal(requests.length, 1);
  queue.push(geminiErr(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded, quotaId: GenerateRequestsPerMinutePerProjectPerModel-FreeTier'));
  const m = await post(base, '/api/turn', { speaker: 'A', log: [] });
  assert.equal(m.json.error.code, 'upstream_busy');
  assert.equal(m.json.error.retryable, true);
  assert.equal(requests.length, 2);
});

test('turn: requests from other origins or without the app header are refused', async () => {
  const before = requests.length;
  const r1 = await post(base, '/api/turn', { speaker: 'A', log: [] }, { 'content-type': 'application/json' });
  assert.equal(r1.status, 403);
  const r2 = await post(base, '/api/turn', { speaker: 'A', log: [] }, { ...H, origin: 'https://evil.example' });
  assert.equal(r2.status, 403);
  assert.equal(requests.length, before);
});

test('demo mode never calls the API', async () => {
  const before = requests.length;
  const r = await post(base, '/api/turn', { mode: 'demo', speaker: 'A', log: [] });
  assert.equal(r.status, 200);
  assert.equal(r.json.demo, true);
  assert.ok(r.json.text.length > 0);
  assert.equal(requests.length, before);
});

test('rejects oversized and malformed bodies', async () => {
  const r = await fetch(base + '/api/turn', { method: 'POST', headers: H, body: '{oops' });
  assert.equal(r.status, 400);
  const big = await fetch(base + '/api/turn', { method: 'POST', headers: H, body: 'x'.repeat(64 * 1024) }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
});

test('daily cap stops API calls once reached', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'test-key', DAILY_CALL_LIMIT: '2' });
  requests.length = 0;
  assert.equal((await post(b, '/api/turn', { speaker: 'A', log: [] })).status, 200);
  assert.equal((await post(b, '/api/turn', { speaker: 'B', log: [] })).status, 200);
  const r = await post(b, '/api/turn', { speaker: 'A', log: [] });
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, 'daily_limit');
  assert.equal(requests.length, 2);
  const s = await (await fetch(b + '/api/status')).json();
  assert.equal(s.reason, 'daily_limit');
});

test('without a key (or with AI disabled) only demo works', async () => {
  const b = await startServer({ GEMINI_API_KEY: '', GOOGLE_API_KEY: '' });
  const s = await (await fetch(b + '/api/status')).json();
  assert.equal(s.ai, false);
  assert.equal(s.reason, 'no_key');
  const r = await post(b, '/api/turn', { speaker: 'A', log: [] });
  assert.equal(r.json.error.code, 'no_key');
  assert.equal((await post(b, '/api/turn', { mode: 'demo', speaker: 'A', log: [] })).status, 200);
  const d = await startServer({ GEMINI_API_KEY: 'k', AI_ENABLED: 'false' });
  assert.equal((await (await fetch(d + '/api/status')).json()).reason, 'disabled');
});
