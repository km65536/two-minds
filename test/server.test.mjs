// サーバーを実際に起動し、Gemini API の代わりにモックサーバーへ接続して動作を確認する（本物の Gemini には接続しない）。
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
const logs = {};
let mock;
let base;

const line = (speaker, text, extra = {}) => ({ speaker, text, expression: 'neutral', action: 'none', type: 'chat', phase: 'FREE', pause: 'none', ...extra });
const episode = (lines = [line('A', 'お茶、ぬるくなっちゃった'), line('B', 'ほんとだ。なんでぬるいとまずいんだろう', { type: 'question', phase: 'DISCOVERY' })], extra = {}) => ({
  summary: 'ぬるいお茶の話',
  topic: 'お茶',
  problem: { exists: true, question: 'ぬるいお茶はなぜまずいか', kind: 'science', status: 'exploring', leo_view: '期待とのズレ', mina_view: '香り', explored: [], conclusion: '', unresolved_reason: '', open_points: [] },
  lines,
  next: { hook: '飲み物', deferred_questions: [], continue_problem: true },
  notes: { A: '', B: '' },
  ...extra,
});
const geminiText = (text, finishReason = 'STOP') => ({ status: 200, json: { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason, index: 0 }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 400 } } });
const geminiOk = (obj = episode(), finishReason) => geminiText(JSON.stringify(obj), finishReason);
const geminiErr = (code, status, message, details) => ({ status: code, json: { error: { code, message, status, ...(details ? { details } : {}) } } });
const overloaded = (code = 503, status = 'UNAVAILABLE', message = 'The model is overloaded. Please try again later.') => geminiErr(code, status, message);

const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const logText = (url) => logs[url].join('');

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

before(async () => {
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
      const next = queue.shift() || geminiOk(episode([line('A', `いつもの話その${requests.length}`), line('B', `うん、続けて${requests.length}`)]));
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(next.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(next.json));
      }, next.delay || 0);
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  // 共通のサーバーでは、障害後の待ち時間をほぼ 0 にしておく（待ち時間そのものは専用のテストで確かめる）
  base = await startServer({ GEMINI_API_KEY: 'test-key', UPSTREAM_COOLDOWN_BASE_MS: '1', UPSTREAM_COOLDOWN_MAX_MS: '1', RPM_LIMIT: '1000', IP_RPM_LIMIT: '1000' });
});
after(() => { for (const s of servers) s.kill(); mock?.close(); });

let sessionSeq = 0;
const H = () => ({ 'content-type': 'application/json', 'x-two-minds': '1', 'x-two-minds-session': `test-session-${++sessionSeq}-abcdef` });
const post = async (b, body, headers = H(), p = '/api/episode') => {
  const r = await fetch(b + p, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json(), headers: r.headers };
};

// ---------- 基本 ----------

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

test('per-utterance endpoint is gone', async () => {
  const r = await post(base, { speaker: 'A', log: [] }, H(), '/api/turn');
  assert.equal(r.status, 404);
});

// ---------- 会話記録の生成 ----------

test('episode: one Gemini call returns a whole validated conversation record', async () => {
  requests.length = 0;
  queue.push(geminiOk(episode([line('A', 'お茶、ぬるくなっちゃった', { expression: 'troubled', action: 'sip' }), line('B', 'ほんとだ。なんでぬるいとまずいんだろう', { type: 'question', phase: 'DISCOVERY', expression: 'thinking' }), line('A', '期待とのズレかな', { type: 'hypothesis', phase: 'EXPLORATION', pause: 'short' })])));
  const r = await post(base, {
    gen: 3,
    context: {
      history: [{ summary: '靴下の話をした', question: '靴下はなぜ消える', status: 'resolved', conclusion: '目立つだけ' }],
      topics: ['靴下'],
      backlog: ['洗濯物はなぜからまる'],
      notes: { A: ['ミナは定義にこだわる'], B: ['レオはすぐ例え話にする'] },
      recent: [{ kind: 'say', speaker: 'B', text: '靴下の国はないよ' }],
    },
  });
  assert.equal(r.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(r.json.calls, 1);
  assert.equal(r.json.gen, 3);
  assert.equal(r.json.demo, false);
  const ep = r.json.episode;
  assert.equal(ep.lines.length, 3);
  assert.deepEqual(ep.lines[2], { speaker: 'A', text: '期待とのズレかな', expression: 'neutral', action: 'none', type: 'hypothesis', phase: 'EXPLORATION', pause: 'short' });
  assert.equal(ep.problem.status, 'continuing');
  const req = requests[0];
  assert.match(req.url, /models\/test-model:generateContent/);
  assert.equal(req.headers['x-goog-api-key'], 'test-key');
  assert.equal(req.body.generationConfig.responseMimeType, 'application/json');
  assert.ok(req.body.generationConfig.responseJsonSchema.properties.lines);
  assert.equal(req.body.generationConfig.maxOutputTokens, 8192);
  const sys = JSON.stringify(req.body.systemInstruction);
  assert.match(sys, /レオ/);
  assert.match(sys, /ミナ/);
  const user = req.body.contents[0].parts[0].text;
  assert.match(user, /靴下の話をした/);
  assert.match(user, /靴下の国はないよ/);
  assert.match(user, /レオだけが覚えていること: ミナは定義にこだわる/);
});

test('episode: the observer interrupt is sent with the played lines and current hypotheses', async () => {
  requests.length = 0;
  queue.push(geminiOk(episode([line('B', '観察者さん、それほんと？', { type: 'answer_player' }), line('A', 'じゃあ僕の仮説は外れか', { type: 'concede' })])));
  const r = await post(base, {
    context: { recent: [{ kind: 'say', speaker: 'A', text: '前の話' }] },
    interrupt: { text: '答えは香りだよ', played: [{ kind: 'say', speaker: 'A', text: 'なんでぬるいとまずいの' }], problem: { question: 'ぬるいお茶はなぜまずいか', leo_view: '期待とのズレ', mina_view: '温度', status: 'exploring' } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.episode.lines[0].type, 'answer_player');
  const user = requests[0].body.contents[0].parts[0].text;
  assert.match(user, /観察者: 答えは香りだよ/);
  assert.match(user, /なんでぬるいとまずいの/);
  assert.match(user, /レオの考え: 期待とのズレ/);
});

test('only one generation per tab: a second plain request is refused, an interrupt supersedes the old one', async () => {
  const headers = H();
  const otherTab = H();
  requests.length = 0;
  queue.push({ ...geminiOk(), delay: 1200 });
  const first = post(base, { context: {} }, headers);
  await wait(150);
  const dup = await post(base, { context: {} }, headers);
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'in_progress');
  const parallel = post(base, { context: {} }, otherTab); // 別のタブは影響を受けない
  const interrupted = await post(base, { context: {}, interrupt: { text: 'ちょっといい？' } }, headers);
  assert.equal(interrupted.status, 200);
  const old = await first;
  assert.equal(old.status, 409);
  assert.equal(old.json.error.code, 'superseded');
  assert.equal((await parallel).status, 200);
  await wait(50);
  assert.match(logText(base), /\[gemini\] aborted model=test-model/);
});

test('interrupts are not held back by the minimum interval (counts still apply)', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k', IP_MIN_INTERVAL_MS: '5000' });
  const h = H();
  assert.equal((await post(b, { context: {} }, h)).status, 200);
  const tooFast = await post(b, { context: {} }, h);
  assert.equal(tooFast.json.error.code, 'too_fast');
  assert.equal((await post(b, { context: {}, interrupt: { text: 'ねえ' } }, h)).status, 200);
});

test('truncated output (MAX_TOKENS): complete lines are salvaged without another call', async () => {
  requests.length = 0;
  const full = JSON.stringify(episode([line('A', '一つ目の発言です'), line('B', '二つ目の発言です'), line('A', '三つ目は途中で切れる')]));
  queue.push(geminiText(full.slice(0, full.indexOf('三つ目は途中') + 2), 'MAX_TOKENS'));
  const r = await post(base, { context: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.episode.lines.length, 2);
  assert.equal(r.json.episode.truncated, true);
  assert.equal(requests.length, 1);
  await wait(30);
  assert.match(logText(base), /finishReason=MAX_TOKENS salvagedLines=2/);
});

test('invalid output is rejected as a retryable error and logged', async () => {
  queue.push(geminiText('これはJSONではありません'));
  const r = await post(base, { context: {} });
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'bad_output');
  assert.equal(r.json.error.retryable, true);
  queue.push(geminiOk(episode([line('A', 'ひとつだけ'), { speaker: 'X', text: '' }])));
  const r2 = await post(base, { context: {} });
  assert.equal(r2.json.error.code, 'bad_output');
  await wait(30);
  assert.match(logText(base), /\[gemini\] bad_json/);
  assert.match(logText(base), /\[gemini\] invalid/);
});

test('safety block is reported as a retryable 422', async () => {
  queue.push(geminiOk(episode(), 'SAFETY'));
  const r = await post(base, { context: {} });
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, 'blocked');
});

// ---------- Gemini の一時的な障害 ----------

test('503 from Gemini: reported as Gemini-side, logged with HTTP status / code / message, not retried', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k', UPSTREAM_COOLDOWN_BASE_MS: '400', UPSTREAM_COOLDOWN_MAX_MS: '2000' });
  requests.length = 0;
  queue.push(overloaded());
  const r = await post(b, { context: {} });
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'upstream_unavailable');
  assert.equal(r.json.error.source, 'gemini');
  assert.equal(r.json.error.upstreamStatus, 503);
  assert.match(r.json.error.message, /Gemini.*HTTP 503 UNAVAILABLE/);
  assert.ok(r.json.error.retryAfterMs >= 400);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal(requests.length, 1);
  await wait(50);
  const log = logText(b);
  assert.match(log, /\[gemini\] error model=test-model ms=\d+ http=503 code=UNAVAILABLE message="The model is overloaded\. Please try again later\." mapped=upstream_unavailable/);
  assert.match(log, /\[gemini\] cooldown \d+ms after upstream_unavailable \(consecutive failures: 1\)/);
  assert.doesNotMatch(log, /test-key/);
});

test('after a 503, the server pauses calls to Gemini (shared cooldown), then recovers on success', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k', UPSTREAM_COOLDOWN_BASE_MS: '400', UPSTREAM_COOLDOWN_MAX_MS: '2000' });
  requests.length = 0;
  queue.push(overloaded());
  assert.equal((await post(b, { context: {} })).json.error.code, 'upstream_unavailable');
  const c = await post(b, { context: {} }, { ...H(), 'x-forwarded-for': '203.0.113.9' });
  assert.equal(c.status, 503);
  assert.equal(c.json.error.code, 'upstream_cooldown');
  assert.ok(c.json.error.retryAfterMs > 0 && c.json.error.retryAfterMs <= 600);
  assert.equal(requests.length, 1);
  await wait(c.json.error.retryAfterMs + 50);
  assert.equal((await post(b, { context: {} })).status, 200);
  assert.equal((await post(b, { context: {} })).status, 200);
});

test('consecutive 503s lengthen the cooldown up to a cap', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k', UPSTREAM_COOLDOWN_BASE_MS: '100', UPSTREAM_COOLDOWN_MAX_MS: '350' });
  const waits = [];
  for (let i = 0; i < 4; i++) {
    queue.push(overloaded(i % 2 ? 500 : 503, i % 2 ? 'INTERNAL' : 'UNAVAILABLE', 'error'));
    const r = await post(b, { context: {} });
    assert.equal(r.json.error.code, 'upstream_unavailable');
    waits.push(r.json.error.retryAfterMs);
    await wait(r.json.error.retryAfterMs + 20);
  }
  assert.ok(waits[1] > waits[0] * 1.5, `grows: ${waits}`);
  assert.ok(waits.every((w) => w <= 350), `capped: ${waits}`);
});

test('Gemini 429: daily vs per-minute quota are distinguished; RetryInfo is honored', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k', UPSTREAM_COOLDOWN_BASE_MS: '100', UPSTREAM_COOLDOWN_MAX_MS: '60000' });
  queue.push(geminiErr(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded, quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier'));
  assert.equal((await post(b, { context: {} })).json.error.code, 'upstream_quota');
  queue.push(geminiErr(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded, quotaId: GenerateRequestsPerMinutePerProjectPerModel-FreeTier', [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }]));
  const m = await post(b, { context: {} });
  assert.equal(m.json.error.code, 'upstream_busy');
  assert.ok(m.json.error.retryAfterMs >= 7000);
});

test('timeout to Gemini is reported as such (not as 503)', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k', GEMINI_TIMEOUT_MS: '300', UPSTREAM_COOLDOWN_BASE_MS: '100', UPSTREAM_COOLDOWN_MAX_MS: '200' });
  queue.push({ ...geminiOk(), delay: 1500 });
  const r = await post(b, { context: {} });
  assert.equal(r.status, 504);
  assert.equal(r.json.error.code, 'timeout');
  await wait(50);
  assert.match(logText(b), /\[gemini\] error model=test-model ms=\d+ code=TIMEOUT/);
});

test('network failure to Gemini maps to a retryable error', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k', GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:9' });
  const r = await post(b, { context: {} });
  assert.ok(r.status >= 500);
  assert.equal(r.json.error.retryable, true);
});

test('non-transient Gemini errors (400) do not start a cooldown', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k', UPSTREAM_COOLDOWN_BASE_MS: '5000' });
  queue.push(geminiErr(400, 'INVALID_ARGUMENT', 'bad schema'));
  assert.equal((await post(b, { context: {} })).json.error.code, 'bad_request');
  assert.equal((await post(b, { context: {} })).status, 200);
});

test('optional thinking level is sent when configured', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k', GEMINI_THINKING_LEVEL: 'low' });
  requests.length = 0;
  await post(b, { context: {} });
  assert.deepEqual(requests[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'LOW' });
});

// ---------- 安全機構 ----------

test('requests from other origins or without the app header are refused', async () => {
  const before = requests.length;
  assert.equal((await post(base, { context: {} }, { 'content-type': 'application/json' })).status, 403);
  assert.equal((await post(base, { context: {} }, { ...H(), origin: 'https://evil.example' })).status, 403);
  assert.equal(requests.length, before);
});

test('demo mode never calls the API and returns a scripted episode', async () => {
  const before = requests.length;
  const r = await post(base, { mode: 'demo', context: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.demo, true);
  assert.ok(r.json.episode.lines.length >= 2);
  const i = await post(base, { mode: 'demo', context: {}, interrupt: { text: 'やあ' } });
  assert.match(i.json.episode.lines[0].text, /やあ/);
  assert.equal(requests.length, before);
});

test('rejects oversized and malformed bodies', async () => {
  const r = await fetch(base + '/api/episode', { method: 'POST', headers: H(), body: '{oops' });
  assert.equal(r.status, 400);
  const big = await fetch(base + '/api/episode', { method: 'POST', headers: H(), body: 'x'.repeat(128 * 1024) }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
});

test('daily cap stops API calls once reached', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'test-key', DAILY_CALL_LIMIT: '2' });
  requests.length = 0;
  assert.equal((await post(b, { context: {} })).status, 200);
  assert.equal((await post(b, { context: {} })).status, 200);
  const r = await post(b, { context: {} });
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, 'daily_limit');
  assert.equal(requests.length, 2);
  assert.equal((await (await fetch(b + '/api/status')).json()).reason, 'daily_limit');
});

test('without a key (or with AI disabled) only demo works', async () => {
  const b = await startServer({ GEMINI_API_KEY: '', GOOGLE_API_KEY: '' });
  const s = await (await fetch(b + '/api/status')).json();
  assert.equal(s.ai, false);
  assert.equal(s.reason, 'no_key');
  assert.equal((await post(b, { context: {} })).json.error.code, 'no_key');
  assert.equal((await post(b, { mode: 'demo', context: {} })).status, 200);
  const d = await startServer({ GEMINI_API_KEY: 'k', AI_ENABLED: 'false' });
  assert.equal((await (await fetch(d + '/api/status')).json()).reason, 'disabled');
});
