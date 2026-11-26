// TWO MINDS — クライアント（画面）
// 会話の進行（再生キュー・先読み・割り込み・通信エラー）は engine.js が担当し、ここは表示と操作だけを受け持つ。
// Gemini からは「続きの数発言（原則 3）」をまとめて受け取り、一発言ずつ再生しながら、次の数発言を 1 件だけ先読みする。
// 文脈（会話の状態・直近の発言・再生中の記録）は、このタブのセッション中だけ sessionStorage に置く。
import { ConversationEngine } from './engine.js';
import { InputPresence } from './input-state.js';

const SESSION_KEY = 'twominds:session:v4';
const PACE_KEY = 'twominds:pace';
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


let mode = 'ai'; // 'ai' | 'demo'
let lastPlayerAt = 0;
let lastRequestAt = 0;
let pausedByHidden = false;
let overlayAction = null;
let serverStatus = { ai: false, reason: 'unknown' };
let engine = null;

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
const sleep = (ms, g) => engine.sleep(ms, g);

// ---------------- 表示 ----------------

function setStatus(state) {
  const labels = { idle: '待機中', running: '会話中', thinking: '考え中', quiet: '静かな間', waiting: '応答待ち', holding: '入力中', paused: '一時停止中', error: '停止中' };
  const running = !!engine?.running;
  el.status.dataset.state = state;
  el.statusText.textContent = labels[state];
  el.playBtn.classList.toggle('paused', !running);
  el.playBtn.setAttribute('aria-label', running ? '一時停止' : '再開');
  // API の応答を待っている間は、どちらかが話し出しそうな「…」を出す（意図的な沈黙とは区別する）
  if (state === 'thinking' || state === 'waiting') {
    if (!thinkingNode) {
      for (const w of ['A', 'B']) setExpression(w, 'thinking');
      clearTimeout(dotsTimer);
      dotsTimer = setTimeout(() => ['thinking', 'waiting'].includes(el.status.dataset.state) && showThinking(Math.random() < 0.5 ? 'A' : 'B'), 1200);
    }
  } else {
    clearTimeout(dotsTimer);
    hideThinking();
  }
}
let dotsTimer = null;

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

// 口を動かしながら 1 文字ずつ表示する。割り込まれたら途中で止める（false を返す）
async function speak(who, text, expr, g, onProgress) {
  const c = el.chars[who];
  const bubble = speechBubble(who);
  addBubble(bubble);
  setExpression(who, expr);
  setRoles(who);
  const rest = restShape(expr);
  const fast = document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches;
  let i = 0;
  let shown = '';
  for (const ch of Array.from(text)) {
    if (g !== engine.gen) {
      bubble.textContent += '…';
      bubble.classList.add('cut');
      c.dataset.shape = rest;
      return false;
    }
    bubble.textContent += ch;
    shown += ch;
    onProgress?.(shown);
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
  return true;
}

/** 一発言を再生する（発言前の間・表情・動作・聞き手の反応・口の動き） */
async function playLine(line, g, onProgress) {
  const speaker = line.speaker;
  const listener = other(speaker);
  if (line.pause === 'long') {
    // 意図的な沈黙・考え込む時間（API の待ち時間とは別。吹き出しは出さない）
    setStatus('quiet');
    setRoles(null);
    for (const w of ['A', 'B']) {
      setExpression(w, w === speaker ? 'thinking' : 'neutral');
      el.chars[w].classList.add('away');
    }
    [...el.bubbles.children].forEach((n) => n.classList.add('older'));
    await sleep(rand(3500, 7000), g);
    for (const w of ['A', 'B']) el.chars[w].classList.remove('away');
    if (g !== engine.gen) return false;
    setStatus('running');
  } else if (line.pause === 'short' || ['hypothesis', 'insight', 'objection', 'reasoning', 'discovery'].includes(line.type)) {
    setExpression(speaker, 'thinking');
    if (line.pause === 'short') act(speaker, 'think');
    await sleep(line.pause === 'short' ? rand(900, 1600) : rand(300, 600), g);
    if (g !== engine.gen) return false;
  }
  listenerReaction(listener, line);
  act(speaker, line.action);
  const done = await speak(speaker, line.text, line.expression, g, onProgress);
  setRoles(null);
  return done;
}

/** 次の発言までの間（文字数・話者の交代・会話の区切りで変える） */
function gapAfter(line, next, { boundary } = {}) {
  const len = Array.from(line.text).length;
  let ms = 900 + Math.min(4200, len * 32);
  if (next && next.speaker === line.speaker) ms = 500 + Math.min(1500, len * 12);
  if (line.type === 'joke' || line.expression === 'laugh') ms += 400;
  if (!next && boundary) ms += rand(1200, 2600); // 話がひと区切りしたら、少し余韻をおく
  return ms;
}

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
  lastRequestAt = Date.now();
  requestTimes.push(lastRequestAt);
  try {
    sessionStorage.setItem(PACE_KEY, JSON.stringify(requestTimes.slice(-30)));
  } catch {}
}
function paceWait({ interrupt = false } = {}) {
  if (engine?.mode === 'demo') return 0;
  const now = Date.now();
  while (requestTimes.length && now - requestTimes[0] >= 60_000) requestTimes.shift();
  const perMinute = Math.max(1, (serverStatus.pace?.perMinute || 8) - 1);
  const budget = requestTimes.length >= perMinute ? requestTimes[0] + 60_000 - now + 200 : 0;
  if (interrupt) return Math.max(0, budget); // 観察者の発言は最優先（回数の上限だけ守る）
  const gap = Math.max(MIN_REQUEST_GAP, (serverStatus.pace?.minIntervalMs || 2500) + 200) - (now - lastRequestAt);
  return Math.max(0, gap, budget);
}


// ---------------- 会話エンジン ----------------

function createEngine() {
  return new ConversationEngine(
    {
      request: (body, signal) => api('/api/chunk', body, signal),
      play: playLine,
      setStatus,
      showWait: showWaitNotice,
      clearWait: clearWaitNotice,
      notice,
      switchToDemo: (text) => {
        setMode('demo');
        notice(text, 'demo');
      },
      onStop: (text, { resumable }) => notice(`${text}${resumable ? ' ▶ で再開できます。' : ''}`, 'error'),
      onIdle: () => showOverlay({ title: 'まだ見ていますか？', text: 'しばらく操作がなかったので、会話を一時停止しました。', button: '続きを見る', action: () => { engine.chunksSinceInput = 0; play(); } }),
      save: (snap) => {
        try {
          sessionStorage.setItem(SESSION_KEY, JSON.stringify(snap));
        } catch {
          /* プライベートブラウズなどで使えなくても、ゲームはそのまま動く */
        }
      },
      paceWait,
      notePace,
      // 観察者が入力を始めたら、話している途中でも口を閉じて止まる（続きは同じ位置から）
      onHold: () => {
        for (const w of ['A', 'B']) el.chars[w].dataset.shape = restShape(el.chars[w].dataset.expr);
      },
    },
    { gap: gapAfter },
  );
}

function play() {
  el.overlay.hidden = true;
  if (!engine.started && engine.mode === 'demo') notice('デモモード — この会話は AI ではなく、用意した台本です', 'demo');
  engine.start();
}

function pause() {
  engine.pause();
}

/** 観察者の発言：再生を止め、未再生の記録と生成中のリクエストを捨てて、発言を踏まえた続きを要求する */
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
  el.overlay.hidden = true;
  hideThinking();
  addBubble(playerBubble(text));
  setRoles(null);
  for (const w of ['A', 'B']) setExpression(w, 'surprised');
  // 送信中は、入力状態の判定で会話を止めたり再開したりしない（割り込みが入力待ちを終えて、観察者の発言を優先して再開する）
  presence.on('send-start');
  try {
    engine.interrupt(text);
  } finally {
    presence.on('send-end');
  }
}

function newConversation() {
  engine.reset();
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {}
  el.bubbles.innerHTML = '';
  for (const w of ['A', 'B']) setExpression(w, 'neutral');
  if (serverStatus.ai) setMode('ai');
  play();
}

// ---------------- 画面サイズ（仮想キーボード対応） ----------------

/**
 * 仮想キーボードへの対応。
 * 画面全体の大きさと位置は、ふだんは CSS（position: fixed + inset: 0）がブラウザの表示領域に合わせる。JS では決めない。
 * キーボードが表示されていて、入力欄にフォーカスがある間だけ、画面全体を見えている範囲（visualViewport）に合わせる。
 * そうしないと iOS は入力欄を見せるためにページごと上へずらし、ヘッダーとゲーム画面が画面外に出てしまう。
 * キーボードを閉じたら上書きを外し、iOS が残したスクロール位置を戻す。
 * 診断用に ?kb=off でこの調整を止められる。
 */
const KEYBOARD_ADJUST = new URLSearchParams(location.search).get('kb') !== 'off';
const KEYBOARD_MIN_PX = 120; // これ以上見えている範囲が狭くなったらキーボードとみなす（固定の補正値ではなく判定のしきい値）
let keyboardVisible = false;
let viewportFrame = 0;

function measureKeyboard() {
  const vv = window.visualViewport;
  const layoutH = window.innerHeight || document.documentElement.clientHeight;
  return !!vv && layoutH - vv.height > KEYBOARD_MIN_PX;
}

function syncViewport() {
  cancelAnimationFrame(viewportFrame);
  viewportFrame = requestAnimationFrame(applyViewport);
}

function applyViewport() {
  const vv = window.visualViewport;
  const kb = measureKeyboard();
  if (kb !== keyboardVisible) {
    keyboardVisible = kb;
    debugLog(kb ? 'keyboard shown' : 'keyboard hidden');
    presence.on(kb ? 'keyboard-show' : 'keyboard-hide');
  }
  if (KEYBOARD_ADJUST && kb && presence.s.focused) {
    el.app.classList.add('kbd');
    el.app.style.setProperty('--kb-h', `${Math.round(vv.height)}px`);
    el.app.style.setProperty('--kb-top', `${Math.round(vv.offsetTop)}px`);
  } else if (el.app.classList.contains('kbd')) {
    el.app.classList.remove('kbd');
    el.app.style.removeProperty('--kb-h');
    el.app.style.removeProperty('--kb-top');
    resetScroll();
  }
  const last = el.bubbles.lastElementChild;
  if (last) fitBubbles(last);
}

// キーボードを閉じたあと、iOS はページを少しスクロールしたまま残すことがある。閉じるアニメーションの間にも何度か戻す
function resetScroll() {
  for (const ms of [0, 120, 350]) {
    setTimeout(() => {
      if (window.scrollX || window.scrollY || document.scrollingElement?.scrollTop) window.scrollTo(0, 0);
    }, ms);
  }
}

// ---------------- 観察者の入力状態 ----------------

const presence = new InputPresence({
  isFocused: () => document.activeElement === el.input && !document.hidden,
  blurInput: () => el.input.blur(),
  hold: () => engine.hold(),
  release: () => engine.release(),
  log: (m) => debugLog(m),
});

// 診断表示（?debug=1 のときだけ読み込む）
const debugEvents = [];
function debugLog(m) {
  debugEvents.push({ t: performance.now(), m });
  if (debugEvents.length > 12) debugEvents.shift();
}


// ---------------- 起動 ----------------

function bind() {
  el.overlayBtn.addEventListener('click', () => (overlayAction || play)());
  el.overlayAlt.addEventListener('click', newConversation);
  el.playBtn.addEventListener('click', () => (engine.running ? pause() : play()));
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    sendPlayer();
  });

  // 画面を離れたら止める（再生も先読みも）。戻ったら続きから再開する
  document.addEventListener('visibilitychange', () => {
    debugLog(document.hidden ? 'hidden' : 'visible');
    if (document.hidden) {
      if (engine.running) {
        pause();
        pausedByHidden = true;
      }
    } else if (pausedByHidden) {
      pausedByHidden = false;
      play();
    }
  });
  window.addEventListener('pagehide', () => engine.save());

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewport);
    window.visualViewport.addEventListener('scroll', syncViewport);
  }
  window.addEventListener('resize', syncViewport);
  window.addEventListener('orientationchange', () => setTimeout(syncViewport, 300));

  // 観察者の入力状態：会話を止める・再開するのは InputPresence だけが決める（イベントの順番や抜けに左右されない）
  //  - 入力欄をタップした瞬間（focus）に止める。フォーカスが外れたら（blur・キーボードを閉じた・バックグラウンド）再開する
  //  - blur が来ないこともあるので、キーボードの非表示・バックグラウンド・1 秒ごとの確認でも判定し直す
  for (const ev of ['focus', 'blur', 'input', 'compositionstart', 'compositionend']) {
    el.input.addEventListener(ev, () => {
      debugLog(ev);
      presence.on(ev);
      if (ev === 'focus' || ev === 'blur') applyViewport(); // フォーカスの変化は、次の描画を待たずにすぐ反映する
    });
  }
  document.addEventListener('visibilitychange', () => presence.on(document.hidden ? 'hidden' : 'visible'));
  window.addEventListener('pagehide', () => presence.on('hidden'));
  window.addEventListener('pageshow', () => presence.on('visible'));
  document.addEventListener('focusout', () => setTimeout(() => presence.on('tick'), 0));
  setInterval(() => presence.on('tick'), 1000);
  for (const ev of ['pointerdown', 'mousedown']) $('sendBtn').addEventListener(ev, (e) => document.activeElement === el.input && e.preventDefault());
}

function restoreBubbles() {
  // 再開時は、直前の二つの発言だけを薄く出しておく
  for (const e of engine.ctx.recent.slice(-2)) addBubble(e.kind === 'player' ? playerBubble(e.text) : Object.assign(speechBubble(e.speaker), { textContent: e.text }));
}

async function init() {
  engine = createEngine();
  if (new URLSearchParams(location.search).has('debug')) {
    import('./debug.js').then((m) => m.startDebug({ el, engine, presence, events: debugEvents, measureKeyboard, keyboardAdjust: KEYBOARD_ADJUST })).catch((e) => console.warn('debug', e));
  }
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
  engine.mode = aiOk ? 'ai' : 'demo';

  const why = aiOk
    ? ''
    : ({
        no_key: 'サーバーに AI の API キーが設定されていません。',
        disabled: 'AI 会話は現在停止しています。',
        daily_limit: '今日の AI 会話の上限に達しました。',
        schema_rejected: 'AI（Gemini）が会話の出力形式を受け付けなかったため、AI 会話を止めています（サーバー側の設定の見直しが必要です）。',
        offline: 'サーバーに接続できませんでした。',
      }[serverStatus.reason] || 'いまは AI を利用できません。') + 'デモモード（AI ではない、用意した台本の会話）で動きます。';

  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
  } catch {}
  if (saved && engine.restore(saved)) {
    if (!aiOk) engine.mode = 'demo';
    setMode(engine.mode);
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
