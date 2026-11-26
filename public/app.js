// TWO MINDS — クライアント
// Gemini が生成した「会話記録（エピソード）」を受け取り、一発言ずつ再生する。
// 通信するのは、記録を再生し終えて次の記録が必要になったときと、観察者が話しかけたときだけ。
// 文脈（会話の概要・問題の状態・後回しの疑問・各自のメモ・直近の発言・再生中の記録）は、
// このタブのセッション中だけ sessionStorage に置く。長期記憶や会話履歴としては保存しない。

const SESSION_KEY = 'twominds:session:v3';
const PACE_KEY = 'twominds:pace';
const RECENT = 12; // 次の記録に引き継ぐ直近の発言数
const IDLE_EPISODES = 8; // 操作が無いままこの数の会話を再生したら一時停止（見ていない間の使いすぎ防止）
const MIN_REQUEST_GAP = 2700; // サーバーの最小間隔（2.5 秒）より少し長く
const PLAYER_COOLDOWN_MS = 3000;
const PER_CHAR_MS = 45;
const NAMES = { A: 'レオ', B: 'ミナ' };
const PHASE_ORDER = ['FREE', 'DISCOVERY', 'EXPLORATION', 'RESOLUTION', 'AFTERMATH'];

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'),
  bubbles: $('bubbles'),
  overlay: $('overlay'),
  overlayTitle: $('overlayTitle'),
  overlayText: $('overlayText'),
  overlayNote: $('overlayNote'),
  overlayBtn: $('overlayBtn'),
  overlayAlt: $('overlayAlt'),
  input: $('input'),
  playBtn: $('playBtn'),
  status: $('status'),
  statusText: $('statusText'),
  modeBadge: $('modeBadge'),
  chars: { A: $('charA'), B: $('charB') },
};

// ---------------- 状態 ----------------

function freshSession() {
  return {
    // 次の記録を作るための文脈
    history: [], // 直近の会話の概要（最大 3）
    problem: null, // 続いている問題
    backlog: [], // 後回しにした疑問
    topics: [],
    notes: { A: [], B: [] }, // 各自のメモ（本人の分だけが本人の考えになる）
    recent: [], // 直近に再生した発言
    // 再生中の記録
    episode: null, // 記録の情報（発言以外）
    queue: [], // まだ再生していない発言
    played: [], // この記録で再生済みの発言
    started: false,
    episodesSinceInput: 0,
    mode: null,
  };
}

let S = freshSession();
let mode = 'ai'; // 'ai' | 'demo'
let running = false;
let gen = 0; // 割り込み・新しい会話のたびに増やす。古い処理の結果は使わない
let loopGen = null; // 再生ループが動いている世代
let pendingInterrupt = null; // 観察者の発言（次の生成で最優先に送る）
let currentFetch = null; // { controller, gen }
let errors = 0;
let lastPlayerAt = 0;
let lastRequestAt = 0;
let pausedByHidden = false;
let overlayAction = null;
let serverStatus = { ai: false, reason: 'unknown' };

const other = (w) => (w === 'A' ? 'B' : 'A');
const rand = (a, b) => a + Math.random() * (b - a);
const sessionTag = (() => {
  try {
    let t = sessionStorage.getItem('twominds:tab');
    if (!t) {
      t = crypto.randomUUID();
      sessionStorage.setItem('twominds:tab', t);
    }
    return t;
  } catch {
    return Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
  }
})();

// 世代が変わったら途中で抜けられる待ち時間
const waiters = new Set();
function sleep(ms, g = gen) {
  return new Promise((resolve) => {
    if (g !== gen) return resolve(false);
    const w = { resolve, t: setTimeout(() => done(true), ms) };
    function done(v) {
      clearTimeout(w.t);
      waiters.delete(w);
      resolve(v);
    }
    w.cancel = () => done(false);
    waiters.add(w);
  });
}
function bumpGeneration() {
  gen++;
  for (const w of [...waiters]) w.cancel();
}

function saveSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...S, mode }));
  } catch {
    /* プライベートブラウズなどで使えなくても、ゲームはそのまま動く */
  }
}
function loadSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (!s || !s.started || !Array.isArray(s.queue)) return null;
    return { ...freshSession(), ...s, notes: { A: s.notes?.A || [], B: s.notes?.B || [] } };
  } catch {
    return null;
  }
}
function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {}
}

// ---------------- 表示 ----------------

function setStatus(state) {
  const labels = { idle: '待機中', running: '会話中', thinking: '考え中', quiet: '静かな間', waiting: '応答待ち', paused: '一時停止中', error: '停止中' };
  el.status.dataset.state = state;
  el.statusText.textContent = labels[state];
  el.playBtn.classList.toggle('paused', !running);
  el.playBtn.setAttribute('aria-label', running ? '一時停止' : '再開');
}

function setMode(m) {
  mode = m;
  el.modeBadge.hidden = m !== 'demo';
}

function markAges() {
  const items = [...el.bubbles.children];
  items.forEach((n, i) => {
    const age = items.length - 1 - i;
    n.classList.toggle('old', age === 1);
    n.classList.toggle('older', age >= 2);
  });
}

/** 吹き出しが表示領域からはみ出さないようにする（古いものから消し、それでも入らなければ文字を詰める） */
function fitBubbles(current) {
  const box = el.bubbles;
  // 下揃えなので、はみ出すと先頭の要素が上の余白より上にずれる（offsetTop は登場アニメの影響を受けない）
  const over = () => {
    const first = box.firstElementChild;
    return !!first && first.offsetTop < 4;
  };
  while (box.children.length > 3) box.firstElementChild.remove();
  while (over() && box.children.length > 1 && box.firstElementChild !== current) box.firstElementChild.remove();
  if (current && over() && !current.classList.contains('compact')) current.classList.add('compact');
  if (current && over() && !current.classList.contains('tiny')) current.classList.add('tiny');
  markAges();
}

function addBubble(node) {
  el.bubbles.appendChild(node);
  fitBubbles(node);
}

function speechBubble(who) {
  const b = document.createElement('div');
  b.className = `bubble ${who}`;
  b.setAttribute('aria-label', NAMES[who]);
  return b;
}

function playerBubble(text) {
  const b = document.createElement('div');
  b.className = 'bubble player';
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = 'あなた';
  b.append(who, document.createTextNode(text));
  return b;
}

function notice(text, kind = '') {
  const n = document.createElement('div');
  n.className = `notice ${kind}`;
  n.textContent = text;
  addBubble(n);
  return n;
}

let thinkingNode = null;
function showThinking(who) {
  hideThinking();
  thinkingNode = speechBubble(who);
  thinkingNode.classList.add('thinking');
  thinkingNode.innerHTML = '<span></span><span></span><span></span>';
  addBubble(thinkingNode);
}
function hideThinking() {
  if (thinkingNode) thinkingNode.remove();
  thinkingNode = null;
  markAges();
}

function setRoles(speaker) {
  for (const w of ['A', 'B']) {
    el.chars[w].classList.toggle('speaking', w === speaker);
    el.chars[w].classList.toggle('listening', !!speaker && w !== speaker);
  }
}

function restShape(expr) {
  if (expr === 'smile' || expr === 'laugh') return 'smile';
  if (expr === 'troubled' || expr === 'sad' || expr === 'annoyed') return 'frown';
  if (expr === 'surprised') return 'o';
  return 'neutral';
}

function setExpression(who, expr) {
  const c = el.chars[who];
  c.dataset.expr = expr;
  c.dataset.shape = restShape(expr);
}

const ACTION_MS = { nod: 800, tilt: 1600, lean: 1800, laugh: 1000, shrug: 900, look_away: 2200, sip: 1800, think: 2000 };
function act(who, action) {
  if (!action || action === 'none' || !ACTION_MS[action]) return;
  const c = el.chars[who];
  const cls = `act-${action}`;
  c.classList.remove(cls);
  void c.getBoundingClientRect();
  c.classList.add(cls);
  setTimeout(() => c.classList.remove(cls), ACTION_MS[action]);
}

/** 聞いている側の反応（相手の発言の種類に合わせて、控えめに） */
function listenerReaction(listener, line) {
  const r = Math.random();
  const map = {
    joke: r < 0.7 ? 'smile' : 'laugh',
    hypothesis: r < 0.6 ? 'thinking' : 'surprised',
    objection: r < 0.5 ? 'thinking' : r < 0.75 ? 'troubled' : 'annoyed',
    insight: r < 0.6 ? 'surprised' : 'thinking',
    question: 'thinking',
    concede: 'smile',
    conclusion: r < 0.6 ? 'smile' : 'neutral',
    agree: 'smile',
  };
  let expr = map[line.type] || null;
  if (!expr && (line.expression === 'laugh' || line.expression === 'smile')) expr = r < 0.5 ? 'smile' : null;
  if (!expr && line.expression === 'sad') expr = r < 0.5 ? 'troubled' : null;
  setExpression(listener, expr || 'neutral');
  if (['hypothesis', 'insight', 'conclusion', 'agree'].includes(line.type) && r < 0.5) setTimeout(() => act(listener, 'nod'), 700);
}

// いま話している発言と、そこまでに表示した文字（割り込まれたとき、途中までを文脈に残すため）
let speakingNow = null;

// 口を動かしながら 1 文字ずつ表示する。割り込まれたら途中で止める（false を返す）
async function speak(who, text, expr, g, line = null) {
  speakingNow = line ? { line, shown: '' } : null;
  const c = el.chars[who];
  const bubble = speechBubble(who);
  addBubble(bubble);
  setExpression(who, expr);
  setRoles(who);
  const rest = restShape(expr);
  const fast = document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches;
  let i = 0;
  for (const ch of Array.from(text)) {
    if (g !== gen) {
      bubble.textContent += '…';
      bubble.classList.add('cut');
      c.dataset.shape = rest;
      return false;
    }
    bubble.textContent += ch;
    if (speakingNow) speakingNow.shown += ch;
    if (i % 4 === 0) fitBubbles(bubble);
    if (!fast) {
      const p = '、。！？!?…'.includes(ch);
      c.dataset.shape = p ? rest : i % 3 === 0 ? 'open' : i % 3 === 1 ? 'mid' : rest;
      await sleep(p ? PER_CHAR_MS * 5 : PER_CHAR_MS, g);
    }
    i++;
  }
  bubble.textContent = text;
  fitBubbles(bubble);
  c.dataset.shape = rest; // 言い終わったら口を閉じる
  speakingNow = null;
  return true;
}

function blinkLoop(who) {
  const c = el.chars[who];
  const next = () =>
    setTimeout(() => {
      c.classList.add('blink');
      setTimeout(() => c.classList.remove('blink'), 130);
      next();
    }, rand(2200, 6000));
  next();
}

function showOverlay({ title, text, note = '', button, alt = '', action }) {
  el.overlayTitle.textContent = title;
  el.overlayText.innerHTML = text;
  el.overlayNote.textContent = note;
  el.overlayNote.hidden = !note;
  el.overlayBtn.textContent = button;
  el.overlayAlt.textContent = alt;
  el.overlayAlt.hidden = !alt;
  overlayAction = action;
  el.overlay.hidden = false;
}

// ---------------- API ----------------

class ApiError extends Error {
  constructor(code, message, retryable, { source = 'server', retryAfterMs = 0, httpStatus = 0 } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.source = source; // 'gemini' | 'server' | 'host'（Render などの手前の層）| 'network'
    this.retryAfterMs = retryAfterMs;
    this.httpStatus = httpStatus;
  }
}

async function api(path, body, signal) {
  let res;
  try {
    res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'X-Two-Minds': '1', 'X-Two-Minds-Session': sessionTag } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw new ApiError('aborted', 'aborted', false, { source: 'client' });
    throw new ApiError('offline', 'サーバーに接続できません（ネットワークを確認してください）。', true, { source: 'network' });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const e = data?.error;
    if (e?.code) {
      throw new ApiError(e.code, e.message, !!e.retryable, { source: e.source || 'server', retryAfterMs: e.retryAfterMs || 0, httpStatus: res.status });
    }
    // JSON でない応答 = アプリより手前（Render のプロキシなど）が返したもの。起動中・再起動中に起きる
    const hostDown = [502, 503, 504].includes(res.status);
    throw new ApiError(hostDown ? 'host_unavailable' : `http_${res.status}`, hostDown ? `ゲームのサーバーが応答していません（HTTP ${res.status}）。起動中かもしれません。` : `エラーが発生しました（HTTP ${res.status}）`, hostDown, { source: 'host', httpStatus: res.status });
  }
  return data;
}

// ---------------- 通信の間隔（サーバーの上限にぶつからないよう、クライアント自身が間をあける） ----------------

let requestTimes = [];
try {
  requestTimes = (JSON.parse(sessionStorage.getItem(PACE_KEY) || '[]') || []).filter((t) => Date.now() - t < 60_000);
  lastRequestAt = requestTimes.at(-1) || 0;
} catch {}
function notePace() {
  requestTimes.push(Date.now());
  try {
    sessionStorage.setItem(PACE_KEY, JSON.stringify(requestTimes.slice(-30)));
  } catch {}
}
function paceWait({ interrupt = false } = {}) {
  if (mode === 'demo') return 0;
  const now = Date.now();
  while (requestTimes.length && now - requestTimes[0] >= 60_000) requestTimes.shift();
  const perMinute = Math.max(1, (serverStatus.pace?.perMinute || 8) - 1);
  const budget = requestTimes.length >= perMinute ? requestTimes[0] + 60_000 - now + 200 : 0;
  if (interrupt) return Math.max(0, budget); // 観察者の発言は最優先（回数の上限だけ守る）
  const gap = Math.max(MIN_REQUEST_GAP, (serverStatus.pace?.minIntervalMs || 2500) + 200) - (now - lastRequestAt);
  return Math.max(0, gap, budget);
}

// ---------------- 会話の文脈（セッション中のみ） ----------------

function remember(entry) {
  S.recent.push(entry);
  if (S.recent.length > RECENT) S.recent = S.recent.slice(-RECENT);
}

function contextPayload() {
  return { history: S.history, problem: S.problem, backlog: S.backlog, topics: S.topics, notes: S.notes, recent: S.recent };
}

/** 再生中の記録のうち、ここまでに話された範囲での問題の状態（まだ言っていない結論は含めない） */
function problemSnapshot() {
  const ep = S.episode;
  if (!ep?.problem?.exists) return S.problem;
  const reached = S.played.reduce((m, l) => Math.max(m, PHASE_ORDER.indexOf(l.phase)), 0);
  if (reached < PHASE_ORDER.indexOf('DISCOVERY')) return S.problem; // まだ問題が出ていない
  const p = ep.problem;
  return {
    question: p.question,
    kind: p.kind,
    status: 'exploring',
    leo_view: reached >= 2 ? p.leo_view : '',
    mina_view: reached >= 2 ? p.mina_view : '',
    explored: reached >= 2 ? p.explored : [],
    conclusion: reached >= 3 ? p.conclusion : '',
    open_points: reached >= 3 ? p.open_points : [],
    phase: PHASE_ORDER[reached],
  };
}

/** 記録を最後まで再生したら、その内容を次の記録のための文脈にまとめる */
function finishEpisode() {
  const ep = S.episode;
  if (!ep) return;
  const p = ep.problem || {};
  S.history.push({ summary: ep.summary, question: p.exists ? p.question : '', status: p.status || 'none', conclusion: p.conclusion || '' });
  if (S.history.length > 3) S.history = S.history.slice(-3);
  if (ep.topic && S.topics.at(-1) !== ep.topic) S.topics.push(ep.topic);
  if (S.topics.length > 10) S.topics = S.topics.slice(-10);
  for (const w of ['A', 'B']) {
    const n = ep.notes?.[w];
    if (n && !S.notes[w].includes(n)) S.notes[w].push(n);
    if (S.notes[w].length > 6) S.notes[w] = S.notes[w].slice(-6);
  }
  // 扱った疑問は後回しリストから消し、新しく後回しにした疑問を足す
  if (p.exists) S.backlog = S.backlog.filter((q) => q !== p.question);
  for (const q of ep.next?.deferred_questions || []) if (!S.backlog.includes(q)) S.backlog.push(q);
  if (S.backlog.length > 5) S.backlog = S.backlog.slice(-5);
  S.problem = p.exists && (p.status === 'continuing' || p.status === 'exploring') ? { ...p, phase: 'EXPLORATION' } : null;
  S.episode = null;
  S.played = [];
  S.episodesSinceInput++;
}

// ---------------- 会話の再生 ----------------

async function playLine(line, g) {
  const speaker = line.speaker;
  const listener = other(speaker);
  // 発言の前の間
  if (line.pause === 'long') {
    // 意図的な沈黙・考え込む時間（API の待ち時間とは別。吹き出しは出さない）
    setStatus('quiet');
    setRoles(null);
    for (const w of ['A', 'B']) {
      setExpression(w, w === speaker ? 'thinking' : 'neutral');
      el.chars[w].classList.add('away');
    }
    markAges();
    [...el.bubbles.children].forEach((n) => n.classList.add('older'));
    await sleep(rand(3500, 7000), g);
    for (const w of ['A', 'B']) el.chars[w].classList.remove('away');
    if (g !== gen) return false;
    if (running) setStatus('running');
  } else if (line.pause === 'short' || ['hypothesis', 'insight', 'objection'].includes(line.type)) {
    setExpression(speaker, 'thinking');
    if (line.pause === 'short') act(speaker, 'think');
    await sleep(line.pause === 'short' ? rand(900, 1600) : rand(300, 600), g);
    if (g !== gen) return false;
  }
  listenerReaction(listener, line);
  act(speaker, line.action);
  const done = await speak(speaker, line.text, line.expression, g, line);
  setRoles(null);
  return done;
}

/** 次の発言までの間（文字数・話者の交代で変える） */
function gapAfter(line, next) {
  const len = Array.from(line.text).length;
  let ms = 900 + Math.min(4200, len * 32);
  if (next && next.speaker === line.speaker) ms = 500 + Math.min(1500, len * 12);
  if (line.type === 'joke' || line.expression === 'laugh') ms += 400;
  return ms;
}

/** 再生ループ。世代（gen）が変わったら、古いループは静かに抜ける */
async function loop() {
  if (loopGen === gen) return;
  const g = gen;
  loopGen = g;
  try {
    while (running && g === gen) {
      if (pendingInterrupt || !S.queue.length) {
        if (!S.queue.length && S.episode) finishEpisode();
        if (!pendingInterrupt && S.episodesSinceInput >= IDLE_EPISODES) {
          pause();
          showOverlay({ title: 'まだ見ていますか？', text: 'しばらく操作がなかったので、会話を一時停止しました。', button: '続きを見る', action: () => { S.episodesSinceInput = 0; play(); } });
          break;
        }
        const ok = await fetchEpisode(g);
        if (!ok) break;
        continue;
      }
      const line = S.queue[0];
      const done = await playLine(line, g);
      if (g !== gen) break; // 割り込まれた（その発言は途中まで）
      S.queue.shift();
      if (done) {
        S.played.push(line);
        remember({ kind: 'say', speaker: line.speaker, text: line.text });
      }
      saveSession();
      if (!S.queue.length) {
        // 一つの会話の終わり：少し余韻をおいてから次へ
        await sleep(gapAfter(line, null) + rand(1200, 2600), g);
        continue;
      }
      await sleep(gapAfter(line, S.queue[0]), g);
    }
  } finally {
    if (loopGen === g) loopGen = null;
  }
}

/** 次の会話記録を 1 回だけ生成する。成功したら true、止めるべきなら false */
async function fetchEpisode(g) {
  const interrupt = pendingInterrupt;
  setStatus('thinking');
  setRoles(null);
  for (const w of ['A', 'B']) setExpression(w, interrupt ? 'surprised' : 'thinking');
  if (interrupt) setTimeout(() => g === gen && ['A', 'B'].forEach((w) => setExpression(w, 'thinking')), 900);
  // 待ち時間が長くなったら、どちらかが話し出しそうな「…」を出す
  const dots = setTimeout(() => g === gen && showThinking(Math.random() < 0.5 ? 'A' : 'B'), interrupt ? 400 : 1500);

  const wait = paceWait({ interrupt: !!interrupt });
  if (wait > 0 && !(await sleep(wait, g))) {
    clearTimeout(dots);
    return false;
  }
  const controller = new AbortController();
  currentFetch = { controller, gen: g };
  lastRequestAt = Date.now();
  if (mode !== 'demo') notePace();
  try {
    const res = await api('/api/episode', { mode, gen: g, context: contextPayload(), interrupt }, controller.signal);
    clearTimeout(dots);
    if (g !== gen) return false; // 割り込みで古くなった結果は使わない
    hideThinking();
    if (interrupt && pendingInterrupt === interrupt) pendingInterrupt = null;
    if (res.episode?.lines?.length) {
      const { lines, ...meta } = res.episode;
      S.episode = meta;
      S.queue = lines;
      S.played = [];
    }
    errors = 0;
    transientErrors = 0;
    if (waitNotice) clearWaitNotice();
    setStatus('running');
    saveSession();
    return true;
  } catch (err) {
    clearTimeout(dots);
    if (g !== gen || err.code === 'aborted' || err.code === 'superseded') return false;
    hideThinking();
    for (const w of ['A', 'B']) setExpression(w, 'neutral');
    const delay = handleError(err);
    saveSession();
    if (delay === null) return false;
    return await sleep(delay, g);
  } finally {
    if (currentFetch?.controller === controller) currentFetch = null;
  }
}

// ---------------- エラー ----------------

// 一時的な障害（Gemini の過負荷・分間上限・タイムアウト、通信、サーバーの起動中）
const TRANSIENT = ['upstream_unavailable', 'upstream_cooldown', 'upstream_busy', 'timeout', 'network', 'host_unavailable', 'offline', 'in_progress'];
const TRANSIENT_MAX = 5; // 続けて失敗したら止める回数（無限にはやり直さない）
const TRANSIENT_BACKOFF = [6000, 15000, 30000, 45000];
let transientErrors = 0;
let waitNotice = null;

function showWaitNotice(text) {
  if (!waitNotice || !waitNotice.isConnected) {
    waitNotice = document.createElement('div');
    waitNotice.className = 'notice error';
    addBubble(waitNotice);
  }
  waitNotice.textContent = text;
  fitBubbles(waitNotice);
}
function clearWaitNotice() {
  if (waitNotice) waitNotice.remove();
  waitNotice = null;
  markAges();
}

/** エラーを処理し、もう一度生成するまでの待ち時間を返す（続けない場合は null） */
function handleError(err) {
  const code = err?.code;
  if (TRANSIENT.includes(code)) {
    transientErrors++;
    if (transientErrors >= TRANSIENT_MAX) {
      transientErrors = 0;
      clearWaitNotice();
      return stopWithError({ message: `${err.message} 何度か待ってみましたが回復しませんでした。時間をおいて` });
    }
    const base = TRANSIENT_BACKOFF[Math.min(transientErrors - 1, TRANSIENT_BACKOFF.length - 1)];
    const wait = Math.max(err.retryAfterMs || 0, base) + Math.round(Math.random() * 2000);
    showWaitNotice(`${err.message} ${Math.ceil(wait / 1000)} 秒ほど待ってから続けます…（${transientErrors}/${TRANSIENT_MAX - 1}）`);
    setStatus('waiting');
    return wait;
  }
  errors++;
  if (['daily_limit', 'upstream_quota', 'no_key', 'disabled', 'auth', 'model'].includes(code)) {
    // AI が使えないときは、はっきり区別したうえでデモモードに切り替えて続ける
    setMode('demo');
    notice(`${err.message} ここからはデモモード（AI ではありません）で続けます。`, 'demo');
    errors = 0;
    return 1500;
  }
  if (code === 'blocked' || code === 'bad_output' || code === 'max_tokens') {
    // 生成し直す（別の内容になる）。続くようなら止める
    if (errors >= 3) return stopWithError(err);
    notice(`${err.message}`, 'error');
    return 4000;
  }
  if (code === 'too_fast' || code === 'busy') {
    return errors >= 4 ? stopWithError(err) : Math.max(err.retryAfterMs || 0, [3000, 6000, 10000][errors - 1] || 10000);
  }
  if (code === 'schema_rejected') {
    // 一時的なエラーではないので、待ってもやり直さない（サーバー側の設定を直すまで再開できない）
    return stopWithError(err, { resumable: false });
  }
  return stopWithError(err);
}

function stopWithError(err, { resumable = true } = {}) {
  pause();
  setStatus('error');
  notice(`${err?.message || 'エラーが発生しました。'}${resumable ? ' ▶ で再開できます。' : ''}`, 'error');
  return null;
}

// ---------------- 操作 ----------------

function play() {
  if (running) return;
  el.overlay.hidden = true;
  running = true;
  errors = 0;
  transientErrors = 0;
  if (!S.started) {
    S.started = true;
    if (mode === 'demo') notice('デモモード — この会話は AI ではなく、用意した台本です', 'demo');
  }
  setStatus(S.queue.length ? 'running' : 'thinking');
  saveSession();
  loop();
}

function pause() {
  if (!running) return;
  running = false;
  setStatus('paused');
  saveSession();
}

/** 観察者の発言：再生中の会話を止め、残りの記録を捨てて、発言を踏まえた新しい記録を作る */
function sendPlayer() {
  const text = el.input.value.replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!text) return;
  const now = Date.now();
  if (now - lastPlayerAt < PLAYER_COOLDOWN_MS) {
    notice('少し間をあけてから話しかけてください');
    return;
  }
  lastPlayerAt = now;
  el.input.value = '';

  // その時点までの要点・問題・二人の考えを残す
  // 話している途中で割り込んだら、そこまで聞こえた分を「…」付きで残す
  if (speakingNow && speakingNow.shown.length >= 4) {
    const cut = { ...speakingNow.line, text: `${speakingNow.shown}…` };
    S.played.push(cut);
    remember({ kind: 'say', speaker: cut.speaker, text: cut.text });
  }
  speakingNow = null;
  // 生成を待っている間に続けて話しかけられたら、二つの発言をまとめて一度に送る（生成は 1 件だけ）
  pendingInterrupt = pendingInterrupt
    ? { ...pendingInterrupt, text: `${pendingInterrupt.text} / ${text}`.slice(-100) }
    : { text, played: S.played.slice(-40), problem: problemSnapshot() };
  const snapshot = pendingInterrupt.problem;
  // 再生中の会話を止めて、まだ再生していない記録は捨てる
  bumpGeneration();
  if (currentFetch) currentFetch.controller.abort();
  S.queue = [];
  S.problem = snapshot;
  S.episode = null;
  S.played = [];
  S.episodesSinceInput = 0;
  remember({ kind: 'player', speaker: null, text });
  hideThinking();
  addBubble(playerBubble(text));
  setRoles(null);
  for (const w of ['A', 'B']) setExpression(w, 'surprised');
  saveSession();

  el.overlay.hidden = true;
  if (!running) {
    play(); // 話しかけたら会話が動き出す
  } else {
    loopGen = null;
    loop();
  }
}

function newConversation() {
  bumpGeneration();
  if (currentFetch) currentFetch.controller.abort();
  clearSession();
  S = freshSession();
  pendingInterrupt = null;
  el.bubbles.innerHTML = '';
  for (const w of ['A', 'B']) setExpression(w, 'neutral');
  if (serverStatus.ai) setMode('ai');
  running = false;
  loopGen = null;
  play();
}

// ---------------- 画面サイズ（仮想キーボード対応） ----------------

function syncViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  el.app.classList.add('vv');
  el.app.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
  el.app.style.setProperty('--app-top', `${Math.round(vv.offsetTop)}px`);
  el.app.classList.toggle('kbd', window.innerHeight - vv.height > 120);
  if (document.scrollingElement && document.scrollingElement.scrollTop && !el.app.classList.contains('kbd')) {
    document.scrollingElement.scrollTop = 0;
  }
  const last = el.bubbles.lastElementChild;
  if (last) fitBubbles(last);
}

// ---------------- 起動 ----------------

function bind() {
  el.overlayBtn.addEventListener('click', () => (overlayAction || play)());
  el.overlayAlt.addEventListener('click', newConversation);
  el.playBtn.addEventListener('click', () => (running ? pause() : play()));
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    sendPlayer();
  });

  // 画面を離れたら止める（再生も次の生成も）。戻ったら続きから再開する
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (running) {
        pause();
        pausedByHidden = true;
      }
    } else if (pausedByHidden) {
      pausedByHidden = false;
      play();
    }
  });
  window.addEventListener('pagehide', saveSession);

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewport);
    window.visualViewport.addEventListener('scroll', syncViewport);
  }
  window.addEventListener('resize', syncViewport);
  el.input.addEventListener('focus', () => setTimeout(syncViewport, 300));
  el.input.addEventListener('blur', () => setTimeout(syncViewport, 300));
}

function restoreBubbles() {
  // 再開時は、直前の二つの発言だけを薄く出しておく
  for (const e of S.recent.slice(-2)) addBubble(e.kind === 'player' ? playerBubble(e.text) : Object.assign(speechBubble(e.speaker), { textContent: e.text }));
}

async function init() {
  bind();
  syncViewport();
  blinkLoop('A');
  blinkLoop('B');
  setStatus('idle');
  try {
    serverStatus = await api('/api/status');
  } catch {
    serverStatus = { ai: false, reason: 'offline' };
  }
  const aiOk = serverStatus.ai && !['daily_limit', 'schema_rejected'].includes(serverStatus.reason);
  setMode(aiOk ? 'ai' : 'demo');

  const why = aiOk
    ? ''
    : ({
        no_key: 'サーバーに AI の API キーが設定されていません。',
        disabled: 'AI 会話は現在停止しています。',
        daily_limit: '今日の AI 会話の上限に達しました。',
        schema_rejected: 'AI（Gemini）が会話の出力形式を受け付けなかったため、AI 会話を止めています（サーバー側の設定の見直しが必要です）。',
        offline: 'サーバーに接続できませんでした。',
      }[serverStatus.reason] || 'いまは AI を利用できません。') + 'デモモード（AI ではない、用意した台本の会話）で動きます。';

  const saved = loadSession();
  if (saved) {
    S = saved;
    if (saved.mode === 'demo') setMode('demo');
    restoreBubbles();
    showOverlay({ title: '続きから見ますか？', text: '二人は、さっきの話の途中です。', note: why, button: '続きを見る', alt: '新しい会話をはじめる', action: play });
    return;
  }
  showOverlay({
    title: '二人は、まだ黙っている。',
    text: 'ひらめきのレオと、分析のミナ。<br>二人の会話を眺めていてください。<br>好きなときに、話しかけてもかまいません。',
    note: why,
    button: aiOk ? '会話をはじめる' : 'デモで見る',
    action: play,
  });
}

init();
