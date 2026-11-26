// Gemini API 呼び出し。API キーはサーバー側の環境変数からのみ読み込む。
import { GoogleGenAI, ApiError } from '@google/genai';
import { buildTurnPrompt, TURN_SCHEMA, normalizeTurn, findDuplicate } from './conversation.mjs';

export class AIError extends Error {
  /**
   * source: 'gemini' = Gemini API 側の応答が原因 / 'server' = このサーバー自身の判断（上限・設定など）
   * retryAfterMs: 次に試すまで待つべき時間（分かる場合）
   */
  constructor(code, message, { status = 502, retryable = false, source = 'server', retryAfterMs = 0, upstream = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.source = source;
    this.retryAfterMs = retryAfterMs;
    this.upstream = upstream; // Gemini の HTTP ステータス・エラーコード・メッセージ（ログ用）
  }
}

/**
 * Gemini SDK の ApiError から、HTTP ステータス・エラーコード（UNAVAILABLE など）・メッセージ・
 * 再試行までの待ち時間（RetryInfo）を取り出す。SDK はエラー本文を JSON 文字列で message に入れている。
 */
export function describeUpstream(err) {
  const info = { httpStatus: err?.status ?? null, code: null, status: null, message: '', retryAfterMs: 0 };
  let body = null;
  try {
    body = JSON.parse(err?.message || '');
  } catch {
    info.message = String(err?.message || '').slice(0, 300);
  }
  const e = body?.error;
  if (e) {
    info.code = e.code ?? null;
    info.status = e.status ?? null;
    info.message = String(e.message || '').slice(0, 300);
    for (const d of Array.isArray(e.details) ? e.details : []) {
      if (String(d?.['@type'] || '').includes('RetryInfo') && typeof d.retryDelay === 'string') {
        const sec = Number.parseFloat(d.retryDelay);
        if (Number.isFinite(sec)) info.retryAfterMs = Math.round(sec * 1000);
      }
    }
  }
  return info;
}

/** Gemini とのやりとりの失敗を 1 行でログに残す（プロンプトや API キーは出さない） */
export function logUpstream(kind, fields) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' && /\s/.test(v) ? JSON.stringify(v) : v}`);
  console.warn(`[gemini] ${kind} ${parts.join(' ')}`);
}

export function getConfig() {
  return {
    model: process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite',
    // 出力トークンの上限（思考トークンも出力に含まれるため、短い発言でも余裕を持たせる）
    maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 2048,
    // 思考の深さ（例: low）。未設定なら送らず、モデルの既定値を使う
    thinkingLevel: (process.env.GEMINI_THINKING_LEVEL || '').trim().toUpperCase(), // MINIMAL / LOW / MEDIUM / HIGH
  };
}

export function hasCredentials() {
  return Boolean(apiKey());
}
function apiKey() {
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
}

let client = null;
function getClient() {
  if (!client) {
    client = new GoogleGenAI({
      apiKey: apiKey(),
      // 無料枠を浪費しないよう、SDK 側の自動リトライは行わない
      // 1 回の呼び出しの制限時間。混雑時は応答が遅くなるので、短すぎない値にしている
      httpOptions: { timeout: Number(process.env.GEMINI_TIMEOUT_MS) || 30_000, retryOptions: { attempts: 1 } },
    });
  }
  return client;
}

/** 1 回だけ呼び出し、JSON をパースして返す */
async function callJSON({ system, user }) {
  const cfg = getConfig();
  const started = Date.now();
  let res;
  try {
    res = await getClient().models.generateContent({
      model: cfg.model,
      contents: [{ role: 'user', parts: [{ text: user }] }],
      config: {
        systemInstruction: system,
        responseMimeType: 'application/json',
        responseJsonSchema: TURN_SCHEMA,
        maxOutputTokens: cfg.maxOutputTokens,
        temperature: 1.0,
        ...(cfg.thinkingLevel ? { thinkingConfig: { thinkingLevel: cfg.thinkingLevel } } : {}),
      },
    });
  } catch (err) {
    const e = toAIError(err);
    logUpstream('error', {
      model: cfg.model,
      ms: Date.now() - started,
      http: e.upstream?.httpStatus,
      code: e.upstream?.status,
      message: e.upstream?.message,
      retryAfterMs: e.retryAfterMs || null,
      cause: e.upstream?.cause,
      mapped: e.code,
    });
    throw e;
  }

  if (res.promptFeedback?.blockReason) {
    logUpstream('blocked', { model: cfg.model, ms: Date.now() - started, blockReason: res.promptFeedback.blockReason });
    throw new AIError('blocked', 'この流れの発言は生成できませんでした。話題を変えて続けます。', { status: 422, retryable: true });
  }
  const finish = res.candidates?.[0]?.finishReason;
  if (finish && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(finish)) {
    logUpstream('finish', { model: cfg.model, ms: Date.now() - started, finishReason: finish });
    const code = finish === 'MAX_TOKENS' ? 'max_tokens' : 'blocked';
    throw new AIError(code, code === 'blocked' ? 'この流れの発言は生成できませんでした。話題を変えて続けます。' : '発言が途中で切れました。', { status: code === 'blocked' ? 422 : 502, retryable: true });
  }
  try {
    return JSON.parse(res.text || '');
  } catch {
    throw new AIError('bad_output', 'AI の応答を読み取れませんでした。', { status: 502, retryable: true });
  }
}

export function toAIError(err) {
  if (err instanceof AIError) return err;
  if (err instanceof ApiError) {
    const up = describeUpstream(err);
    const g = { source: 'gemini', upstream: up, retryAfterMs: up.retryAfterMs };
    if (err.status === 429) {
      // Gemini 側の無料枠に達した。1 日の上限か、1 分あたりの上限かを区別する
      if (/per ?day|PerDay|daily/i.test(err.message || '')) {
        return new AIError('upstream_quota', '今日の AI（Gemini）の無料枠の上限に達しました。', { status: 429, ...g });
      }
      return new AIError('upstream_busy', 'AI（Gemini）の 1 分あたりの上限に達しました。少し待ってから続けます。', { status: 429, retryable: true, ...g });
    }
    if (err.status === 400 && /api key/i.test(err.message)) {
      return new AIError('auth', 'サーバーの API キーが無効です。', { status: 503, ...g });
    }
    if (err.status === 401 || err.status === 403) return new AIError('auth', 'サーバーの API キーが無効か、権限がありません。', { status: 503, ...g });
    if (err.status === 404) return new AIError('model', 'AI モデルが見つかりません（GEMINI_MODEL を確認してください）。', { status: 503, ...g });
    if (err.status === 400) return new AIError('bad_request', 'AI へのリクエストが拒否されました。', { status: 502, ...g });
    if ([500, 502, 503, 504].includes(err.status)) {
      // Gemini 側の一時的な障害・過負荷（503 UNAVAILABLE = "The model is overloaded" など）
      return new AIError('upstream_unavailable', `Google の AI（Gemini）が一時的に応答できません（HTTP ${err.status}${up.status ? ` ${up.status}` : ''}）。`, { status: 503, retryable: true, ...g });
    }
    return new AIError('api', `AI（Gemini）からエラーが返りました（HTTP ${err.status}）。`, { status: 502, retryable: true, ...g });
  }
  const cause = err?.cause?.code || err?.code || err?.name || '';
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timeout|timed out/i.test(err?.message || '')) {
    return new AIError('timeout', 'AI（Gemini）の応答に時間がかかりすぎました。', { status: 504, retryable: true, source: 'gemini', upstream: { httpStatus: null, status: 'TIMEOUT', message: String(err?.message || '').slice(0, 200), cause } });
  }
  return new AIError('network', 'AI（Gemini）に接続できませんでした。', { status: 503, retryable: true, source: 'gemini', upstream: { httpStatus: null, status: 'NETWORK', message: String(err?.message || '').slice(0, 200), cause } });
}

/**
 * 1 発言を生成する。reserve() は API を 1 回呼ぶ直前に呼ばれ、上限を超えていれば例外を投げる。
 * 重複時の作り直しも上限に数えるため、呼び出し回数は必ず reserve を通る。
 */
export async function generateTurn({ speaker, log, ctx, reserve = () => {}, allowRegenerate = true }) {
  const started = Date.now();
  const prompt = buildTurnPrompt({ speaker, log, ctx });
  let calls = 0;
  const take = () => {
    reserve();
    calls++;
  };
  take();
  let turn = normalizeTurn(await callJSON(prompt), prompt.analysis);

  // 作り直しは、最初の呼び出しが速く済み、Gemini が安定しているときだけ（失敗が続く時間帯に呼び出しを増やさない）
  const canRegenerate = allowRegenerate && Date.now() - started < 12_000;
  if (!turn.text || (canRegenerate && findDuplicate(turn.text, log))) {
    if (!turn.text && !canRegenerate) throw new AIError('empty', 'AI が発言を生成できませんでした。', { status: 502, retryable: true, source: 'gemini' });
    try {
      take();
      const retry = normalizeTurn(
        await callJSON({
          system: prompt.system,
          user: `${prompt.user}\n\n# 注意\n次の発言は直前の会話と重複していたので使えません。違う角度・違う言葉で話してください:\n「${turn.text}」`,
        }),
        prompt.analysis,
      );
      if (retry.text && !findDuplicate(retry.text, log)) turn = retry;
    } catch (err) {
      if (!turn.text) throw err;
      // 作り直せなくても、最初の発言が空でなければそれを使う
    }
    if (!turn.text) throw new AIError('empty', 'AI が発言を生成できませんでした。', { status: 502, retryable: true });
  }
  // calls: この発言のために使った API 呼び出し回数（クライアントが間隔の調整に使う）
  return { ...turn, calls };
}
