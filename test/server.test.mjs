// サーバーを実際に起動し、Anthropic API の代わりにモックサーバーへ接続して動作を確認する。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requests = [];
const queue = [];
let mock, server, base;

function messageResponse(obj, { stop_reason = 'end_turn' } = {}) {
  return {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
    content: stop_reason === 'refusal' ? [] : [{ type: 'text', text: JSON.stringify(obj) }],
    stop_reason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 },
  };
}
const turn = (utterance, extra = {}) => ({ utterance, inner: '…', intent: 'develop', topic: '雨', feeling: { trust: 1, closeness: 1, understanding: 0, agreement: 0 }, addressed_player: false, ...extra });

const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

before(async () => {
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
      const next = queue.shift() || { status: 200, json: messageResponse(turn('デフォルトの応答です')) };
      res.writeHead(next.status, { 'content-type': 'application/json', 'x-should-retry': 'false' });
      res.end(JSON.stringify(next.json));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.address().port}`, ANTHROPIC_MODEL: 'claude-opus-5-5' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('TWO MINDS') && resolve());
    server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
});
after(() => { server?.kill(); mock?.close(); });

const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
const chars = { A: { name: 'レオ', personality: '論理的' }, B: { name: 'ミナ', personality: '感覚的' } };

test('status reports configuration without leaking the key', async () => {
  const r = await fetch(base + '/api/status');
  const j = await r.json();
  assert.equal(j.configured, true);
  assert.equal(j.model, 'claude-opus-5-5');
  assert.ok(!JSON.stringify(j).includes('test-key'));
});

test('serves the game page and blocks path traversal', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /TWO&nbsp;MINDS/);
  const t = await fetch(base + '/..%2F.env.example');
  assert.notEqual(t.status, 200);
});

test('turn: sends structured-output request with fallbacks and returns utterance', async () => {
  requests.length = 0;
  queue.push({ status: 200, json: messageResponse(turn('雨の音って、なぜ落ち着くんだろう。')) });
  const r = await post('/api/turn', { speaker: 'A', characters: chars, log: [{ id: '1', kind: 'say', speaker: 'B', text: '雨だねえ', topic: '雨' }], memory: {}, relationship: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.text, '雨の音って、なぜ落ち着くんだろう。');
  assert.equal(r.json.demo, false);
  const req = requests[0];
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.equal(req.body.output_config.format.type, 'json_schema');
  assert.equal(req.body.output_config.effort, 'low');
  assert.equal(req.body.fallbacks, 'default');
  assert.match(req.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.match(req.body.system, /あなたは「レオ」/);
  assert.match(req.body.messages[0].content, /雨だねえ/);
  assert.equal(req.body.thinking, undefined);
});

test('turn: duplicate utterance triggers exactly one regeneration', async () => {
  requests.length = 0;
  queue.push({ status: 200, json: messageResponse(turn('雨だねえ')) });
  queue.push({ status: 200, json: messageResponse(turn('パン屋さんの匂いがしてきた。')) });
  const r = await post('/api/turn', { speaker: 'B', characters: chars, log: [{ id: '1', kind: 'say', speaker: 'B', text: '雨だねえ' }], memory: {}, relationship: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.text, 'パン屋さんの匂いがしてきた。');
  assert.equal(requests.length, 2);
  assert.match(requests[1].body.messages[0].content, /重複/);
});

test('turn: refusal is reported as a retryable 422', async () => {
  queue.push({ status: 200, json: messageResponse({}, { stop_reason: 'refusal' }) });
  const r = await post('/api/turn', { speaker: 'A', characters: chars, log: [], memory: {}, relationship: {} });
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, 'refusal');
  assert.equal(r.json.error.retryable, true);
});

test('turn: invalid key maps to a clear auth error', async () => {
  queue.push({ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
  const r = await post('/api/turn', { speaker: 'A', characters: chars, log: [], memory: {}, relationship: {} });
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'auth');
  assert.equal(r.json.error.retryable, false);
});

test('memory: extracts facts, episode and impressions', async () => {
  queue.push({ status: 200, json: messageResponse({ new_facts: [{ about: 'B', category: 'like', text: 'ミナは雨の音が好き', importance: 4 }], resolved_ids: [], episode: { title: '雨の日', summary: '雨の音について話した', topics: ['雨'] }, impressions: { A: '感覚で話す人', B: '理屈っぽい人' } }) });
  const r = await post('/api/memory', { characters: chars, entries: [{ id: '1', kind: 'say', speaker: 'B', text: '雨の音、好きなんだ' }], memory: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.newFacts[0].text, 'ミナは雨の音が好き');
  assert.equal(r.json.episode.title, '雨の日');
  assert.equal(r.json.impressions.B, '理屈っぽい人');
  assert.equal(requests.at(-1).body.output_config.effort, 'medium');
});

test('demo mode never calls the API', async () => {
  const before = requests.length;
  const r = await post('/api/turn', { mode: 'demo', speaker: 'A', characters: chars, log: [], memory: {}, relationship: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.demo, true);
  assert.ok(r.json.text.length > 0);
  assert.equal(requests.length, before);
});

test('rejects oversized and malformed bodies', async () => {
  const r = await fetch(base + '/api/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(r.status, 400);
  const big = await fetch(base + '/api/turn', { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024) }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
});
