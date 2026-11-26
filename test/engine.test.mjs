// 再生キューと通信の制御（public/engine.js）のテスト。画面と通信の代わりに偽物を渡して動きを確かめる（モック）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationEngine } from '../public/engine.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await tick(2);
  }
}

/** 偽の画面・通信。リクエストは手動で応答させる */
function harness(opts = {}) {
  const log = { requests: [], played: [], cut: [], status: [], waits: [], stops: [], notices: [], maxInflight: 0, saves: 0 };
  let inflight = 0;
  let engine;
  const io = {
    request(body, signal) {
      return new Promise((resolve, reject) => {
        const r = { body, signal, resolve: (v) => { inflight--; resolve(v); }, reject: (e) => { inflight--; reject(e); }, at: Date.now(), playingWhenSent: !!engine.current, linesPlayedWhenSent: log.played.length };
        inflight++;
        log.maxInflight = Math.max(log.maxInflight, inflight);
        log.requests.push(r);
        signal?.addEventListener('abort', () => {
          r.aborted = true;
        });
      });
    },
    async play(line, g, onProgress) {
      onProgress(line.text.slice(0, Math.ceil(line.text.length / 2)));
      const ok = await engine.sleep(opts.playMs ?? 15, g);
      if (!ok) {
        log.cut.push(line.text);
        return false;
      }
      log.played.push(line.text);
      return true;
    },
    setStatus: (s) => log.status.push(s),
    showWait: (t) => log.waits.push(t),
    clearWait: () => {},
    notice: (t) => log.notices.push(t),
    switchToDemo: (t) => log.notices.push(t),
    onStop: (t, o) => log.stops.push({ t, ...o }),
    onIdle: () => {},
    save: () => log.saves++,
    paceWait: () => 0,
    notePace: () => {},
  };
  engine = new ConversationEngine(io, { gap: () => 1, backoff: [20, 40, 60, 80], jitter: 0, badOutputDelay: 20, ...opts.engine });
  return { engine, log };
}

const line = (speaker, text, extra = {}) => ({ speaker, text, expression: 'neutral', action: 'none', type: 'chat', phase: 'FREE', pause: 'none', ...extra });
const state = (extra = {}) => ({ topic: 't', summary: 's', question: '', status: 'none', leo_view: '', mina_view: '', explored: [], known: [], open_points: [], next_focus: '', mood: '', phase: 'FREE', age: 0, free_run: 0, cursor: '', ...extra });
const respond = (req, texts, extra = {}) => req.resolve({ chunk: { lines: texts.map((t, i) => line(i % 2 ? 'B' : 'A', t)), state: state(extra.state), deferred: [], notes: {}, boundary: false }, gen: req.body.gen, rid: req.body.rid, demo: false, calls: 1 });
const fail = (req, code, extra = {}) => req.reject(Object.assign(new Error(extra.message || code), { code, ...extra }));

// ---------- 通信 ----------

test('first request returns several lines at once (standard 3) and they play in order', async () => {
  const { engine, log } = harness();
  engine.start();
  await until(() => log.requests.length === 1);
  assert.equal(log.requests[0].playingWhenSent, false);
  respond(log.requests[0], ['1-1', '1-2', '1-3']);
  await until(() => log.played.length === 3);
  assert.deepEqual(log.played, ['1-1', '1-2', '1-3']);
});

test('the next chunk is requested in the background as soon as playback starts, and only once', async () => {
  const { engine, log } = harness({ playMs: 30 });
  engine.start();
  await until(() => log.requests.length === 1);
  respond(log.requests[0], ['1-1', '1-2', '1-3']);
  await until(() => log.requests.length === 2);
  assert.equal(log.requests[1].playingWhenSent, true); // 再生中に先読み
  assert.equal(log.requests[1].linesPlayedWhenSent, 0); // 1 発言目の再生と同時
  // 先読みの文脈には、再生中の記録の発言と、その後の状態が入る（同じ内容を作り直さない）
  assert.deepEqual(log.requests[1].body.context.recent.map((e) => e.text), ['1-1', '1-2', '1-3']);
  await until(() => log.played.length === 3);
  assert.equal(log.requests.length, 2); // 生成済みの記録を重ねて要求しない
  engine.pause();
});

test('a received chunk is queued and played right after the current one, without duplicates', async () => {
  const { engine, log } = harness({ playMs: 20 });
  engine.start();
  await until(() => log.requests.length === 1);
  respond(log.requests[0], ['1-1', '1-2', '1-3']);
  await until(() => log.requests.length === 2);
  respond(log.requests[1], ['2-1', '2-2', '2-3']);
  await until(() => engine.next !== null || log.played.length >= 3);
  assert.ok(engine.next || log.played.length >= 3); // 受信した記録はキューに入る
  await until(() => log.requests.length === 3); // 2 つ目の再生開始で 3 つ目を先読み
  respond(log.requests[2], ['3-1', '3-2']);
  await until(() => log.played.length === 8);
  assert.deepEqual(log.played, ['1-1', '1-2', '1-3', '2-1', '2-2', '2-3', '3-1', '3-2']);
  assert.equal(new Set(log.played).size, log.played.length);
  assert.equal(log.maxInflight, 1); // 同時に複数の生成リクエストを出さない
  engine.pause();
});

test('variable chunk sizes (2..5) are handled', async () => {
  const { engine, log } = harness({ playMs: 3 });
  engine.start();
  const sizes = [2, 5, 4, 3];
  let n = 0;
  for (const size of sizes) {
    await until(() => log.requests.length === n + 1);
    respond(log.requests[n], Array.from({ length: size }, (_, i) => `${n}-${i}`));
    n++;
  }
  await until(() => log.played.length === 14);
  assert.deepEqual(log.played.slice(0, 7), ['0-0', '0-1', '1-0', '1-1', '1-2', '1-3', '1-4']);
  engine.pause();
});

test('if the next chunk has not arrived, the current one plays to the end and then waits ("thinking")', async () => {
  const { engine, log } = harness({ playMs: 5 });
  engine.start();
  await until(() => log.requests.length === 1);
  respond(log.requests[0], ['1-1', '1-2', '1-3']);
  await until(() => log.played.length === 3);
  await tick(30);
  assert.equal(log.played.length, 3);
  assert.equal(log.status.at(-1), 'thinking');
  assert.equal(log.requests.length, 2); // 待っている間も、要求は 1 件だけ
  respond(log.requests[1], ['2-1', '2-2', '2-3']);
  await until(() => log.played.length === 6);
  engine.pause();
});

test('a stale or mismatched response is ignored', async () => {
  const { engine, log } = harness();
  engine.start();
  await until(() => log.requests.length === 1);
  const req = log.requests[0];
  req.resolve({ chunk: { lines: [line('A', 'wrong')], state: state() }, gen: req.body.gen, rid: req.body.rid + 99 });
  await until(() => log.requests.length === 2, 3000); // 不正な応答として、少し待って要求し直す
  assert.deepEqual(log.played, []);
  engine.pause();
});

test('pausing stops new requests; resuming continues where it left off', async () => {
  const { engine, log } = harness({ playMs: 10 });
  engine.start();
  await until(() => log.requests.length === 1);
  respond(log.requests[0], ['1-1', '1-2', '1-3']);
  await until(() => log.played.length === 1);
  engine.pause();
  respond(log.requests[1], ['2-1', '2-2', '2-3']); // 一時停止中に届いた先読みは保存される
  await tick(60);
  const played = log.played.length;
  assert.ok(played <= 2);
  assert.equal(log.requests.length, 2);
  engine.start();
  await until(() => log.played.length === 6);
  assert.deepEqual(log.played, ['1-1', '1-2', '1-3', '2-1', '2-2', '2-3']);
  engine.pause();
});

test('snapshot / restore resumes from the same line (sessionStorage)', async () => {
  const a = harness({ playMs: 10 });
  a.engine.start();
  await until(() => a.log.requests.length === 1);
  respond(a.log.requests[0], ['1-1', '1-2', '1-3']);
  await until(() => a.log.played.length === 1);
  a.engine.pause();
  await tick(20);
  const snap = JSON.parse(JSON.stringify(a.engine.snapshot()));
  const b = harness({ playMs: 5 });
  assert.ok(b.engine.restore(snap));
  b.engine.start();
  await until(() => b.log.played.length >= 1);
  assert.notEqual(b.log.played[0], '1-1');
  assert.deepEqual(b.engine.ctx.recent.map((e) => e.text).slice(0, a.log.played.length), a.log.played);
  b.engine.pause();
});

// ---------- 観察者の割り込み ----------

test('interrupt: playback stops at once, unplayed lines and the prefetch are discarded, the old response never mixes in', async () => {
  const { engine, log } = harness({ playMs: 40 });
  engine.start();
  await until(() => log.requests.length === 1);
  respond(log.requests[0], ['1-1 服ってなんでくっつくんだろう', '1-2 洗剤のせいじゃないかな、たぶん', '1-3 それは違うと思う'], { state: { question: 'Q', status: 'exploring', leo_view: 'L1', mina_view: 'M1', phase: 'EXPLORATION' } });
  await until(() => log.requests.length === 2); // 先読み中
  await until(() => log.played.length === 1);
  await tick(10); // 2 発言目を話している途中
  const prefetch = log.requests[1];
  engine.interrupt('答えは静電気だよ');
  await tick(5);
  assert.deepEqual(log.cut, ['1-2 洗剤のせいじゃないかな、たぶん']); // 再生がすぐ止まる
  assert.equal(prefetch.aborted, true); // 生成中のリクエストを取り消す
  assert.equal(engine.next, null);
  // 古い応答が後から届いても使わない
  respond(prefetch, ['OLD-1', 'OLD-2', 'OLD-3']);
  await until(() => log.requests.length === 3);
  const ir = log.requests[2];
  assert.equal(ir.body.interrupt.text, '答えは静電気だよ');
  const recent = ir.body.context.recent.map((e) => e.text);
  assert.deepEqual(recent.slice(0, 1), ['1-1 服ってなんでくっつくんだろう']); // 再生済みの発言は残る
  assert.match(recent[1], /^1-2 .*…$/); // 話している途中の発言は、聞こえた分だけ
  assert.notEqual(recent[1], '1-2 洗剤のせいじゃないかな、たぶん…');
  assert.equal(recent.at(-1), '答えは静電気だよ');
  assert.ok(!recent.some((t) => t.startsWith('1-3'))); // 未再生の発言は捨てる
  assert.equal(ir.body.context.state, null); // 記録の途中なので、その記録より前の状態（結論は含めない）
  respond(ir, ['R-1', 'R-2', 'R-3']);
  await until(() => log.played.includes('R-3'));
  assert.ok(!log.played.some((t) => t.startsWith('OLD')));
  assert.ok(!log.played.some((t) => t.startsWith('1-3')));
  engine.pause();
});

test('interrupt keeps the problem and both opinions from the last completed chunk', async () => {
  const { engine, log } = harness({ playMs: 5 });
  engine.start();
  await until(() => log.requests.length === 1);
  respond(log.requests[0], ['1-1', '1-2'], { state: { question: '服はなぜくっつく', status: 'exploring', leo_view: '仲良し', mina_view: '洗剤', phase: 'EXPLORATION' } });
  await until(() => log.played.length === 2);
  await until(() => engine.current === null);
  engine.interrupt('静電気だよ');
  await until(() => log.requests.length === 3);
  const st = log.requests[2].body.context.state;
  assert.equal(st.question, '服はなぜくっつく');
  assert.equal(st.leo_view, '仲良し');
  assert.equal(st.mina_view, '洗剤');
  engine.pause();
});

test('interrupt while paused resumes; two quick messages are sent together in one request', async () => {
  const { engine, log } = harness({ playMs: 5 });
  engine.interrupt('こんにちは');
  engine.interrupt('聞こえる？');
  await until(() => log.requests.length >= 1);
  await tick(10);
  const last = log.requests.at(-1);
  assert.equal(last.body.interrupt.text, 'こんにちは / 聞こえる？');
  assert.equal(log.requests.filter((r) => !r.signal.aborted).length, 1); // 先に送った分は取り消し、有効なのは 1 件だけ
  respond(last, ['R-1', 'R-2']);
  await until(() => log.played.length === 2);
  assert.equal(engine.running, true);
  engine.pause();
});

// ---------- エラー ----------

test('a 503 during prefetch does not break the chunk being played; Retry-After is respected; it recovers', async () => {
  const { engine, log } = harness({ playMs: 10 });
  engine.start();
  await until(() => log.requests.length === 1);
  respond(log.requests[0], ['1-1', '1-2', '1-3']);
  await until(() => log.requests.length === 2);
  const failedAt = Date.now();
  fail(log.requests[1], 'upstream_unavailable', { message: 'Gemini 503', retryAfterMs: 150 });
  await until(() => log.played.length === 3);
  assert.deepEqual(log.played, ['1-1', '1-2', '1-3']); // 再生中の記録は最後まで
  await until(() => log.status.at(-1) === 'waiting');
  assert.match(log.waits.at(-1), /Gemini 503/);
  await until(() => log.requests.length === 3, 2000);
  assert.ok(log.requests[2].at - failedAt >= 140, `retry waited ${log.requests[2].at - failedAt}ms`); // backoff は 20ms だが Retry-After を優先
  respond(log.requests[2], ['2-1', '2-2', '2-3']);
  await until(() => log.played.length === 6);
  engine.pause();
});

test('repeated 503s are retried a bounded number of times, then playback stops with a resumable message', async () => {
  const { engine, log } = harness({ playMs: 2 });
  engine.start();
  for (let i = 0; i < 5; i++) {
    await until(() => log.requests.length === i + 1, 2000);
    fail(log.requests[i], 'upstream_unavailable', { message: 'Gemini 503' });
  }
  await until(() => log.stops.length === 1);
  await tick(200);
  assert.equal(log.requests.length, 5); // 無限にはやり直さない
  assert.equal(log.stops[0].resumable, true);
  assert.equal(engine.running, false);
  // 復旧後は再開できる
  engine.start();
  await until(() => log.requests.length === 6);
  respond(log.requests[5], ['ok-1', 'ok-2']);
  await until(() => log.played.length === 2);
  engine.pause();
});

test('schema rejection is not retried; invalid output stops after 3 attempts', async () => {
  const a = harness();
  a.engine.start();
  await until(() => a.log.requests.length === 1);
  fail(a.log.requests[0], 'schema_rejected', { message: 'schema' });
  await until(() => a.log.stops.length === 1);
  await tick(100);
  assert.equal(a.log.requests.length, 1);
  assert.equal(a.log.stops[0].resumable, false);
  const b = harness({ engine: { badOutputMax: 3 } });
  b.engine.o.backoff = [5];
  b.engine.start();
  for (let i = 0; i < 3; i++) {
    await until(() => b.log.requests.length === i + 1, 6000);
    fail(b.log.requests[i], 'bad_output', { message: 'bad' });
  }
  await until(() => b.log.stops.length === 1, 6000);
  assert.equal(b.log.requests.length, 3);
});

test('daily limit switches to clearly labeled demo mode and continues', async () => {
  const { engine, log } = harness();
  engine.start();
  await until(() => log.requests.length === 1);
  fail(log.requests[0], 'daily_limit', { message: '今日の上限' });
  await until(() => log.requests.length === 2, 3000);
  assert.equal(engine.mode, 'demo');
  assert.equal(log.requests[1].body.mode, 'demo');
  assert.match(log.notices[0], /デモモード（AI ではありません）/);
  engine.pause();
});
