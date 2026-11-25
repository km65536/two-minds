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
  begin(ip) {
    const now = this.clock();
    this.rollover(now);
    const s = this.ipState(ip, now);
    if (s.last && now - s.last < this.o.ipMinIntervalMs) {
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
