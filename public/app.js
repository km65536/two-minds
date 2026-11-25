// TWO MINDS — クライアント
// 会話の進行・状態管理・保存・描画を担当する。AI の呼び出しは必ずサーバー経由（/api/*）。

const STORAGE_KEY = 'twominds:v1';
const MAX_LOG = 4000; // 保存するログの上限（それ以前は記憶の要約として残る）
const RENDER_PAGE = 150;
const SHORT_TERM = 30; // AI に渡す直近ログの件数
const MAX_FACTS = 220;

const DEFAULT_CHARACTERS = {
  A: {
    name: 'レオ',
    personality:
      '好奇心旺盛で、論理的で知的。少し理屈っぽく、何事にも理由を求める。哲学的な話が好き。自分の意見をしっかり持っていて、相手の意見に簡単には流されない。',
    speech: '落ち着いた口調で、くだけすぎない。「つまり」「なぜなら」「〜だと思う」をよく使う。一人称は「僕」。',
    likes: '思考実験、古い天文学の本、筋の通った説明、夜の散歩',
    dislikes: '根拠のない断定、曖昧なままの結論',
    background: '考え事を始めると時間を忘れる。小さい頃から「なぜ？」が口ぐせだった。',
  },
  B: {
    name: 'ミナ',
    personality:
      'マイペースで、感覚的で自由な発想の持ち主。少し天然。独特な価値観を持ち、日常の些細なことに興味を持つ。話題を突然変えることがある。でも、ときどき意外と核心を突く。',
    speech: 'やわらかく、くだけた口調。「なんかさ」「〜かも」「ねえ」。一人称は「わたし」。ときどき擬音語を使う。',
    likes: '雨の音、パン屋さんの匂い、変な形の雲、知らない道を歩くこと',
    dislikes: '急かされること、難しい言葉ばかりの話',
    background: '気になったものはつい立ち止まって眺めてしまう。小さなノートに、どうでもいい発見を書きためている。',
  },
};

const SPEEDS = {
  slow: { delay: 5200, perChar: 55, read: 45 },
  normal: { delay: 2600, perChar: 32, read: 28 },
  fast: { delay: 900, perChar: 14, read: 10 },
  instant: { delay: 250, perChar: 0, read: 0 },
};

const CATEGORY_LABELS = {
  like: '好きなもの',
  dislike: '苦手なもの',
  memory: '思い出',
  conflict: '対立したテーマ',
  learned: '知ったこと',
  promise: '約束',
  question: '未解決の疑問',
  other: 'その他',
};

// ---------------- 状態 ----------------

function freshRelationship() {
  return {
    A: { trust: 50, closeness: 35, understanding: 25 },
    B: { trust: 50, closeness: 35, understanding: 25 },
    agreement: 50,
    history: [],
  };
}
function freshMemory() {
  return { facts: [], episodes: [], impressions: { A: '', B: '' }, cursor: 0, lastAttemptSays: 0 };
}
function freshState() {
  return {
    version: 1,
    characters: structuredClone(DEFAULT_CHARACTERS),
    log: [],
    memory: freshMemory(),
    relationship: freshRelationship(),
    settings: { speed: 'normal', mode: 'ai', showInner: false, autoPause: true, memEvery: 12 },
    stats: { elapsedMs: 0, says: 0, inputTokens: 0, outputTokens: 0, calls: 0 },
    nextSpeaker: 'A',
    started: false,
  };
}

let state = load();
let running = false;
let busy = false;
let memBusy = false;
let epoch = 0; // リセットのたびに増やし、古いリクエストの結果を捨てる
let timer = null;
let consecutiveErrors = 0;
let serverStatus = { configured: false, model: '' };
let renderFrom = 0;
let target = 'both';
let personaWho = 'A';
let hiddenSince = null;

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshState();
    const s = JSON.parse(raw);
    const base = freshState();
    return {
      ...base,
      ...s,
      characters: { A: { ...base.characters.A, ...s.characters?.A }, B: { ...base.characters.B, ...s.characters?.B } },
      memory: { ...base.memory, ...s.memory, impressions: { ...base.memory.impressions, ...s.memory?.impressions } },
      relationship: { ...base.relationship, ...s.relationship },
      settings: { ...base.settings, ...s.settings },
      stats: { ...base.stats, ...s.stats },
      log: Array.isArray(s.log) ? s.log : [],
    };
  } catch (e) {
    console.warn('保存データを読み込めませんでした', e);
    return freshState();
  }
}

let saveTimer = null;
function save(immediate = false) {
  clearTimeout(saveTimer);
  const doSave = () => {
    trimLog();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // 容量超過：古いログをさらに削って再試行
      const cut = Math.floor(state.log.length / 3);
      if (cut > 0) {
        dropOldest(cut);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
          return;
        } catch {}
      }
      toast('ブラウザの保存容量が足りません。設定から書き出しを行ってください。');
    }
  };
  if (immediate) doSave();
  else saveTimer = setTimeout(doSave, 400);
}

function trimLog() {
  if (state.log.length > MAX_LOG) dropOldest(state.log.length - MAX_LOG);
}
function dropOldest(n) {
  state.log.splice(0, n);
  state.memory.cursor = Math.max(0, state.memory.cursor - n);
  renderFrom = Math.max(0, renderFrom - n);
}

// ---------------- DOM ----------------

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'),
  log: $('log'),
  items: $('logItems'),
  typing: $('typing'),
  empty: $('emptyState'),
  jump: $('jumpLatest'),
  loadOlder: $('loadOlder'),
  input: $('input'),
  playBtn: $('playBtn'),
  playLabel: $('playLabel'),
  statusPill: $('statusPill'),
  statusText: $('statusText'),
  elapsed: $('elapsed'),
  count: $('count'),
  modeBadge: $('modeBadge'),
  topic: $('topicLabel'),
  bond: $('bondLine'),
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const nameOf = (w) => state.characters[w]?.name || w;
const other = (w) => (w === 'A' ? 'B' : 'A');
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const saysCount = () => state.log.filter((e) => e.kind === 'say').length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 描画 ----------------

function isNearBottom() {
  const l = el.log;
  return l.scrollHeight - l.scrollTop - l.clientHeight < 90;
}
function scrollToBottom() {
  el.log.scrollTop = el.log.scrollHeight;
  el.jump.hidden = true;
}
function afterAppend(wasNear) {
  if (wasNear) scrollToBottom();
  else el.jump.hidden = false;
}

function entryNode(e) {
  if (e.kind === 'say') {
    const n = document.createElement('div');
    n.className = `msg ${e.speaker}`;
    n.dataset.id = e.id;
    n.innerHTML = `<div class="who"><b>${esc(nameOf(e.speaker))}</b>${e.demo ? '<span class="tag">DEMO</span>' : ''}</div><div class="bubble"></div>${e.inner ? `<div class="inner">${esc(e.inner)}</div>` : ''}`;
    n.querySelector('.bubble').textContent = e.text;
    return n;
  }
  if (e.kind === 'player') {
    const n = document.createElement('div');
    n.className = 'msg player';
    n.dataset.id = e.id;
    const to = e.to === 'both' ? 'あなた → 二人' : `あなた → ${esc(nameOf(e.to))}（内緒）`;
    n.innerHTML = `<div class="who">${to}</div><div class="bubble"></div>`;
    n.querySelector('.bubble').textContent = e.text;
    return n;
  }
  const n = document.createElement('div');
  n.className = `divider ${e.kind === 'topic' ? 'topic' : e.level || ''}`;
  n.dataset.id = e.id;
  const span = document.createElement('span');
  span.textContent = e.kind === 'topic' ? `話題の提案：${e.text}` : e.text;
  n.appendChild(span);
  return n;
}

function renderLog() {
  el.items.innerHTML = '';
  renderFrom = Math.max(0, state.log.length - RENDER_PAGE);
  const frag = document.createDocumentFragment();
  for (let i = renderFrom; i < state.log.length; i++) frag.appendChild(entryNode(state.log[i]));
  el.items.appendChild(frag);
  el.loadOlder.hidden = renderFrom === 0;
  el.empty.hidden = state.log.length > 0;
  scrollToBottom();
}

function loadOlder() {
  const prevH = el.log.scrollHeight;
  const start = Math.max(0, renderFrom - RENDER_PAGE);
  const frag = document.createDocumentFragment();
  for (let i = start; i < renderFrom; i++) frag.appendChild(entryNode(state.log[i]));
  el.items.prepend(frag);
  renderFrom = start;
  el.loadOlder.hidden = renderFrom === 0;
  el.log.scrollTop += el.log.scrollHeight - prevH;
}

function pushEntry(e, { animateText = false } = {}) {
  const wasNear = isNearBottom();
  state.log.push(e);
  el.empty.hidden = true;
  const node = entryNode(e);
  el.items.appendChild(node);
  afterAppend(wasNear);
  save();
  return node;
}

function systemLine(text, level = '') {
  pushEntry({ id: uid(), kind: 'system', level, text, t: Date.now() });
}

async function typewrite(node, text) {
  const sp = SPEEDS[state.settings.speed] || SPEEDS.normal;
  const bubble = node.querySelector('.bubble');
  if (!sp.perChar || document.hidden) {
    bubble.textContent = text;
    afterAppend(isNearBottom());
    return;
  }
  bubble.textContent = '';
  bubble.classList.add('typing-now');
  const myEpoch = epoch;
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    if (myEpoch !== epoch || !node.isConnected) break;
    const wasNear = isNearBottom();
    bubble.textContent += chars[i];
    if (wasNear) scrollToBottom();
    const c = chars[i];
    await sleep(sp.perChar * ('、。！？!?…'.includes(c) ? 5 : 1));
  }
  bubble.textContent = text;
  bubble.classList.remove('typing-now');
}

function setCharState(who, mode) {
  for (const w of ['A', 'B']) {
    const c = $(`char${w}`);
    c.classList.toggle('speaking', w === who && mode === 'speaking');
    c.classList.toggle('thinking', w === who && mode === 'thinking');
    $(`state${w}`).textContent = w === who && mode === 'thinking' ? '考え中…' : w === who && mode === 'speaking' ? '話している' : running ? '聞いている' : '—';
  }
}

function showTyping(who) {
  el.typing.className = `typing ${who}`;
  el.typing.hidden = !who;
  if (who) afterAppend(isNearBottom());
}

function renderHeader() {
  const s = state.stats;
  const sec = Math.floor(s.elapsedMs / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  el.elapsed.textContent = h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  el.count.textContent = saysCount().toLocaleString();
}

function setStatus(kind) {
  const labels = { idle: '未開始', running: '会話中', paused: '停止中', error: 'エラー' };
  el.statusPill.dataset.state = kind;
  el.statusText.textContent = labels[kind];
  el.playLabel.textContent = running ? '一時停止' : state.started ? '再開' : '開始';
  el.playBtn.classList.toggle('primary', !running);
}

function renderNames() {
  for (const w of ['A', 'B']) {
    const n = nameOf(w);
    $(`name${w}`).textContent = n;
    $(`initial${w}`).textContent = Array.from(n)[0] || w;
    $(`target${w}`).textContent = `${n}へ`;
    $(`personaTab${w}`).textContent = n;
  }
  $('relTitleA').textContent = `${nameOf('A')} → ${nameOf('B')}`;
  $('relTitleB').textContent = `${nameOf('B')} → ${nameOf('A')}`;
  document.querySelector('.empty-sub').innerHTML = `「開始」を押すと、${esc(nameOf('A'))}と${esc(nameOf('B'))}が話し始めます。<br>あなたはその会話を、ただ眺めていても、ときどき口を挟んでもかまいません。`;
}

function renderTopic() {
  const last = [...state.log].reverse().find((e) => e.kind === 'say' && e.topic);
  el.topic.textContent = last ? last.topic : '';
  const r = state.relationship;
  const closeness = (r.A.closeness + r.B.closeness) / 2;
  el.bond.style.opacity = String(0.15 + (closeness / 100) * 0.85);
  el.bond.style.height = closeness > 70 ? '2px' : '1px';
}

function renderMode() {
  const demo = state.settings.mode === 'demo';
  el.modeBadge.hidden = !demo;
  $('modeAi').classList.toggle('active', !demo);
  $('modeDemo').classList.toggle('active', demo);
  $('apiInfo').textContent = serverStatus.configured
    ? `AI: ${serverStatus.model}（記憶整理: ${serverStatus.memoryModel}）`
    : 'API キー未設定。デモモードは AI を使わないテンプレート会話です。';
}

// ---- 関係性パネル ----
function meter(label, value, trend) {
  const t = trend ? `<span class="trend">${trend > 0 ? '↑' : '↓'}${Math.abs(trend).toFixed(0)}</span>` : '<span class="trend"></span>';
  return `<div class="meter"><div class="meter-head"><span>${label}</span>${t}</div><div class="meter-track"><div class="meter-fill" style="width:${value.toFixed(1)}%"></div></div></div>`;
}
function renderRelationship() {
  const r = state.relationship;
  const past = r.history.length > 2 ? r.history[Math.max(0, r.history.length - 3)] : null;
  const tr = (w, k) => (past ? r[w][k] - past[w][k] : 0);
  for (const w of ['A', 'B']) {
    $(`rel${w}`).innerHTML = meter('信頼', r[w].trust, tr(w, 'trust')) + meter('親しさ', r[w].closeness, tr(w, 'closeness')) + meter('理解度', r[w].understanding, tr(w, 'understanding'));
    $(`imp${w}`).textContent = state.memory.impressions[w] ? `「${state.memory.impressions[w]}」` : '';
  }
  $('relAgree').innerHTML = meter('すれ違い ←→ 一致', r.agreement, past ? r.agreement - past.agreement : 0);
  const c = (r.A.closeness + r.B.closeness) / 2;
  const mood = c < 25 ? 'まだお互いに少し距離がある。' : c < 45 ? '少しずつ打ち解けてきている。' : c < 65 ? '気軽に話せる間柄になっている。' : c < 85 ? 'かなり親しい。' : '何でも話せる仲になっている。';
  const ag = r.agreement < 35 ? '意見はぶつかりがちだ。' : r.agreement > 65 ? '考え方がよく噛み合う。' : '';
  $('relSummary').textContent = `${nameOf('A')}と${nameOf('B')}は、${mood}${ag}`;
}

// ---- 記憶パネル ----
function renderMemory() {
  const filter = $('memFilter').value;
  const facts = state.memory.facts.filter((f) => filter === 'all' || f.category === filter);
  const groups = {};
  for (const f of facts) (groups[f.category] ||= []).push(f);
  const list = $('memList');
  list.innerHTML = '';
  if (!facts.length) {
    list.innerHTML = '<p class="note">まだ記憶はありません。会話が進むと、印象に残ったことが自動的に記憶されます。</p>';
  }
  for (const cat of Object.keys(CATEGORY_LABELS)) {
    if (!groups[cat]) continue;
    const g = document.createElement('div');
    g.className = 'mem-group';
    g.innerHTML = `<h4>${CATEGORY_LABELS[cat]}（${groups[cat].length}）</h4>`;
    for (const f of [...groups[cat]].reverse()) {
      const d = document.createElement('div');
      d.className = `mem${f.resolved ? ' resolved' : ''}`;
      const about = f.about === 'both' ? '二人' : nameOf(f.about);
      d.innerHTML = `<span class="about ${f.about}">${esc(about)}</span><span class="txt"></span><span class="imp" title="重要度">${'●'.repeat(f.importance)}</span><button class="del" aria-label="この記憶を消す" data-id="${esc(f.id)}">×</button>`;
      d.querySelector('.txt').textContent = f.text;
      g.appendChild(d);
    }
    list.appendChild(g);
  }
  const since = saysCount() - (state.memory.lastProcessedSays || 0);
  $('memStatus').textContent = memBusy
    ? '記憶を整理しています…'
    : `記憶 ${state.memory.facts.length}件・思い出 ${state.memory.episodes.length}件。前回の整理から ${Math.max(0, since)} 発言。`;
}

// ---- 過去パネル ----
function renderEpisodes() {
  const box = $('episodeList');
  box.innerHTML = '';
  if (!state.memory.episodes.length) {
    box.innerHTML = '<p class="note">会話がある程度進むと、ひとまとまりの思い出として要約されます。古い会話はここに残り、二人は後からでも思い出すことができます。</p>';
    return;
  }
  for (const ep of [...state.memory.episodes].reverse()) {
    const d = document.createElement('div');
    d.className = 'episode';
    d.innerHTML = `<div><span class="ep-title"></span><span class="ep-turn">${ep.turn}発言目まで</span></div><p></p><div class="chips">${ep.topics.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>`;
    d.querySelector('.ep-title').textContent = ep.title;
    d.querySelector('p').textContent = ep.summary;
    box.appendChild(d);
  }
}

function renderSearch() {
  const q = $('logSearch').value.trim();
  const box = $('searchResults');
  box.innerHTML = '';
  if (!q) return;
  const hits = [];
  for (let i = state.log.length - 1; i >= 0 && hits.length < 50; i--) {
    const e = state.log[i];
    if ((e.kind === 'say' || e.kind === 'player') && e.text.includes(q)) hits.push(e);
  }
  if (!hits.length) {
    box.innerHTML = '<p class="note">見つかりませんでした。</p>';
    return;
  }
  for (const e of hits) {
    const d = document.createElement('div');
    d.className = 'hit';
    const who = e.kind === 'say' ? `<b class="${e.speaker}">${esc(nameOf(e.speaker))}</b>` : '<b class="P">あなた</b>';
    const parts = e.text.split(q).map(esc);
    d.innerHTML = `${who}：${parts.join(`<mark>${esc(q)}</mark>`)}`;
    d.addEventListener('click', () => jumpTo(e.id));
    box.appendChild(d);
  }
}

function jumpTo(id) {
  const idx = state.log.findIndex((e) => e.id === id);
  if (idx < 0) return;
  while (renderFrom > idx) loadOlder();
  const node = el.items.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!node) return;
  closePanel();
  node.scrollIntoView({ block: 'center' });
  node.animate([{ background: 'rgba(229,192,123,0.25)' }, { background: 'transparent' }], { duration: 1600 });
}

// ---- 人格パネル ----
function renderPersona() {
  const c = state.characters[personaWho];
  const f = $('personaForm');
  for (const k of ['name', 'personality', 'speech', 'likes', 'dislikes', 'background']) f.elements[k].value = c[k] || '';
  document.querySelectorAll('[data-persona]').forEach((b) => b.classList.toggle('active', b.dataset.persona === personaWho));
}

function renderUsage() {
  const s = state.stats;
  $('usageInfo').textContent = `API 呼び出し ${s.calls}回・入力 ${s.inputTokens.toLocaleString()} / 出力 ${s.outputTokens.toLocaleString()} トークン`;
}

function renderAll() {
  renderNames();
  renderLog();
  renderHeader();
  renderTopic();
  renderRelationship();
  renderMemory();
  renderEpisodes();
  renderPersona();
  renderMode();
  renderUsage();
  $('speedSelect').value = state.settings.speed;
  $('optInner').checked = state.settings.showInner;
  $('optAutoPause').checked = state.settings.autoPause;
  $('optMemEvery').value = String(state.settings.memEvery);
  el.app.classList.toggle('show-inner', state.settings.showInner);
  setStatus(running ? 'running' : state.started ? 'paused' : 'idle');
  setCharState(null);
}

// ---------------- API ----------------

class ApiError extends Error {
  constructor(code, message, retryable) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

async function api(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('offline', 'サーバーに接続できません。サーバーが起動しているか確認してください。', true);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const e = data?.error || {};
    throw new ApiError(e.code || `http_${res.status}`, e.message || `エラーが発生しました（${res.status}）`, !!e.retryable);
  }
  return data;
}

function payloadBase() {
  const { facts, episodes, impressions } = state.memory;
  return {
    mode: state.settings.mode,
    characters: state.characters,
    memory: { facts, episodes, impressions },
    relationship: state.relationship,
  };
}

function trackUsage(u) {
  state.stats.calls++;
  if (u) {
    state.stats.inputTokens += u.input || 0;
    state.stats.outputTokens += u.output || 0;
  }
  renderUsage();
}

// ---------------- 会話の進行 ----------------

function chooseSpeaker() {
  // 内緒話を受け取った本人が、まだ応えていなければ優先して話す
  const recent = state.log.slice(-12);
  const lastSay = [...state.log].reverse().find((e) => e.kind === 'say');
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i];
    if (e.kind === 'player' && e.to !== 'both' && !e.answeredBy?.includes(e.to)) {
      if (!lastSay || lastSay.speaker !== e.to) return e.to;
    }
  }
  return state.nextSpeaker === 'B' ? 'B' : 'A';
}

function markAnswered(speaker) {
  for (const e of state.log.slice(-30)) {
    if (e.kind === 'player' && (e.to === 'both' || e.to === speaker)) {
      e.answeredBy ||= [];
      if (!e.answeredBy.includes(speaker)) e.answeredBy.push(speaker);
    }
    if (e.kind === 'topic') {
      e.answeredBy ||= [];
      if (!e.answeredBy.includes(speaker)) e.answeredBy.push(speaker);
    }
  }
}

function applyFeeling(speaker, f) {
  const r = state.relationship;
  const clamp = (v) => Math.max(0, Math.min(100, v));
  const s = r[speaker];
  s.trust = clamp(s.trust + f.trust * 0.9);
  s.closeness = clamp(s.closeness + f.closeness * 0.9 + 0.08); // 話すほどわずかに慣れていく
  s.understanding = clamp(s.understanding + f.understanding * 0.9 + 0.05);
  r.agreement = clamp(r.agreement + f.agreement * 0.8 + (50 - r.agreement) * 0.01);
  if (saysCount() % 10 === 0) {
    r.history.push({ n: saysCount(), A: { ...r.A }, B: { ...r.B }, agreement: r.agreement });
    if (r.history.length > 300) r.history.splice(0, r.history.length - 300);
  }
}

async function step({ once = false } = {}) {
  if (busy) return;
  busy = true;
  clearTimeout(timer);
  const myEpoch = epoch;
  const speaker = chooseSpeaker();
  setCharState(speaker, 'thinking');
  showTyping(speaker);
  let ok = false;
  try {
    const res = await api('/api/turn', { ...payloadBase(), speaker, log: state.log.slice(-SHORT_TERM) });
    if (myEpoch !== epoch) return; // リセットされた
    if (!res.demo) trackUsage(res.usage);
    showTyping(null);
    markAnswered(speaker);
    const entry = {
      id: uid(),
      kind: 'say',
      speaker,
      text: res.text,
      inner: res.inner,
      intent: res.intent,
      topic: res.topic,
      demo: !!res.demo,
      t: Date.now(),
    };
    applyFeeling(speaker, res.feeling);
    state.nextSpeaker = other(speaker);
    setCharState(speaker, 'speaking');
    const node = pushEntry(entry);
    renderHeader();
    renderTopic();
    renderRelationship();
    await typewrite(node, entry.text);
    consecutiveErrors = 0;
    ok = true;
    maybeExtractMemory();
    save();
  } catch (err) {
    if (myEpoch !== epoch) return;
    showTyping(null);
    consecutiveErrors++;
    handleTurnError(err);
  } finally {
    if (myEpoch === epoch) {
      busy = false;
      setCharState(null);
      if (running && !once) scheduleNext(ok ? null : backoff());
      else if (!running && state.started) setStatus('paused');
    }
  }
}

function backoff() {
  return [3000, 8000, 15000][Math.min(consecutiveErrors - 1, 2)];
}

function handleTurnError(err) {
  const msg = err?.message || '不明なエラー';
  if (err?.code === 'no_key') {
    pause();
    systemLine('API キーが設定されていないため停止しました。', 'error');
    openSetup();
    return;
  }
  if (err?.code === 'busy') return; // 並行リクエスト：静かにリトライ
  if (err?.code === 'refusal') {
    systemLine(`${msg}`, 'error');
    // 拒否された流れを避けるため、次は相手に話してもらう
    state.nextSpeaker = other(state.nextSpeaker);
    if (consecutiveErrors < 2) return;
  }
  if (!err?.retryable || consecutiveErrors >= 3) {
    pause();
    setStatus('error');
    systemLine(`${msg} — 会話を一時停止しました。「再開」で続けられます。`, 'error');
  } else {
    systemLine(`${msg}（少し待って再試行します）`, 'error');
  }
}

function scheduleNext(forcedDelay) {
  clearTimeout(timer);
  const sp = SPEEDS[state.settings.speed] || SPEEDS.normal;
  const last = state.log.at(-1);
  const readTime = last?.kind === 'say' ? Math.min(6000, Array.from(last.text).length * sp.read) : 0;
  const delay = forcedDelay ?? sp.delay + readTime;
  timer = setTimeout(() => {
    if (running) step();
  }, delay);
}

let clockTimer = null;
let lastTick = 0;
function startClock() {
  stopClock();
  lastTick = Date.now();
  clockTimer = setInterval(() => {
    const now = Date.now();
    state.stats.elapsedMs += now - lastTick;
    lastTick = now;
    renderHeader();
    if (Math.floor(state.stats.elapsedMs / 1000) % 10 === 0) save();
  }, 1000);
}
function stopClock() {
  if (clockTimer) {
    state.stats.elapsedMs += Date.now() - lastTick;
    clearInterval(clockTimer);
    clockTimer = null;
  }
}

function canRun() {
  if (state.settings.mode === 'ai' && !serverStatus.configured) {
    openSetup();
    return false;
  }
  return true;
}

function play() {
  if (running || !canRun()) return;
  running = true;
  consecutiveErrors = 0;
  if (!state.started) {
    state.started = true;
    if (state.settings.mode === 'demo') systemLine('デモモード — この会話は AI ではなく、テンプレートから作られています', 'demo');
  }
  setStatus('running');
  setCharState(null);
  startClock();
  save();
  if (!busy) step();
}

function pause() {
  if (!running) return;
  running = false;
  clearTimeout(timer);
  stopClock();
  setStatus('paused');
  if (!busy) setCharState(null);
  save(true);
}

function resetConversation(all) {
  epoch++;
  running = false;
  busy = false;
  clearTimeout(timer);
  stopClock();
  showTyping(null);
  const keepChars = state.characters;
  const keepSettings = state.settings;
  if (all) {
    state = freshState();
  } else {
    // 記憶・関係性は残す。直近の未整理分は失われるので、印象として残っている分だけ引き継がれる
    const s = freshState();
    s.memory = { ...state.memory, cursor: 0, lastProcessedSays: 0, lastAttemptSays: 0 };
    s.relationship = state.relationship;
    s.stats = { ...s.stats, calls: state.stats.calls, inputTokens: state.stats.inputTokens, outputTokens: state.stats.outputTokens };
    state = s;
  }
  state.characters = keepChars;
  state.settings = keepSettings;
  save(true);
  renderAll();
  toast(all ? 'すべてリセットしました。二人は初対面に戻りました。' : '会話ログをリセットしました。二人は以前のことを覚えています。');
}

// ---------------- 記憶 ----------------

function maybeExtractMemory(force = false) {
  if (memBusy) return;
  const n = saysCount();
  const lastProcessed = state.memory.lastProcessedSays || 0;
  const every = Number(state.settings.memEvery) || 12;
  if (!force) {
    if (n - lastProcessed < every) return;
    // 失敗した直後は少し間をあける（無限リトライ防止）
    if (state.memory.lastAttemptSays && n - state.memory.lastAttemptSays < Math.ceil(every / 2)) return;
  }
  const cursor = Math.min(state.memory.cursor || 0, state.log.length);
  const from = Math.max(0, cursor - 4); // 少しだけ前の文脈を含める
  const entries = state.log.slice(from).slice(-60);
  if (!entries.some((e) => e.kind === 'say')) {
    if (force) toast('整理する新しい会話がありません。');
    return;
  }
  runMemory(entries, state.log.at(-1)?.id, n);
}

async function runMemory(entries, lastId, saysAt) {
  memBusy = true;
  const myEpoch = epoch;
  state.memory.lastAttemptSays = saysAt;
  renderMemory();
  try {
    const res = await api('/api/memory', { ...payloadBase(), entries });
    if (myEpoch !== epoch) return;
    if (!res.demo) trackUsage(res.usage);
    const mem = state.memory;
    for (const f of res.newFacts) {
      // 既存とほぼ同じ内容は追加しない
      if (mem.facts.some((x) => x.text === f.text)) continue;
      mem.facts.push({ id: uid(), ...f, turn: saysAt, resolved: false });
    }
    for (const id of res.resolvedIds) {
      const f = mem.facts.find((x) => x.id === id);
      if (f) f.resolved = true;
    }
    if (res.episode?.summary) mem.episodes.push({ id: uid(), ...res.episode, turn: saysAt });
    if (mem.episodes.length > 200) mem.episodes.splice(0, mem.episodes.length - 200);
    if (res.impressions?.A) mem.impressions.A = res.impressions.A;
    if (res.impressions?.B) mem.impressions.B = res.impressions.B;
    pruneFacts();
    // ログが途中で削られていても位置がずれないよう、最後に処理した発言の id から位置を求める
    const idx = state.log.findIndex((e) => e.id === lastId);
    mem.cursor = idx >= 0 ? idx + 1 : state.log.length;
    mem.lastProcessedSays = saysAt;
    mem.lastAttemptSays = 0;
    save();
  } catch (err) {
    if (myEpoch !== epoch) return;
    console.warn('記憶の整理に失敗', err);
    if (err.code === 'auth' || err.code === 'no_key' || err.code === 'quota') toast(`記憶の整理に失敗しました: ${err.message}`);
  } finally {
    if (myEpoch === epoch) {
      memBusy = false;
      renderMemory();
      renderEpisodes();
      renderRelationship();
    }
  }
}

function pruneFacts() {
  const facts = state.memory.facts;
  if (facts.length <= MAX_FACTS) return;
  // 重要度が低く古いもの、解決済みのものから忘れていく
  const ranked = facts
    .map((f, i) => ({ f, i, score: f.importance * 10 + i / facts.length * 8 - (f.resolved ? 15 : 0) }))
    .sort((a, b) => a.score - b.score);
  const drop = new Set(ranked.slice(0, facts.length - MAX_FACTS).map((x) => x.f.id));
  state.memory.facts = facts.filter((f) => !drop.has(f.id));
}

// ---------------- プレイヤーの介入 ----------------

function sendPlayer(text) {
  text = text.trim();
  if (!text) return;
  if (state.settings.mode === 'ai' && !serverStatus.configured) {
    openSetup();
    return;
  }
  if (target === 'topic') {
    pushEntry({ id: uid(), kind: 'topic', text: text.slice(0, 80), answeredBy: [], t: Date.now() });
  } else {
    pushEntry({ id: uid(), kind: 'player', to: target, text, answeredBy: [], t: Date.now() });
  }
  if (!state.started) state.started = true;
  scrollToBottom();
  if (running) {
    // 待機中なら、すぐに反応させる
    if (!busy) {
      clearTimeout(timer);
      timer = setTimeout(() => running && step(), 600);
    }
  } else if (!busy) {
    // 停止中でも、話しかけられた一人だけは応える
    if (target === 'A' || target === 'B') state.nextSpeaker = target;
    setStatus('paused');
    step({ once: true });
  }
}

// ---------------- パネル・UI イベント ----------------

function openPanel() {
  el.app.classList.add('panel-open');
  $('scrim').hidden = false;
  $('panelToggle').setAttribute('aria-expanded', 'true');
}
function closePanel() {
  el.app.classList.remove('panel-open');
  $('scrim').hidden = true;
  $('panelToggle').setAttribute('aria-expanded', 'false');
}

function selectTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.tabpane').forEach((p) => {
    const on = p.dataset.pane === name;
    p.hidden = !on;
    p.classList.toggle('active', on);
  });
  if (name === 'memory') renderMemory();
  if (name === 'history') renderEpisodes();
  if (name === 'relation') renderRelationship();
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

function openSetup() {
  const d = $('setupDialog');
  if (!d.open) d.showModal();
}

function setMode(mode) {
  if (state.settings.mode === mode) return;
  if (mode === 'ai' && !serverStatus.configured) {
    openSetup();
    return;
  }
  state.settings.mode = mode;
  if (state.started) systemLine(mode === 'demo' ? 'ここからデモモード — AI ではなく、テンプレートの会話です' : 'ここから AI による会話に戻りました', mode === 'demo' ? 'demo' : '');
  renderMode();
  save();
}

function bind() {
  el.playBtn.addEventListener('click', () => (running ? pause() : play()));
  $('startBtnEmpty').addEventListener('click', play);
  $('resetBtn').addEventListener('click', () => $('resetDialog').showModal());
  $('resetLogOnly').addEventListener('click', () => {
    $('resetDialog').close();
    resetConversation(false);
  });
  $('resetAll').addEventListener('click', () => {
    $('resetDialog').close();
    resetConversation(true);
  });
  $('resetCancel').addEventListener('click', () => $('resetDialog').close());

  $('speedSelect').addEventListener('change', (e) => {
    state.settings.speed = e.target.value;
    save();
  });

  document.querySelectorAll('.target').forEach((b) =>
    b.addEventListener('click', () => {
      target = b.dataset.target;
      document.querySelectorAll('.target').forEach((x) => {
        x.classList.toggle('active', x === b);
        x.setAttribute('aria-checked', String(x === b));
      });
      el.input.placeholder = target === 'topic' ? '新しい話題を指定する…（例：宇宙の果て）' : target === 'both' ? '二人に話しかける…' : `${nameOf(target)}にだけ、こっそり話しかける…`;
      el.input.focus();
    }),
  );
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    sendPlayer(el.input.value);
    el.input.value = '';
  });

  el.log.addEventListener('scroll', () => {
    if (isNearBottom()) el.jump.hidden = true;
  });
  el.jump.addEventListener('click', scrollToBottom);
  el.loadOlder.addEventListener('click', loadOlder);

  $('panelToggle').addEventListener('click', openPanel);
  $('panelClose').addEventListener('click', closePanel);
  $('scrim').addEventListener('click', closePanel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
  });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  // 記憶
  const mf = $('memFilter');
  for (const [k, v] of Object.entries(CATEGORY_LABELS)) mf.insertAdjacentHTML('beforeend', `<option value="${k}">${v}</option>`);
  mf.addEventListener('change', renderMemory);
  $('memNow').addEventListener('click', () => {
    if (state.settings.mode === 'ai' && !serverStatus.configured) return openSetup();
    if (memBusy) return toast('整理中です');
    maybeExtractMemory(true);
  });
  $('memList').addEventListener('click', (e) => {
    const id = e.target.closest('.del')?.dataset.id;
    if (!id) return;
    state.memory.facts = state.memory.facts.filter((f) => f.id !== id);
    save();
    renderMemory();
  });

  // 過去
  let st = null;
  $('logSearch').addEventListener('input', () => {
    clearTimeout(st);
    st = setTimeout(renderSearch, 200);
  });

  // 人格
  document.querySelectorAll('[data-persona]').forEach((b) =>
    b.addEventListener('click', () => {
      personaWho = b.dataset.persona;
      renderPersona();
    }),
  );
  $('personaForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const prev = state.characters[personaWho].name;
    const next = {};
    for (const k of ['name', 'personality', 'speech', 'likes', 'dislikes', 'background']) next[k] = f[k].value.trim();
    if (!next.name) return toast('名前を入力してください');
    if (next.name === nameOf(other(personaWho))) return toast('二人に同じ名前は付けられません');
    state.characters[personaWho] = next;
    save();
    renderNames();
    renderMemory();
    renderRelationship();
    if (prev !== next.name && state.started) systemLine(`${prev} は「${next.name}」と名乗るようになった`);
    // ログの名前表示を更新
    renderLog();
    toast(`${next.name}の人格を保存しました。次の発言から反映されます。`);
  });
  $('personaDefault').addEventListener('click', () => {
    const d = DEFAULT_CHARACTERS[personaWho];
    const f = $('personaForm').elements;
    for (const k of Object.keys(d)) f[k].value = d[k];
    toast('初期設定を入力しました。「保存」で反映されます。');
  });

  // 設定
  $('modeAi').addEventListener('click', () => setMode('ai'));
  $('modeDemo').addEventListener('click', () => setMode('demo'));
  $('optInner').addEventListener('change', (e) => {
    state.settings.showInner = e.target.checked;
    el.app.classList.toggle('show-inner', e.target.checked);
    save();
  });
  $('optAutoPause').addEventListener('change', (e) => {
    state.settings.autoPause = e.target.checked;
    save();
  });
  $('optMemEvery').addEventListener('change', (e) => {
    state.settings.memEvery = Number(e.target.value);
    save();
  });
  $('exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `two-minds-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || data.version !== 1 || !Array.isArray(data.log)) throw new Error('形式が違います');
      pause();
      epoch++;
      busy = false;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      state = load();
      renderAll();
      toast('読み込みました');
    } catch (err) {
      toast(`読み込めませんでした: ${err.message}`);
    }
    e.target.value = '';
  });
  $('wipeBtn').addEventListener('click', () => {
    if (!confirm('会話・記憶・関係性・人格・設定をすべて初期化します。よろしいですか？')) return;
    epoch++;
    running = false;
    busy = false;
    clearTimeout(timer);
    stopClock();
    localStorage.removeItem(STORAGE_KEY);
    state = freshState();
    renderAll();
    toast('初期化しました');
  });

  // セットアップ
  $('setupDemo').addEventListener('click', () => {
    $('setupDialog').close();
    state.settings.mode = 'demo';
    renderMode();
    save();
    toast('デモモードに切り替えました（AI ではありません）');
  });
  $('setupRecheck').addEventListener('click', async () => {
    await checkStatus();
    if (serverStatus.configured) {
      $('setupDialog').close();
      state.settings.mode = 'ai';
      renderMode();
      save();
      toast('API キーを確認しました。AI モードで会話できます。');
    } else toast('まだ API キーが見つかりません。サーバーを再起動しましたか？');
  });

  // 画面を離れたら自動一時停止（API 使用量の節約）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenSince = Date.now();
    } else {
      hiddenSince = null;
    }
  });
  setInterval(() => {
    if (running && state.settings.autoPause && hiddenSince && Date.now() - hiddenSince > 5 * 60_000) {
      pause();
      systemLine('画面を離れていたので、会話を一時停止しました', '');
    }
  }, 15_000);

  window.addEventListener('beforeunload', () => {
    stopClock();
    save(true);
  });
}

async function checkStatus() {
  try {
    serverStatus = await api('/api/status');
  } catch (e) {
    serverStatus = { configured: false, model: '' };
    toast(e.message);
  }
  renderMode();
}

// ---------------- 起動 ----------------

bind();
renderAll();
await checkStatus();
if (!serverStatus.configured && state.settings.mode === 'ai') openSetup();
