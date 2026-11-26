// 使いすぎ・不正利用を防ぐための呼び出し制限（メモリ上で管理）。
// - 全体: 1 日あたり / 1 分あたりの上限、同時実行数
// - 接続元 IP ごと: 1 日あたり / 1 分あたりの上限、最小間隔
// 1 日の区切りは Gemini の無料枠と同じ太平洋時間の 0 時。

import { AIError } from './ai.mjs';

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export function limitsFromEnv(env = process.env) {
  return {
    dailyLimit: num(env.DAILY_CALL_LIMIT, 300),
    rpmLimit: num(env.RPM_LIMIT, 10),
    ipDailyLimit: num(env.IP_DAILY_LIMIT, 120),
    ipRpmLimit: num(env.IP_RPM_LIMIT, 8),
    ipMinIntervalMs: num(env.IP_MIN_INTERVAL_MS, 2500),
    maxConcurrent: num(env.MAX_CONCURRENT, 3),
  };
}

export function pacificDay(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export class Limiter {
  constructor(opts, clock = () => Date.now()) {
    this.o = opts;
    this.clock = clock;
    this.day = pacificDay(clock());
    this.dailyCount = 0;
    this.minute = []; // 直近 60 秒の呼び出し時刻
    this.ips = new Map(); // ip -> { day, count, minute: [], last }
    this.inFlight = 0;
  }

  rollover(now) {
    const d = pacificDay(now);
    if (d !== this.day) {
      this.day = d;
      this.dailyCount = 0;
      this.ips.clear();
    }
    while (this.minute.length && now - this.minute[0] >= 60_000) this.minute.shift();
  }

  ipState(ip, now) {
    let s = this.ips.get(ip);
    if (!s) {
      s = { count: 0, minute: [], last: 0 };
      this.ips.set(ip, s);
      if (this.ips.size > 5000) this.prune(now);
    }
    while (s.minute.length && now - s.minute[0] >= 60_000) s.minute.shift();
    return s;
  }

  prune(now) {
    for (const [ip, s] of this.ips) if (now - s.last > 10 * 60_000) this.ips.delete(ip);
  }

  dailyExhausted() {
    this.rollover(this.clock());
    return this.dailyCount >= this.o.dailyLimit;
  }

  /** 1 回分の呼び出しを予約する。上限を超えていれば AIError を投げる。 */
  take(ip) {
    const now = this.clock();
    this.rollover(now);
    const s = this.ipState(ip, now);
    if (this.dailyCount >= this.o.dailyLimit) {
      throw new AIError('daily_limit', '今日の AI 会話の上限に達しました。', { status: 429 });
    }
    if (s.count >= this.o.ipDailyLimit) {
      throw new AIError('daily_limit', 'このネットワークからの今日の AI 会話の上限に達しました。', { status: 429 });
    }
    if (this.minute.length >= this.o.rpmLimit || s.minute.length >= this.o.ipRpmLimit) {
      throw new AIError('busy', 'ただいま混み合っています。', { status: 429, retryable: true });
    }
    this.dailyCount++;
    this.minute.push(now);
    s.count++;
    s.minute.push(now);
    s.last = now;
  }

  /** 1 リクエスト（＝1 発言）の開始時に呼ぶ。最小間隔と同時実行数を確認する。 */
  begin(ip, { interrupt = false } = {}) {
    const now = this.clock();
    this.rollover(now);
    const s = this.ipState(ip, now);
    // 観察者の割り込みは最優先なので、最小間隔の制限はかけない（1 分・1 日の回数の上限は通常どおり）
    if (!interrupt && s.last && now - s.last < this.o.ipMinIntervalMs) {
      throw new AIError('too_fast', 'リクエストの間隔が短すぎます。', { status: 429, retryable: true });
    }
    if (this.inFlight >= this.o.maxConcurrent) {
      throw new AIError('busy', 'ただいま混み合っています。', { status: 429, retryable: true });
    }
    this.inFlight++;
    let done = false;
    return () => {
      if (!done) {
        done = true;
        this.inFlight--;
      }
    };
  }
}

/**
 * Gemini が過負荷（503 など）・分間上限（429）・タイムアウトを返したとき、サーバー全体で少し待つための仕組み。
 * 待っている間は Gemini を呼ばずに、理由と待ち時間をすぐ返す（混雑中に全員が呼び続けて悪化させない・無料枠を使わない）。
 * 待ち時間は失敗が続くほど伸び（上限あり）、成功すると元に戻る。
 */
export class UpstreamGate {
  constructor({ baseMs = 4000, maxMs = 60_000 } = {}, clock = () => Date.now(), rng = Math.random) {
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.clock = clock;
    this.rng = rng;
    this.failures = 0;
    this.until = 0;
    this.lastReason = null;
  }

  /** 待機中なら、あと何ミリ秒待てばよいか（待機中でなければ 0） */
  remaining() {
    return Math.max(0, this.until - this.clock());
  }

  check() {
    const ms = this.remaining();
    if (ms > 0) {
      throw new AIError('upstream_cooldown', `Google の AI（Gemini）が混み合っているため、少し待っています（直前の応答: ${this.lastReason}）。`, {
        status: 503,
        retryable: true,
        source: 'gemini',
        retryAfterMs: ms,
      });
    }
  }

  onSuccess() {
    this.failures = 0;
    this.until = 0;
  }

  /** 失敗を記録し、待ち時間（ミリ秒）を返す */
  onFailure(reason, hintMs = 0) {
    this.failures++;
    const backoff = Math.min(this.maxMs, this.baseMs * 2 ** (this.failures - 1));
    const jitter = backoff * 0.25 * this.rng();
    const wait = Math.round(Math.min(this.maxMs, Math.max(hintMs, backoff + jitter)));
    this.until = this.clock() + wait;
    this.lastReason = reason;
    return wait;
  }
}

/** この種類のエラーなら、サーバー全体で少し待つ */
export function isUpstreamTransient(err) {
  return err?.source === 'gemini' && ['upstream_unavailable', 'upstream_busy', 'timeout'].includes(err.code);
}
