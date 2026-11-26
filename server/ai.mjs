// Gemini API 呼び出し。API キーはサーバー側の環境変数からのみ読み込む。
import { GoogleGenAI, ApiError } from '@google/genai';
import { buildChunkPrompt, CHUNK_SCHEMA, normalizeChunk, salvageChunk } from './conversation.mjs';

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
    // 出力トークンの上限。1 回に書くのは数発言と会話の状態だけだが、思考トークンも含むので余裕を持たせる
    maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 4096,
    // 思考の深さ（例: low）。未設定なら送らず、モデルの既定値を使う
    thinkingLevel: (process.env.GEMINI_THINKING_LEVEL || '').trim().toUpperCase(), // MINIMAL / LOW / MEDIUM / HIGH
    // 出力形式の指定方法。schema = 簡略化した JSON Schema を送る（既定）/ json = スキーマを送らず JSON 出力だけを指定する
    schemaMode: (process.env.GEMINI_SCHEMA_MODE || 'schema').trim().toLowerCase() === 'json' ? 'json' : 'schema',
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

/** 生成を中止したとき（観察者の割り込みで、古いリクエストを取り消した） */
export class SupersededError extends Error {}

/**
 * 1 回だけ呼び出し、会話記録の JSON を返す。
 * 出力が上限で途中で切れた（MAX_TOKENS）ときは、完全な発言だけを取り出して返す（追加の呼び出しはしない）。
 */
async function callChunk({ system, user }, signal) {
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
        ...(cfg.schemaMode === 'schema' ? { responseJsonSchema: CHUNK_SCHEMA } : {}),
        maxOutputTokens: cfg.maxOutputTokens,
        temperature: 1.0,
        ...(cfg.thinkingLevel ? { thinkingConfig: { thinkingLevel: cfg.thinkingLevel } } : {}),
        ...(signal ? { abortSignal: signal } : {}),
      },
    });
  } catch (err) {
    if (signal?.aborted) {
      logUpstream('aborted', { model: cfg.model, ms: Date.now() - started, reason: 'superseded by a newer request' });
      throw new SupersededError('superseded');
    }
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
  if (signal?.aborted) throw new SupersededError('superseded');

  if (res.promptFeedback?.blockReason) {
    logUpstream('blocked', { model: cfg.model, ms: Date.now() - started, blockReason: res.promptFeedback.blockReason });
    throw new AIError('blocked', 'この流れの会話は生成できませんでした。別の話にして続けます。', { status: 422, retryable: true, source: 'gemini' });
  }
  const finish = res.candidates?.[0]?.finishReason;
  const text = res.text || '';
  const ms = Date.now() - started;
  if (finish && !['STOP', 'FINISH_REASON_UNSPECIFIED', 'MAX_TOKENS'].includes(finish)) {
    logUpstream('finish', { model: cfg.model, ms, finishReason: finish });
    throw new AIError('blocked', 'この流れの会話は生成できませんでした。別の話にして続けます。', { status: 422, retryable: true, source: 'gemini' });
  }
  if (finish === 'MAX_TOKENS') {
    const partial = salvageChunk(text);
    logUpstream('finish', { model: cfg.model, ms, finishReason: finish, salvagedLines: partial?.lines?.length ?? 0 });
    if (partial?.lines?.length) return { data: partial, truncated: true, ms };
    throw new AIError('max_tokens', '会話の続きが途中で切れてしまいました。', { status: 502, retryable: true, source: 'gemini' });
  }
  try {
    return { data: JSON.parse(text), truncated: false, ms };
  } catch {
    // 形式が崩れていても、読める発言があれば使う
    const partial = salvageChunk(text);
    logUpstream('bad_json', { model: cfg.model, ms, length: text.length, salvagedLines: partial?.lines?.length ?? 0 });
    if (partial?.lines?.length) return { data: partial, truncated: true, ms };
    throw new AIError('bad_output', 'AI の応答を読み取れませんでした。', { status: 502, retryable: true, source: 'gemini' });
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
    if (err.status === 400 && /too many states|schema produces a constraint|response_?(json_?)?schema/i.test(up.message || err.message || '')) {
      // 出力形式（JSON Schema）が受け付けられない。同じリクエストを繰り返しても結果は変わらない
      return new AIError('schema_rejected', 'AI（Gemini）が会話の出力形式を受け付けませんでした（HTTP 400 INVALID_ARGUMENT）。サーバー側の設定の見直しが必要です。', { status: 502, ...g });
    }
    if (err.status === 400) return new AIError('bad_request', `AI（Gemini）がリクエストを受け付けませんでした（HTTP 400${up.status ? ` ${up.status}` : ''}）。`, { status: 502, ...g });
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
 * 会話の続き（原則 3 発言、2〜5 発言）と、その時点の会話の状態を 1 回の呼び出しで生成する。
 * reserve() は API を呼ぶ直前に呼ばれ、上限を超えていれば例外を投げる。作り直しの呼び出しはしない。
 */
export async function generateChunk({ ctx, interrupt = null, reserve = () => {}, signal = null }) {
  const prompt = buildChunkPrompt({ ctx, interrupt });
  reserve();
  const { data, truncated, ms } = await callChunk(prompt, signal);
  const chunk = normalizeChunk(data, { prev: ctx.state, recent: ctx.recent, truncated });
  if (!chunk) {
    logUpstream('invalid', { model: getConfig().model, ms, lines: Array.isArray(data?.lines) ? data.lines.length : 0, truncated });
    throw new AIError('bad_output', 'AI の応答の形式が正しくありませんでした。', { status: 502, retryable: true, source: 'gemini' });
  }
  return { chunk, calls: 1 };
}
