// デモモード：API キー無しで画面の動作を確認するための、決まった筋書きの会話記録。
// AI は一切使っていない。用意した台本を順番に返すだけで、会話の質は本物とは比べものにならない。
import { normalizeEpisode } from './conversation.mjs';

const L = (speaker, text, type = 'chat', phase = 'FREE', expression = 'neutral', action = 'none', pause = 'none') => ({ speaker, text, type, phase, expression, action, pause });

const SCRIPTS = [
  {
    summary: '靴下が片方だけなくなる理由を推理した。',
    topic: '消える靴下',
    problem: { exists: true, question: '靴下はなぜ片方だけなくなるのか', kind: 'daily_mystery', status: 'resolved', leo_view: '洗濯機の中に靴下だけの国がある', mina_view: '数え間違いと、洗濯物の移動中に落ちている', explored: ['洗濯機のすき間', '組み合わせの数'], conclusion: '片方だけ失くすと目立つので、なくなる回数より「なくなった気がする」回数が多い', unresolved_reason: '', open_points: [] },
    lines: [
      L('A', 'ねえ、また靴下が片方だけないんだけど。', 'chat', 'FREE', 'troubled'),
      L('B', 'それ、先週も言ってなかった？', 'react', 'FREE', 'smile'),
      L('A', 'ちょっと待って。なんでいつも「片方だけ」なんだろう。', 'question', 'DISCOVERY', 'thinking', 'tilt'),
      L('A', '僕の仮説。洗濯機の奥に、靴下だけが暮らす国がある。', 'hypothesis', 'EXPLORATION', 'smile', 'lean'),
      L('B', 'かわいいけど却下。わたしは、運ぶ途中で落ちてると思う。', 'objection', 'EXPLORATION', 'neutral', 'shrug'),
      L('B', 'それに、両方なくなったら「靴下がない」とすら気づかないでしょ。', 'insight', 'EXPLORATION', 'thinking', 'none', 'short'),
      L('A', 'あ……片方だけ残るから、なくしたことに気づくのか。', 'concede', 'EXPLORATION', 'surprised'),
      L('B', 'そう。だから「片方だけ消える」んじゃなくて、「片方だけ目立つ」。', 'conclusion', 'RESOLUTION', 'smile', 'nod'),
      L('A', 'じゃあ靴下の国はないのか……ちょっと残念。', 'joke', 'AFTERMATH', 'sad'),
      L('B', 'あってもいいよ。夢があるし。', 'chat', 'AFTERMATH', 'laugh', 'laugh'),
    ],
    next: { hook: '洗濯物の話', deferred_questions: ['なぜ洗濯物はからまるのか'], continue_problem: false },
  },
  {
    summary: 'お茶が冷めるとおいしくなくなる理由を考えた。',
    topic: 'ぬるいお茶',
    problem: { exists: true, question: 'ぬるいお茶はなぜおいしく感じないのか', kind: 'science', status: 'resolved', leo_view: '期待とのズレ', mina_view: '温度で感じる味の強さが変わる', explored: ['舌の感じ方', '香り'], conclusion: '温度で香りの立ち方と味の感じ方が変わる。それに「熱いはず」という期待も重なる', unresolved_reason: '', open_points: [] },
    lines: [
      L('B', 'お茶、ぬるくなっちゃった。', 'chat', 'FREE', 'troubled', 'sip'),
      L('A', '同じお茶なのに、ぬるいと急にまずくなるよね。', 'chat', 'FREE', 'neutral'),
      L('B', '……それ、ちょっと不思議かも。中身は何も変わってないのに。', 'question', 'DISCOVERY', 'thinking', 'tilt', 'short'),
      L('A', '僕は「熱いはずなのに」っていう、がっかりのせいだと思う。', 'hypothesis', 'EXPLORATION', 'thinking'),
      L('B', 'それもあるけど、温度で香りの出方が変わるんじゃないかな。熱いと湯気と一緒に香りが来る。', 'hypothesis', 'EXPLORATION', 'neutral'),
      L('A', 'たしかに、冷めたお茶って匂いがしない。', 'agree', 'EXPLORATION', 'surprised', 'nod'),
      L('B', '舌の感じ方も温度で変わるって聞いたことがある。そこは自信ないけど。', 'aside', 'EXPLORATION', 'thinking'),
      L('A', 'じゃあ、香りと舌と、がっかりの合わせ技。', 'conclusion', 'RESOLUTION', 'smile'),
      L('B', '最後のいる？', 'joke', 'AFTERMATH', 'laugh', 'laugh'),
    ],
    next: { hook: '飲み物の温度', deferred_questions: [], continue_problem: false },
  },
  {
    summary: '夢をすぐ忘れる理由を話したが、決め手がなく未解決になった。',
    topic: '忘れる夢',
    problem: { exists: true, question: '夢はなぜすぐ忘れるのか', kind: 'psychology', status: 'unresolved', leo_view: '夢は現実と混ざらないように消える', mina_view: '起きた直後は記憶を残す準備ができていない', explored: ['起きた瞬間', 'メモを取ると覚えている'], conclusion: '', unresolved_reason: 'どちらも推測で、確かめる方法が二人には分からない', open_points: ['夢を覚えている人と忘れる人の違い'] },
    lines: [
      L('A', 'さっき見てた夢、もう思い出せない。すごく面白かったのに。', 'chat', 'FREE', 'sad'),
      L('B', 'あるある。起きて三秒で消えるよね。', 'react', 'FREE', 'smile'),
      L('B', 'でも、なんですぐ忘れるんだろう。', 'question', 'DISCOVERY', 'thinking', 'think', 'short'),
      L('A', '夢が現実と混ざらないように、わざと消えるんじゃない？', 'hypothesis', 'EXPLORATION', 'thinking', 'lean'),
      L('B', 'わたしは、寝起きは記憶を残す準備ができてないだけだと思う。', 'hypothesis', 'EXPLORATION', 'neutral'),
      L('A', 'でもメモすると覚えてるよね。', 'objection', 'EXPLORATION', 'surprised'),
      L('B', 'それは、書くことで改めて覚え直してるのかも。……うーん、確かめようがないな。', 'concede', 'EXPLORATION', 'troubled', 'shrug', 'long'),
      L('A', 'これは保留だね。今度、夢日記つけてみる。', 'conclusion', 'RESOLUTION', 'smile'),
    ],
    next: { hook: '夢日記', deferred_questions: ['夢を覚えている人と忘れる人の違い'], continue_problem: false },
  },
  {
    summary: '好きな雲の形について雑談した。',
    topic: '雲の形',
    problem: { exists: false, question: '', kind: 'none', status: 'none', leo_view: '', mina_view: '', explored: [], conclusion: '', unresolved_reason: '', open_points: [] },
    lines: [
      L('B', '今日の雲、なんか魚みたいだった。', 'chat', 'FREE', 'smile', 'look_away'),
      L('A', '僕は昨日、どう見ても恐竜の雲を見たよ。', 'chat', 'FREE', 'laugh'),
      L('B', 'それ、本当に恐竜だった？', 'joke', 'FREE', 'smile', 'tilt'),
      L('A', '首が長かったから、たぶん恐竜。もしくはキリン。', 'joke', 'FREE', 'thinking'),
      L('B', '幅が広すぎる。', 'react', 'FREE', 'laugh', 'laugh'),
      L('A', '雲って、見る人によって全然違うものになるのがいいよね。', 'chat', 'AFTERMATH', 'smile', 'none', 'short'),
    ],
    next: { hook: '空を見上げること', deferred_questions: [], continue_problem: false },
  },
];

let cursor = Math.floor(Math.random() * SCRIPTS.length);

export function demoEpisode({ ctx, interrupt }) {
  if (interrupt) {
    const t = interrupt.text.slice(0, 30);
    const q = interrupt.problem?.question;
    return normalizeEpisode({
      summary: `観察者の「${t}」に反応した。`,
      topic: interrupt.problem ? 'さっきの続き' : '観察者の話',
      problem: interrupt.problem ? { exists: true, ...interrupt.problem, status: 'continuing' } : { exists: false },
      lines: [
        L('A', `お、「${t}」だって。`, 'answer_player', 'EXPLORATION', 'surprised', 'tilt'),
        L('B', 'その視点はなかった。少し考えさせて。', 'answer_player', 'EXPLORATION', 'thinking', 'think', 'short'),
        L('A', q ? `じゃあ、「${q}」も見方が変わるかもね。` : 'せっかくだし、その話をもう少し聞いてみたいな。', 'insight', 'EXPLORATION', 'smile', 'lean'),
        L('B', 'うん。あとで、ちゃんと確かめよう。', 'agree', 'AFTERMATH', 'smile', 'nod'),
      ],
      next: { hook: '', deferred_questions: [], continue_problem: !!interrupt.problem },
    });
  }
  const script = SCRIPTS[cursor % SCRIPTS.length];
  cursor++;
  return normalizeEpisode(script, { recent: ctx?.recent || [] }) || normalizeEpisode(script);
}
