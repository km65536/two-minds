import test from 'node:test';
import assert from 'node:assert/strict';
import { Limiter, pacificDay, limitsFromEnv, UpstreamGate, isUpstreamTransient } from '../server/limits.mjs';
import { describeUpstream, toAIError } from '../server/ai.mjs';
import { ApiError } from '@google/genai';

const opts = { dailyLimit: 5, rpmLimit: 3, ipDailyLimit: 4, ipRpmLimit: 2, ipMinIntervalMs: 1000, maxConcurrent: 1 };
const clockAt = (t) => { const c = () => c.t; c.t = t; return c; };

test('per-minute limits (global and per IP)', () => {
  const clock = clockAt(Date.UTC(2026, 0, 1, 20));
  const l = new Limiter(opts, clock);
  l.take('1.1.1.1');
  l.take('1.1.1.1');
  assert.throws(() => l.take('1.1.1.1'), (e) => e.code === 'busy');
  l.take('2.2.2.2');
  assert.throws(() => l.take('3.3.3.3'), (e) => e.code === 'busy'); // 全体 3/分
  clock.t += 61_000;
  l.take('3.3.3.3');
});

test('daily limits reset at Pacific midnight', () => {
  const clock = clockAt(Date.UTC(2026, 0, 1, 20));
  const l = new Limiter({ ...opts, rpmLimit: 100, ipRpmLimit: 100 }, clock);
  for (let i = 0; i < 4; i++) l.take('1.1.1.1');
  assert.throws(() => l.take('1.1.1.1'), (e) => e.code === 'daily_limit'); // IP 4/日
  l.take('2.2.2.2');
  assert.throws(() => l.take('3.3.3.3'), (e) => e.code === 'daily_limit'); // 全体 5/日
  assert.ok(l.dailyExhausted());
  clock.t = Date.UTC(2026, 0, 2, 9); // 太平洋時間で翌日 1 時
  assert.notEqual(pacificDay(clock.t), pacificDay(Date.UTC(2026, 0, 1, 20)));
  assert.ok(!l.dailyExhausted());
  l.take('3.3.3.3');
});

test('minimum interval and concurrency', () => {
  const clock = clockAt(Date.UTC(2026, 0, 1, 20));
  const l = new Limiter(opts, clock);
  const end = l.begin('1.1.1.1');
  assert.throws(() => l.begin('2.2.2.2'), (e) => e.code === 'busy'); // 同時 1
  l.take('1.1.1.1');
  end();
  end(); // 二重解放しても壊れない
  assert.throws(() => l.begin('1.1.1.1'), (e) => e.code === 'too_fast');
  clock.t += 1500;
  l.begin('1.1.1.1')();
});

test('env parsing falls back to safe defaults', () => {
  const o = limitsFromEnv({ DAILY_CALL_LIMIT: 'abc', RPM_LIMIT: '-5', IP_DAILY_LIMIT: '50' });
  assert.equal(o.dailyLimit, 300);
  assert.equal(o.rpmLimit, 10);
  assert.equal(o.ipDailyLimit, 50);
});

test('UpstreamGate: exponential cooldown with cap, hint respected, reset on success', () => {
  const clock = clockAt(0);
  const g = new UpstreamGate({ baseMs: 1000, maxMs: 5000 }, clock, () => 0);
  g.check();
  assert.equal(g.onFailure('HTTP 503'), 1000);
  assert.throws(() => g.check(), (e) => e.code === 'upstream_cooldown' && e.retryAfterMs === 1000 && e.source === 'gemini');
  clock.t = 1000;
  g.check();
  assert.equal(g.onFailure('HTTP 503'), 2000);
  assert.equal(g.onFailure('HTTP 503'), 4000);
  assert.equal(g.onFailure('HTTP 503'), 5000); // 上限
  assert.equal(g.onFailure('HTTP 429', 9000), 5000); // ヒントがあっても上限を超えない
  g.onSuccess();
  g.check();
  assert.equal(g.onFailure('HTTP 503', 3000), 3000); // ヒントの方が長ければそれに従う
});

test('describeUpstream parses Gemini error bodies; toAIError classifies by HTTP status', () => {
  const body = { error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded. Please try again later.' } };
  const e503 = new ApiError({ status: 503, message: JSON.stringify(body) });
  assert.deepEqual(describeUpstream(e503), { httpStatus: 503, code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded. Please try again later.', retryAfterMs: 0 });
  const m = toAIError(e503);
  assert.equal(m.code, 'upstream_unavailable');
  assert.equal(m.source, 'gemini');
  assert.ok(isUpstreamTransient(m));
  for (const st of [500, 502, 504]) assert.equal(toAIError(new ApiError({ status: st, message: '{}' })).code, 'upstream_unavailable');
  const plain = describeUpstream(new ApiError({ status: 502, message: '<html>Bad Gateway</html>' }));
  assert.equal(plain.message, '<html>Bad Gateway</html>');
  const timeout = toAIError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
  assert.equal(timeout.code, 'timeout');
  assert.ok(isUpstreamTransient(timeout));
  assert.ok(!isUpstreamTransient(toAIError(new ApiError({ status: 400, message: '{}' }))));
});
