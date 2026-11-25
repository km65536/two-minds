import test from 'node:test';
import assert from 'node:assert/strict';
import { Limiter, pacificDay, limitsFromEnv } from '../server/limits.mjs';

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
