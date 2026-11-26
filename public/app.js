// TWO MINDS — クライアント
// 二人の会話を進め、吹き出しと表情を描く。
// 文脈（直近の発言・話題の流れ・各自のメモ）は、このタブのセッション中だけ sessionStorage に置く。
// 長期記憶や会話履歴としては保存しない。「新しい会話」を始めると消える。

const SESSION_KEY = 'twominds:session:v2';
const RECENT = 16; // サーバーに送る直近の発言数
const TOPICS = 10;
const NOTES = 6;
const IDLE_TURNS = 40; // 操作が無いままこの発言数に達したら一時停止（見ていない間の使いすぎ防止）
const MIN_REQUEST_GAP = 2700; // サーバーの最小間隔（2.5 秒）より少し長く
const PLAYER_COOLDOWN_MS = 3000;
const PER_CHAR_MS = 45;
const NAMES = { A: 'レオ', B: 'ミナ' };

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
  return { recent: [], topics: [], notes: { A: [], B: [] }, nextSpeaker: Math.random() < 0.5 ? 'A' : 'B', sinceSilence: 0, started: false, mode: null };
}
let S = freshSession();
let mode = 'ai'; // 'ai' | 'demo'
let running = false;
let busy = false;
let timer = null;
let quietTimer = null;
let quiet = false;
let errors = 0;
let idleTurns = 0;
let lastPlayerAt = 0;
let lastRequestAt = 0;
let pausedByHidden = false;
let forcedNext = null; // プレイヤーに話しかけられたときの、次の話し手
let overlayAction = null;
let serverStatus = { ai: false, reason: 'unknown' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const other = (w) => (w === 'A' ? 'B' : 'A');
const rand = (a, b) => a + Math.random() * (b - a);

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
    if (!s || !Array.isArray(s.recent) || !s.started) return null;
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
  const labels = { idle: '待機中', running: '会話中', quiet: '静かな間', waiting: '応答待ち', paused: '一時停止中', error: '停止中' };
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
  // 下揃えなので、はみ出すと先頭の要素が上の余白より上にずれる。
  // offsetTop はアニメーションの transform の影響を受けないので、登場アニメ中でも誤判定しない
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
}

let thinkingNode = null;
function showThinking(who) {
  hideThinking();
  thinkingNode = speechBubble(who);
  thinkingNode.classList.add('thinking');
  thinkingNode.innerHTML = '<span></span><span></span><span></span>';
  addBubble(thinkingNode);
  setExpression(who, 'thinking');
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

function nod(who) {
  const c = el.chars[who];
  c.classList.remove('nod');
  void c.getBoundingClientRect();
  c.classList.add('nod');
  setTimeout(() => c.classList.remove('nod'), 800);
}

/** 聞いている側の反応（相手のセリフの雰囲気に合わせて、控えめに） */
function listenerReaction(listener, res) {
  const r = Math.random();
  let expr = null;
  if (res.intent === 'joke' || res.intent === 'tease' || res.expression === 'laugh') expr = r < 0.65 ? 'smile' : null;
  else if (res.expression === 'smile') expr = r < 0.4 ? 'smile' : null;
  else if (res.intent === 'disagree') expr = r < 0.5 ? 'thinking' : r < 0.7 ? 'annoyed' : null;
  else if (res.intent === 'question') expr = r < 0.5 ? 'thinking' : null;
  else if (res.expression === 'surprised') expr = r < 0.5 ? 'surprised' : null;
  else if (res.expression === 'sad' || res.expression === 'troubled') expr = r < 0.4 ? 'troubled' : null;
  setExpression(listener, expr || 'neutral');
}

// 発言に合わせて口を動かしながら、1 文字ずつ表示する
async function speak(who, text, expr) {
  const c = el.chars[who];
  const bubble = speechBubble(who);
  addBubble(bubble);
  setExpression(who, expr);
  setRoles(who);
  const rest = restShape(expr);
  const fast = document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches;
  let i = 0;
  for (const ch of Array.from(text)) {
    bubble.textContent += ch;
    if (i % 4 === 0) fitBubbles(bubble);
    if (!fast) {
      const pause = '、。！？!?…'.includes(ch);
      c.dataset.shape = pause ? rest : i % 3 === 0 ? 'open' : i % 3 === 1 ? 'mid' : rest;
      await sleep(pause ? PER_CHAR_MS * 5 : PER_CHAR_MS);
    }
    i++;
  }
  bubble.textContent = text;
  fitBubbles(bubble);
  c.dataset.shape = rest; // 言い終わったら口を閉じる
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

async function api(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'X-Two-Minds': '1' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('offline', 'サーバーに接続できません（ネットワークを確認してください）。', true, { source: 'network' });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const e = data?.error;
    if (e?.code) {
      // このアプリのサーバーが返したエラー（Gemini 由来なら source が 'gemini'）
      throw new ApiError(e.code, e.message, !!e.retryable, { source: e.source || 'server', retryAfterMs: e.retryAfterMs || 0, httpStatus: res.status });
    }
    // JSON でない応答 = アプリより手前（Render のプロキシなど）が返したもの。起動中・再起動中に起きる
    const hostDown = [502, 503, 504].includes(res.status);
    throw new ApiError(hostDown ? 'host_unavailable' : `http_${res.status}`, hostDown ? `ゲームのサーバーが応答していません（HTTP ${res.status}）。起動中かもしれません。` : `エラーが発生しました（HTTP ${res.status}）`, hostDown, { source: 'host', httpStatus: res.status });
  }
  return data;
}

// ---------------- 会話の文脈（セッション中のみ） ----------------

function remember(entry) {
  S.recent.push(entry);
  if (S.recent.length > RECENT) S.recent = S.recent.slice(-RECENT);
}

function rememberTurn(speaker, res) {
  if (res.topic) {
    const last = S.topics.at(-1);
    if (!last || last.label !== res.topic) S.topics.push({ label: res.topic, genre: res.genre });
    if (S.topics.length > TOPICS) S.topics = S.topics.slice(-TOPICS);
  }
  if (res.note) {
    const list = S.notes[speaker];
    if (!list.includes(res.note)) list.push(res.note);
    if (list.length > NOTES) S.notes[speaker] = list.slice(-NOTES);
  }
}

// ---------------- 会話の進行 ----------------

function waitVisible() {
  if (!document.hidden) return Promise.resolve();
  return new Promise((r) => {
    const h = () => {
      if (!document.hidden) {
        document.removeEventListener('visibilitychange', h);
        r();
      }
    };
    document.addEventListener('visibilitychange', h);
  });
}

// 直近 1 分の AI リクエスト時刻。サーバーの上限にぶつからないよう、クライアント自身が間をあける。
// 再読み込みしても間隔が崩れないよう、時刻だけは sessionStorage に置く（会話内容ではない）。
const PACE_KEY = 'twominds:pace';
let requestTimes = [];
try {
  requestTimes = (JSON.parse(sessionStorage.getItem(PACE_KEY) || '[]') || []).filter((t) => Date.now() - t < 60_000);
  lastRequestAt = requestTimes.at(-1) || 0;
} catch {}
function notePace(n = 1) {
  for (let k = 0; k < n; k++) requestTimes.push(Date.now());
  try {
    sessionStorage.setItem(PACE_KEY, JSON.stringify(requestTimes.slice(-30)));
  } catch {}
}

function paceWait() {
  if (mode === 'demo') return 0;
  const now = Date.now();
  while (requestTimes.length && now - requestTimes[0] >= 60_000) requestTimes.shift();
  const perMinute = Math.max(1, (serverStatus.pace?.perMinute || 8) - 1);
  // 枠に余裕があるうちはテンポよく、使うほど一定の間隔に落ち着く（使い切って長く止まるのを避ける）
  const steady = requestTimes.length >= Math.ceil(perMinute / 2) ? 60_000 / perMinute : 0;
  const gap = Math.max(MIN_REQUEST_GAP, (serverStatus.pace?.minIntervalMs || 2500) + 200, steady) - (now - lastRequestAt);
  const budget = requestTimes.length >= perMinute ? requestTimes[0] + 60_000 - now + 200 : 0;
  return Math.max(0, gap, budget);
}

function schedule(delay) {
  clearTimeout(timer);
  timer = setTimeout(() => running && !quiet && step(), Math.max(delay, paceWait()));
}

function ownRun(speaker) {
  let n = 0;
  for (let i = S.recent.length - 1; i >= 0; i--) {
    if (S.recent[i].kind === 'say' && S.recent[i].speaker === speaker) n++;
    else break;
  }
  return n;
}

async function step({ once = false } = {}) {
  if (busy) return;
  busy = true;
  clearTimeout(timer);
  const speaker = S.nextSpeaker;
  showThinking(speaker);
  lastRequestAt = Date.now();
  if (mode !== 'demo') notePace();
  let res = null;
  try {
    res = await api('/api/turn', { mode, speaker, log: S.recent, context: { topics: S.topics, notes: S.notes } });
    if ((res.calls || 1) > 1) notePace(res.calls - 1); // 作り直しの分も数える
    await waitVisible(); // 画面を離れている間に届いた発言は、戻ってから話す
    hideThinking();
    if (waitNotice) {
      clearWaitNotice();
      if (running) setStatus('running');
    }
    for (const e of S.recent) if (e.kind === 'player' && !e.answeredBy.includes(speaker)) e.answeredBy.push(speaker);
    remember({ kind: 'say', speaker, text: res.text, intent: res.intent, topic: res.topic, answeredBy: [] });
    rememberTurn(speaker, res);
    S.sinceSilence++;
    listenerReaction(other(speaker), res);
    await speak(speaker, res.text, res.expression);
    if (Math.random() < 0.45) nod(other(speaker));
    errors = 0;
    transientErrors = 0;
    idleTurns++;
  } catch (err) {
    hideThinking();
    setExpression(speaker, 'neutral');
    res = null;
    const delay = handleError(err, speaker);
    busy = false;
    setRoles(null);
    saveSession();
    if (running && !once && delay !== null) schedule(delay);
    return;
  }
  busy = false;
  setRoles(null);
  decideNext(speaker, res, once);
  saveSession();
}

/** 次に誰が、どのくらいの間をおいて話すかを決める */
function decideNext(speaker, res, once) {
  const len = Array.from(res.text).length;
  const read = { lively: 22, normal: 38, slow: 52 }[res.tempo] ?? 38;
  const base = { lively: 700, normal: 1500, slow: 2600 }[res.tempo] ?? 1500;
  let delay = Math.min(7000, base + len * read);

  if (forcedNext) {
    S.nextSpeaker = forcedNext;
    forcedNext = null;
  } else if (res.after === 'continue' && ownRun(speaker) < 2) {
    S.nextSpeaker = speaker; // 言い足りないので自分が続ける
    delay = Math.min(delay, 900 + len * 15);
  } else if (res.after === 'silence' && S.sinceSilence >= 5) {
    S.nextSpeaker = other(speaker);
    if (running && !once) beginSilence(delay);
    return;
  } else {
    S.nextSpeaker = other(speaker);
  }

  if (!running || once) return;
  if (idleTurns >= IDLE_TURNS) {
    pause();
    showOverlay({ title: 'まだ見ていますか？', text: 'しばらく操作がなかったので、会話を一時停止しました。', button: '続きを見る', action: play });
    return;
  }
  schedule(delay);
}

/** 意図的な沈黙。API の待ち時間とは区別して、吹き出しを出さずに静かな間をとる */
function beginSilence(afterDelay) {
  quiet = true;
  setStatus('quiet');
  const length = afterDelay + rand(6000, 13000);
  setTimeout(() => {
    if (!quiet) return;
    for (const w of ['A', 'B']) {
      setExpression(w, 'neutral');
      el.chars[w].classList.add('away');
    }
    markAges();
    [...el.bubbles.children].forEach((n) => n.classList.add('older'));
  }, afterDelay);
  clearTimeout(quietTimer);
  quietTimer = setTimeout(() => endSilence(true), length);
}

function endSilence(natural) {
  if (!quiet) return;
  quiet = false;
  clearTimeout(quietTimer);
  for (const w of ['A', 'B']) el.chars[w].classList.remove('away');
  if (natural) {
    remember({ kind: 'pause', speaker: null, text: '', intent: '', topic: '', answeredBy: [] });
    S.sinceSilence = 0;
    // 沈黙を破るのはどちらでもいい
    S.nextSpeaker = Math.random() < 0.5 ? 'A' : 'B';
  }
  if (running) {
    setStatus('running');
    if (natural) schedule(0);
  }
}

/** エラーを処理し、次の発言までの待ち時間を返す（続けない場合は null） */
// 一時的な障害（Gemini の過負荷・分間上限・タイムアウト、通信、サーバーの起動中）
const TRANSIENT = ['upstream_unavailable', 'upstream_cooldown', 'upstream_busy', 'timeout', 'network', 'host_unavailable', 'offline'];
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

function handleError(err, speaker) {
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
  if (code === 'blocked') {
    notice(err.message);
    S.nextSpeaker = other(speaker);
    return errors >= 3 ? stopWithError(err) : 2500;
  }
  if (code === 'too_fast' || code === 'busy') {
    // このサーバーの上限による待ち（AI は呼んでいない）：少し待ってやり直す（上限 3 回）
    return errors >= 4 ? stopWithError(err) : Math.max(err.retryAfterMs || 0, [3000, 6000, 10000][errors - 1] || 10000);
  }
  if (err?.retryable && errors < 3) {
    notice('通信がうまくいかなかったので、少し待ってやり直します…', 'error');
    return [3000, 6000, 12000][errors - 1];
  }
  return stopWithError(err);
}

function stopWithError(err) {
  pause();
  setStatus('error');
  notice(`${err?.message || 'エラーが発生しました。'} ▶ で再開できます。`, 'error');
  return null;
}

function play() {
  if (running) return;
  el.overlay.hidden = true;
  running = true;
  errors = 0;
  transientErrors = 0;
  idleTurns = 0;
  if (!S.started) {
    S.started = true;
    if (mode === 'demo') notice('デモモード — この会話は AI ではなく、決まった文型で作られています', 'demo');
  }
  setStatus('running');
  saveSession();
  if (!busy) schedule(0);
}

function pause() {
  if (!running) return;
  running = false;
  clearTimeout(timer);
  endSilence(false);
  setStatus('paused');
  saveSession();
}

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
  idleTurns = 0;
  remember({ kind: 'player', speaker: null, text, intent: '', topic: '', answeredBy: [] });
  addBubble(playerBubble(text));

  // 名前を呼ばれた方が先に反応する。呼ばれていなければ、どちらでも
  const responder = /レオ/.test(text) && !/ミナ/.test(text) ? 'A' : /ミナ/.test(text) && !/レオ/.test(text) ? 'B' : Math.random() < 0.5 ? 'A' : 'B';
  saveSession();

  if (!S.started) {
    S.nextSpeaker = responder;
    play();
    return;
  }
  el.overlay.hidden = true;
  if (busy) {
    forcedNext = responder; // 今の発言が終わったら
    return;
  }
  S.nextSpeaker = responder;
  if (quiet) endSilence(false);
  if (running) schedule(700);
  else {
    // 一時停止中でも、話しかけたら一人が応える
    clearTimeout(timer);
    timer = setTimeout(() => !running && !busy && step({ once: true }), paceWait());
  }
}

function newConversation() {
  clearSession();
  S = freshSession();
  forcedNext = null;
  el.bubbles.innerHTML = '';
  for (const w of ['A', 'B']) setExpression(w, 'neutral');
  if (serverStatus.ai) setMode('ai');
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

  // 画面を離れたら、すぐに会話の生成を止める。戻ったら続きから再開する
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
  // 再開時は、直前の二つのセリフだけを薄く出しておく
  const lastLines = S.recent.filter((e) => e.kind === 'say' || e.kind === 'player').slice(-2);
  for (const e of lastLines) addBubble(e.kind === 'player' ? playerBubble(e.text) : Object.assign(speechBubble(e.speaker), { textContent: e.text }));
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
  const aiOk = serverStatus.ai && serverStatus.reason !== 'daily_limit';
  setMode(aiOk ? 'ai' : 'demo');

  const why = aiOk
    ? ''
    : ({
        no_key: 'サーバーに AI の API キーが設定されていません。',
        disabled: 'AI 会話は現在停止しています。',
        daily_limit: '今日の AI 会話の上限に達しました。',
        offline: 'サーバーに接続できませんでした。',
      }[serverStatus.reason] || 'いまは AI を利用できません。') + 'デモモード（AI ではない、決まった文型の会話）で動きます。';

  const saved = loadSession();
  if (saved) {
    S = saved;
    if (saved.mode === 'demo') setMode('demo');
    restoreBubbles();
    showOverlay({
      title: '続きから見ますか？',
      text: '二人は、さっきの話の途中です。',
      note: why,
      button: '続きを見る',
      alt: '新しい会話をはじめる',
      action: play,
    });
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
