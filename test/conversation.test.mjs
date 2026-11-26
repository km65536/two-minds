import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSystemPrompt,
  buildChunkPrompt,
  sanitizeContext,
  sanitizeState,
  sanitizeInterrupt,
  normalizeChunk,
  mergeState,
  salvageChunk,
  parseTag,
  cleanText,
  similarity,
  emptyState,
  CHARACTERS,
  CHUNK_SCHEMA,
  MODEL_FIELDS,
  LINE_FIELDS,
  CHUNK_MAX_LINES,
  LINE_MAX,
} from '../server/conversation.mjs';
import { demoChunk } from '../server/demo.mjs';

const rng = (v) => () => v;
// Gemini が実際に返す平らな形
const L = (speaker, text, extra = {}) => ({ speaker, text, expression: 'neutral', action: 'none', tag: 'FREE chat none', ...extra });
const out = (lines, extra = {}) => ({ lines, topic: 'お茶', summary: 'お茶の話', question: '', kind: '', status: 'none', leo_view: '', mina_view: '', explored: '', known: '', open_points: '', next_focus: '', deferred: '', mood: '', boundary: 'no', note_leo: '', note_mina: '', ...extra });
const said = (lines) => lines.map((l) => ({ kind: 'say', speaker: l.speaker, text: l.text }));

// ---------- 人格とプロンプト ----------

test('system prompt: both personas, equal intelligence, curiosity, plain spoken language', () => {
  const p = buildSystemPrompt();
  for (const c of Object.values(CHARACTERS)) for (const t of c.traits) assert.ok(p.includes(t));
  assert.match(p, /上下はない/);
  assert.match(p, /いつもレオがとっぴで、いつもミナが正しく訂正する、という形にしない/);
  assert.match(p, /本当に納得したら、素直に同意する。無理に対立しない/);
  assert.match(p, /分からないことは分からないと言う。事実と推測を区別する/);
  assert.match(p, /関係.*決めない/);
  assert.match(p, /面白い言葉を使うことではなく、面白いことを考える/);
  assert.match(p, /講義のような説明口調/);
  assert.match(p, /すべてを哲学や学問の話にしない/);
});

test('system prompt: chunks are a transport detail; progress in every chunk; problems are pursued', () => {
  const p = buildSystemPrompt();
  assert.match(p, /通信の都合です。会話の内容まで区切らない/);
  assert.match(p, /数発言の中でも、何か一つは進める/);
  assert.match(p, /それを解くことを最優先する/);
  assert.match(p, /deferred に書いて後回し/);
  assert.match(p, /問題を出しただけで別の話に移らない/);
  assert.match(p, /事実として正解がある問題は正確さを最優先/);
  assert.match(p, /原則 3 個/);
  assert.match(p, /必ずしも交互でなくていい/);
});

test('system prompt: forbidden conversation patterns are listed', () => {
  const p = buildSystemPrompt();
  for (const re of [/抽象的な意見を言い合うだけ/, /難しい単語を並べるだけ/, /毎回レオがとっぴなことを言って、ミナが論理的に訂正する/, /毎回同じように問題を出して/, /質問だけが続く/, /何でも哲学の問題にする/, /問題を出してすぐ別の話に移る/, /何も考えずに相手に同意するだけ/]) assert.match(p, re);
});

test('chunk prompt: a fresh conversation starts from everyday life without greetings', () => {
  const p = buildChunkPrompt({ ctx: sanitizeContext({}), rng: rng(0.1) });
  assert.match(p.user, /会話の始まり。あいさつから入らず/);
  assert.match(p.user, /日常の話から自然に始める/);
  assert.match(p.user, /まだ何も話していない/);
  assert.match(p.user, /原則 3 つ（2〜5 つ）/);
});

test('chunk prompt: passes the structured state (problem, both views, explored, known, open points, focus, mood)', () => {
  const ctx = sanitizeContext({
    state: { topic: 'お茶', summary: 'ぬるいお茶の話', question: 'ぬるいお茶はなぜまずい', status: 'exploring', leo_view: '期待とのズレ', mina_view: '香り', explored: ['舌'], known: ['温度で香りが変わる'], open_points: ['期待の影響'], next_focus: '期待を確かめる方法', mood: 'じっくり', phase: 'EXPLORATION', age: 2 },
    recent: [{ kind: 'say', speaker: 'B', text: '香りだと思う' }],
    backlog: ['氷はなぜ浮く'],
    topics: ['靴下'],
    notes: { A: ['ミナは定義にこだわる'], B: ['レオはすぐたとえる'] },
  });
  const u = buildChunkPrompt({ ctx, rng: rng(0.9) }).user;
  for (const s of ['いまの問い: ぬるいお茶はなぜまずい（考えている途中）', 'レオの今の考え: 期待とのズレ', 'ミナの今の考え: 香り', '検討したこと: 舌', '分かったこと: 温度で香りが変わる', 'まだ分からないこと: 期待の影響', '次に考えること: 期待を確かめる方法', '雰囲気: じっくり', '後回しにしている疑問', '氷はなぜ浮く', '最近話した話題', '靴下', 'レオだけが覚えていること: ミナは定義にこだわる', 'ミナ: 香りだと思う']) assert.ok(u.includes(s), s);
  // 未解決の問題は、話題を変えずに追究を続ける
  assert.match(u, /話題を変えずに、この問題を一歩進める（次に考えること: 期待を確かめる方法）/);
  assert.match(u, /直前に話したのはミナ/);
});

test('chunk prompt: a long-running problem is steered toward a conclusion or an explicit "unknown"', () => {
  const ctx = sanitizeContext({ state: { question: 'Q', status: 'exploring', age: 7, phase: 'EXPLORATION' } });
  assert.match(buildChunkPrompt({ ctx, rng: rng(0.5) }).user, /そろそろ結論をまとめるか、今は分からないと確かめて区切りをつける/);
});

test('chunk prompt: after a resolution it moves on (aftermath variety); long small talk may raise a problem', () => {
  const resolved = sanitizeContext({ state: { question: 'Q', status: 'resolved', phase: 'RESOLUTION' }, recent: [{ kind: 'say', speaker: 'A', text: 'なるほどね' }] });
  const a = new Set([0.05, 0.3, 0.5, 0.7, 0.95].map((r) => buildChunkPrompt({ ctx: resolved, rng: rng(r) }).user.match(/次は「(.+?)」流れ/)[1]));
  assert.ok(a.size >= 3, `aftermath variety: ${[...a]}`);
  const chatty = sanitizeContext({ state: { free_run: 2, phase: 'FREE', summary: '雑談' }, recent: [{ kind: 'say', speaker: 'A', text: '今日は寒いね' }] });
  assert.match(buildChunkPrompt({ ctx: chatty, rng: rng(0.5) }).user, /気になることが見つかったら問題として出してもいい（無理に作らない）/);
});

test('chunk prompt: the observer interrupt comes first and may change hypotheses', () => {
  const ctx = sanitizeContext({ state: { question: '服がくっつく理由', status: 'exploring', leo_view: '仲良し', mina_view: '洗剤' }, recent: [{ kind: 'say', speaker: 'A', text: 'なんでくっつくんだろう' }, { kind: 'player', text: '答えは静電気だよ' }] });
  const u = buildChunkPrompt({ ctx, interrupt: sanitizeInterrupt({ text: '答えは静電気だよ' }), rng: rng(0.5) }).user;
  assert.match(u, /観察者がたった今「答えは静電気だよ」と話しかけてきた/);
  assert.match(u, /最初の発言は観察者への反応/);
  assert.match(u, /答えを教えられたら、それを考慮して議論を進める/);
  assert.match(u, /観察者: 答えは静電気だよ/);
  assert.match(u, /ミナの今の考え: 洗剤/);
});

test('sanitizers cap sizes and reject junk', () => {
  const ctx = sanitizeContext({ recent: Array(50).fill({ kind: 'say', speaker: 'Z', text: 'x' }), backlog: Array(20).fill('q'), topics: Array(20).fill('t'), state: { question: '', status: 'resolved', age: 'x', explored: Array(20).fill('e') } });
  assert.equal(ctx.recent.length, 10);
  assert.equal(ctx.recent[0].speaker, 'A');
  assert.equal(ctx.backlog.length, 5);
  assert.equal(ctx.topics.length, 8);
  assert.equal(ctx.state.status, 'none'); // 問いが無ければ状態も無し
  assert.equal(ctx.state.age, 0);
  assert.equal(sanitizeState({ explored: Array(20).fill('e'), question: 'q' }).explored.length, 6);
  assert.equal(sanitizeInterrupt({ text: '   ' }), null);
  assert.equal(sanitizeInterrupt({ text: 'あ'.repeat(500) }).text.length, 100);
  assert.deepEqual(sanitizeContext(null).state, emptyState());
});

// ---------- スキーマ ----------

function schemaStats(schema) {
  const st = { enums: 0, limits: 0, depth: 0, objects: 0, keywords: new Set(), types: new Set() };
  const walk = (n, d) => {
    st.depth = Math.max(st.depth, d);
    Object.keys(n).forEach((k) => st.keywords.add(k));
    st.types.add(n.type);
    if (n.enum) st.enums++;
    for (const k of ['minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum']) if (k in n) st.limits++;
    if (n.type === 'object') {
      st.objects++;
      Object.values(n.properties).forEach((v) => walk(v, d + 1));
    }
    if (n.type === 'array') walk(n.items, d + 1);
  };
  walk(schema, 0);
  return st;
}

test('schema stays simple (the form Gemini accepted): no enum, no limits, one array of flat objects', () => {
  const st = schemaStats(CHUNK_SCHEMA);
  assert.equal(st.enums, 0);
  assert.equal(st.limits, 0);
  assert.equal(st.objects, 2);
  assert.ok(st.depth <= 3);
  assert.deepEqual([...st.types].sort(), ['array', 'object', 'string']);
  for (const k of st.keywords) assert.ok(['type', 'properties', 'required', 'items', 'propertyOrdering'].includes(k), k);
  assert.deepEqual(LINE_FIELDS, ['speaker', 'text', 'expression', 'action', 'tag']);
  assert.equal(MODEL_FIELDS[0], 'lines'); // 発言 → その発言を踏まえた状態、の順
  for (const k of ['topic', 'summary', 'question', 'kind', 'status', 'leo_view', 'mina_view', 'explored', 'known', 'open_points', 'next_focus', 'deferred', 'mood', 'boundary']) assert.ok(MODEL_FIELDS.includes(k), k);
  assert.ok(JSON.stringify(CHUNK_SCHEMA).length < 2000);
});

test('the value choices removed from the schema are described in the prompt', () => {
  const p = buildSystemPrompt();
  for (const k of MODEL_FIELDS) assert.ok(p.includes(k), k);
  for (const v of ['neutral', 'surprised', 'troubled', 'nod', 'look_away', 'EXPLORATION', 'AFTERMATH', 'discovery', 'hypothesis', 'reasoning', 'objection', 'agree', 'conclusion', 'joke', 'answer_player']) assert.ok(p.includes(v), v);
});

// ---------- 出力の検証 ----------

test('normalizeChunk: 3 lines in order; tolerant parsing of speaker, expression, action and tag', () => {
  const c = normalizeChunk(out([L('レオ', 'ねえ、お茶がぬるい', { expression: '笑顔', action: 'うなずく', tag: 'FREE, chat' }), L('mina', 'なんでぬるいとまずいんだろう', { expression: 'THINKING', tag: 'discovery DISCOVERY short' }), L('A', '期待とのズレかも', { expression: '???', action: 'dance', tag: '仮説' })]));
  assert.deepEqual(c.lines.map((l) => l.speaker), ['A', 'B', 'A']);
  assert.deepEqual(c.lines[0], { speaker: 'A', text: 'ねえ、お茶がぬるい', expression: 'smile', action: 'nod', type: 'chat', phase: 'FREE', pause: 'none' });
  assert.deepEqual([c.lines[1].phase, c.lines[1].type, c.lines[1].pause], ['DISCOVERY', 'discovery', 'short']);
  assert.deepEqual([c.lines[2].phase, c.lines[2].type, c.lines[2].expression, c.lines[2].action], ['DISCOVERY', 'hypothesis', 'neutral', 'none']); // 状態は直前を引き継ぐ
  assert.deepEqual(parseTag('', 'EXPLORATION'), { phase: 'EXPLORATION', type: 'chat', pause: 'none' });
});

test('normalizeChunk: variable size 2..5; extra lines are cut; unexpected speakers, empty and duplicate lines are dropped', () => {
  assert.equal(normalizeChunk(out([L('A', 'ひとつ目の発言'), L('B', 'ふたつ目の発言')])).lines.length, 2);
  const five = normalizeChunk(out(Array.from({ length: 5 }, (_, i) => L(i % 2 ? 'B' : 'A', `発言その${'一二三四五'[i]}、それぞれ内容が違う`))));
  assert.equal(five.lines.length, 5);
  const many = normalizeChunk(out(Array.from({ length: 9 }, (_, i) => L(i % 2 ? 'B' : 'A', `発言その${'一二三四五六七八九'[i]}、内容が違う${'あいうえおかきくけ'[i]}`))));
  assert.equal(many.lines.length, CHUNK_MAX_LINES);
  const junk = normalizeChunk(out([L('C', '誰？'), L('A', ''), null, { speaker: 'B' }, L('B', 'ほんとだね'), L('B', 'ほんとだね'), L('A', 'レオ: （笑いながら）だよね')]));
  assert.deepEqual(junk.lines.map((l) => l.text), ['ほんとだね', 'だよね']);
  assert.equal(normalizeChunk(out([L('Z', 'x')])), null);
  assert.equal(normalizeChunk('nope'), null);
});

test('normalizeChunk: lines repeating the previous chunk are removed (no duplicate at chunk boundaries)', () => {
  const recent = said([L('A', '靴下が片方だけなくなるのはなぜだろう')]);
  const c = normalizeChunk(out([L('A', '靴下が片方だけなくなるのはなぜだろう'), L('B', '洗濯機かな'), L('A', 'かもね')]), { recent });
  assert.deepEqual(c.lines.map((l) => l.text), ['洗濯機かな', 'かもね']);
});

test('too-long lines are cut at a sentence boundary', () => {
  const long = `${'これはとても長い説明です。'.repeat(12)}`;
  const t = cleanText(long);
  assert.ok(t.length <= LINE_MAX);
  assert.ok(t.endsWith('。'));
  assert.ok(cleanText('あ'.repeat(300)).endsWith('…'));
});

test('state: an unresolved problem is carried over; missing fields keep previous values', () => {
  const prev = sanitizeState({ topic: 'お茶', question: 'ぬるいお茶はなぜまずい', status: 'exploring', leo_view: '期待', mina_view: '香り', known: ['温度で香りが変わる'], phase: 'EXPLORATION', age: 2 });
  const c = normalizeChunk(out([L('A', '期待もあると思うな', { tag: 'EXPLORATION reasoning' }), L('B', 'それは確かめにくい', { tag: 'EXPLORATION objection' })], { topic: '', question: '', status: '', leo_view: '', mina_view: '' }), { prev });
  assert.equal(c.state.question, 'ぬるいお茶はなぜまずい');
  assert.equal(c.state.status, 'exploring');
  assert.equal(c.state.leo_view, '期待');
  assert.deepEqual(c.state.known, ['温度で香りが変わる']);
  assert.equal(c.state.topic, 'お茶');
  assert.equal(c.state.age, 3);
});

test('state: resolution then aftermath closes the question; a new question starts its own count', () => {
  const s1 = sanitizeState({ question: 'Q1', status: 'exploring', phase: 'EXPLORATION', age: 3 });
  const s2 = mergeState(s1, { question: 'Q1', status: 'resolved' }, [{ phase: 'RESOLUTION' }]);
  assert.equal(s2.status, 'resolved');
  const s3 = mergeState(s2, { question: 'Q1', status: 'resolved' }, [{ phase: 'AFTERMATH' }]);
  assert.equal(s3.question, '');
  assert.equal(s3.status, 'none');
  assert.equal(s3.free_run, 1);
  const s4 = mergeState(s3, { question: '氷はなぜ浮く', status: 'exploring' }, [{ phase: 'DISCOVERY' }]);
  assert.equal(s4.age, 1);
  assert.equal(s4.free_run, 0);
  assert.equal(mergeState(s1, { question: 'Q1', status: '未解決' }, [{ phase: 'RESOLUTION' }]).status, 'unresolved');
});

test('state: two different opinions are kept separately', () => {
  const c = normalizeChunk(out([L('A', '僕は期待だと思う', { tag: 'EXPLORATION hypothesis' }), L('B', 'わたしは香り', { tag: 'EXPLORATION objection' })], { question: 'なぜ？', status: 'exploring', leo_view: '期待とのズレ', mina_view: '香りの変化' }));
  assert.notEqual(c.state.leo_view, c.state.mina_view);
});

test('boundary and deferred questions are read', () => {
  const c = normalizeChunk(out([L('A', 'なるほどね'), L('B', 'すっきりした')], { boundary: 'yes', deferred: '氷はなぜ浮く / 雪はなぜ白い' }));
  assert.equal(c.boundary, true);
  assert.deepEqual(c.deferred, ['氷はなぜ浮く', '雪はなぜ白い']);
});

test('salvageChunk: recovers complete lines from a truncated JSON (strings with braces and quotes)', () => {
  const full = JSON.stringify(out([L('A', '括弧 {こういうの} と "引用" があっても'), L('B', 'だいじょうぶ？'), L('A', 'ここで切れる')]));
  const cut = full.slice(0, full.indexOf('ここで切れる') + 3);
  const s = salvageChunk(cut);
  assert.equal(s.lines.length, 2);
  assert.equal(s.lines[0].text, '括弧 {こういうの} と "引用" があっても');
  const c = normalizeChunk(s, { prev: sanitizeState({ question: 'Q', status: 'exploring', phase: 'EXPLORATION' }), truncated: true });
  assert.equal(c.lines.length, 2);
  assert.equal(c.truncated, true);
  assert.equal(c.state.question, 'Q'); // 状態が読めなければ前の状態を引き継ぐ
  assert.equal(salvageChunk('{"topic":"x"'), null);
});

test('similarity', () => {
  assert.equal(similarity('今日はいい天気だね', '今日はいい天気だね'), 1);
});

// ---------- デモ ----------

test('demo: scripts are played in chunks of up to 3 lines, in order, and react to the observer', () => {
  let ctx = sanitizeContext({ state: { cursor: '0:0' } });
  const seen = [];
  for (let i = 0; i < 4; i++) {
    const ch = demoChunk({ ctx, interrupt: null });
    assert.ok(ch.lines.length >= 1 && ch.lines.length <= 3);
    seen.push(...ch.lines.map((l) => l.text));
    ctx = sanitizeContext({ state: ch.state, recent: said(ch.lines) });
  }
  assert.equal(new Set(seen).size, seen.length); // 重複なし
  assert.match(seen[2], /片方だけ/); // 日常会話 → 問題提起
  const r = demoChunk({ ctx, interrupt: { text: 'こんばんは' } });
  assert.match(r.lines[0].text, /こんばんは/);
  assert.equal(r.lines[0].type, 'answer_player');
});
