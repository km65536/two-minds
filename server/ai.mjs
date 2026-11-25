// Claude API 呼び出し。API キーはサーバー側の環境変数からのみ読み込む。
import Anthropic from '@anthropic-ai/sdk';
import {
  buildTurnPrompt,
  buildMemoryPrompt,
  TURN_SCHEMA,
  MEMORY_SCHEMA,
  normalizeTurn,
  normalizeMemory,
  findDuplicate,
} from './conversation.mjs';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// サーバー側フォールバック（fallbacks: "default"）に対応しているモデル
const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class AIError extends Error {
  constructor(code, message, { status = 502, retryable = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function getConfig() {
  const model = process.env.ANTHROPIC_MODEL?.trim() || 'claude-opus-5-5';
  const memoryModel = process.env.MEMORY_MODEL?.trim() || model;
  const effort = EFFORTS.includes(process.env.CONVERSATION_EFFORT) ? process.env.CONVERSATION_EFFORT : 'low';
  const memoryEffort = EFFORTS.includes(process.env.MEMORY_EFFORT) ? process.env.MEMORY_EFFORT : 'medium';
  const fallbacks = (process.env.ANTHROPIC_FALLBACKS ?? 'on').toLowerCase() !== 'off';
  return { model, memoryModel, effort, memoryEffort, fallbacks };
}

export function hasCredentials() {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim());
}

let client = null;
function getClient() {
  if (!client) {
    // 1回だけ SDK 内部でリトライ（429 / 5xx / 接続エラー）。無限リトライはしない。
    client = new Anthropic({ maxRetries: 1, timeout: 90_000 });
  }
  return client;
}

/** 構造化出力（JSON Schema）で 1 回呼び出し、パース済みオブジェクトを返す */
async function callJSON({ model, effort, system, user, schema, maxTokens }) {
  const params = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort, format: { type: 'json_schema', schema } },
  };
  const c = getClient();
  let res;
  try {
    if (getConfig().fallbacks && FALLBACK_MODELS.has(model)) {
      res = await c.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' });
    } else {
      res = await c.messages.create(params);
    }
  } catch (err) {
    throw toAIError(err);
  }

  if (res.stop_reason === 'refusal') {
    throw new AIError('refusal', 'AI がこの発言の生成を控えました。話題を変えるか、そのまま続けてください。', { status: 422, retryable: true });
  }
  if (res.stop_reason === 'max_tokens') {
    throw new AIError('max_tokens', '応答が長すぎて途中で切れました。', { status: 502, retryable: true });
  }
  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  try {
    return { data: JSON.parse(text), usage: res.usage, model: res.model };
  } catch {
    throw new AIError('bad_output', 'AI の応答を読み取れませんでした。', { status: 502, retryable: true });
  }
}

function toAIError(err) {
  if (err instanceof AIError) return err;
  if (err instanceof Anthropic.AuthenticationError) {
    return new AIError('auth', 'API キーが無効です。.env の ANTHROPIC_API_KEY を確認してください。', { status: 401 });
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new AIError('permission', 'この API キーではモデルを利用できません。', { status: 403 });
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new AIError('model', `モデルが見つかりません。ANTHROPIC_MODEL の設定を確認してください。`, { status: 400 });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AIError('rate_limit', 'API のレート制限に達しました。少し待ってから再開してください。', { status: 429, retryable: true });
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new AIError('bad_request', `API リクエストが拒否されました: ${err.message}`.slice(0, 300), { status: 400 });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AIError('network', 'AI サーバーに接続できませんでした。', { status: 503, retryable: true });
  }
  if (err instanceof Anthropic.APIError) {
    return new AIError('api', `AI サーバーでエラーが発生しました（${err.status ?? '?'}）。`, { status: 502, retryable: true });
  }
  return new AIError('unknown', '予期しないエラーが発生しました。', { status: 500 });
}

export async function generateTurn({ speaker, chars, log, memory, relationship }) {
  const cfg = getConfig();
  const prompt = buildTurnPrompt({ speaker, chars, log, memory, relationship });
  let { data, usage } = await callJSON({
    model: cfg.model,
    effort: cfg.effort,
    system: prompt.system,
    user: prompt.user,
    schema: TURN_SCHEMA,
    maxTokens: 4000,
  });
  let turn = normalizeTurn(data, chars);

  // 重複防止：直近と似すぎた発言・空発言なら 1 回だけ作り直す
  const dup = turn.text ? findDuplicate(turn.text, log) : { text: '' };
  if (dup) {
    const retry = await callJSON({
      model: cfg.model,
      effort: cfg.effort,
      system: prompt.system,
      user: `${prompt.user}\n\n# 注意\n次の発言は直前の会話と内容・言い回しが重複していたので使えません。違う角度・違う言葉で話してください:\n「${turn.text}」`,
      schema: TURN_SCHEMA,
      maxTokens: 4000,
    });
    const t2 = normalizeTurn(retry.data, chars);
    if (t2.text && !findDuplicate(t2.text, log)) {
      turn = t2;
      usage = retry.usage;
    } else if (!turn.text) {
      throw new AIError('empty', 'AI が発言を生成できませんでした。', { status: 502, retryable: true });
    }
  }
  return { ...turn, usage: summarizeUsage(usage) };
}

export async function extractMemory({ chars, entries, memory }) {
  const cfg = getConfig();
  const prompt = buildMemoryPrompt({ chars, entries, memory });
  const { data, usage } = await callJSON({
    model: cfg.memoryModel,
    effort: cfg.memoryEffort,
    system: prompt.system,
    user: prompt.user,
    schema: MEMORY_SCHEMA,
    maxTokens: 8000,
  });
  return { ...normalizeMemory(data), usage: summarizeUsage(usage) };
}

function summarizeUsage(u) {
  if (!u) return null;
  return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
}
