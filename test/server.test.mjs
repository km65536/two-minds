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

// Gemini が返す平らな形（簡略化したスキーマどおり）
const line = (speaker, text, extra = {}) => ({ speaker, text, expression: 'neutral', action: 'none', tag: 'FREE chat none', ...extra });
// Gemini が返す「続きの数発言＋会話の状態」（簡略化したスキーマどおりの平らな形）
const episode = (lines = [line('A', 'お茶、ぬるくなっちゃった'), line('B', 'ほんとだ。なんでぬるいとまずいんだろう', { tag: 'DISCOVERY discovery' }), line('A', '期待とのズレかな', { tag: 'EXPLORATION hypothesis' })], extra = {}) => ({
  lines,
  topic: 'お茶',
  summary: 'ぬるいお茶の話',
  question: 'ぬるいお茶はなぜまずいか',
  kind: '科学',
  status: 'exploring',
  leo_view: '期待とのズレ',
  mina_view: '香り',
  explored: '',
  known: '',
  open_points: '温度と香りの関係',
  next_focus: '香りを確かめる',
  deferred: '',
  mood: 'のんびり',
  boundary: 'no',
  note_leo: '',
  note_mina: '',
  ...extra,
});
const geminiText = (text, finishReason = 'STOP') => ({ status: 200, json: { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason, index: 0 }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 400 } } });
const geminiOk = (obj = episode(), finishReason) => geminiText(JSON.stringify(obj), finishReason);
const geminiErr = (code, status, message, details) => ({ status: code, json: { error: { code, message, status, ...(details ? { details } : {}) } } });
const schemaTooComplex = () => geminiErr(400, 'INVALID_ARGUMENT', 'The specified schema produces a constraint that has too many states for serving.  Typical causes of this error are schemas with lots of text (for example, very long property or enum names), schemas with long array length limits (especially when nested), or schemas using complex value matchers (for example, integers or numbers with minimum/maximum bounds or strings with complex formats like date-time)');
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
      let next = queue.shift() || geminiOk(episode([line('A', `いつもの話その${requests.length}`), line('B', `うん、続けて${requests.length}`)]));
      // 模擬：スキーマの複雑さを判定する（本物の Gemini の判定ではない）
      if (next.checkSchema) next = next.checkSchema(requests.at(-1).body.generationConfig?.responseJsonSchema) ? schemaTooComplex() : geminiOk(next.episode);
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
const post = async (b, body, headers = H(), p = '/api/chunk') => {
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

test('per-utterance and whole-episode endpoints are gone', async () => {
  assert.equal((await post(base, { speaker: 'A', log: [] }, H(), '/api/turn')).status, 404);
  assert.equal((await post(base, { context: {} }, H(), '/api/episode')).status, 404);
});

// ---------- 会話記録の生成 ----------

test('one Gemini call returns several lines (standard 3) plus the updated conversation state', async () => {
  requests.length = 0;
  queue.push(geminiOk(episode([line('A', 'お茶、ぬるくなっちゃった', { expression: 'troubled', action: 'sip' }), line('B', 'ほんとだ。なんでぬるいとまずいんだろう', { tag: 'DISCOVERY discovery', expression: 'thinking' }), line('A', '期待とのズレかな', { tag: 'EXPLORATION hypothesis short' })])));
  const r = await post(base, {
    gen: 3,
    rid: 17,
    context: {
      state: { topic: '靴下', summary: '靴下の話をした', question: '', status: 'none', phase: 'AFTERMATH', free_run: 1 },
      topics: ['靴下'],
      backlog: ['洗濯物はなぜからまる'],
      notes: { A: ['ミナは定義にこだわる'], B: ['レオはすぐ例え話にする'] },
      recent: [{ kind: 'say', speaker: 'B', text: '靴下の国はないよ' }],
    },
  });
  assert.equal(r.status, 200);
  assert.equal(requests.length, 1);
  assert.deepEqual([r.json.calls, r.json.gen, r.json.rid, r.json.demo], [1, 3, 17, false]); // リクエスト番号と世代をそのまま返す
  const c = r.json.chunk;
  assert.equal(c.lines.length, 3);
  assert.deepEqual(c.lines[2], { speaker: 'A', text: '期待とのズレかな', expression: 'neutral', action: 'none', type: 'hypothesis', phase: 'EXPLORATION', pause: 'short' });
  assert.equal(c.state.question, 'ぬるいお茶はなぜまずいか');
  assert.equal(c.state.status, 'exploring');
  assert.deepEqual([c.state.leo_view, c.state.mina_view], ['期待とのズレ', '香り']);
  assert.deepEqual(c.state.open_points, ['温度と香りの関係']);
  assert.equal(c.state.next_focus, '香りを確かめる');
  assert.equal(c.state.age, 1);
  assert.equal(c.boundary, false);
  const req = requests[0];
  assert.match(req.url, /models\/test-model:generateContent/);
  assert.equal(req.headers['x-goog-api-key'], 'test-key');
  assert.equal(req.body.generationConfig.responseMimeType, 'application/json');
  const schema = req.body.generationConfig.responseJsonSchema;
  assert.ok(schema.properties.lines && schema.properties.next_focus);
  assert.doesNotMatch(JSON.stringify(schema), /"enum"|"maxItems"|"minItems"/); // 受け付けられた簡潔なスキーマのまま
  assert.equal(req.body.generationConfig.maxOutputTokens, 4096);
  const sys = JSON.stringify(req.body.systemInstruction);
  assert.match(sys, /レオ/);
  assert.match(sys, /ミナ/);
  const user = req.body.contents[0].parts[0].text;
  assert.match(user, /ここまでの流れ: 靴下の話をした/);
  assert.match(user, /ミナ: 靴下の国はないよ/);
  assert.match(user, /洗濯物はなぜからまる/);
  assert.match(user, /レオだけが覚えていること: ミナは定義にこだわる/);
  assert.match(user, /原則 3 つ（2〜5 つ）/);
});

test('the observer interrupt is answered first, with the current problem and both opinions kept', async () => {
  requests.length = 0;
  queue.push(geminiOk(episode([line('B', '観察者さん、それほんと？', { tag: 'EXPLORATION answer_player' }), line('A', 'じゃあ僕の仮説は外れか', { tag: 'EXPLORATION concede' })])));
  const r = await post(base, {
    context: {
      state: { question: 'ぬるいお茶はなぜまずいか', status: 'exploring', leo_view: '期待とのズレ', mina_view: '温度', phase: 'EXPLORATION' },
      recent: [{ kind: 'say', speaker: 'A', text: 'なんでぬるいとまずいの' }, { kind: 'player', text: '答えは香りだよ' }],
    },
    interrupt: { text: '答えは香りだよ' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.chunk.lines[0].type, 'answer_player');
  const user = requests[0].body.contents[0].parts[0].text;
  assert.match(user, /観察者がたった今「答えは香りだよ」と話しかけてきた/);
  assert.match(user, /観察者: 答えは香りだよ/);
  assert.match(user, /なんでぬるいとまずいの/);
  assert.match(user, /レオの今の考え: 期待とのズレ/);
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
  const full = JSON.stringify(episode([line('A', '一つ目の発言です'), line('B', '二つ目の発言です'), line('A', '三つ目は途中で切れる')]));  // 発言が先、状態が後
  queue.push(geminiText(full.slice(0, full.indexOf('三つ目は途中') + 2), 'MAX_TOKENS'));
  const r = await post(base, { context: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.chunk.lines.length, 2);
  assert.equal(r.json.chunk.truncated, true);
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
  queue.push(geminiOk(episode([{ speaker: 'X', text: '' }, line('Z', '誰？'), line('A', '')])));
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

// ---------- 簡略化したスキーマ・出力形式の拒否 ----------

/**
 * 模擬の判定（本物の Gemini ではない）：Gemini の 400「too many states」の説明にある原因
 * （enum、配列の長さの制約、入れ子）を含むスキーマを拒否する。
 */
function tooComplex(schema) {
  if (!schema) return false;
  const json = JSON.stringify(schema);
  const enums = (json.match(/"enum"/g) || []).length;
  const limits = (json.match(/"(minItems|maxItems|minLength|maxLength|minimum|maximum|pattern|format)"/g) || []).length;
  const objects = (json.match(/"type":"object"/g) || []).length;
  return enums > 0 || limits > 0 || objects > 3;
}

const OLD_COMPLEX_SCHEMA = {
  type: 'object',
  properties: {
    problem: { type: 'object', properties: { kind: { type: 'string', enum: ['none', 'science'] }, status: { type: 'string', enum: ['none', 'resolved'] } } },
    lines: { type: 'array', maxItems: 36, items: { type: 'object', properties: { speaker: { type: 'string', enum: ['A', 'B'] }, phase: { type: 'string', enum: ['FREE', 'DISCOVERY'] } } } },
  },
};

test('[mock] the simplified schema passes a complexity check that the previous schema fails (not the real Gemini)', async () => {
  assert.equal(tooComplex(OLD_COMPLEX_SCHEMA), true);
  requests.length = 0;
  queue.push({ checkSchema: tooComplex, episode: episode() });
  const r = await post(base, { context: {} });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(tooComplex(requests[0].body.generationConfig.responseJsonSchema), false);
});

test('schema rejected (400 too many states): clear non-retryable error, and Gemini is not called again', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k' });
  requests.length = 0;
  queue.push(schemaTooComplex());
  const r = await post(b, { context: {} });
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'schema_rejected');
  assert.equal(r.json.error.retryable, false);
  assert.equal(r.json.error.source, 'gemini');
  assert.match(r.json.error.message, /出力形式.*HTTP 400 INVALID_ARGUMENT/);
  assert.equal(r.headers.get('retry-after'), null);
  // 同じリクエストは繰り返さない：別のタブからでも Gemini を呼ばずに同じエラーを返す
  const again = await post(b, { context: {} });
  assert.equal(again.json.error.code, 'schema_rejected');
  assert.equal(requests.length, 1);
  assert.equal((await (await fetch(b + '/api/status')).json()).reason, 'schema_rejected');
  await wait(50);
  const log = logText(b);
  assert.match(log, /\[gemini\] error .*http=400 code=INVALID_ARGUMENT message="The specified schema produces a constraint that has too many states/);
  assert.match(log, /\[gemini\] schema rejected/);
  assert.doesNotMatch(log, /cooldown/); // 一時的な障害としては扱わない
});

test('other 400 errors are not retried either, but do not block later requests', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k' });
  requests.length = 0;
  queue.push(geminiErr(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.'));
  const r = await post(b, { context: {} });
  assert.equal(r.json.error.code, 'bad_request');
  assert.equal(r.json.error.retryable, false);
  assert.equal(requests.length, 1);
  assert.equal((await post(b, { context: {} })).status, 200);
});

test('GEMINI_SCHEMA_MODE=json sends no schema (JSON output only) and still validates the result', async () => {
  const b = await startServer({ GEMINI_API_KEY: 'k', GEMINI_SCHEMA_MODE: 'json' });
  requests.length = 0;
  queue.push(geminiOk(episode([line('A', '一つ目の発言だよ'), line('B', '二つ目の発言だね', { expression: '笑顔', tag: 'AFTERMATH joke' })])));
  const r = await post(b, { context: {} });
  assert.equal(r.status, 200);
  assert.equal(requests[0].body.generationConfig.responseMimeType, 'application/json');
  assert.equal(requests[0].body.generationConfig.responseJsonSchema, undefined);
  assert.deepEqual([r.json.chunk.lines[1].expression, r.json.chunk.lines[1].phase, r.json.chunk.lines[1].type], ['smile', 'AFTERMATH', 'joke']);
});

// ---------- 安全機構 ----------

test('requests from other origins or without the app header are refused', async () => {
  const before = requests.length;
  assert.equal((await post(base, { context: {} }, { 'content-type': 'application/json' })).status, 403);
  assert.equal((await post(base, { context: {} }, { ...H(), origin: 'https://evil.example' })).status, 403);
  assert.equal(requests.length, before);
});

test('demo mode never calls the API and returns a scripted chunk', async () => {
  const before = requests.length;
  const r = await post(base, { mode: 'demo', context: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.demo, true);
  assert.ok(r.json.chunk.lines.length >= 1 && r.json.chunk.lines.length <= 3);
  const i = await post(base, { mode: 'demo', context: {}, interrupt: { text: 'やあ' } });
  assert.match(i.json.chunk.lines[0].text, /やあ/);
  assert.equal(requests.length, before);
});

test('rejects oversized and malformed bodies', async () => {
  const r = await fetch(base + '/api/chunk', { method: 'POST', headers: H(), body: '{oops' });
  assert.equal(r.status, 400);
  const big = await fetch(base + '/api/chunk', { method: 'POST', headers: H(), body: 'x'.repeat(128 * 1024) }).catch(() => ({ status: 413 }));
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
