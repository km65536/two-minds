// TWO MINDS — クライアント
// 二人の会話を進め、吹き出しと表情を描く。会話の文脈は直近の発言だけをメモリ上に持ち、保存はしない。

const RECENT = 14; // サーバーに送る直近の発言数
const IDLE_TURNS = 40; // プレイヤーの操作が無いまま、この発言数に達したら一時停止（使いすぎ防止）
const HIDDEN_PAUSE_MS = 20_000; // 画面を離れてこの時間がたったら一時停止
const PLAYER_COOLDOWN_MS = 3000;
const PER_CHAR_MS = 45;
const NAMES = { A: 'レオ', B: 'ミナ' };

const $ = (id) => document.getElementById(id);
const el = {
  bubbles: $('bubbles'),
  overlay: $('overlay'),
  overlayTitle: $('overlayTitle'),
  overlayText: $('overlayText'),
  overlayBtn: $('overlayBtn'),
  input: $('input'),
  playBtn: $('playBtn'),
  status: $('status'),
  statusText: $('statusText'),
  modeBadge: $('modeBadge'),
  chars: { A: $('charA'), B: $('charB') },
};

let recent = [];
let mode = 'ai'; // 'ai' | 'demo'
let running = false;
let started = false;
let busy = false;
let nextSpeaker = 'A';
let timer = null;
let errors = 0;
let idleTurns = 0;
let lastPlayerAt = 0;
let hiddenTimer = null;
let pausedByHidden = false;
let generation = 0; // 古い応答を捨てるための番号
let serverStatus = { ai: false, reason: 'unknown' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const other = (w) => (w === 'A' ? 'B' : 'A');

// ---------------- 表示 ----------------

function setStatus(state) {
  const labels = { idle: '待機中', running: '会話中', paused: '一時停止中', error: '停止中' };
  el.status.dataset.state = state;
  el.statusText.textContent = labels[state];
  el.playBtn.classList.toggle('paused', !running);
  el.playBtn.setAttribute('aria-label', running ? '一時停止' : '再開');
}

function setMode(m) {
  mode = m;
  el.modeBadge.hidden = m !== 'demo';
}

function trimBubbles() {
  const items = [...el.bubbles.children];
  // 最新 3 つだけ残し、古いものほど薄くする
  items.slice(0, -3).forEach((n) => n.remove());
  // 画面が低くて収まらないときは、さらに古いものから消す
  while (el.bubbles.children.length > 1 && el.bubbles.scrollHeight > el.bubbles.clientHeight + 2) {
    el.bubbles.firstElementChild.remove();
  }
  const left = [...el.bubbles.children];
  left.forEach((n, i) => {
    const age = left.length - 1 - i;
    n.classList.toggle('old', age === 1);
    n.classList.toggle('older', age >= 2);
  });
}

function addBubble(node) {
  el.bubbles.appendChild(node);
  trimBubbles();
}

function speechBubble(who) {
  const b = document.createElement('div');
  b.className = `bubble ${who}`;
  b.setAttribute('aria-label', NAMES[who]);
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
  setRoles(who, false);
  setExpression(who, 'thinking');
}
function hideThinking() {
  if (thinkingNode) thinkingNode.remove();
  thinkingNode = null;
  trimBubbles();
}

function setRoles(speaker, speaking) {
  for (const w of ['A', 'B']) {
    el.chars[w].classList.toggle('speaking', speaking && w === speaker);
    el.chars[w].classList.toggle('listening', speaking && w !== speaker);
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

// 発言に合わせて口を動かしながら、1 文字ずつ表示する
async function speak(who, text, expr, gen) {
  const c = el.chars[who];
  const bubble = speechBubble(who);
  addBubble(bubble);
  setExpression(who, expr);
  setRoles(who, true);
  const rest = restShape(expr);
  const chars = Array.from(text);
  const fast = document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches;
  let i = 0;
  for (const ch of chars) {
    if (gen !== generation) break;
    bubble.textContent += ch;
    if (fast) continue;
    const pause = '、。！？!?…'.includes(ch);
    c.dataset.shape = pause ? rest : i % 3 === 0 ? 'open' : i % 3 === 1 ? 'mid' : rest;
    i++;
    await sleep(pause ? PER_CHAR_MS * 5 : PER_CHAR_MS);
  }
  bubble.textContent = text;
  c.dataset.shape = rest;
}

// まばたき
function blinkLoop(who) {
  const c = el.chars[who];
  const next = () => {
    setTimeout(() => {
      c.classList.add('blink');
      setTimeout(() => c.classList.remove('blink'), 130);
      next();
    }, 2200 + Math.random() * 3800);
  };
  next();
}

function showOverlay(title, text, button) {
  el.overlayTitle.textContent = title;
  el.overlayText.innerHTML = text;
  el.overlayBtn.textContent = button;
  el.overlay.hidden = false;
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
      headers: body ? { 'Content-Type': 'application/json', 'X-Two-Minds': '1' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('offline', 'サーバーに接続できません。', true);
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

// ---------------- 会話の進行 ----------------

function remember(entry) {
  recent.push(entry);
  if (recent.length > RECENT) recent = recent.slice(-RECENT);
}

async function step({ once = false } = {}) {
  if (busy) return;
  busy = true;
  clearTimeout(timer);
  const gen = generation;
  const speaker = nextSpeaker;
  showThinking(speaker);
  let ok = false;
  let delay = null;
  try {
    const res = await api('/api/turn', { mode, speaker, log: recent });
    if (gen !== generation) return;
    hideThinking();
    for (const e of recent) if (e.kind === 'player' && !e.answeredBy.includes(speaker)) e.answeredBy.push(speaker);
    remember({ kind: 'say', speaker, text: res.text, intent: res.intent, topic: res.topic, answeredBy: [] });
    nextSpeaker = other(speaker);
    await speak(speaker, res.text, res.expression, gen);
    errors = 0;
    ok = true;
    idleTurns++;
    // 読み終わるまでの間（文字数に応じて）
    delay = 1600 + Math.min(4000, Array.from(res.text).length * 40);
  } catch (err) {
    if (gen !== generation) return;
    hideThinking();
    setExpression(speaker, 'neutral');
    delay = handleError(err, speaker);
  } finally {
    if (gen === generation) {
      busy = false;
      setRoles(null, false);
      if (running && !once && delay !== null) {
        if (ok && idleTurns >= IDLE_TURNS) {
          pause();
          showOverlay('まだ見ていますか？', 'しばらく操作がなかったので、会話を一時停止しました。', '続きを見る');
        } else {
          timer = setTimeout(() => running && step(), delay);
        }
      }
    }
  }
}

/** エラーを処理し、次の発言までの待ち時間を返す（続けない場合は null） */
function handleError(err, speaker) {
  errors++;
  const code = err?.code;
  if (code === 'daily_limit' || code === 'upstream_quota' || code === 'no_key' || code === 'disabled' || code === 'auth' || code === 'model') {
    // AI が使えないときは、はっきり区別したうえでデモモードに切り替えて続ける
    setMode('demo');
    notice(`${err.message} ここからはデモモード（AI ではありません）で続けます。`, 'demo');
    errors = 0;
    return 1500;
  }
  if (code === 'blocked') {
    notice(err.message);
    nextSpeaker = other(speaker);
    return errors >= 3 ? stopWithError(err) : 2000;
  }
  if (err?.retryable && errors < 3) return [3000, 6000, 12000][errors - 1];
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
  idleTurns = 0;
  if (!started) {
    started = true;
    if (mode === 'demo') notice('デモモード — この会話は AI ではなく、決まった文型で作られています', 'demo');
  }
  setStatus('running');
  if (!busy) step();
}

function pause() {
  if (!running) return;
  running = false;
  clearTimeout(timer);
  setStatus('paused');
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
  const b = document.createElement('div');
  b.className = 'bubble player';
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = 'あなた';
  b.append(who, document.createTextNode(text));
  addBubble(b);

  if (!started) {
    play();
    return;
  }
  el.overlay.hidden = true;
  if (running) {
    if (!busy) {
      clearTimeout(timer);
      timer = setTimeout(() => running && step(), 700);
    }
  } else if (!busy) {
    // 一時停止中でも、話しかけたら一人が応える
    step({ once: true });
  }
}

// ---------------- 起動 ----------------

function bind() {
  el.overlayBtn.addEventListener('click', play);
  el.playBtn.addEventListener('click', () => {
    if (running) pause();
    else play();
  });
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    sendPlayer();
  });

  // 画面を離れたら一時停止し、戻ったら再開する（見ていない間に API を使わない）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(hiddenTimer);
      hiddenTimer = setTimeout(() => {
        if (running) {
          pause();
          pausedByHidden = true;
        }
      }, HIDDEN_PAUSE_MS);
    } else {
      clearTimeout(hiddenTimer);
      if (pausedByHidden) {
        pausedByHidden = false;
        play();
      }
    }
  });
}

async function init() {
  bind();
  blinkLoop('A');
  blinkLoop('B');
  setStatus('idle');
  try {
    serverStatus = await api('/api/status');
  } catch (e) {
    serverStatus = { ai: false, reason: 'offline' };
  }
  if (serverStatus.ai && serverStatus.reason !== 'daily_limit') {
    setMode('ai');
    return;
  }
  setMode('demo');
  const why = {
    no_key: 'サーバーに AI の API キーが設定されていません。',
    disabled: 'AI 会話は現在停止しています。',
    daily_limit: '今日の AI 会話の上限に達しました。',
    offline: 'サーバーに接続できませんでした。',
  }[serverStatus.reason] || 'いまは AI を利用できません。';
  el.overlayText.insertAdjacentHTML('beforeend', `<span class="demo-note">${why}<br>デモモード（AI ではない、決まった文型の会話）で動きます。</span>`);
  el.overlayBtn.textContent = 'デモで見る';
}

init();
