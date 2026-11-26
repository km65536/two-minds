import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSystemPrompt,
  buildEpisodePrompt,
  sanitizeContext,
  sanitizeInterrupt,
  normalizeEpisode,
  salvageEpisode,
  cleanText,
  similarity,
  CHARACTERS,
  EPISODE_SCHEMA,
  EPISODE_MAX_LINES,
} from '../server/conversation.mjs';
import { demoEpisode } from '../server/demo.mjs';

const rng = (v) => () => v;
const line = (speaker, text, extra = {}) => ({ speaker, text, expression: 'neutral', action: 'none', type: 'chat', phase: 'FREE', pause: 'none', ...extra });
const episode = (lines, extra = {}) => ({
  summary: 'テスト',
  topic: 'お茶',
  problem: { exists: false, question: '', kind: 'none', status: 'none', leo_view: '', mina_view: '', explored: [], conclusion: '', unresolved_reason: '', open_points: [] },
  lines,
  next: { hook: '', deferred_questions: [], continue_problem: false },
  notes: { A: '', B: '' },
  ...extra,
});

test('system prompt: both personas, equal intelligence, curiosity, plain language, phases and problem rules', () => {
  const p = buildSystemPrompt();
  for (const c of Object.values(CHARACTERS)) for (const t of c.traits) assert.ok(p.includes(t));
  assert.match(p, /上下はない/);
  assert.match(p, /いつもレオがとっぴで、いつもミナが正しい、という形にしない/);
  assert.match(p, /分からないことは分からないと言う/);
  assert.match(p, /関係.*決めない/);
  assert.match(p, /難しい言葉/);
  for (const ph of ['FREE', 'DISCOVERY', 'EXPLORATION', 'RESOLUTION', 'AFTERMATH']) assert.match(p, new RegExp(ph));
  assert.match(p, /最後まで取り組む/);
  assert.match(p, /deferred_questions に入れて後回し/);
  assert.match(p, /正確さを最優先/);
  assert.match(p, /でっち上げずに「未解決」/);
  assert.match(p, /長さはあなたが決める/);
  assert.match(p, /同意するだけの発言を続けない/);
  assert.match(p, /無理に対立させない/);
  assert.match(p, /観察者が答えを教えたら/);
});

test('episode prompt: fresh start uses a random everyday opener and avoids recent topics', () => {
  const ctx = sanitizeContext({ topics: ['靴下', '雲'] });
  const p = buildEpisodePrompt({ ctx, rng: rng(0.1) });
  assert.match(p.user, /最近話した話題.*靴下 \/ 雲/s);
  assert.match(p.user, /始め方の例/);
  assert.match(p.user, /あいさつから始めない/);
});

test('episode prompt: an unfinished problem is continued; backlog questions can come back', () => {
  const ctx = sanitizeContext({ problem: { question: '夢はなぜ忘れるのか', status: 'continuing', leo_view: '消える', mina_view: '準備不足' }, backlog: ['洗濯物はなぜからまるのか'] });
  const p = buildEpisodePrompt({ ctx, rng: rng(0.1) });
  assert.match(p.user, /前回から続いている問題/);
  assert.match(p.user, /夢はなぜ忘れるのか/);
  assert.match(p.user, /レオの考え: 消える/);
  const ctx2 = sanitizeContext({ backlog: ['洗濯物はなぜからまるのか'] });
  assert.match(buildEpisodePrompt({ ctx: ctx2, rng: rng(0.1) }).user, /後回しにした疑問「洗濯物はなぜからまるのか」/);
});

test('episode prompt: interrupt puts the observer first, with what was said and the hypotheses so far', () => {
  const ctx = sanitizeContext({ recent: [{ kind: 'say', speaker: 'A', text: '前の話' }] });
  const interrupt = sanitizeInterrupt({
    text: '答えは静電気だよ',
    played: [{ kind: 'say', speaker: 'A', text: 'なんで服がくっつくんだろう' }, { kind: 'say', speaker: 'B', text: '洗剤のせいかも' }],
    problem: { question: '服がくっつく理由', leo_view: '服が仲良し', mina_view: '洗剤', status: 'exploring' },
  });
  const p = buildEpisodePrompt({ ctx, interrupt, rng: rng(0.5) });
  assert.match(p.user, /たった今まで話していた会話[\s\S]*なんで服がくっつくんだろう[\s\S]*洗剤のせいかも/);
  assert.match(p.user, /ミナの考え: 洗剤/);
  assert.match(p.user, /観察者: 答えは静電気だよ/);
  assert.match(p.user, /最初の発言は観察者への反応/);
  assert.match(p.user, /答えを教えられたら/);
  assert.doesNotMatch(p.user, /前の話/); // 割り込み時は、その時点までに再生された発言を使う
});

test('sanitizers cap sizes and reject junk', () => {
  const ctx = sanitizeContext({ history: Array(9).fill({ summary: 's' }), backlog: Array(20).fill('q'), recent: Array(50).fill({ kind: 'say', speaker: 'Z', text: 'x' }), problem: { question: '' } });
  assert.equal(ctx.history.length, 3);
  assert.equal(ctx.backlog.length, 5);
  assert.equal(ctx.recent.length, 12);
  assert.equal(ctx.recent[0].speaker, 'A');
  assert.equal(ctx.problem, null);
  assert.equal(sanitizeInterrupt({ text: '   ' }), null);
  assert.equal(sanitizeInterrupt({ text: 'あ'.repeat(500) }).text.length, 100);
  assert.deepEqual(sanitizeContext(null).notes, { A: [], B: [] });
});

test('normalizeEpisode: fills defaults, drops broken lines and duplicates, clamps size', () => {
  const ep = normalizeEpisode(
    episode([
      line('A', 'レオ: ねえ、お茶ぬるくなった', { expression: 'weird', action: 'fly', type: 'x', phase: 'Y', pause: 'z' }),
      { speaker: 'C', text: '誰？' },
      line('B', ''),
      null,
      line('B', 'ほんとだ'),
      line('B', 'ほんとだ'),
      line('A', '（笑いながら）なんでだろう'),
    ]),
  );
  assert.equal(ep.lines.length, 3);
  assert.deepEqual(ep.lines[0], { speaker: 'A', text: 'ねえ、お茶ぬるくなった', expression: 'neutral', action: 'none', type: 'chat', phase: 'FREE', pause: 'none' });
  assert.equal(ep.lines[2].text, 'なんでだろう');
  assert.equal(ep.problem.status, 'none');
  const many = normalizeEpisode(episode(Array.from({ length: 80 }, (_, i) => line(i % 2 ? 'B' : 'A', `発言その${i}について話すと長くなるんだけど${'あいうえおかきくけこ'[i % 10]}`))));
  assert.equal(many.lines.length, EPISODE_MAX_LINES);
  assert.equal(normalizeEpisode(episode([line('A', 'ひとつだけ')])), null);
  assert.equal(normalizeEpisode('nope'), null);
  assert.equal(normalizeEpisode({}), null);
});

test('normalizeEpisode: lines repeating the previous episode are removed', () => {
  const recent = [{ kind: 'say', speaker: 'A', text: '靴下が片方だけなくなるのはなぜだろう' }];
  const ep = normalizeEpisode(episode([line('A', '靴下が片方だけなくなるのはなぜだろう'), line('B', '洗濯機かな'), line('A', 'かもね')]), { recent });
  assert.equal(ep.lines.length, 2);
  assert.equal(ep.lines[0].text, '洗濯機かな');
});

test('normalizeEpisode: problem status, continuation and truncation', () => {
  const p = { exists: true, question: 'なぜ？', kind: 'science', status: 'resolved', leo_view: 'a', mina_view: 'b', explored: [], conclusion: 'c', unresolved_reason: '', open_points: [] };
  const lines = [line('A', 'まず一つ目の話'), line('B', 'それから二つ目の話')];
  assert.equal(normalizeEpisode(episode(lines, { problem: p })).problem.status, 'resolved');
  assert.equal(normalizeEpisode(episode(lines, { problem: p }), { truncated: true }).problem.status, 'continuing');
  const cont = normalizeEpisode(episode(lines, { problem: { ...p, status: 'exploring' }, next: { hook: '', deferred_questions: ['次の疑問'], continue_problem: true } }));
  assert.equal(cont.problem.status, 'continuing');
  assert.equal(cont.next.continue_problem, true);
  assert.deepEqual(cont.next.deferred_questions, ['次の疑問']);
  assert.equal(normalizeEpisode(episode(lines, { problem: { ...p, question: '' } })).problem.exists, false);
});

test('salvageEpisode: recovers complete lines from a truncated JSON (strings with braces and quotes)', () => {
  const full = JSON.stringify(episode([line('A', '括弧 {こういうの} と "引用" があっても'), line('B', 'だいじょうぶ？'), line('A', 'ここで切れる')]));
  const cut = full.slice(0, full.indexOf('ここで切れる') + 3);
  const s = salvageEpisode(cut);
  assert.equal(s.lines.length, 2);
  assert.equal(s.lines[0].text, '括弧 {こういうの} と "引用" があっても');
  assert.equal(s.summary, 'テスト');
  assert.equal(s.problem.exists, false);
  const ep = normalizeEpisode(s, { truncated: true });
  assert.equal(ep.lines.length, 2);
  assert.equal(ep.truncated, true);
  assert.equal(salvageEpisode('{"summary":"x"'), null);
  assert.equal(salvageEpisode(123), null);
});

test('schema: problem is planned before lines; all fields required', () => {
  assert.deepEqual(EPISODE_SCHEMA.propertyOrdering, ['summary', 'topic', 'problem', 'lines', 'next', 'notes']);
  assert.deepEqual(EPISODE_SCHEMA.required, EPISODE_SCHEMA.propertyOrdering);
  assert.equal(EPISODE_SCHEMA.properties.lines.maxItems, EPISODE_MAX_LINES);
});

test('cleanText and similarity', () => {
  assert.equal(cleanText('ミナ：「そうだね」'), 'そうだね');
  assert.equal(cleanText('  改行\nも 消す '), '改行 も 消す');
  assert.ok(similarity('今日はいい天気だね', '今日はいい天気だね') === 1);
});

test('demo episodes are valid scripts and react to the observer', () => {
  const ctx = sanitizeContext({});
  const ep = demoEpisode({ ctx, interrupt: null });
  assert.ok(ep.lines.length >= 2);
  for (const l of ep.lines) assert.ok(['A', 'B'].includes(l.speaker) && l.text);
  const r = demoEpisode({ ctx, interrupt: sanitizeInterrupt({ text: 'こんばんは', problem: { question: '夢はなぜ忘れるのか' } }) });
  assert.match(r.lines[0].text, /こんばんは/);
  assert.equal(r.lines[0].type, 'answer_player');
  assert.equal(r.problem.status, 'continuing');
});
