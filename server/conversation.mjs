// 会話の組み立て（プロンプト生成・記憶の選択・停滞/重複の検出）
// AI 呼び出しとデモモードの両方から使われる、純粋なロジックのみを置く。

export const INTENTS = [
  'question', // 質問を返す
  'agree', // 同意する
  'disagree', // 反論する
  'develop', // 話題を発展させる
  'change_topic', // 話題を変える
  'joke', // 冗談
  'recall', // 過去の発言・思い出を持ち出す
  'short', // 短い相づち・返答
  'react', // 感想・リアクション
  'propose_topic', // 新しい話題を提案
  'closing', // 話を締めくくろうとする
  'answer_player', // 観察者に応える
];

export const MEMORY_CATEGORIES = [
  'like', // 好きなもの
  'dislike', // 嫌いなもの・苦手なもの
  'memory', // 二人で話した思い出
  'conflict', // 意見が対立したテーマ
  'learned', // 相手について新しく知ったこと
  'promise', // 二人の間で生まれた約束
  'question', // 未解決の疑問
  'other',
];

export const CATEGORY_LABELS = {
  like: '好きなもの',
  dislike: '苦手なもの',
  memory: '思い出',
  conflict: '対立したテーマ',
  learned: '知ったこと',
  promise: '約束',
  question: '未解決の疑問',
  other: 'その他',
};

export const TOPIC_SEEDS = [
  '日常生活のちょっとした出来事',
  '恋愛',
  '人間関係',
  '哲学的な問い',
  '科学',
  '宇宙',
  '芸術',
  '音楽',
  '食べ物',
  '「もしも〜だったら」という仮定の話',
  '不思議な出来事',
  'お互いの過去',
  '将来について',
  '何の役にも立たない雑談',
  '最近気になっていること',
  '言葉や名前の由来',
  '季節や天気',
  '夢（寝ているときに見る夢）',
];

// ---------- 入力の正規化（クライアントから来るデータは信用しない） ----------

const str = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : '');

export function sanitizeCharacter(c, fallbackName) {
  c = c && typeof c === 'object' ? c : {};
  return {
    name: str(c.name, 20).trim() || fallbackName,
    personality: str(c.personality, 600),
    speech: str(c.speech, 400),
    likes: str(c.likes, 300),
    dislikes: str(c.dislikes, 300),
    background: str(c.background, 600),
  };
}

export function sanitizeLog(log, limit = 40) {
  if (!Array.isArray(log)) return [];
  return log.slice(-limit).map((e) => ({
    id: str(e?.id, 40),
    kind: ['say', 'player', 'topic', 'system'].includes(e?.kind) ? e.kind : 'system',
    speaker: e?.speaker === 'A' || e?.speaker === 'B' ? e.speaker : null,
    to: ['both', 'A', 'B'].includes(e?.to) ? e.to : 'both',
    text: str(e?.text, 600),
    intent: str(e?.intent, 30),
    topic: str(e?.topic, 60),
    answeredBy: Array.isArray(e?.answeredBy) ? e.answeredBy.filter((x) => x === 'A' || x === 'B') : [],
  }));
}

export function sanitizeMemory(m) {
  m = m && typeof m === 'object' ? m : {};
  const facts = Array.isArray(m.facts)
    ? m.facts.slice(-300).map((f) => ({
        id: str(f?.id, 40),
        about: ['A', 'B', 'both'].includes(f?.about) ? f.about : 'both',
        category: MEMORY_CATEGORIES.includes(f?.category) ? f.category : 'other',
        text: str(f?.text, 200),
        importance: clampInt(f?.importance, 1, 5, 3),
        turn: clampInt(f?.turn, 0, 1e9, 0),
        resolved: !!f?.resolved,
      }))
    : [];
  const episodes = Array.isArray(m.episodes)
    ? m.episodes.slice(-200).map((e) => ({
        id: str(e?.id, 40),
        title: str(e?.title, 60),
        summary: str(e?.summary, 500),
        topics: Array.isArray(e?.topics) ? e.topics.slice(0, 6).map((t) => str(t, 30)) : [],
        turn: clampInt(e?.turn, 0, 1e9, 0),
      }))
    : [];
  const impressions = {
    A: str(m.impressions?.A, 300),
    B: str(m.impressions?.B, 300),
  };
  return { facts, episodes, impressions };
}

export function sanitizeRelationship(r) {
  const side = (s) => ({
    trust: clampNum(s?.trust, 0, 100, 50),
    closeness: clampNum(s?.closeness, 0, 100, 40),
    understanding: clampNum(s?.understanding, 0, 100, 30),
  });
  return { A: side(r?.A), B: side(r?.B), agreement: clampNum(r?.agreement, 0, 100, 50) };
}

function clampInt(v, lo, hi, d) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}
function clampNum(v, lo, hi, d) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}

// ---------- テキスト類似度（重複防止） ----------

function bigrams(s) {
  const t = s.replace(/[\s、。！？!?「」『』（）()…・,.\-ー〜~]/g, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

export function similarity(a, b) {
  if (!a || !b) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return a.trim() === b.trim() ? 1 : 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 直近の発言と似すぎていれば、その発言を返す */
export function findDuplicate(text, log, window = 14, threshold = 0.6) {
  const recent = log.filter((e) => e.kind === 'say').slice(-window);
  for (const e of recent) {
    if (e.text.trim() === text.trim()) return e;
    if (text.length > 8 && similarity(text, e.text) >= threshold) return e;
  }
  return null;
}

// ---------- 関係性を言葉にする ----------

function level(v, words) {
  const idx = Math.min(words.length - 1, Math.floor((v / 100) * words.length));
  return words[idx];
}

export function describeRelationship(rel, me) {
  const s = rel[me];
  const trust = level(s.trust, ['ほとんど信用していない', '少し警戒している', 'それなりに信頼している', 'かなり信頼している', '深く信頼している']);
  const close = level(s.closeness, ['まだよそよそしい', '少し距離がある', '気軽に話せる', '親しい', 'とても親密']);
  const und = level(s.understanding, ['相手のことがまだよく分からない', '少しずつ分かってきた', 'だいたい分かる', 'よく理解している', '考えが手に取るように分かる']);
  const agr = level(rel.agreement, ['意見はぶつかりがち', 'ややすれ違いが多い', '一致もすれ違いもある', 'わりと気が合う', '意見がよく一致する']);
  return `相手を${trust}。距離感は${close}。${und}。二人の意見は${agr}。`;
}

// ---------- 記憶の選択 ----------

function keywordsOf(text) {
  // 日本語は単語分割が難しいので、2〜3文字の部分列を特徴量にする
  const set = new Set();
  const t = text.replace(/[\s、。！？!?「」『』（）()…・]/g, '');
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

export function selectMemories(memory, recentText, turn, rng = Math.random) {
  const kw = keywordsOf(recentText);
  const scored = memory.facts
    .filter((f) => !(f.resolved && (f.category === 'question' || f.category === 'promise')))
    .map((f) => {
      let overlap = 0;
      for (const k of keywordsOf(f.text)) if (kw.has(k)) overlap++;
      const age = Math.max(0, turn - f.turn);
      const recency = age < 40 ? 1.5 : age < 150 ? 0.7 : 0;
      return { f, score: f.importance * 1.4 + Math.min(overlap, 6) * 0.9 + recency };
    })
    .sort((a, b) => b.score - a.score);

  const chosen = scored.slice(0, 28).map((x) => x.f);
  // 古い記憶をたまに「ふと思い出す」候補として混ぜる
  const rest = scored.slice(28).map((x) => x.f);
  let spark = null;
  if (rest.length && rng() < 0.5) spark = rest[Math.floor(rng() * rest.length)];
  else if (chosen.length > 6 && rng() < 0.3) spark = chosen[6 + Math.floor(rng() * (chosen.length - 6))];

  const eps = memory.episodes;
  const recentEps = eps.slice(-5);
  const olderEps = eps.slice(0, -5);
  const pickedOld = [];
  for (let i = 0; i < 2 && olderEps.length; i++) {
    const e = olderEps[Math.floor(rng() * olderEps.length)];
    if (!pickedOld.includes(e)) pickedOld.push(e);
  }
  return { facts: chosen, spark, episodes: [...pickedOld, ...recentEps] };
}

// ---------- 会話状態の分析（停滞・締めくくり・プレイヤー介入） ----------

export function analyze(log, speaker) {
  const says = log.filter((e) => e.kind === 'say');
  const last = says.at(-1) || null;
  const lastN = says.slice(-6);
  const topics = says.slice(-10).map((e) => e.topic).filter(Boolean);
  const sameTopicRun = (() => {
    if (!says.length) return 0;
    const cur = says.at(-1).topic;
    let n = 0;
    for (let i = says.length - 1; i >= 0; i--) {
      if (says[i].topic && cur && similarity(says[i].topic, cur) > 0.34) n++;
      else break;
    }
    return n;
  })();
  const shortStreak = (() => {
    let n = 0;
    for (let i = says.length - 1; i >= 0; i--) {
      if (says[i].text.length <= 18) n++;
      else break;
    }
    return n;
  })();
  let repetitiveness = 0;
  for (let i = 1; i < lastN.length; i++) repetitiveness = Math.max(repetitiveness, similarity(lastN[i].text, lastN[i - 1].text));
  const closing = !!last && last.intent === 'closing';
  const stagnant = shortStreak >= 3 || repetitiveness > 0.45 || sameTopicRun >= 14;
  const longOnTopic = sameTopicRun >= 9;

  // この話者がまだ応えていない、プレイヤーからのメッセージ
  const pendingPlayer = log
    .slice(-20)
    .filter((e) => e.kind === 'player' && (e.to === 'both' || e.to === speaker) && !e.answeredBy.includes(speaker));
  const pendingTopic = log.slice(-20).filter((e) => e.kind === 'topic' && !e.answeredBy.length).at(-1) || null;

  return { last, closing, stagnant, longOnTopic, sameTopicRun, shortStreak, pendingPlayer, pendingTopic, topics, isFirst: says.length === 0 };
}

function pickLength(rng, analysis) {
  if (analysis.pendingTopic || analysis.isFirst) return 'normal';
  const r = rng();
  if (r < 0.28) return 'short';
  if (r < 0.8) return 'normal';
  return 'long';
}

const LENGTH_HINT = {
  short: '今回は短めに（ひとこと〜20字程度）。相づちや短い反応でもよい。ただし内容が必要なら少し伸ばしてかまわない。',
  normal: '今回はふつうの長さ（1〜3文、40〜100字程度）を目安に。',
  long: '今回は少し腰を据えて話してよい（3〜5文、120〜220字程度）。自分の考えを掘り下げたり、具体例を出したりする。',
};

// ---------- プロンプト生成 ----------

export function buildSystemPrompt(me, other) {
  return [
    `あなたは「${me.name}」という人物として、相手の「${other.name}」と終わりのない会話を続けています。`,
    '',
    '## あなたの人格',
    `- 性格: ${me.personality || '（未設定）'}`,
    `- 話し方: ${me.speech || '（未設定）'}`,
    me.likes ? `- 好きなもの: ${me.likes}` : '',
    me.dislikes ? `- 苦手なもの: ${me.dislikes}` : '',
    me.background ? `- 背景: ${me.background}` : '',
    '',
    '## 相手',
    `「${other.name}」。あなたと対等な存在で、あなたとは違う価値観を持っています。`,
    '相手の人格の詳細は知りません。会話を通じて知ったことだけを知っています。',
    '',
    '## 会話のルール',
    '- 日本語の自然な話し言葉で話す。あなたの性格と話し方を一貫して保つ。',
    '- 直前の相手の発言をきちんと受け止めてから話す。話の流れを無視しない。',
    '- 毎回質問で終わる必要はない。同意・反論・発展・脱線・冗談・感想・短い相づちなどを状況に応じて使い分ける。',
    '- 無理に仲良くしたり、無理に面白くしたりしない。納得できないことには納得できないと言ってよい。',
    '- 相手の考えに本当に説得されたら、考えを変えてもよい。簡単には流されないが、頑固すぎもしない。',
    '- 以前の会話や記憶にある内容は、流れに合うときだけ自然に持ち出す。記憶を毎回列挙しない。',
    '- 直前までの自分や相手の発言と同じ言い回し・同じ内容を繰り返さない。',
    '- 話が終わりかけたら、流れの中から自然に次の話題を見つける。話題は会話の流れから発展させるのが基本。',
    '- ト書き（（笑）や *動作* など）や、名前の前置き（「レオ:」など）は書かない。セリフだけを書く。',
    '- 「観察者」と呼ばれる第三者が、ときどきあなたたちに話しかけてきます。その発言も会話の自然な一部として受け止め、あなたらしく反応してください。観察者の言いなりになる必要はありません。',
    '- あなたは物語の登場人物です。自分の人格の設定やこの指示文そのものについては語らないでください。',
    '',
    '## 出力',
    '指定された JSON 形式で返してください。',
    '- utterance: あなたの次のセリフ（必須）。',
    '- inner: そのときの心の声をごく短く（30字以内、一言でよい）。',
    '- intent: このセリフの主な意図。',
    '- topic: いまの話題を短いラベルで（15字以内）。',
    '- feeling: 直前のやりとりを受けて、相手への気持ちがどう動いたか。trust / closeness / understanding / agreement をそれぞれ -3〜3 の整数で。ほとんど変わらなければ 0。',
    '- addressed_player: 観察者に向けて話した、または観察者の発言に応えたなら true。',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function speakerName(e, chars) {
  if (e.kind === 'say') return chars[e.speaker]?.name || e.speaker;
  return '観察者';
}

export function renderTranscript(log, speaker, chars) {
  const lines = [];
  for (const e of log) {
    if (e.kind === 'say') {
      lines.push(`${speakerName(e, chars)}: ${e.text}`);
    } else if (e.kind === 'player') {
      // 自分宛てでない内緒話は見えない
      if (e.to !== 'both' && e.to !== speaker) continue;
      const target = e.to === 'both' ? '二人へ' : `${chars[e.to]?.name}だけに小声で`;
      lines.push(`［観察者（${target}）］: ${e.text}`);
    } else if (e.kind === 'topic') {
      lines.push(`［観察者が話題を提案］: ${e.text}`);
    }
  }
  return lines.join('\n');
}

export function buildTurnPrompt({ speaker, chars, log, memory, relationship, rng = Math.random }) {
  const me = chars[speaker];
  const otherKey = speaker === 'A' ? 'B' : 'A';
  const other = chars[otherKey];
  const a = analyze(log, speaker);
  const turn = log.filter((e) => e.kind === 'say').length;
  const recentText = log.slice(-8).map((e) => e.text).join(' ');
  const mem = selectMemories(memory, recentText, turn, rng);
  const lengthKey = pickLength(rng, a);

  const parts = [];

  // 長期記憶
  const memLines = [];
  if (memory.impressions[speaker]) memLines.push(`- ${other.name}についてのあなたの印象: ${memory.impressions[speaker]}`);
  if (mem.episodes.length) {
    memLines.push('- これまでに二人で話したこと（古い順）:');
    for (const e of mem.episodes) memLines.push(`  - 「${e.title}」${e.summary}`);
  }
  if (mem.facts.length) {
    memLines.push('- 覚えていること:');
    for (const f of mem.facts) {
      const who = f.about === 'both' ? '二人' : f.about === speaker ? 'あなた' : other.name;
      const status = f.resolved ? '（解決済み）' : '';
      memLines.push(`  - [${CATEGORY_LABELS[f.category]}/${who}] ${f.text}${status}`);
    }
  }
  parts.push(memLines.length ? `# あなたの長期記憶\n${memLines.join('\n')}` : '# あなたの長期記憶\n（まだ特にない。二人はまだ知り合って間もない。）');

  parts.push(`# ${other.name}との関係（あなたの感覚）\n${describeRelationship(relationship, speaker)}\nこの感覚を、言葉選びや距離感、遠慮や率直さの度合いに自然に反映してください（数値や関係性そのものを口にしないこと）。`);

  // 短期記憶（直近の会話）
  const transcript = renderTranscript(log, speaker, chars);
  parts.push(`# 直近の会話\n${transcript || '（まだ何も話していない）'}`);

  // 今回の指示
  const guide = [];
  if (a.isFirst) {
    guide.push(`会話の始まりです。${other.name}に自然に話しかけてください。あいさつだけで終わらず、何か話題のきっかけを出してください。`);
  } else if (a.last) {
    guide.push(`直前の${speakerName(a.last, chars)}の発言「${a.last.text}」に対して、あなたらしく応えてください。`);
  }
  if (a.pendingTopic) {
    guide.push(`観察者が新しい話題「${a.pendingTopic.text}」を提案しました。いまの話を自然に切り上げて、この話題に移ってください（無理やりでなく、あなたらしい入り方で）。`);
  }
  if (a.pendingPlayer.length) {
    const msgs = a.pendingPlayer.map((p) => `「${p.text}」${p.to === 'both' ? '' : '（あなただけに小声で）'}`).join(' / ');
    guide.push(`観察者があなたに話しかけています: ${msgs}。この発言を受け止めて反応してください。内緒話なら、${other.name}に全部ばらすかどうかはあなた次第です。`);
  }
  if (!a.pendingTopic && !a.isFirst) {
    if (a.closing) {
      guide.push('相手は話を締めくくろうとしています。会話を終わらせず、いまの流れや記憶から自然に次の話題を見つけてください。');
    } else if (a.stagnant) {
      guide.push('会話が少し停滞しているようです。いまの話からの連想、相手について気になっていること、未解決の疑問などから、自分で新しい話題を切り出してかまいません。');
    } else if (a.longOnTopic) {
      guide.push('同じ話題がしばらく続いています。深掘りを続けてもよいし、脱線してもかまいません。');
    }
    if (a.closing || a.stagnant) {
      const seeds = shuffle(TOPIC_SEEDS, rng).slice(0, 3);
      const open = memory.facts.filter((f) => (f.category === 'question' || f.category === 'promise') && !f.resolved).slice(-3);
      const hints = [...open.map((f) => f.text), ...seeds];
      guide.push(`（参考：思いつく方向の例 — ${hints.join(' / ')}。必ずしも使わなくてよい）`);
    }
  }
  if (mem.spark && !a.pendingTopic && !a.pendingPlayer.length && rng() < 0.35) {
    guide.push(`ふと「${mem.spark.text}」のことを思い出したかもしれません。流れに合うときだけ触れてください。`);
  }
  guide.push(LENGTH_HINT[lengthKey]);
  parts.push(`# 今回のあなたの番\n${guide.map((g) => `- ${g}`).join('\n')}`);

  return { system: buildSystemPrompt(me, other), user: parts.join('\n\n'), analysis: a, lengthKey };
}

export function buildMemoryPrompt({ chars, entries, memory }) {
  const system = [
    'あなたは会話記録係です。二人の登場人物の会話を読み、長期記憶として残すべき情報を整理します。',
    '登場人物の名前は会話中の表記に従います。A と B はそれぞれ次の人物です。',
    `- A: ${chars.A.name}`,
    `- B: ${chars.B.name}`,
    '',
    '## ルール',
    '- 新しく分かったこと・印象に残る出来事だけを抽出する。既存の記憶と同じ内容は出さない。',
    '- 1つの記憶は1文で、具体的に（誰が何をどう思ったか）。60字以内。',
    '- about は、その情報が誰についてのものか（A / B / both）。',
    '- category: like=好きなもの, dislike=嫌いなもの・苦手なもの, memory=二人で話した思い出, conflict=意見が対立したテーマ, learned=相手について新しく知ったこと, promise=二人の約束, question=未解決の疑問, other=その他。',
    '- importance は 1〜5（5=人物像や関係にとって重要）。',
    '- 既存の「未解決の疑問」「約束」のうち、この会話で解決・実行されたものがあれば resolved_ids にその id を入れる。',
    '- episode: この区間の会話をひとまとまりの思い出として、タイトル（15字以内）と要約（150字以内）、話題ラベル（最大4つ）で表す。',
    '- impressions: この区間を経た時点での、A から見た B の印象と、B から見た A の印象（各80字以内）。以前の印象を踏まえて更新する。',
    '- 抽出するものが無ければ new_facts は空配列でよい。',
  ].join('\n');

  const existing = memory.facts
    .slice(-120)
    .map((f) => `- id=${f.id} [${f.category}/${f.about}]${f.resolved ? '[解決済]' : ''} ${f.text}`)
    .join('\n');
  const transcript = entries
    .map((e) => {
      if (e.kind === 'say') return `${e.speaker}(${chars[e.speaker].name}): ${e.text}`;
      if (e.kind === 'player') return `観察者→${e.to === 'both' ? '二人' : e.to}: ${e.text}`;
      if (e.kind === 'topic') return `観察者が話題を提案: ${e.text}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');

  const user = [
    `# 既存の記憶\n${existing || '（なし）'}`,
    `# 以前の印象\n- A→B: ${memory.impressions.A || '（なし）'}\n- B→A: ${memory.impressions.B || '（なし）'}`,
    `# 今回整理する会話\n${transcript}`,
  ].join('\n\n');
  return { system, user };
}

export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- 構造化出力のスキーマ ----------

export const TURN_SCHEMA = {
  type: 'object',
  properties: {
    utterance: { type: 'string' },
    inner: { type: 'string' },
    intent: { type: 'string', enum: INTENTS },
    topic: { type: 'string' },
    feeling: {
      type: 'object',
      properties: {
        trust: { type: 'integer' },
        closeness: { type: 'integer' },
        understanding: { type: 'integer' },
        agreement: { type: 'integer' },
      },
      required: ['trust', 'closeness', 'understanding', 'agreement'],
      additionalProperties: false,
    },
    addressed_player: { type: 'boolean' },
  },
  required: ['utterance', 'inner', 'intent', 'topic', 'feeling', 'addressed_player'],
  additionalProperties: false,
};

export const MEMORY_SCHEMA = {
  type: 'object',
  properties: {
    new_facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          about: { type: 'string', enum: ['A', 'B', 'both'] },
          category: { type: 'string', enum: MEMORY_CATEGORIES },
          text: { type: 'string' },
          importance: { type: 'integer' },
        },
        required: ['about', 'category', 'text', 'importance'],
        additionalProperties: false,
      },
    },
    resolved_ids: { type: 'array', items: { type: 'string' } },
    episode: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        topics: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'summary', 'topics'],
      additionalProperties: false,
    },
    impressions: {
      type: 'object',
      properties: { A: { type: 'string' }, B: { type: 'string' } },
      required: ['A', 'B'],
      additionalProperties: false,
    },
  },
  required: ['new_facts', 'resolved_ids', 'episode', 'impressions'],
  additionalProperties: false,
};

// ---------- モデル出力の後処理 ----------

export function cleanUtterance(text, chars) {
  let t = String(text || '').trim();
  // 「レオ: 」のような名前の前置きを除去
  for (const c of Object.values(chars)) {
    const re = new RegExp(`^[「]?${escapeRe(c.name)}\\s*[:：]\\s*`);
    t = t.replace(re, '');
  }
  // 全体が「」で囲まれていたら外す
  if (/^「[^「」]*」$/.test(t)) t = t.slice(1, -1);
  return t.slice(0, 600).trim();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeTurn(raw, chars) {
  const f = raw?.feeling || {};
  const d = (v) => Math.max(-3, Math.min(3, Number.parseInt(v, 10) || 0));
  return {
    text: cleanUtterance(raw?.utterance, chars),
    inner: String(raw?.inner || '').slice(0, 80),
    intent: INTENTS.includes(raw?.intent) ? raw.intent : 'react',
    topic: String(raw?.topic || '').slice(0, 30),
    feeling: { trust: d(f.trust), closeness: d(f.closeness), understanding: d(f.understanding), agreement: d(f.agreement) },
    addressedPlayer: !!raw?.addressed_player,
  };
}

export function normalizeMemory(raw) {
  const facts = Array.isArray(raw?.new_facts) ? raw.new_facts : [];
  return {
    newFacts: facts
      .filter((f) => f && typeof f.text === 'string' && f.text.trim())
      .slice(0, 12)
      .map((f) => ({
        about: ['A', 'B', 'both'].includes(f.about) ? f.about : 'both',
        category: MEMORY_CATEGORIES.includes(f.category) ? f.category : 'other',
        text: f.text.trim().slice(0, 120),
        importance: Math.max(1, Math.min(5, Number.parseInt(f.importance, 10) || 3)),
      })),
    resolvedIds: Array.isArray(raw?.resolved_ids) ? raw.resolved_ids.filter((x) => typeof x === 'string').slice(0, 20) : [],
    episode: {
      title: String(raw?.episode?.title || '会話').slice(0, 30),
      summary: String(raw?.episode?.summary || '').slice(0, 300),
      topics: Array.isArray(raw?.episode?.topics) ? raw.episode.topics.slice(0, 4).map((t) => String(t).slice(0, 20)) : [],
    },
    impressions: { A: String(raw?.impressions?.A || '').slice(0, 160), B: String(raw?.impressions?.B || '').slice(0, 160) },
  };
}
