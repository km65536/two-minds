// TWO MINDS — 会話の再生キューと通信の制御（画面には触れない。ブラウザでも Node のテストでも動く）
//
//  ・Gemini から「続きの数発言（原則 3）」をまとめて受け取り、一発言ずつ再生する
//  ・ある記録の再生を始めたら、すぐに次の記録を 1 件だけ先読みする（同時に複数・重複して要求しない）
//  ・現在の記録を再生し終えたら、届いている次の記録へ移る。まだ届いていなければ待つ
//  ・観察者が話しかけたら、再生を止め、未再生の記録と生成中のリクエストを捨て、発言を踏まえた続きを要求する
//  ・リクエストごとに番号（rid）と会話の世代（gen）を持たせ、古い応答は必ず捨てる
//  ・一時的な障害（503 など）は、再生中の記録を壊さずに裏で待ってやり直す（回数に上限あり）

export const TRANSIENT = ['upstream_unavailable', 'upstream_cooldown', 'upstream_busy', 'timeout', 'network', 'host_unavailable', 'offline'];
const LIMIT_WAIT = ['too_fast', 'busy', 'in_progress']; // このサーバーの上限による待ち（AI は呼んでいない）
const DEMO_SWITCH = ['daily_limit', 'upstream_quota', 'no_key', 'disabled', 'auth', 'model'];
const BAD_OUTPUT = ['blocked', 'bad_output', 'max_tokens'];
const RECENT = 10;

export function emptyContext() {
  return { state: null, recent: [], topics: [], backlog: [], notes: { A: [], B: [] } };
}

export class ConversationEngine {
  /**
   * io（画面・通信との接点）:
   *   request(body, signal) → Promise<レスポンス JSON>（失敗時は { code, message, retryAfterMs } を持つエラーを投げる）
   *   play(line, gen, onProgress(shownText)) → Promise<boolean>（最後まで話したら true。割り込まれたら false）
   *   setStatus(state), showWait(text), clearWait(), notice(text, kind), switchToDemo(text),
   *   onStop(text, { resumable }), onIdle(), save(snapshot), paceWait({ interrupt }) → ms, notePace(n)
   */
  constructor(io, opts = {}) {
    this.io = io;
    this.o = {
      backoff: [6000, 15000, 30000, 45000],
      transientMax: 5,
      badOutputMax: 3,
      limitWaitMax: 4,
      badOutputDelay: 4000, // 形式の崩れた応答のあと、もう一度要求するまでの待ち
      resumeDelay: 600, // 入力をやめて会話に戻るときの、ひと呼吸
      idleChunks: 30, // 操作がないまま、この数の記録を再生したら一時停止（見ていない間の使いすぎ防止）
      jitter: 2000,
      gap: () => 1000, // 発言と発言の間（line, nextLine, { boundary }）→ ms
      random: Math.random,
      ...opts,
    };
    this.mode = 'ai';
    this.ctx = emptyContext();
    this.current = null; // 再生中の記録 { rid, lines, idx, before, after, deferred, notes, boundary, prefetched }
    this.next = null; // 届いている次の記録
    this.inflight = null; // 生成中のリクエスト { rid, gen, controller, interrupt, before }
    this.retryTimer = null; // 次のリクエストを送るまでの待ち（障害のあと・間隔の調整）
    this.waitInfo = null; // 障害で待っているときの表示
    this.failure = null; // 続けられない状態 { message, resumable }
    this.transient = 0;
    this.badOutput = 0;
    this.limitWaits = 0;
    this.gen = 0;
    this.rid = 0;
    this.running = false;
    this.started = false;
    this.loopGen = null;
    this.pendingInterrupt = null;
    this.speaking = null; // 話している途中の発言 { line, shown }
    this.chunksSinceInput = 0;
    this.stats = { requests: 0, played: 0 };
    this.sleepers = new Set();
    this.nextWaiters = new Set();
    // 観察者が入力している間は、再生を止める（一時停止とは別。キュー・状態・生成中の応答はそのまま）
    this.held = false;
    this.holdWaiters = new Set();
    this.shownStatus = null; // 入力中に、本来出すはずだった状態表示
  }

  // ---------- 待ち合わせ ----------

  /**
   * 世代が変わったら途中で抜ける待ち時間。観察者が入力している間は、待ち終わっても入力が終わるまで先へ進まない
   * （発言を 1 文字ずつ表示する待ちもこれを使うので、入力を始めると話している途中でもすぐ止まる）
   */
  async sleep(ms, g = this.gen) {
    if (!(await this.timer(ms, g))) return false;
    if (this.held) {
      await this.untilReleased(g);
      if (g !== this.gen) return false;
      // 入力をやめて戻ってきたら、ひと呼吸おいてから続ける
      if (!(await this.timer(this.o.resumeDelay, g))) return false;
    }
    return g === this.gen;
  }

  timer(ms, g = this.gen) {
    return new Promise((resolve) => {
      if (g !== this.gen) return resolve(false);
      const s = {};
      const done = (v) => {
        clearTimeout(s.t);
        this.sleepers.delete(s);
        resolve(v);
      };
      s.t = setTimeout(() => done(true), Math.max(0, ms));
      s.cancel = () => done(false);
      this.sleepers.add(s);
    });
  }

  /** 観察者の入力が終わる（または割り込み・リセットで世代が変わる）まで待つ */
  untilReleased(g) {
    return new Promise((resolve) => {
      if (!this.held || g !== this.gen) return resolve();
      this.holdWaiters.add(resolve);
    });
  }

  wakeHold() {
    for (const r of [...this.holdWaiters]) r();
    this.holdWaiters.clear();
  }

  /** 状態表示。入力中は「入力中」を優先し、本来の表示は入力が終わってから出す */
  setStatus(state) {
    if (this.held && !['holding', 'paused', 'error'].includes(state)) {
      this.shownStatus = state;
      return;
    }
    this.io.setStatus(state);
  }

  waitForNext(g) {
    return new Promise((resolve) => {
      if (g !== this.gen || this.next || this.failure || !this.running) return resolve();
      this.nextWaiters.add(resolve);
    });
  }

  wake() {
    for (const r of [...this.nextWaiters]) r();
    this.nextWaiters.clear();
  }

  bumpGeneration() {
    this.gen++;
    for (const s of [...this.sleepers]) s.cancel();
    this.wake();
    this.wakeHold();
  }

  // ---------- 文脈 ----------

  remember(entry) {
    this.ctx.recent.push(entry);
    if (this.ctx.recent.length > RECENT) this.ctx.recent = this.ctx.recent.slice(-RECENT);
  }

  /** 次の記録を作るための文脈。先読みのときは、再生中の記録の内容と、その記録のあとの状態を含める */
  contextForRequest() {
    const c = this.current && !this.pendingInterrupt ? this.current : null;
    const recent = [...this.ctx.recent];
    let state = this.ctx.state;
    let backlog = this.ctx.backlog;
    if (c) {
      for (const l of c.lines.slice(c.idx)) recent.push({ kind: 'say', speaker: l.speaker, text: l.text });
      state = c.after;
      backlog = mergeList(backlog, c.deferred, 5);
    }
    return { state, recent: recent.slice(-RECENT), topics: this.ctx.topics, backlog, notes: this.ctx.notes };
  }

  commitLine(line) {
    this.remember({ kind: 'say', speaker: line.speaker, text: line.text });
    this.stats.played++;
  }

  commitChunk(c) {
    this.ctx.state = c.after;
    const topic = c.after?.topic;
    if (topic && this.ctx.topics.at(-1) !== topic) this.ctx.topics = [...this.ctx.topics, topic].slice(-8);
    if (c.after?.question) this.ctx.backlog = this.ctx.backlog.filter((q) => q !== c.after.question); // 取り上げた疑問は後回しリストから外す
    this.ctx.backlog = mergeList(this.ctx.backlog, c.deferred, 5);
    for (const w of ['A', 'B']) if (c.notes?.[w]) this.ctx.notes[w] = mergeList(this.ctx.notes[w], [c.notes[w]], 5);
    this.chunksSinceInput++;
  }

  // ---------- 通信 ----------

  /** 次の記録が必要で、まだ誰も要求していなければ、1 件だけ要求する */
  ensureNext() {
    // 入力中は新しい生成を始めない（送信されたら割り込みになり、作っても捨てることになるため）。生成中の応答は受け取る
    if (!this.running || this.held || this.failure || this.next || this.inflight || this.retryTimer) return;
    const interrupt = this.pendingInterrupt;
    const wait = this.io.paceWait({ interrupt: !!interrupt }) || 0;
    if (wait > 0) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.ensureNext();
      }, wait);
      return;
    }
    this.send(interrupt);
  }

  send(interrupt) {
    const rid = ++this.rid;
    const gen = this.gen;
    const context = this.contextForRequest();
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const req = { rid, gen, controller, interrupt, before: context.state };
    this.inflight = req;
    this.stats.requests++;
    if (this.mode !== 'demo') this.io.notePace?.(1);
    Promise.resolve()
      .then(() => this.io.request({ mode: this.mode, gen, rid, context, interrupt: interrupt ? { text: interrupt.text } : null }, controller?.signal))
      .then(
        (res) => this.onResult(req, res),
        (err) => this.onError(req, err),
      );
  }

  isStale(req) {
    return req.gen !== this.gen || this.inflight !== req;
  }

  onResult(req, res) {
    if (this.isStale(req)) return; // 割り込みなどで古くなった応答は使わない
    this.inflight = null;
    const chunk = res?.chunk;
    const valid = res && res.gen === req.gen && res.rid === req.rid && chunk && Array.isArray(chunk.lines) && chunk.lines.length > 0 && chunk.lines.every((l) => (l.speaker === 'A' || l.speaker === 'B') && typeof l.text === 'string' && l.text);
    if (!valid) return this.onError(Object.assign({}, req, { stale: true }), { code: 'bad_output', message: '会話の続きの形式が正しくありませんでした。' }, true);
    if (req.interrupt && this.pendingInterrupt === req.interrupt) this.pendingInterrupt = null;
    if (res.mode === 'demo' || res.demo) this.mode = res.demo ? 'demo' : this.mode;
    this.next = { rid: req.rid, lines: chunk.lines, idx: 0, before: req.before, after: chunk.state, deferred: chunk.deferred || [], notes: chunk.notes || {}, boundary: !!chunk.boundary, prefetched: false };
    this.transient = 0;
    this.badOutput = 0;
    this.limitWaits = 0;
    if (this.waitInfo) {
      this.waitInfo = null;
      this.io.clearWait();
    }
    this.save();
    this.wake();
  }

  onError(req, err, alreadyCleared = false) {
    if (!alreadyCleared) {
      if (this.isStale(req)) return;
      this.inflight = null;
    }
    const code = err?.code;
    if (code === 'aborted' || code === 'superseded') return;
    const retryIn = (ms) => {
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.ensureNext();
      }, ms);
    };
    if (TRANSIENT.includes(code)) {
      this.transient++;
      if (this.transient >= this.o.transientMax) {
        this.fail(`${err.message} 何度か待ってみましたが回復しませんでした。時間をおいて`, true);
      } else {
        const base = this.o.backoff[Math.min(this.transient - 1, this.o.backoff.length - 1)];
        const wait = Math.max(err.retryAfterMs || 0, base) + Math.round(this.o.random() * this.o.jitter);
        this.waitInfo = { text: `${err.message} ${Math.ceil(wait / 1000)} 秒ほど待ってから続けます…（${this.transient}/${this.o.transientMax - 1}）` };
        retryIn(wait);
        // 再生中の記録はそのまま最後まで流す。待ちに入ったときに表示する
        if (!this.current) this.showWaiting();
      }
    } else if (LIMIT_WAIT.includes(code)) {
      this.limitWaits++;
      if (this.limitWaits > this.o.limitWaitMax) this.fail(err.message, true);
      else retryIn(Math.max(err.retryAfterMs || 0, 3000 * this.limitWaits));
    } else if (DEMO_SWITCH.includes(code)) {
      // AI が使えないときは、AI ではないと明示したうえでデモに切り替えて続ける
      this.mode = 'demo';
      this.io.switchToDemo(`${err.message} ここからはデモモード（AI ではありません）で続けます。`);
      retryIn(1500);
    } else if (BAD_OUTPUT.includes(code)) {
      this.badOutput++;
      if (this.badOutput >= this.o.badOutputMax) this.fail(err.message, true);
      else retryIn(this.o.badOutputDelay);
    } else if (code === 'schema_rejected') {
      this.fail(err.message, false); // 一時的な障害ではないので、やり直さない
    } else {
      this.fail(err?.message || 'エラーが発生しました。', true);
    }
    this.save();
    this.wake();
  }

  fail(message, resumable) {
    this.failure = { message, resumable };
  }

  showWaiting() {
    if (this.waitInfo) {
      this.setStatus('waiting');
      this.io.showWait(this.waitInfo.text);
    } else {
      this.setStatus('thinking');
    }
  }

  // ---------- 再生 ----------

  async loop() {
    if (this.loopGen === this.gen) return;
    const g = this.gen;
    this.loopGen = g;
    try {
      while (this.running && g === this.gen) {
        if (this.held) {
          await this.untilReleased(g);
          continue;
        }
        if (!this.current) {
          if (this.next) {
            this.current = this.next;
            this.next = null;
          } else {
            if (this.failure) {
              this.stopWithFailure();
              break;
            }
            this.showWaiting();
            this.ensureNext();
            await this.waitForNext(g);
            continue;
          }
        }
        const c = this.current;
        if (c.idx === 0 && !this.pendingInterrupt && this.chunksSinceInput >= this.o.idleChunks) {
          this.pause();
          this.io.onIdle();
          break;
        }
        // この記録の再生を始めたら、すぐに次の記録を先読みする（1 件だけ）
        c.prefetched = true;
        this.ensureNext();
        this.setStatus('running');
        const line = c.lines[c.idx];
        this.speaking = { line, shown: '' };
        const done = await this.io.play(line, g, (shown) => {
          if (this.speaking && this.speaking.line === line) this.speaking.shown = shown;
        });
        if (g !== this.gen) break; // 割り込まれた
        this.speaking = null;
        if (done !== false) this.commitLine(line);
        c.idx++;
        if (c.idx >= c.lines.length) {
          this.commitChunk(c);
          this.current = null;
          this.save();
          await this.sleep(this.o.gap(line, null, { boundary: c.boundary }), g);
        } else {
          this.save();
          await this.sleep(this.o.gap(line, c.lines[c.idx], { boundary: false }), g);
        }
      }
    } finally {
      if (this.loopGen === g) this.loopGen = null;
    }
  }

  stopWithFailure() {
    const f = this.failure;
    this.running = false;
    this.setStatus('error');
    this.io.clearWait();
    this.io.onStop(f.message, { resumable: f.resumable });
    this.save();
  }

  // ---------- 操作 ----------

  start() {
    if (this.running) return;
    if (this.failure?.resumable) {
      this.failure = null;
      this.transient = 0;
      this.badOutput = 0;
      this.limitWaits = 0;
    }
    if (this.failure) {
      this.setStatus('error');
      return;
    }
    this.running = true;
    this.started = true;
    this.save();
    this.loop();
  }

  pause() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.setStatus('paused');
    this.wake();
    this.save();
  }

  /**
   * 観察者が入力を始めた：会話の再生をすぐに止める。
   * キュー（再生中・先読み済みの記録）、会話の状態、生成中のリクエストは捨てない。新しい生成だけ始めない。
   */
  hold() {
    if (this.held) return;
    this.held = true;
    this.shownStatus = null;
    this.io.onHold?.();
    this.io.setStatus('holding');
  }

  /** 送信せずに入力をやめた：止まったところから会話を再開する */
  release() {
    if (!this.held) return;
    this.held = false;
    this.wakeHold();
    const s = this.shownStatus;
    this.shownStatus = null;
    if (!this.running) {
      this.io.setStatus(this.failure ? 'error' : 'paused');
      return;
    }
    this.io.setStatus(s || (this.current ? 'running' : 'thinking'));
    if (this.waitInfo && !this.current) this.io.showWait(this.waitInfo.text);
    this.ensureNext();
    this.loop();
  }

  /** 観察者の発言：最優先で処理する（入力中だった場合も、ここで入力待ちを終える） */
  interrupt(text) {
    this.held = false;
    this.shownStatus = null;
    // 1. 再生中の発言を止める（世代を進めると、再生も待ちもすぐ抜ける）
    this.bumpGeneration();
    // 2. 生成中のリクエストを取り消す（取り消せなくても、世代が違う応答は使われない）
    if (this.inflight) this.inflight.controller?.abort();
    this.inflight = null;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.waitInfo) {
      this.waitInfo = null;
      this.io.clearWait();
    }
    // 3. 未再生の記録を捨てる。再生済みの発言と、その時点の状態（問題・二人の考え）は残す
    this.next = null;
    const c = this.current;
    if (c) {
      const sp = this.speaking;
      if (sp && sp.shown.length >= 4) this.remember({ kind: 'say', speaker: sp.line.speaker, text: `${sp.shown}…` });
      // 記録の途中なら、記録の前の状態を使う（まだ話していない結論は含めない）
      this.ctx.state = c.before;
      this.current = null;
    }
    this.speaking = null;
    // 4. 観察者の発言を文脈に加える。生成待ちの間に続けて話しかけられたら、まとめて 1 回で送る
    this.remember({ kind: 'player', speaker: null, text });
    this.pendingInterrupt = this.pendingInterrupt ? { text: `${this.pendingInterrupt.text} / ${text}`.slice(-100) } : { text };
    this.chunksSinceInput = 0;
    this.transient = 0;
    this.badOutput = 0;
    this.limitWaits = 0;
    if (this.failure?.resumable) this.failure = null;
    // 5. 新しい続きを要求して再生する
    this.started = true;
    this.running = !this.failure;
    this.save();
    if (this.running) {
      this.ensureNext();
      this.loop();
    } else {
      this.setStatus('error');
    }
  }

  reset() {
    this.held = false;
    this.shownStatus = null;
    this.bumpGeneration();
    if (this.inflight) this.inflight.controller?.abort();
    this.inflight = null;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.ctx = emptyContext();
    this.current = null;
    this.next = null;
    this.pendingInterrupt = null;
    this.speaking = null;
    this.waitInfo = null;
    this.chunksSinceInput = 0;
    this.transient = this.badOutput = this.limitWaits = 0;
    if (this.failure?.resumable) this.failure = null;
    this.running = false;
    this.started = false;
  }

  // ---------- 保存（このタブの sessionStorage だけ） ----------

  snapshot() {
    const keep = (c) => c && { rid: c.rid, lines: c.lines, idx: c.idx, before: c.before, after: c.after, deferred: c.deferred, notes: c.notes, boundary: c.boundary };
    return { v: 4, mode: this.mode, ctx: this.ctx, current: keep(this.current), next: keep(this.next), started: this.started, chunksSinceInput: this.chunksSinceInput };
  }

  restore(s) {
    if (!s || s.v !== 4 || !s.started) return false;
    const ok = (c) => c && Array.isArray(c.lines) && c.lines.length && Number.isInteger(c.idx) && c.idx < c.lines.length;
    this.ctx = { ...emptyContext(), ...s.ctx, notes: { A: s.ctx?.notes?.A || [], B: s.ctx?.notes?.B || [] } };
    this.current = ok(s.current) ? { ...s.current, prefetched: false } : null;
    this.next = ok(s.next) ? { ...s.next, prefetched: false } : null;
    this.mode = s.mode === 'demo' ? 'demo' : 'ai';
    this.started = true;
    this.chunksSinceInput = s.chunksSinceInput || 0;
    return true;
  }

  save() {
    this.io.save?.(this.snapshot());
  }
}

function mergeList(list, add, max) {
  const out = [...(list || [])];
  for (const x of add || []) if (x && !out.includes(x)) out.push(x);
  return out.slice(-max);
}
