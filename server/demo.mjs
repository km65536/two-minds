// デモモード：API キー無しで画面の動作を確認するための簡易生成器。
// AI は一切使っていない。テンプレートを組み合わせているだけなので、会話の質は本物とは比較にならない。
import { analyze, TOPIC_SEEDS, normalizeTurn } from './conversation.mjs';

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];

const LINES = {
  A: {
    open: ['ねえ、{topic}について考えたことある？ 僕は最近そればかり気になってる。', '少し聞いてほしいんだ。{topic}って、突き詰めると何なんだろう。'],
    question: ['それはどうしてそう思うの？', '{word}って、具体的にはどういうこと？', 'でも、その根拠は何だろう。'],
    disagree: ['いや、そこは賛成できないな。{word}は別の説明もできると思う。', 'うーん、それは少し飛躍してないか？'],
    agree: ['なるほど、{word}という見方は筋が通ってる。', 'それは一理あるね。認めるよ。'],
    develop: ['つまり、{word}を前提にすると、次に問題になるのは「なぜ」の部分だ。', '仮にそうだとすると、{topic}そのものの定義も変わってくるね。'],
    short: ['ふむ。', 'なるほどね。', 'それは面白い。'],
    change: ['話は変わるけど、{topic}についてはどう思う？'],
    player: ['観察者さん、「{player}」って言われてもね……でも、考える価値はありそうだ。'],
  },
  B: {
    open: ['ねえねえ、{topic}の話しよ。なんとなく今そういう気分。'],
    question: ['それってさ、{word}が好きってこと？', 'ふーん、レオはどう感じるの？ 考えるんじゃなくて。'],
    disagree: ['えー、わたしはちょっと違うかも。{word}ってもっとふわっとしてるよ。', 'それ、理屈ではそうかもだけど、なんか違う気がする。'],
    agree: ['あ、それわかる。{word}ってそういう感じあるよね。', 'うん、たしかに。'],
    develop: ['{word}っていえばさ、パン屋さんの前を通るときの気持ちに似てる。', 'それ、雨の日に考えると答えが変わりそう。'],
    short: ['へえー。', 'ふふ。', 'そっかぁ。'],
    change: ['あ、そういえば{topic}のこと考えてたんだった。'],
    player: ['あ、観察者さんが「{player}」だって。どう思う？'],
  },
};

function keyword(text) {
  const m = text.match(/[一-龠ァ-ヴー]{2,6}/g);
  return m ? m[Math.floor(m.length / 2)] : 'それ';
}

export function demoTurn({ speaker, chars, log, rng = Math.random }) {
  const a = analyze(log, speaker);
  const L = LINES[speaker];
  const topic = a.pendingTopic?.text || (a.closing || a.stagnant ? pick(TOPIC_SEEDS, rng) : a.last?.topic || pick(TOPIC_SEEDS, rng));
  const word = a.last ? keyword(a.last.text) : topic;
  let kind;
  if (a.isFirst || a.pendingTopic) kind = 'open';
  else if (a.pendingPlayer.length) kind = 'player';
  else if (a.closing || a.stagnant) kind = 'change';
  else kind = pick(['question', 'disagree', 'agree', 'develop', 'short', 'develop'], rng);
  const tpl = pick(L[kind], rng);
  const text = tpl
    .replaceAll('{topic}', topic)
    .replaceAll('{word}', word)
    .replaceAll('{player}', a.pendingPlayer.at(-1)?.text.slice(0, 30) || '')
    .replaceAll('レオ', chars.A.name);
  const intentMap = { open: 'propose_topic', question: 'question', disagree: 'disagree', agree: 'agree', develop: 'develop', short: 'short', change: 'change_topic', player: 'answer_player' };
  const r = () => Math.round(rng() * 2 - 0.8);
  return normalizeTurn(
    {
      utterance: text,
      inner: '（デモモード）',
      intent: intentMap[kind],
      topic: String(topic).slice(0, 15),
      feeling: { trust: r(), closeness: r(), understanding: r(), agreement: kind === 'disagree' ? -1 : kind === 'agree' ? 1 : 0 },
      addressed_player: kind === 'player',
    },
    chars,
  );
}

export function demoMemory({ entries }) {
  const says = entries.filter((e) => e.kind === 'say');
  const topics = [...new Set(says.map((e) => e.topic).filter(Boolean))].slice(0, 4);
  return {
    newFacts: topics.slice(0, 2).map((t) => ({ about: 'both', category: 'memory', text: `（デモ）「${t}」について話した`, importance: 2 })),
    resolvedIds: [],
    episode: { title: `（デモ）${topics[0] || '雑談'}`, summary: `デモモードの会話（${says.length}発言）。テンプレート生成のため要約はありません。`, topics },
    impressions: { A: '', B: '' },
  };
}
