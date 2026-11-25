import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTurnPrompt,
  buildMemoryPrompt,
  findDuplicate,
  similarity,
  analyze,
  sanitizeLog,
  sanitizeMemory,
  sanitizeRelationship,
  sanitizeCharacter,
  normalizeTurn,
  cleanUtterance,
  renderTranscript,
} from '../server/conversation.mjs';

const chars = { A: sanitizeCharacter({ name: 'レオ', personality: '論理的' }, 'レオ'), B: sanitizeCharacter({ name: 'ミナ', personality: '感覚的' }, 'ミナ') };
const say = (speaker, text, extra = {}) => ({ id: Math.random().toString(36), kind: 'say', speaker, text, intent: 'react', topic: '雨', answeredBy: [], ...extra });
const rngConst = (v) => () => v;

test('similarity / duplicate detection', () => {
  assert.equal(similarity('今日はいい天気だね', '今日はいい天気だね'), 1);
  assert.ok(similarity('今日はいい天気だね', '宇宙の果てには何がある？') < 0.1);
  const log = sanitizeLog([say('A', 'なぜ雨の音は落ち着くんだろう。理由が知りたい。')]);
  assert.ok(findDuplicate('なぜ雨の音は落ち着くんだろう。理由が知りたいな。', log));
  assert.equal(findDuplicate('パン屋の匂いの話をしよう', log), null);
});

test('first turn prompt asks to open the conversation', () => {
  const p = buildTurnPrompt({ speaker: 'A', chars, log: [], memory: sanitizeMemory({}), relationship: sanitizeRelationship({}), rng: rngConst(0.5) });
  assert.match(p.system, /あなたは「レオ」/);
  assert.match(p.user, /会話の始まり/);
  assert.match(p.user, /まだ何も話していない/);
});

test('prompt includes previous utterance, memory and relationship', () => {
  const memory = sanitizeMemory({ facts: [{ id: 'f1', about: 'B', category: 'like', text: 'ミナは雨の音が好き', importance: 5, turn: 1 }], episodes: [{ id: 'e1', title: '雨の日', summary: '雨について話した', topics: ['雨'], turn: 10 }], impressions: { A: '不思議な人' } });
  const log = sanitizeLog([say('B', '雨の音って、なんか落ち着くよね')]);
  const p = buildTurnPrompt({ speaker: 'A', chars, log, memory, relationship: sanitizeRelationship({}), rng: rngConst(0.9) });
  assert.match(p.user, /直前のミナの発言「雨の音って、なんか落ち着くよね」/);
  assert.match(p.user, /ミナは雨の音が好き/);
  assert.match(p.user, /不思議な人/);
  assert.match(p.user, /雨の日/);
  assert.match(p.user, /相手を/);
});

test('private player messages are hidden from the other character', () => {
  const log = sanitizeLog([say('A', 'こんにちは'), { id: 'p', kind: 'player', to: 'B', text: '内緒の話', answeredBy: [] }]);
  assert.match(renderTranscript(log, 'B', chars), /内緒の話/);
  assert.doesNotMatch(renderTranscript(log, 'A', chars), /内緒の話/);
  const pB = buildTurnPrompt({ speaker: 'B', chars, log, memory: sanitizeMemory({}), relationship: sanitizeRelationship({}), rng: rngConst(0.5) });
  assert.match(pB.user, /観察者があなたに話しかけています/);
  const pA = buildTurnPrompt({ speaker: 'A', chars, log, memory: sanitizeMemory({}), relationship: sanitizeRelationship({}), rng: rngConst(0.5) });
  assert.doesNotMatch(pA.user, /内緒の話/);
});

test('topic request and closing/stagnation hints', () => {
  const log = sanitizeLog([say('A', 'じゃあ、今日はこのへんで', { intent: 'closing' }), { id: 't', kind: 'topic', text: '宇宙の果て', answeredBy: [] }]);
  const p = buildTurnPrompt({ speaker: 'B', chars, log, memory: sanitizeMemory({}), relationship: sanitizeRelationship({}), rng: rngConst(0.5) });
  assert.match(p.user, /新しい話題「宇宙の果て」/);
  const log2 = sanitizeLog([say('A', 'うん'), say('B', 'そうだね'), say('A', 'ふむ'), say('B', 'へえ')]);
  const a = analyze(log2, 'A');
  assert.ok(a.stagnant);
  const p2 = buildTurnPrompt({ speaker: 'A', chars, log: log2, memory: sanitizeMemory({}), relationship: sanitizeRelationship({}), rng: rngConst(0.5) });
  assert.match(p2.user, /停滞/);
  const log3 = sanitizeLog([say('A', 'じゃあ、今日はこのへんにしておこうか', { intent: 'closing' })]);
  const p3 = buildTurnPrompt({ speaker: 'B', chars, log: log3, memory: sanitizeMemory({}), relationship: sanitizeRelationship({}), rng: rngConst(0.5) });
  assert.match(p3.user, /締めくくろうとしています/);
});

test('normalizeTurn clamps feelings and strips name prefixes', () => {
  const t = normalizeTurn({ utterance: 'レオ: 「なるほどね」', inner: 'x', intent: 'nope', topic: 't', feeling: { trust: 99, closeness: -9, understanding: 'a', agreement: 1 }, addressed_player: 0 }, chars);
  assert.equal(t.text, 'なるほどね');
  assert.equal(t.intent, 'react');
  assert.deepEqual(t.feeling, { trust: 3, closeness: -3, understanding: 0, agreement: 1 });
  assert.equal(cleanUtterance('ミナ：ねえ', chars), 'ねえ');
});

test('sanitizers reject junk input', () => {
  const log = sanitizeLog([{ kind: 'evil', text: 5, speaker: 'Z' }, null]);
  assert.equal(log[0].kind, 'system');
  assert.equal(log[0].speaker, null);
  const r = sanitizeRelationship({ A: { trust: 1000 }, agreement: 'x' });
  assert.equal(r.A.trust, 100);
  assert.equal(r.agreement, 50);
  assert.equal(sanitizeCharacter({ name: '' }, 'レオ').name, 'レオ');
});

test('memory prompt lists existing facts with ids', () => {
  const memory = sanitizeMemory({ facts: [{ id: 'q1', about: 'both', category: 'question', text: '時間はなぜ流れるのか', importance: 4 }] });
  const p = buildMemoryPrompt({ chars, entries: sanitizeLog([say('A', '時間って何だろう')]), memory });
  assert.match(p.user, /id=q1/);
  assert.match(p.user, /A\(レオ\): 時間って何だろう/);
});
