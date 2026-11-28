import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, whenLabel, kindClass } from '../public/memory.js';
import { sanitizeContext, buildChunkPrompt } from '../server/conversation.mjs';

const DAY = 24 * 60 * 60 * 1000;
function memStorage() {
  const m = new Map();
  return { m, get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), remove: (k) => m.delete(k) };
}
function clock(t0 = Date.UTC(2026, 10, 20, 12)) {
  const c = { t: t0, now: () => c.t };
  return c;
}
const st = (o = {}) => ({ topic: '', summary: '', question: '', kind: '', status: 'none', leo_view: '', mina_view: '', explored: [], known: [], open_points: [], next_focus: '', known_answer: '', hints: [], final_answer: '', mood: '', phase: 'FREE', age: 0, free_run: 0, ...o });

// 3 発言ずつ再生して記録を確定する、エンジンと同じ呼び方
function play(mem, lines, before, after, extra = {}) {
  for (const [speaker, text, type] of lines) mem.addLine({ kind: 'say', speaker, text, type: type || 'chat', phase: after.phase });
  mem.onChunkCommitted({ before, after, recap: extra.recap || '', memos: extra.memos || [] });
}

function quizSession(mem) {
  const q = '1 から 100 までの整数の和はいくつ？';
  const s0 = st();
  const s1 = st({ topic: '数の和', question: q, kind: 'クイズ', status: 'exploring', phase: 'DISCOVERY', known_answer: '5050', age: 1 });
  play(mem, [['B', 'クイズ。1から100まで全部足すといくつ？', 'discovery'], ['A', '地道に足すのは嫌だなあ', 'chat'], ['B', 'ヒント。端と端を組にしてみて', 'reasoning']], s0, s1);
  const s2 = { ...s1, phase: 'EXPLORATION', hints: ['端と端を組にする'], age: 2 };
  play(mem, [['A', '1と100で101、2と99でも101だ', 'insight'], ['A', 'それが50組だから5050！', 'conclusion'], ['B', '正解。101が50組で5050', 'conclusion']], s1, { ...s2, status: 'resolved', phase: 'RESOLUTION', final_answer: '5050', known: ['端と端の和はいつも101'] }, { recap: 'ミナのクイズ「1から100の和」。レオが端と端を組にして101×50=5050と導いた', memos: [{ kind: 'quiz', text: '1から100の和（レオがヒント1つで正解）' }] });
  play(mem, [['A', 'なんか気持ちいいね', 'chat'], ['B', 'ガウスも子どもの頃に同じことをしたらしい', 'chat'], ['A', '僕、ガウス少年じゃん', 'joke']], s2, st({ topic: '数の和', phase: 'AFTERMATH', free_run: 1 }), { memos: [{ kind: 'joke', text: 'レオが自分をガウス少年と呼んだ' }] });
  return q;
}

test('segments: a question becomes one long-term record with its conclusion, views and source lines', () => {
  const c = clock();
  const mem = new MemoryStore({ storage: memStorage(), now: c.now });
  const q = quizSession(mem);
  const topics = mem.data.records.filter((r) => r.kind === 'topic');
  assert.equal(topics.length, 1);
  assert.equal(topics[0].question, q);
  assert.equal(topics[0].status, 'resolved');
  assert.equal(topics[0].conclusion, '5050');
  assert.match(topics[0].text, /5050/);
  assert.ok(mem.linesBetween(topics[0].from, topics[0].to).some((l) => /5050/.test(l.text)));
  assert.deepEqual(mem.data.quizzes, [q]);
  assert.ok(mem.data.records.some((r) => r.kind === 'quiz'));
  assert.ok(mem.data.records.some((r) => r.kind === 'joke'));
  assert.equal(mem.log.lines.length, 9);
});

test('interrupted (unplayed) content is not memorized: memos come only with committed chunks', () => {
  const mem = new MemoryStore({ storage: memStorage(), now: clock().now });
  // エンジンは、最後まで再生されなかった記録では onChunkCommitted を呼ばない。再生された 1 発言だけがログに残る
  mem.addLine({ kind: 'say', speaker: 'A', text: '靴下は旅に出るんだと思う', type: 'hypothesis' });
  mem.addLine({ kind: 'player', text: 'それは違うよ' });
  assert.equal(mem.data.records.length, 0);
  assert.equal(mem.log.lines.length, 2);
});

test('retrieval (E): only memories related to the current topic are returned, with an excerpt of the source lines', () => {
  const c = clock();
  const mem = new MemoryStore({ storage: memStorage(), now: c.now });
  quizSession(mem);
  mem.addRecord({ kind: 'topic', topic: '雨の匂い', question: '雨の匂いの正体は？', status: 'resolved', text: 'ペトリコールと土の細菌が作るゲオスミン', conclusion: 'ゲオスミン' });
  mem.addRecord({ kind: 'topic', topic: '靴下', question: '靴下はなぜ片方だけ消える？', status: 'unresolved', text: '洗濯機説と数え間違い説', open: '数えて確かめる' });
  c.t += 2 * DAY;
  const r = mem.retrieve({ state: st({ topic: '数の和', question: '1 から 1000 までの和は？', kind: 'クイズ', status: 'exploring' }), recent: [{ kind: 'say', speaker: 'B', text: '今度は1000までの和' }] });
  assert.ok(r.memories.length >= 1);
  const topic = r.memories.find((m) => m.kind === 'topic');
  assert.match(topic.question, /100 までの整数の和/);
  assert.equal(topic.when, '2日前');
  assert.ok(topic.excerpt.length > 0 && topic.excerpt.length <= 4);
  assert.ok(topic.excerpt.some((e) => /5050/.test(e.text)));
  assert.equal(r.memories.filter((m) => m.excerpt.length).length, 1);
  assert.ok(r.memories.some((m) => m.kind === 'quiz'));
  assert.ok(!r.memories.some((m) => /雨の匂い|靴下/.test(m.question)), 'unrelated topics are not recalled');
  assert.deepEqual(r.quizzes, ['1 から 100 までの整数の和はいくつ？']);
  // サーバー側でもそのまま受け取れて、プロンプトに載る
  const u = buildChunkPrompt({ ctx: sanitizeContext({ state: { question: '1 から 1000 までの和は？', status: 'exploring', kind: 'クイズ' }, ...r }), rng: () => 0.9 }).user;
  assert.match(u, /# 二人の記憶/);
  assert.match(u, /2日前・解決/);
  assert.match(u, /当時の発言:/);
  assert.match(u, /# ミナが前に出した問題/);
});

test('persistence (F): a new session (new store instance) remembers the previous conversation; the open question ends as "途中"', () => {
  const storage = memStorage();
  const c = clock();
  const a = new MemoryStore({ storage, now: c.now });
  quizSession(a);
  // 途中の問題を残したまま会話を終える
  play(a, [['A', '靴下って片方だけ消えない？', 'discovery'], ['B', '数え間違いの可能性が高い', 'hypothesis'], ['A', '洗濯機が食べてる説を推したい', 'hypothesis']], st(), st({ topic: '靴下', question: '靴下はなぜ片方だけ消える？', kind: '日常の謎', status: 'exploring', phase: 'EXPLORATION', leo_view: '洗濯機が食べる', mina_view: '数え間違い', open_points: ['実際に数えたことがない'] }));
  a.endSession();
  c.t += 1 * DAY;
  const b = new MemoryStore({ storage, now: c.now });
  assert.equal(b.data.sid, a.data.sid + 1);
  assert.equal(b.stats().records, a.stats().records);
  const open = b.data.records.find((r) => r.question === '靴下はなぜ片方だけ消える？');
  assert.equal(open.status, 'exploring');
  assert.equal(open.leo, '洗濯機が食べる');
  // 新しい会話の始まりには、重要で新しい記憶が少しだけ渡る
  const fresh = b.retrieve({ state: st(), recent: [] });
  assert.ok(fresh.memories.length >= 1 && fresh.memories.length <= 4);
  assert.ok(fresh.memories.some((m) => m.question === '靴下はなぜ片方だけ消える？'));
  assert.ok(fresh.memories.every((m) => m.when === '昨日'));
  // 話題に関係すれば、当時の考えも思い出す
  const rel = b.retrieve({ state: st({ topic: '靴下', question: '靴下の行方', status: 'exploring' }), recent: [{ kind: 'say', speaker: 'A', text: 'また靴下が片方ない' }] });
  assert.ok(rel.memories.some((m) => m.leo === '洗濯機が食べる'));
});

test('bounded: many records still yield a small payload; the server caps it again', () => {
  const c = clock();
  const mem = new MemoryStore({ storage: memStorage(), now: c.now, maxRecords: 200 });
  for (let i = 0; i < 400; i++) {
    c.t += 60 * 1000;
    mem.addRecord({ kind: i % 5 ? 'topic' : 'finding', topic: `話題${i}`, question: `問題その${i}について考える：${'色々な言葉'.repeat(i % 7)}${i}`, status: 'resolved', text: `${i}番目の要約。猫と月と数の話。`.repeat(4) });
  }
  assert.ok(mem.data.records.length <= 200);
  const r = mem.retrieve({ state: st({ topic: '猫', question: '猫はなぜ月を見る', status: 'exploring' }), recent: [{ kind: 'say', speaker: 'A', text: '猫と月の話' }] });
  assert.ok(r.memories.length <= 8);
  const ctx = sanitizeContext(r);
  assert.ok(JSON.stringify(ctx.memories).length <= 2400);
});

test('dedupe: talking about the same question again updates the memory instead of duplicating it', () => {
  const mem = new MemoryStore({ storage: memStorage(), now: clock().now });
  mem.addRecord({ kind: 'topic', question: '空はなぜ青い？', status: 'exploring', text: 'レイリー散乱の話の途中' });
  mem.addRecord({ kind: 'topic', question: '空はなぜ青いの？', status: 'resolved', text: '波長の短い青い光ほど強く散乱される（レイリー散乱）', conclusion: 'レイリー散乱' });
  const t = mem.data.records.filter((r) => r.kind === 'topic');
  assert.equal(t.length, 1);
  assert.equal(t[0].status, 'resolved');
  assert.equal(t[0].conclusion, 'レイリー散乱');
});

test('eviction keeps important and unresolved memories; old memories are not deleted while under capacity', () => {
  const c = clock();
  const mem = new MemoryStore({ storage: memStorage(), now: c.now, maxRecords: 10 });
  mem.addRecord({ kind: 'about_mina', text: 'ミナは数学の証明が好き' }); // 重要度 4
  mem.addRecord({ kind: 'topic', question: '双子素数は無限にある？', status: 'unresolved', importance: 4, text: '未解決' });
  c.t += 400 * DAY; // とても古くなっても、容量内なら消さない
  for (let i = 0; i < 8; i++) mem.addRecord({ kind: 'topic', topic: `雑談${i}`, text: `何気ない雑談その${i}番、${'ねこいぬとりさかな'.slice(i)}`, importance: 1 });
  assert.equal(mem.data.records.length, 10);
  for (let i = 0; i < 5; i++) mem.addRecord({ kind: 'topic', topic: `雑談追加${i}`, text: `別の雑談${i}号、${'あかさたなはまやらわ'.slice(i)}`, importance: 1 });
  assert.equal(mem.data.records.length, 10);
  assert.ok(mem.data.records.some((r) => r.kind === 'about_mina'));
  assert.ok(mem.data.records.some((r) => r.question === '双子素数は無限にある？'));
});

test('raw log is capped; clear() forgets everything; broken storage does not throw', () => {
  const storage = memStorage();
  const mem = new MemoryStore({ storage, now: clock().now, maxLines: 50 });
  for (let i = 0; i < 120; i++) mem.addLine({ kind: 'say', speaker: 'A', text: `発言${i}` });
  assert.equal(mem.log.lines.length, 50);
  assert.equal(mem.log.lines[0].text, '発言70');
  mem.save();
  mem.clear();
  assert.equal(mem.stats().records, 0);
  assert.equal(storage.m.size, 0);
  storage.set('twominds:memory:v1', '{broken');
  const m2 = new MemoryStore({ storage, now: clock().now });
  assert.equal(m2.stats().records, 0);
  const full = { get: () => null, set: () => { throw new Error('QuotaExceeded'); }, remove: () => {} };
  const m3 = new MemoryStore({ storage: full });
  m3.addLine({ text: 'x' });
  assert.doesNotThrow(() => m3.save());
});

test('labels and classes', () => {
  const now = Date.UTC(2026, 10, 27, 12);
  assert.equal(whenLabel(now - 5 * 60 * 1000, now), 'さっき');
  assert.equal(whenLabel(now - 3 * DAY, now), '3日前');
  assert.equal(whenLabel(now - 14 * DAY, now), '2週間前');
  assert.equal(kindClass('日常の謎'), 'mystery');
});
