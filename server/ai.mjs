// Gemini API 呼び出し。API キーはサーバー側の環境変数からのみ読み込む。
import { GoogleGenAI, ApiError } from '@google/genai';
import { buildTurnPrompt, TURN_SCHEMA, normalizeTurn, findDuplicate } from './conversation.mjs';

export class AIError extends Error {
  constructor(code, message, { status = 502, retryable = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
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
      httpOptions: { timeout: 30_000, retryOptions: { attempts: 1 } },
    });
  }
  return client;
}

/** 1 回だけ呼び出し、JSON をパースして返す */
async function callJSON({ system, user }) {
  const cfg = getConfig();
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
    throw toAIError(err);
  }

  if (res.promptFeedback?.blockReason) {
    throw new AIError('blocked', 'この流れの発言は生成できませんでした。話題を変えて続けます。', { status: 422, retryable: true });
  }
  const finish = res.candidates?.[0]?.finishReason;
  if (finish && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(finish)) {
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
    if (err.status === 429) {
      // Gemini 側の無料枠に達した。1 日の上限か、1 分あたりの上限かを区別する
      if (/per ?day|PerDay|daily/i.test(err.message || '')) {
        return new AIError('upstream_quota', '今日の AI の無料枠の上限に達しました。', { status: 429 });
      }
      return new AIError('upstream_busy', 'AI が混み合っています。少し待ってから続けます。', { status: 429, retryable: true });
    }
    if (err.status === 400 && /api key/i.test(err.message)) {
      return new AIError('auth', 'サーバーの API キーが無効です。', { status: 503 });
    }
    if (err.status === 401 || err.status === 403) return new AIError('auth', 'サーバーの API キーが無効か、権限がありません。', { status: 503 });
    if (err.status === 404) return new AIError('model', 'AI モデルが見つかりません（GEMINI_MODEL を確認してください）。', { status: 503 });
    if (err.status === 400) return new AIError('bad_request', 'AI へのリクエストが拒否されました。', { status: 502 });
    return new AIError('api', `AI サーバーでエラーが発生しました（${err.status}）。`, { status: 502, retryable: true });
  }
  if (err?.name === 'AbortError' || /timeout|timed out/i.test(err?.message || '')) {
    return new AIError('timeout', 'AI の応答に時間がかかりすぎました。', { status: 504, retryable: true });
  }
  return new AIError('network', 'AI サーバーに接続できませんでした。', { status: 503, retryable: true });
}

/**
 * 1 発言を生成する。reserve() は API を 1 回呼ぶ直前に呼ばれ、上限を超えていれば例外を投げる。
 * 重複時の作り直しも上限に数えるため、呼び出し回数は必ず reserve を通る。
 */
export async function generateTurn({ speaker, log, ctx, reserve = () => {} }) {
  const prompt = buildTurnPrompt({ speaker, log, ctx });
  let calls = 0;
  const take = () => {
    reserve();
    calls++;
  };
  take();
  let turn = normalizeTurn(await callJSON(prompt), prompt.analysis);

  if (!turn.text || findDuplicate(turn.text, log)) {
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
