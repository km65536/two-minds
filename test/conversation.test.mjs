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
  ROLE_TABLE,
  kindClass,
  parseMemo,
  MEMORY_KINDS,
  sanitizeMemories,
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

test('system prompt: both personas, different kinds of intelligence, no fixed roles, plain spoken language', () => {
  const p = buildSystemPrompt();
  for (const c of Object.values(CHARACTERS)) for (const t of c.traits) assert.ok(p.includes(t));
  assert.match(p, /二人とも非常に賢い。違うのは知性の種類/);
  assert.match(p, /単なる聞き役・解説役・生徒になることはない/);
  assert.match(p, /主導権は問題の種類で自然に入れ替わる（固定ではない）/);
  assert.match(p, /本当に納得したら素直に同意し、考えを改める/);
  assert.match(p, /無理な対立は作らない/);
  assert.match(p, /関係.*決めない/);
  assert.match(p, /講義口調/);
  assert.match(p, /すべてを真面目な議論にしない/);
  // ミナ: 膨大な知識、すぐ答えない、段階的ヒント、未解決は知ったふりをしない
  assert.match(p, /膨大な知識/);
  assert.match(p, /すぐには答えを言わない/);
  assert.match(p, /答えを知っているふりは絶対にしない/);
  // レオ: ひらめき、結びつける、直感→論理、未解決で主導
  assert.match(p, /一見関係のない事柄を結びつけ/);
  assert.match(p, /直感で先に結論が見え、そのあとで筋道を組み立てる/);
  assert.match(p, /議論を引っ張る/);
});

test('system prompt: role table by problem type covers all six kinds', () => {
  const p = buildSystemPrompt();
  assert.equal(ROLE_TABLE.length, 6);
  for (const r of ROLE_TABLE) for (const cell of r) assert.ok(p.includes(cell), cell);
  for (const s of ['既に証明された数学・論理パズル', '科学的な既知の事実', 'クイズ', '未解決の科学・数学の問題', '日常の謎', '哲学的な問題']) assert.ok(p.includes(s), s);
  assert.equal(kindClass('既知の数学'), 'known');
  assert.equal(kindClass('クイズ'), 'known');
  assert.equal(kindClass('論理パズル'), 'known');
  assert.equal(kindClass('既知の科学'), 'known');
  assert.equal(kindClass('未解決の数学'), 'unsolved');
  assert.equal(kindClass('日常の謎'), 'mystery');
  assert.equal(kindClass('哲学'), 'opinion');
  assert.equal(kindClass(''), 'chat');
});

test('system prompt: accuracy — no intentional mistakes, facts vs hypotheses, no pretending on unsolved problems', () => {
  const p = buildSystemPrompt();
  assert.match(p, /明らかに間違ったことを、わざと言わない/);
  assert.match(p, /5\+5=20/);
  assert.match(p, /間違いを面白さの演出に使わない/);
  assert.match(p, /確定した事実と、推測や仮説をはっきり区別する/);
  assert.match(p, /答えを知っているふりをしない/);
  assert.match(p, /レオの誤った答えを正解扱いしない/);
});

test('system prompt: solving protocol for problems with a definite answer; staged hints', () => {
  const p = buildSystemPrompt();
  assert.match(p, /条件を整理する → 必要な知識や公式を確かめる → 実際に計算・推論する → 結果を検算する → 最終的な答えをはっきり言う/);
  assert.match(p, /数値と単位を必ず言う/);
  assert.match(p, /何が足りないかを説明する/);
  assert.match(p, /答えが一つに決まらないなら、その理由を説明する/);
  assert.match(p, /曖昧なまま話題を変えない/);
  assert.match(p, /known_answer に書く/);
  assert.match(p, /段階的に（出したヒントは hints に記録する）/);
  assert.match(p, /ヒントを 3 つ出しても/);
});

test('system prompt: chunks are a transport detail; progress in every line; problems are pursued', () => {
  const p = buildSystemPrompt();
  assert.match(p, /通信の都合です。会話の内容まで区切らない/);
  assert.match(p, /どの発言も、何かを一歩進める/);
  assert.match(p, /それを解くことを最優先する/);
  assert.match(p, /deferred に書いて後回し/);
  assert.match(p, /原則 3 個/);
  assert.match(p, /必ずしも交互でなくていい/);
});

test('system prompt: forbidden conversation patterns are listed', () => {
  const p = buildSystemPrompt();
  for (const s of ['相手の発言の言い換えだけ', '毎回同意するだけ', '内容の薄い感想の繰り返し', '会話を続けるためだけの質問', '何度も同じ結論に戻る', '説明済みのことの説明し直し', '不自然な話題の切り替え', '毎回きれいにまとめようとする']) assert.ok(p.includes(s), s);
});

test('system prompt: memory usage rules', () => {
  const p = buildSystemPrompt();
  assert.match(p, /関係があるときだけ自然に持ち出す/);
  assert.match(p, /結論が出ている問題を説明し直さない/);
  assert.match(p, /前に出したクイズや問題を、同じように出し直さない/);
  for (const k of ['recap', 'memo', 'known_answer', 'hints', 'final_answer']) assert.ok(p.includes(k), k);
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
  for (const s of ['いまの問い: ぬるいお茶はなぜまずい（考えている途中）', 'レオの今の考え: 期待とのズレ', 'ミナの今の考え: 香り', '検討したこと・出た根拠: 舌', '確かめられたこと: 温度で香りが変わる', 'まだ分からないこと: 期待の影響', '次に考えること: 期待を確かめる方法', '雰囲気: じっくり', '後回しにしている疑問', '氷はなぜ浮く', '最近話した話題', '靴下', 'レオだけが覚えていること: ミナは定義にこだわる', 'ミナ: 香りだと思う']) assert.ok(u.includes(s), s);
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
  assert.match(buildChunkPrompt({ ctx: chatty, rng: rng(0.5) }).user, /次は、例えばこんな流れもいい: .+無理に作らない/);
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

// ---------- 問題の種類ごとの誘導・答えのある問題 ----------

test('chunk prompt (A: known math quiz): Mina keeps the answer private, gives one hint at a time, explains when Leo is stuck', () => {
  const base = { question: '1 から 100 までの和は？', kind: '既知の数学', status: 'exploring', phase: 'EXPLORATION' };
  const early = buildChunkPrompt({ ctx: sanitizeContext({ state: { ...base, age: 1 } }), rng: rng(0.5) }).user;
  assert.match(early, /ミナは正確な答えを known_answer に書いておく/);
  assert.match(early, /ミナはすぐに答えを言わない.*次のヒントを一つだけ出す/);
  const withAnswer = buildChunkPrompt({ ctx: sanitizeContext({ state: { ...base, age: 2, known_answer: '5050', hints: ['端と端を組にしてみて'] } }), rng: rng(0.5) }).user;
  assert.match(withAnswer, /ミナだけが知っている答え（レオはまだ知らない）: 5050/);
  assert.match(withAnswer, /ミナがこれまでに出したヒント: 端と端を組にしてみて/);
  assert.doesNotMatch(withAnswer, /known_answer に書いておく/);
  const stuck = buildChunkPrompt({ ctx: sanitizeContext({ state: { ...base, age: 4, known_answer: '5050', hints: ['h1', 'h2', 'h3'] } }), rng: rng(0.5) }).user;
  assert.match(stuck, /ミナが答えと理由を筋道立てて説明し、最終的な答え（数値なら単位も）をはっきり言う/);
  const done = buildChunkPrompt({ ctx: sanitizeContext({ state: { ...base, age: 5, known_answer: '5050', final_answer: '5050' } }), rng: rng(0.5) }).user;
  assert.match(done, /答え（5050）はもう出ている。検算/);
});

test('chunk prompt (B/C/D): science facts, daily mysteries and unsolved problems get their own guidance', () => {
  const sci = buildChunkPrompt({ ctx: sanitizeContext({ state: { question: '空はなぜ青い', kind: '既知の科学', status: 'exploring', age: 1 } }), rng: rng(0.5) }).user;
  assert.match(sci, /known_answer/);
  const mys = buildChunkPrompt({ ctx: sanitizeContext({ state: { question: '靴下が片方だけ消える', kind: '日常の謎', status: 'exploring', age: 2 } }), rng: rng(0.5) }).user;
  assert.match(mys, /レオが主導して仮説を出し、ミナは確かめられている知識で整理・検証する。確定した事実と仮説をはっきり区別する/);
  const uns = buildChunkPrompt({ ctx: sanitizeContext({ state: { question: '双子素数は無限にある？', kind: '未解決の数学', status: 'exploring', age: 6 } }), rng: rng(0.5) }).user;
  assert.match(uns, /確定した事実と仮説をはっきり区別する/);
  assert.match(uns, /無理に結論を作らない/);
  const op = buildChunkPrompt({ ctx: sanitizeContext({ state: { question: '記憶を全部失っても同じ人？', kind: '哲学', status: 'exploring', age: 1 } }), rng: rng(0.5) }).user;
  assert.match(op, /立場や前提をはっきりさせ/);
});

test('free talk suggestions avoid the problem kinds used most recently', () => {
  const ctx = sanitizeContext({ state: { free_run: 3, phase: 'FREE', summary: '雑談' }, recent: [{ kind: 'say', speaker: 'A', text: '寒いね' }], recentKinds: ['クイズ', '既知の数学'] });
  for (const r of [0.0, 0.2, 0.4, 0.6]) {
    const u = buildChunkPrompt({ ctx, rng: rng(r) }).user;
    if (/例えばこんな流れ/.test(u)) assert.doesNotMatch(u, /クイズや既知の数学|確立した科学の知識/);
  }
});

test('state: kind, known_answer, hints and final_answer are carried for the same question and cleared after it closes', () => {
  const s1 = mergeState(emptyState(), { question: '1 から 100 までの和は？', kind: '既知の数学', status: 'exploring', known_answer: '5050', hints: '端と端を組にする' }, [{ phase: 'DISCOVERY' }]);
  assert.equal(s1.known_answer, '5050');
  assert.deepEqual(s1.hints, ['端と端を組にする']);
  const s2 = mergeState(s1, { question: '1 から 100 までの和は？', status: 'exploring', known_answer: '', hints: '' }, [{ phase: 'EXPLORATION' }]);
  assert.equal(s2.known_answer, '5050');
  assert.equal(s2.kind, '既知の数学');
  assert.deepEqual(s2.hints, ['端と端を組にする']);
  const s3 = mergeState(s2, { question: '1 から 100 までの和は？', status: 'resolved', final_answer: '5050' }, [{ phase: 'RESOLUTION' }]);
  assert.equal(s3.final_answer, '5050');
  const s4 = mergeState(s3, { question: '', status: 'none' }, [{ phase: 'AFTERMATH' }]);
  assert.equal(s4.known_answer, '');
  assert.deepEqual(s4.hints, []);
  assert.equal(sanitizeState({ known_answer: 'x', hints: ['a'] }).known_answer, ''); // 問いが無ければ持たない
  assert.equal(sanitizeState({ question: 'q', hints: Array(20).fill('h') }).hints.length, 5);
});

test('normalizeChunk: recap and memo are read; memo kinds are mapped and capped', () => {
  const c = normalizeChunk(out([L('A', 'わかった、5050だ'), L('B', '正解。組にすると101が50組')], { recap: '1から100の和をレオが組の考え方で5050と導いた', memo: 'クイズ: 1から100の和（レオが正解） / 冗談: ガウス少年ごっこ / 発見: 余分' }));
  assert.match(c.recap, /5050/);
  assert.deepEqual(c.memos.map((m) => m.kind), ['quiz', 'joke']);
  assert.deepEqual(parseMemo('hypothesis: 靴下は旅に出る'), [{ kind: 'hypothesis', text: '靴下は旅に出る' }]);
  assert.deepEqual(parseMemo('ただのメモ'), [{ kind: 'finding', text: 'ただのメモ' }]);
  assert.deepEqual(parseMemo(''), []);
  assert.ok(MEMORY_KINDS.includes('about_leo'));
});

test('memories (E): sanitized, capped by count and size, rendered with when/label/excerpt', () => {
  const mem = { kind: 'topic', when: '3日前', topic: '靴下', question: '靴下はなぜ片方だけ消える', status: 'unresolved', text: '洗濯機説と記憶違い説', open: '数えて確かめる方法', leo: '靴下は旅に出る', mina: '数え間違い', excerpt: [{ kind: 'say', speaker: 'A', text: '靴下は旅に出るんだよ' }] };
  const ctx = sanitizeContext({ memories: [mem, { kind: 'joke', when: '昨日', text: 'ガウス少年ごっこ' }, { kind: '???', text: '' }], quizzes: ['1から100の和'] });
  assert.equal(ctx.memories.length, 2);
  const u = buildChunkPrompt({ ctx, rng: rng(0.9) }).user;
  assert.match(u, /# 二人の記憶/);
  assert.match(u, /\[3日前・未解決\] 靴下: 問い「靴下はなぜ片方だけ消える」/);
  assert.match(u, /残った疑問: 数えて確かめる方法/);
  assert.match(u, /当時の発言: レオ「靴下は旅に出るんだよ」/);
  assert.match(u, /\[昨日・二人の冗談\] ガウス少年ごっこ/);
  assert.match(u, /# ミナが前に出した問題（同じ問題を出さない）\n1から100の和/);
  const many = sanitizeContext({ memories: Array.from({ length: 50 }, (_, i) => ({ ...mem, text: `記憶${i}${'あ'.repeat(190)}` })) });
  assert.ok(many.memories.length <= 8);
  assert.ok(JSON.stringify(many.memories).length <= 2400);
  assert.equal(sanitizeContext({ quizzes: Array(30).fill('q') }).quizzes.length, 10);
  // 新しい会話の始まりで、未解決の記憶を思い出してもいい
  const fresh = buildChunkPrompt({ ctx: sanitizeContext({ memories: [mem] }), rng: rng(0.1) }).user;
  assert.match(fresh, /前に話して未解決のままの「靴下はなぜ片方だけ消える」/);
});
