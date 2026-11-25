import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnPrompt, buildSystemPrompt, findDuplicate, similarity, analyze, sanitizeLog, normalizeTurn, cleanUtterance, RECENT_LIMIT } from '../server/conversation.mjs';
import { demoTurn } from '../server/demo.mjs';

const say = (speaker, text, extra = {}) => ({ kind: 'say', speaker, text, intent: 'react', topic: '雨', answeredBy: [], ...extra });
const rng = (v) => () => v;

test('each character has an independent system prompt', () => {
  const a = buildSystemPrompt('A');
  const b = buildSystemPrompt('B');
  assert.match(a, /あなたは「レオ」/);
  assert.match(b, /あなたは「ミナ」/);
  // 相手の人格設定は含まれない
  assert.doesNotMatch(a, /マイペース/);
  assert.doesNotMatch(b, /理屈っぽく/);
});

test('similarity / duplicate detection', () => {
  assert.equal(similarity('今日はいい天気だね', '今日はいい天気だね'), 1);
  const log = sanitizeLog([say('A', 'なぜ雨の音は落ち着くんだろう。理由が知りたい。')]);
  assert.ok(findDuplicate('なぜ雨の音は落ち着くんだろう。理由が知りたいな。', log));
  assert.equal(findDuplicate('パン屋の匂いの話をしよう', log), null);
});

test('only recent context is kept', () => {
  const many = Array.from({ length: 50 }, (_, i) => say(i % 2 ? 'B' : 'A', `発言${i}`));
  const log = sanitizeLog(many);
  assert.equal(log.length, RECENT_LIMIT);
  assert.equal(log.at(-1).text, '発言49');
});

test('first turn opens the conversation; later turns respond to the last line', () => {
  const p = buildTurnPrompt({ speaker: 'A', log: [], rng: rng(0.5) });
  assert.match(p.user, /会話の始まり/);
  const p2 = buildTurnPrompt({ speaker: 'A', log: sanitizeLog([say('B', '雨の音って落ち着くよね')]), rng: rng(0.5) });
  assert.match(p2.user, /直前のミナの発言「雨の音って落ち着くよね」/);
});

test('player messages are presented to the next speaker until answered', () => {
  const log = sanitizeLog([say('A', 'こんにちは'), { kind: 'player', text: '好きな食べ物は？', answeredBy: ['A'] }]);
  const pB = buildTurnPrompt({ speaker: 'B', log, rng: rng(0.5) });
  assert.match(pB.user, /観察者があなたたちに話しかけました: 「好きな食べ物は？」/);
  const pA = buildTurnPrompt({ speaker: 'A', log, rng: rng(0.5) });
  assert.doesNotMatch(pA.user, /話しかけました/);
  assert.match(pA.user, /観察者: 好きな食べ物は？/); // 文脈としては見える
});

test('stagnation and closing prompt a topic change', () => {
  const log = sanitizeLog([say('A', 'うん'), say('B', 'そうだね'), say('A', 'ふむ'), say('B', 'へえ')]);
  assert.ok(analyze(log, 'A').stagnant);
  assert.match(buildTurnPrompt({ speaker: 'A', log, rng: rng(0.5) }).user, /停滞/);
  const log2 = sanitizeLog([say('A', 'じゃあ、今日はこのへんにしておこうか', { intent: 'closing' })]);
  assert.match(buildTurnPrompt({ speaker: 'B', log: log2, rng: rng(0.5) }).user, /締めくくろう/);
});

test('sanitizeLog rejects junk and caps player length', () => {
  const log = sanitizeLog([{ kind: 'evil', speaker: 'Z', text: 'x' }, null, { kind: 'player', text: 'あ'.repeat(500) }, { kind: 'say', text: '' }]);
  assert.equal(log.length, 2);
  assert.equal(log[0].kind, 'say');
  assert.equal(log[0].speaker, 'A');
  assert.equal(log[1].text.length, 100);
});

test('normalizeTurn validates fields and strips name prefixes', () => {
  const t = normalizeTurn({ utterance: 'レオ: 「なるほどね」', expression: 'weird', intent: 'nope', topic: 't' });
  assert.deepEqual(t, { text: 'なるほどね', expression: 'neutral', intent: 'react', topic: 't' });
  assert.equal(cleanUtterance('ミナ：ねえ'), 'ねえ');
});

test('demo mode answers the player and produces valid turns', () => {
  const log = sanitizeLog([say('A', '宇宙って広いね'), { kind: 'player', text: 'こんばんは' }]);
  const t = demoTurn({ speaker: 'B', log, rng: rng(0.1) });
  assert.equal(t.intent, 'answer_player');
  assert.ok(t.text.length > 0);
  const first = demoTurn({ speaker: 'A', log: [], rng: rng(0.3) });
  assert.ok(first.text.length > 0);
});
