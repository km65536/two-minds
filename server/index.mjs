// TWO MINDS サーバー：静的ファイル配信 + AI 呼び出しの中継。
// API キーはこのプロセスの環境変数にだけ存在し、ブラウザには一切送らない。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// .env があれば読み込む（Node 20.12+ の組み込み機能）
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  /* .env が無い場合は環境変数のみを使う */
}

const { generateTurn, extractMemory, hasCredentials, getConfig, AIError } = await import('./ai.mjs');
const { demoTurn, demoMemory } = await import('./demo.mjs');
const { sanitizeCharacter, sanitizeLog, sanitizeMemory, sanitizeRelationship } = await import('./conversation.mjs');

const PUBLIC_DIR = path.join(root, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 1024 * 1024;
const MAX_CALLS_PER_HOUR = Number(process.env.MAX_CALLS_PER_HOUR) || 400;
const MAX_CONCURRENT = 2;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// ---------- 使用量の制限 ----------
const callTimes = [];
let inFlight = 0;
function reserveCall() {
  const now = Date.now();
  while (callTimes.length && now - callTimes[0] > 3600_000) callTimes.shift();
  if (callTimes.length >= MAX_CALLS_PER_HOUR) {
    throw new AIError('quota', `1時間あたりの呼び出し上限（${MAX_CALLS_PER_HOUR}回）に達しました。しばらくしてから再開してください。`, { status: 429 });
  }
  if (inFlight >= MAX_CONCURRENT) {
    throw new AIError('busy', '別のリクエストを処理中です。', { status: 429, retryable: true });
  }
  callTimes.push(now);
  inFlight++;
  return () => {
    inFlight--;
  };
}

// ---------- HTTP ヘルパー ----------
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(data);
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new AIError('too_large', 'リクエストが大きすぎます。', { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new AIError('bad_json', 'JSON の形式が正しくありません。', { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function parseCommon(body) {
  const chars = { A: sanitizeCharacter(body.characters?.A, 'レオ'), B: sanitizeCharacter(body.characters?.B, 'ミナ') };
  return {
    chars,
    memory: sanitizeMemory(body.memory),
    relationship: sanitizeRelationship(body.relationship),
    demo: body.mode === 'demo',
  };
}

// ---------- API ----------
async function handleApi(req, res, url) {
  if (url.pathname === '/api/status' && req.method === 'GET') {
    const cfg = getConfig();
    return send(res, 200, { configured: hasCredentials(), model: cfg.model, memoryModel: cfg.memoryModel });
  }

  if (url.pathname === '/api/turn' && req.method === 'POST') {
    const body = await readJSON(req);
    const { chars, memory, relationship, demo } = parseCommon(body);
    const speaker = body.speaker === 'B' ? 'B' : 'A';
    const log = sanitizeLog(body.log, 40);
    if (demo) {
      return send(res, 200, { ...demoTurn({ speaker, chars, log }), demo: true });
    }
    if (!hasCredentials()) throw new AIError('no_key', 'API キーが設定されていません。', { status: 503 });
    const release = reserveCall();
    try {
      const turn = await generateTurn({ speaker, chars, log, memory, relationship });
      return send(res, 200, { ...turn, demo: false });
    } finally {
      release();
    }
  }

  if (url.pathname === '/api/memory' && req.method === 'POST') {
    const body = await readJSON(req);
    const { chars, memory, demo } = parseCommon(body);
    const entries = sanitizeLog(body.entries, 60);
    if (!entries.some((e) => e.kind === 'say')) throw new AIError('empty', '整理する会話がありません。', { status: 400 });
    if (demo) return send(res, 200, { ...demoMemory({ entries }), demo: true });
    if (!hasCredentials()) throw new AIError('no_key', 'API キーが設定されていません。', { status: 503 });
    const release = reserveCall();
    try {
      return send(res, 200, { ...(await extractMemory({ chars, entries, memory })), demo: false });
    } finally {
      release();
    }
  }

  send(res, 404, { error: { code: 'not_found', message: 'Not found' } });
}

// ---------- 静的ファイル ----------
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url);
  } catch (err) {
    const e = err instanceof AIError ? err : new AIError('internal', 'サーバー内部でエラーが発生しました。', { status: 500 });
    if (!(err instanceof AIError)) console.error(err);
    else if (e.status >= 500) console.warn(`[${e.code}] ${e.message}`);
    if (!res.headersSent) send(res, e.status, { error: { code: e.code, message: e.message, retryable: e.retryable } });
  }
});

server.listen(PORT, HOST, () => {
  const cfg = getConfig();
  console.log(`TWO MINDS: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(hasCredentials() ? `  モデル: ${cfg.model}（記憶: ${cfg.memoryModel}）` : '  ⚠ ANTHROPIC_API_KEY が未設定です（デモモードのみ利用可能）。README を参照してください。');
});
