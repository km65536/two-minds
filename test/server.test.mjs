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
  const url = `http://127.0.0.1:${port}`;
  logs[url] = [];
  proc.stderr.on('data', (d) => logs[url].push(String(d)));
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => {
      logs[url].push(String(d));
      if (String(d).includes('TWO MINDS')) resolve();
    });
    proc.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
  return url;
}
const logs = {};
const logText = (url) => logs[url].join('');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let base;
before(async () => {
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
      const next = queue.shift() || geminiOk(turn(`デフォルトの応答です${requests.length}`));
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(next.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(next.json));
      }, next.delay || 0);
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  // 共通のサーバーでは、障害後の待ち時間をほぼ 0 にしておく（待ち時間そのものは専用のテストで確かめる）
  base = await startServer({ GEMINI_API_KEY: 'test-key', UPSTREAM_COOLDOWN_BASE_MS: '1', UPSTREAM_COOLDOWN_MAX_MS: '1' });
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
  await wait(20);
});

// ---------- 503 などの一時的な障害 ----------

const overloaded = (code = 503, status = 'UNAVAILABLE', message = 'The model is overloaded. Please try again later.') => geminiErr(code, status, message);

test('503 from Gemini: reported as Gemini-side, logged with HTTP status / code / message, not retried', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k', UPSTREAM_COOLDOWN_BASE_MS: '400', UPSTREAM_COOLDOWN_MAX_MS: '2000' });
  requests.length = 0;
  queue.push(overloaded());
  const r = await fetch(b + '/api/turn', { method: 'POST', headers: H, body: JSON.stringify({ speaker: 'A', log: [] }) });
  const j = await r.json();
  assert.equal(r.status, 503);
  assert.equal(j.error.code, 'upstream_unavailable');
  assert.equal(j.error.source, 'gemini');
  assert.equal(j.error.upstreamStatus, 503);
  assert.equal(j.error.retryable, true);
  assert.match(j.error.message, /Gemini.*HTTP 503 UNAVAILABLE/);
  assert.ok(j.error.retryAfterMs >= 400);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal(requests.length, 1); // SDK もサーバーも勝手にやり直さない
  await wait(50);
  const log = logText(b);
  assert.match(log, /\[gemini\] error model=test-model ms=\d+ http=503 code=UNAVAILABLE message="The model is overloaded\. Please try again later\." mapped=upstream_unavailable/);
  assert.match(log, /\[gemini\] cooldown \d+ms after upstream_unavailable \(consecutive failures: 1\)/);
  assert.doesNotMatch(log, /test-key|"k"/); // API キーはログに出さない
});

test('after a 503, the server pauses calls to Gemini (shared cooldown), then recovers on success', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k', UPSTREAM_COOLDOWN_BASE_MS: '400', UPSTREAM_COOLDOWN_MAX_MS: '2000' });
  requests.length = 0;
  queue.push(overloaded());
  assert.equal((await post(b, '/api/turn', { speaker: 'A', log: [] })).json.error.code, 'upstream_unavailable');
  // 待機中は Gemini を呼ばずにすぐ返す（別の閲覧者でも同じ）
  const c = await post(b, '/api/turn', { speaker: 'B', log: [] }, { ...H, 'x-forwarded-for': '203.0.113.9' });
  assert.equal(c.status, 503);
  assert.equal(c.json.error.code, 'upstream_cooldown');
  assert.ok(c.json.error.retryAfterMs > 0 && c.json.error.retryAfterMs <= 600);
  assert.match(c.json.error.message, /HTTP 503 UNAVAILABLE/);
  assert.equal(requests.length, 1);
  // 待ち時間が過ぎれば、また呼ぶ。成功すれば待ち時間は元に戻る
  await wait(c.json.error.retryAfterMs + 50);
  const ok = await post(b, '/api/turn', { speaker: 'A', log: [] });
  assert.equal(ok.status, 200);
  assert.equal(requests.length, 2);
  const again = await post(b, '/api/turn', { speaker: 'B', log: [] });
  assert.equal(again.status, 200);
});

test('consecutive 503s lengthen the cooldown up to a cap', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k', UPSTREAM_COOLDOWN_BASE_MS: '100', UPSTREAM_COOLDOWN_MAX_MS: '350' });
  const waits = [];
  for (let i = 0; i < 4; i++) {
    queue.push(overloaded(i % 2 ? 500 : 503, i % 2 ? 'INTERNAL' : 'UNAVAILABLE', 'error'));
    const r = await post(b, '/api/turn', { speaker: 'A', log: [] });
    assert.equal(r.json.error.code, 'upstream_unavailable');
    waits.push(r.json.error.retryAfterMs);
    await wait(r.json.error.retryAfterMs + 20);
  }
  assert.ok(waits[1] > waits[0] * 1.5, `grows: ${waits}`);
  assert.ok(waits.every((w) => w <= 350), `capped: ${waits}`);
});

test('per-minute 429 with RetryInfo: the suggested delay is passed to the client', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k', UPSTREAM_COOLDOWN_BASE_MS: '100', UPSTREAM_COOLDOWN_MAX_MS: '60000' });
  queue.push({ status: 429, json: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded, quotaId: GenerateRequestsPerMinutePerProjectPerModel-FreeTier', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }] } } });
  const r = await post(b, '/api/turn', { speaker: 'A', log: [] });
  assert.equal(r.json.error.code, 'upstream_busy');
  assert.ok(r.json.error.retryAfterMs >= 7000);
  assert.match(logText(b), /retryAfterMs=7000/);
});

test('timeout to Gemini is reported as such (not as 503) and triggers the cooldown', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k', GEMINI_TIMEOUT_MS: '300', UPSTREAM_COOLDOWN_BASE_MS: '100', UPSTREAM_COOLDOWN_MAX_MS: '200' });
  queue.push({ ...geminiOk(turn('遅すぎる応答')), delay: 1500 });
  const r = await post(b, '/api/turn', { speaker: 'A', log: [] });
  assert.equal(r.status, 504);
  assert.equal(r.json.error.code, 'timeout');
  assert.equal(r.json.error.source, 'gemini');
  await wait(50);
  assert.match(logText(b), /\[gemini\] error model=test-model ms=\d+ code=TIMEOUT/);
});

test('non-transient Gemini errors (400) do not start a cooldown', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k', UPSTREAM_COOLDOWN_BASE_MS: '5000' });
  queue.push(geminiErr(400, 'INVALID_ARGUMENT', 'bad schema'));
  assert.equal((await post(b, '/api/turn', { speaker: 'A', log: [] })).json.error.code, 'bad_request');
  assert.equal((await post(b, '/api/turn', { speaker: 'A', log: [] })).status, 200);
});

test('during Gemini trouble the duplicate-regeneration call is skipped (no extra API use)', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k', UPSTREAM_COOLDOWN_BASE_MS: '100', UPSTREAM_COOLDOWN_MAX_MS: '100' });
  queue.push(overloaded());
  await post(b, '/api/turn', { speaker: 'A', log: [] });
  await wait(250);
  requests.length = 0;
  queue.push(geminiOk(turn('雨だねえ')));
  const r = await post(b, '/api/turn', { speaker: 'B', log: [{ kind: 'say', speaker: 'B', text: '雨だねえ' }] });
  assert.equal(r.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(r.json.calls, 1);
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
