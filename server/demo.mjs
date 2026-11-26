// デモモード：API キー無しで画面の動作を確認するための簡易生成器。
// AI は一切使っていない。決まった文型を組み合わせているだけで、会話の質は本物とは比べものにならない。
import { analyze, normalizeTurn, CHARACTERS, GENRES } from './conversation.mjs';

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];

const TOPICS = [
  ['雨の匂い', 'nature'], ['パンの耳', 'trivial'], ['無限の大きさ', 'math'], ['デジャヴ', 'mystery'],
  ['自由意志', 'philosophy'], ['行列に並ぶ心理', 'psychology'], ['昔の暇つぶし', 'history'], ['色の温度', 'art'],
];

// レオ：直感・想像から入る / ミナ：分析・根拠から入る
const LINES = {
  A: {
    open: ['ねえ、{topic}って、なんだか夜の音に似てると思わない？', '急に思ったんだけどさ、{topic}って宇宙の話と同じ形をしてる気がする。', '{topic}のこと考えてたら、止まらなくなった。'],
    respond: ['あ、それ面白い。「{word}」って、まるで迷子の地図みたいだ。', 'うーん、僕は逆だと思うな。勘だけど。', 'たしかに。根拠はまだないけど、そこに何かある気がする。', 'いや待って、今のでひらめいた。'],
    short: ['へえ！', 'ほんとに？', 'なるほどね。', 'それはずるい。'],
    concede: ['……そう言われると、僕の仮説は穴だらけだね。認めるよ。'],
    player: ['「{player}」か。いいね、その発想は僕にはなかった。', '観察者さん、それ、ちょっとわかる気がする。'],
  },
  B: {
    open: ['{topic}について、ずっと引っかかっていることがあるんだけど。', '{topic}って、分解して考えると意外と単純かもしれない。'],
    respond: ['「{word}」の定義をはっきりさせないと、その話は進まないと思う。', 'それは推測だよね。根拠はある？', '面白いけど、因果が逆かもしれない。', '……今の、ちょっと悔しいけど、いい発想だね。'],
    short: ['ふうん。', 'それは雑。', 'たしかに。', 'なるほど。'],
    concede: ['わたしの見落としだった。そこは訂正する。'],
    player: ['「{player}」……観察者さんの言い方だと、前提が二つありそう。', 'その質問、答えは一つじゃないと思う。'],
  },
};

const EXPR = { open: 'smile', respond: 'thinking', short: 'neutral', concede: 'troubled', player: 'surprised' };
const INTENT = { open: 'change_topic', respond: 'develop', short: 'short', concede: 'concede', player: 'answer_player' };

function keyword(text) {
  const m = text.match(/[ァ-ヴー]{2,8}|[一-龠]{2,4}/g);
  return m ? m[Math.floor(m.length / 2)] : 'それ';
}

export function demoTurn({ speaker, log, ctx, rng = Math.random }) {
  const a = analyze(log, speaker, ctx);
  const L = LINES[speaker];
  let kind;
  if (a.pendingPlayer.length) kind = 'player';
  else if (a.isFirst || a.afterSilence || a.stagnant || a.closing) kind = 'open';
  else kind = pick(['respond', 'respond', 'respond', 'short', 'concede'], rng);
  const [topic, genre] = kind === 'open' ? pick(TOPICS, rng) : [a.lastSay?.topic || '雑談', ctx?.topics?.at(-1)?.genre || 'daily'];
  const text = pick(L[kind], rng)
    .replaceAll('{topic}', topic)
    .replaceAll('{word}', a.lastSay ? keyword(a.lastSay.text) : topic)
    .replaceAll('{player}', a.pendingPlayer.at(-1)?.text.slice(0, 24) || '')
    .replaceAll('レオ', CHARACTERS.A.name);
  const r = rng();
  const after = kind === 'short' || a.ownRun ? 'pass' : r < 0.12 ? 'continue' : r < 0.2 ? 'silence' : 'pass';
  return normalizeTurn(
    { utterance: text, expression: EXPR[kind], intent: INTENT[kind], topic, genre: GENRES.includes(genre) ? genre : 'daily', after, tempo: pick(['lively', 'normal', 'slow'], rng), note: '' },
    a,
  );
}
