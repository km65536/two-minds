// デモモード：API キー無しで画面の動作を確認するための簡易生成器。
// AI は一切使っていない。決まった文型を組み合わせているだけで、会話の質は本物とは比べものにならない。
import { analyze, TOPIC_SEEDS, normalizeTurn, CHARACTERS } from './conversation.mjs';

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];

const LINES = {
  A: {
    open: ['ねえ、{topic}について考えたことある？ 僕は最近そればかり気になってる。', '少し聞いてほしいんだ。{topic}って、突き詰めると何なんだろう。'],
    question: ['それはどうしてそう思うの？', '「{word}」って、具体的にはどういうこと？', 'でも、その根拠は何だろう。'],
    disagree: ['いや、そこは賛成できないな。「{word}」は別の説明もできると思う。', 'うーん、それは少し飛躍してないか？'],
    agree: ['なるほど、「{word}」という見方は筋が通ってる。', 'それは一理あるね。認めるよ。'],
    develop: ['つまり、「{word}」を前提にすると、次は「なぜ」が問題になる。', '仮にそうだとすると、{topic}の定義そのものが変わってくるね。'],
    short: ['ふむ。', 'なるほどね。', 'それは面白い。'],
    change: ['話は変わるけど、{topic}についてはどう思う？'],
    player: ['「{player}」か……。観察者さん、それには理由があるのかい？', '観察者さんの言うことも一理ある。でも僕はまだ納得していないよ。'],
  },
  B: {
    open: ['ねえねえ、{topic}の話しよ。なんとなく今そういう気分。'],
    question: ['それってさ、「{word}」が好きってこと？', 'ふーん。レオはどう感じるの？ 考えるんじゃなくて。'],
    disagree: ['えー、わたしはちょっと違うかも。もっとふわっとしてるよ。', 'それ、理屈ではそうかもだけど、なんか違う気がする。'],
    agree: ['あ、それわかる。「{word}」ってそういう感じあるよね。', 'うん、たしかに。'],
    develop: ['「{word}」っていえばさ、パン屋さんの前を通るときの気持ちに似てる。', 'それ、雨の日に考えると答えが変わりそう。'],
    short: ['へえー。', 'ふふ。', 'そっかぁ。'],
    change: ['あ、そういえば{topic}のこと考えてたんだった。'],
    player: ['あ、観察者さんだ。「{player}」だって。ふふ、どう思う？', '観察者さん、それ、ちょっとわかるかも。'],
  },
};

const EXPRESSION = { open: 'smile', question: 'thinking', disagree: 'annoyed', agree: 'smile', develop: 'neutral', short: 'neutral', change: 'surprised', player: 'surprised' };
const INTENT = { open: 'change_topic', question: 'question', disagree: 'disagree', agree: 'agree', develop: 'develop', short: 'short', change: 'change_topic', player: 'answer_player' };

function keyword(text) {
  const m = text.match(/[ァ-ヴー]{2,8}|[一-龠]{2,4}/g);
  return m ? m[Math.floor(m.length / 2)] : 'それ';
}

export function demoTurn({ speaker, log, rng = Math.random }) {
  const a = analyze(log, speaker);
  const L = LINES[speaker];
  const topic = a.closing || a.stagnant || a.isFirst ? pick(TOPIC_SEEDS, rng) : a.lastSay?.topic || pick(TOPIC_SEEDS, rng);
  let kind;
  if (a.pendingPlayer.length) kind = 'player';
  else if (a.isFirst) kind = 'open';
  else if (a.closing || a.stagnant) kind = 'change';
  else kind = pick(['question', 'disagree', 'agree', 'develop', 'short', 'develop'], rng);
  const text = pick(L[kind], rng)
    .replaceAll('{topic}', topic)
    .replaceAll('{word}', a.lastSay ? keyword(a.lastSay.text) : topic)
    .replaceAll('{player}', a.pendingPlayer.at(-1)?.text.slice(0, 24) || '')
    .replaceAll('レオ', CHARACTERS.A.name);
  return normalizeTurn({ utterance: text, expression: EXPRESSION[kind], intent: INTENT[kind], topic: String(topic).slice(0, 12) });
}
