import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTurnPrompt,
  buildSystemPrompt,
  findDuplicate,
  similarity,
  analyze,
  sanitizeLog,
  sanitizeContext,
  normalizeTurn,
  cleanUtterance,
  renderTranscript,
  CHARACTERS,
  RECENT_LIMIT,
} from '../server/conversation.mjs';
import { demoTurn } from '../server/demo.mjs';

const say = (speaker, text, extra = {}) => ({ kind: 'say', speaker, text, intent: 'react', topic: '雨', answeredBy: [], ...extra });
const player = (text, answeredBy = []) => ({ kind: 'player', text, answeredBy });
const rng = (v) => () => v;
const emptyCtx = { topics: [], notes: { A: [], B: [] } };

test('personas: each prompt contains only its own character, both equally intelligent', () => {
  const a = buildSystemPrompt('A');
  const b = buildSystemPrompt('B');
  assert.match(a, /あなたは「レオ」/);
  assert.match(b, /あなたは「ミナ」/);
  for (const line of CHARACTERS.A.core) assert.ok(a.includes(line) && !b.includes(line));
  for (const line of CHARACTERS.B.core) assert.ok(b.includes(line) && !a.includes(line));
  for (const p of [a, b]) {
    assert.match(p, /どちらが上ということはありません/);
    assert.match(p, /知らないことは知らないと言います/);
    assert.match(p, /事実・推測・仮説を区別/);
    assert.match(p, /間柄かは決まっていません/);
    assert.match(p, /影響を受けてもかまいません/);
  }
  // 直感型も論理を使え、論理型も直感を持つ（固定的な役割にしない）
  assert.match(CHARACTERS.A.balance, /根拠を確かめ/);
  assert.match(CHARACTERS.B.balance, /直感的なひらめき/);
});

test('similarity / duplicate detection', () => {
  assert.equal(similarity('今日はいい天気だね', '今日はいい天気だね'), 1);
  const log = sanitizeLog([say('A', 'なぜ雨の音は落ち着くんだろう。理由が知りたい。')]);
  assert.ok(findDuplicate('なぜ雨の音は落ち着くんだろう。理由が知りたいな。', log));
  assert.equal(findDuplicate('パン屋の匂いの話をしよう', log), null);
});

test('only recent lines are kept, but topic flow and notes carry the thread', () => {
  const many = Array.from({ length: 50 }, (_, i) => say(i % 2 ? 'B' : 'A', `発言${i}`));
  const log = sanitizeLog(many);
  assert.equal(log.length, RECENT_LIMIT);
  assert.equal(log.at(-1).text, '発言49');
  const ctx = sanitizeContext({ topics: [{ label: '雨の匂い', genre: 'nature' }, { label: '自由意志', genre: 'philosophy' }], notes: { A: ['ミナは定義にこだわる'], B: ['レオはたとえ話で逃げる'] } });
  const pA = buildTurnPrompt({ speaker: 'A', log, ctx, rng: rng(0.5) });
  assert.match(pA.user, /雨の匂い[\s\S]*自由意志/);
  assert.match(pA.user, /前の話題に戻ってもかまいません/);
  assert.match(pA.user, /ミナは定義にこだわる/);
  assert.doesNotMatch(pA.user, /レオはたとえ話で逃げる/); // 相手のメモは見えない
});

test('sanitizeContext caps sizes and rejects junk', () => {
  const ctx = sanitizeContext({ topics: Array.from({ length: 30 }, (_, i) => ({ label: `t${i}`, genre: 'nope' })), notes: { A: ['x'.repeat(500)], B: 'bad' } });
  assert.equal(ctx.topics.length, 10);
  assert.equal(ctx.topics[0].genre, 'daily');
  assert.equal(ctx.notes.A[0].length, 80);
  assert.deepEqual(ctx.notes.B, []);
  assert.deepEqual(sanitizeContext(null), emptyCtx);
});

test('first turn does not start with a greeting', () => {
  const p = buildTurnPrompt({ speaker: 'A', log: [], rng: rng(0.5) });
  assert.match(p.user, /会話の始まり/);
  assert.match(p.user, /あいさつから入らず/);
});

test('responds to the other; continuing own turn is allowed once', () => {
  const p = buildTurnPrompt({ speaker: 'A', log: sanitizeLog([say('B', '雨の音って落ち着くよね')]), rng: rng(0.5) });
  assert.match(p.user, /直前のミナの発言「雨の音って落ち着くよね」/);
  const log = sanitizeLog([say('B', 'ねえ'), say('A', 'ちょっと思いついたんだけど')]);
  const cont = buildTurnPrompt({ speaker: 'A', log, rng: rng(0.5) });
  assert.match(cont.user, /自分の話を続けています/);
  assert.match(cont.user, /after は pass/);
  // 2 発言目で continue を返しても、3 連続にはさせない
  assert.equal(normalizeTurn({ utterance: 'まだある', after: 'continue' }, cont.analysis).after, 'pass');
  assert.equal(normalizeTurn({ utterance: 'まだある', after: 'continue' }, analyze(sanitizeLog([say('B', 'ねえ')]), 'A')).after, 'continue');
});

test('silence is part of the transcript and invites a casual restart', () => {
  const log = sanitizeLog([say('A', 'そういうことか'), { kind: 'pause' }]);
  assert.match(renderTranscript(log), /（しばらく沈黙）/);
  const p = buildTurnPrompt({ speaker: 'B', log, rng: rng(0.5) });
  assert.match(p.user, /少し沈黙が続きました/);
});

test('player: first responder reacts, second adds a view or returns; expires after three lines', () => {
  const log = sanitizeLog([say('A', 'こんにちは'), player('好きな食べ物は？')]);
  const first = buildTurnPrompt({ speaker: 'B', log, rng: rng(0.5) });
  assert.match(first.user, /観察者が話しかけてきました: 「好きな食べ物は？」/);
  const log2 = sanitizeLog([say('A', 'こんにちは'), player('好きな食べ物は？', ['B']), say('B', 'カレーかな')]);
  const second = buildTurnPrompt({ speaker: 'A', log: log2, rng: rng(0.5) });
  assert.match(second.user, /ミナがすでに反応しています/);
  assert.match(second.user, /必ず答える必要はありません/);
  const log3 = sanitizeLog([player('好きな食べ物は？'), say('B', 'カレー'), say('A', '僕はパン'), say('B', 'パンか')]);
  assert.equal(analyze(log3, 'A').pendingPlayer.length, 0);
  assert.match(renderTranscript(log3), /観察者: 好きな食べ物は？/);
});

test('stagnation, closing, genre repetition and question habits are nudged', () => {
  const log = sanitizeLog([say('A', 'うん'), say('B', 'そうだね'), say('A', 'ふむ'), say('B', 'へえ')]);
  assert.ok(analyze(log, 'A').stagnant);
  assert.match(buildTurnPrompt({ speaker: 'A', log, rng: rng(0.5) }).user, /停滞/);
  const closing = sanitizeLog([say('A', 'じゃあ、このへんにしておこうか', { intent: 'closing' })]);
  assert.match(buildTurnPrompt({ speaker: 'B', log: closing, rng: rng(0.5) }).user, /締めくくろう/);
  const ctx = sanitizeContext({ topics: [{ label: 'a', genre: 'science' }, { label: 'b', genre: 'science' }, { label: 'c', genre: 'science' }] });
  assert.match(buildTurnPrompt({ speaker: 'A', log: sanitizeLog([say('B', '量子の話の続き')]), ctx, rng: rng(0.5) }).user, /別のジャンルへ/);
  const q = sanitizeLog([say('A', 'なんで？'), say('B', '理由はね'), say('A', '本当に？'), say('B', 'たぶん')]);
  assert.match(buildTurnPrompt({ speaker: 'A', log: q, rng: rng(0.5) }).user, /質問で終わらないで/);
});

test('sanitizeLog rejects junk and caps player length', () => {
  const log = sanitizeLog([{ kind: 'evil', speaker: 'Z', text: 'x' }, null, { kind: 'player', text: 'あ'.repeat(500) }, { kind: 'say', text: '' }, { kind: 'pause', text: 'ignored' }]);
  assert.equal(log.length, 3);
  assert.equal(log[0].speaker, 'A');
  assert.equal(log[1].text.length, 100);
  assert.equal(log[2].kind, 'pause');
  assert.equal(log[2].text, '');
});

test('normalizeTurn validates fields and strips name prefixes', () => {
  const t = normalizeTurn({ utterance: 'レオ: 「なるほどね」', expression: 'weird', intent: 'nope', topic: 't', genre: 'x', after: 'y', tempo: 'z', note: ' メモ ' });
  assert.deepEqual(t, { text: 'なるほどね', expression: 'neutral', intent: 'react', topic: 't', genre: 'daily', after: 'pass', tempo: 'normal', note: 'メモ' });
  assert.equal(cleanUtterance('ミナ：ねえ'), 'ねえ');
});

test('demo mode answers the player and produces valid turns', () => {
  const log = sanitizeLog([say('A', '宇宙って広いね'), player('こんばんは')]);
  const t = demoTurn({ speaker: 'B', log, ctx: emptyCtx, rng: rng(0.1) });
  assert.equal(t.intent, 'answer_player');
  assert.ok(t.text.length > 0);
  const first = demoTurn({ speaker: 'A', log: [], ctx: emptyCtx, rng: rng(0.3) });
  assert.ok(first.text.length > 0);
  assert.ok(['pass', 'continue', 'silence'].includes(first.after));
});
