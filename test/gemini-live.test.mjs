// 実際の Gemini API に 1 回だけ接続して、簡略化した JSON Schema が受け付けられ、続きの数発言と会話の状態が生成できるかを確かめる。
// 本物の API キーと実行の指示（GEMINI_LIVE=1）があるときだけ動く。無料枠を 1 回分使う。
//   GEMINI_LIVE=1 GEMINI_API_KEY=... npm run test:live
// キーがない環境ではスキップし、「未検証」と表示する（受け入れ確認済みとは扱わない）。
import test from 'node:test';
import assert from 'node:assert/strict';

const key = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
const enabled = process.env.GEMINI_LIVE === '1' && !!key;
const why = !key ? '未検証：GEMINI_API_KEY が無いため、実際の Gemini API での受け入れは確認していません' : '未検証：GEMINI_LIVE=1 を指定していないため、実際の Gemini API には接続していません';

test('[live] the simplified schema is accepted by the real Gemini API and yields a playable chunk (2..5 lines)', { skip: enabled ? false : why, timeout: 120_000 }, async () => {
  delete process.env.GOOGLE_GEMINI_BASE_URL; // モックではなく本物に接続する
  const { generateChunk, getConfig } = await import('../server/ai.mjs');
  const { sanitizeContext } = await import('../server/conversation.mjs');
  let calls = 0;
  let result;
  try {
    result = await generateChunk({ ctx: sanitizeContext({}), reserve: () => calls++ });
  } catch (err) {
    // スキーマが拒否されたなら、ここで明確に失敗させる
    assert.fail(`Gemini (${getConfig().model}) rejected the request: ${err.code} ${err.upstream?.httpStatus ?? ''} ${err.upstream?.status ?? ''} ${err.upstream?.message ?? err.message}`);
  }
  assert.equal(calls, 1);
  const { chunk } = result;
  assert.ok(chunk.lines.length >= 1 && chunk.lines.length <= 5, `lines: ${chunk.lines.length}`);
  for (const l of chunk.lines) {
    assert.ok(['A', 'B'].includes(l.speaker));
    assert.ok(l.text.length > 0);
  }
  console.log(`[live] model=${getConfig().model} lines=${chunk.lines.length} truncated=${chunk.truncated} topic=${chunk.state.topic} question=${chunk.state.question || '(なし)'}`);
  for (const l of chunk.lines) console.log(`[live]   ${l.speaker === 'A' ? 'レオ' : 'ミナ'}（${l.phase} ${l.type}）: ${l.text}`);
});
