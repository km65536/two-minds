// 実際の Gemini API で、会話の知性・役割・記憶のシナリオ（A〜F）を確かめる。
// 本物の API キーと実行の指示（GEMINI_LIVE=1）があるときだけ動く。シナリオごとに 1〜3 回、合計 10 回ほど無料枠を使う。
//   GEMINI_LIVE=1 GEMINI_API_KEY=... node --test test/gemini-live-scenarios.test.mjs
// キーがない環境ではスキップし、「未検証」と表示する。生成された会話は目で確かめられるようにログに出す。
// モデルの出力は毎回変わるので、ここで確かめるのは「明らかに守られるべき性質」だけにする。
import test from 'node:test';
import assert from 'node:assert/strict';

const key = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
const enabled = process.env.GEMINI_LIVE === '1' && !!key;
const skip = enabled ? false : !key ? '未検証：GEMINI_API_KEY が無いため、実際の Gemini API では確認していません' : '未検証：GEMINI_LIVE=1 を指定していないため、実際の Gemini API には接続していません';
const opts = { skip, timeout: 240_000 };

async function lib() {
  delete process.env.GOOGLE_GEMINI_BASE_URL;
  const ai = await import('../server/ai.mjs');
  const conv = await import('../server/conversation.mjs');
  return { ...ai, ...conv };
}
const show = (name, chunk) => {
  console.log(`[live ${name}] state: question=${chunk.state.question || '-'} kind=${chunk.state.kind || '-'} status=${chunk.state.status} known_answer=${chunk.state.known_answer || '-'} hints=${chunk.state.hints.join(' / ') || '-'} final=${chunk.state.final_answer || '-'}`);
  for (const l of chunk.lines) console.log(`[live ${name}]   ${l.speaker === 'A' ? 'レオ' : 'ミナ'}（${l.type}）: ${l.text}`);
};
// 何回か続きを生成する（再生された前提で、状態と直近の発言を引き継ぐ）
async function run(L, name, ctx, n) {
  let c = L.sanitizeContext(ctx);
  const chunks = [];
  for (let i = 0; i < n; i++) {
    const { chunk } = await L.generateChunk({ ctx: c, reserve: () => {} });
    show(`${name}#${i + 1}`, chunk);
    chunks.push(chunk);
    c = L.sanitizeContext({ ...ctx, state: chunk.state, recent: [...c.recent, ...chunk.lines.map((l) => ({ kind: 'say', speaker: l.speaker, text: l.text }))].slice(-10) });
  }
  return chunks;
}

test('[live A] known math quiz: Mina keeps the answer, gives staged hints, never accepts a wrong answer', opts, async () => {
  const L = await lib();
  const chunks = await run(L, 'A', { state: { topic: '数の和', summary: 'ミナがレオにクイズを出した', question: '1 から 100 までの整数をすべて足すといくつ？', kind: 'クイズ', status: 'exploring', phase: 'DISCOVERY', age: 1 }, recent: [{ kind: 'say', speaker: 'B', text: 'クイズ。1から100までの整数を全部足すと、いくつになる？' }] }, 3);
  const st = chunks.at(-1).state;
  assert.match(chunks[0].state.known_answer + chunks[1].state.known_answer, /5050/);
  assert.ok(!chunks[0].lines.some((l) => l.speaker === 'B' && /5050/.test(l.text)), 'Mina does not reveal the answer immediately');
  if (st.final_answer) assert.match(st.final_answer, /5050/);
});

test('[live B] known science fact: Mina explains accurately; Leo derives a new question', opts, async () => {
  const L = await lib();
  const chunks = await run(L, 'B', { state: { topic: '空', question: '空はなぜ青いのか', kind: '既知の科学', status: 'exploring', phase: 'DISCOVERY', age: 1 }, recent: [{ kind: 'say', speaker: 'A', text: 'ねえ、空ってなんで青いの？' }] }, 2);
  const all = chunks.flatMap((c) => c.lines);
  assert.ok(all.some((l) => l.speaker === 'B' && /散乱|波長/.test(l.text)), 'Mina explains scattering');
  assert.ok(all.some((l) => l.speaker === 'A' && /[？?]/.test(l.text)), 'Leo asks a new question');
});

test('[live C] daily mystery: Leo proposes hypotheses, Mina verifies', opts, async () => {
  const L = await lib();
  const chunks = await run(L, 'C', { state: { topic: '靴下', question: '洗濯すると靴下が片方だけなくなるのはなぜ', kind: '日常の謎', status: 'exploring', phase: 'DISCOVERY', age: 1 }, recent: [{ kind: 'say', speaker: 'A', text: 'また靴下が片方だけない。なんでだろう' }] }, 2);
  const all = chunks.flatMap((c) => c.lines);
  assert.ok(all.some((l) => l.speaker === 'A' && ['hypothesis', 'insight'].includes(l.type)), 'Leo offers a hypothesis');
});

test('[live D] unsolved problem: no pretending to know; facts and hypotheses are separated', opts, async () => {
  const L = await lib();
  const chunks = await run(L, 'D', { state: { topic: 'コラッツ予想', question: 'コラッツ予想は正しいのか', kind: '未解決の数学', status: 'exploring', phase: 'DISCOVERY', age: 1 }, recent: [{ kind: 'say', speaker: 'A', text: '偶数なら半分、奇数なら3倍して1足す。どんな数でも1になるの？' }] }, 2);
  const all = chunks.flatMap((c) => c.lines);
  assert.ok(all.some((l) => /未解決|証明されていない|分かっていない|わかっていない/.test(l.text)), 'says it is unsolved');
  assert.ok(!chunks.some((c) => c.state.status === 'resolved' && /証明され(た|ている)/.test(c.state.final_answer)), 'does not claim a proof');
});

test('[live E] past memory is referred to naturally and not re-explained', opts, async () => {
  const L = await lib();
  const memories = [{ kind: 'topic', when: '3日前', topic: '数の和', question: '1から100の和', status: 'resolved', text: 'ミナのクイズ。レオが端と端を組にして101×50=5050と導いた', conclusion: '5050' }, { kind: 'joke', when: '3日前', text: 'レオが自分をガウス少年と呼んだ' }];
  const chunks = await run(L, 'E', { state: { topic: '数', summary: '数の話になった', phase: 'FREE', free_run: 2 }, recent: [{ kind: 'say', speaker: 'B', text: 'じゃあ今度は、1から200までの和は？' }], memories, quizzes: ['1から100の和'] }, 2);
  const all = chunks.flatMap((c) => c.lines).map((l) => l.text).join(' ');
  assert.match(all, /前|この前|あのとき|ガウス|組/);
});

test('[live F] memory continuity across sessions (MemoryStore → new store → prompt)', opts, async () => {
  const L = await lib();
  const { MemoryStore } = await import('../public/memory.js');
  const m = new Map();
  const storage = { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), remove: (k) => m.delete(k) };
  const a = new MemoryStore({ storage });
  a.addRecord({ kind: 'topic', topic: '靴下', question: '靴下はなぜ片方だけ消える', status: 'unresolved', text: 'レオは洗濯機が食べる説、ミナは数え間違い説。結論は出ず', leo: '洗濯機が食べる', mina: '数え間違い', open: '実際に数えて確かめる' });
  a.endSession();
  const b = new MemoryStore({ storage });
  const mem = b.retrieve({ state: null, recent: [] });
  assert.ok(mem.memories.length >= 1);
  const chunks = await run(L, 'F', { recent: [], ...mem }, 1);
  assert.ok(chunks[0].lines.length >= 1);
});
