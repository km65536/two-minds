// TWO MINDS サーバー：静的ファイル配信 + AI 呼び出しの中継。
// API キーはこのプロセスの環境変数にだけ存在し、ブラウザには一切送らない。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// .env があれば読み込む（Node 20.12+ の組み込み機能）。Render などでは環境変数を直接設定する。
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  /* .env が無い場合は環境変数のみを使う */
}

const { generateTurn, hasCredentials, getConfig, AIError } = await import('./ai.mjs');
const { demoTurn } = await import('./demo.mjs');
const { sanitizeLog, sanitizeContext, PLAYER_MAX } = await import('./conversation.mjs');
const { Limiter, limitsFromEnv, UpstreamGate, isUpstreamTransient } = await import('./limits.mjs');

const PUBLIC_DIR = path.join(root, 'public');
const PORT = Number(process.env.PORT) || 3000;
// Render では外部から届くよう 0.0.0.0 で待ち受ける。ローカルでは自分の PC からのみ。
const HOST = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
const MAX_BODY = 24 * 1024;
const AI_ENABLED = (process.env.AI_ENABLED ?? 'true').toLowerCase() !== 'false';
const limiter = new Limiter(limitsFromEnv());
const gate = new UpstreamGate({
  baseMs: Number(process.env.UPSTREAM_COOLDOWN_BASE_MS) || 4000,
  maxMs: Number(process.env.UPSTREAM_COOLDOWN_MAX_MS) || 60_000,
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function aiAvailable() {
  return AI_ENABLED && hasCredentials();
}

// ---------- HTTP ヘルパー ----------
function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object';
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
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

/** 接続元 IP。Render は Cloudflare 経由なので、上書きされない CF のヘッダーを優先する。 */
function clientIp(req) {
  const h = req.headers;
  const cf = h['cf-connecting-ip'] || h['true-client-ip'];
  if (typeof cf === 'string' && cf) return cf.trim();
  const xff = h['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/** 他サイトのページから API を呼ばせないための確認 */
function checkCaller(req) {
  if (req.headers['x-two-minds'] !== '1') throw new AIError('forbidden', '許可されていない呼び出しです。', { status: 403 });
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      host = '';
    }
    if (host !== req.headers.host) throw new AIError('forbidden', '許可されていない呼び出し元です。', { status: 403 });
  }
}

// ---------- API ----------
async function handleApi(req, res, url) {
  if (url.pathname === '/api/status' && req.method === 'GET') {
    return send(res, 200, {
      ai: aiAvailable(),
      reason: !AI_ENABLED ? 'disabled' : !hasCredentials() ? 'no_key' : limiter.dailyExhausted() ? 'daily_limit' : null,
      model: aiAvailable() ? getConfig().model : null,
      playerMax: PLAYER_MAX,
      // クライアントが自分で間隔を調整し、上限にぶつからないようにするための目安
      pace: { perMinute: limiter.o.ipRpmLimit, minIntervalMs: limiter.o.ipMinIntervalMs },
    });
  }

  if (url.pathname === '/api/turn' && req.method === 'POST') {
    checkCaller(req);
    const body = await readJSON(req);
    const speaker = body.speaker === 'B' ? 'B' : 'A';
    const log = sanitizeLog(body.log);
    const ctx = sanitizeContext(body.context);
    if (body.mode === 'demo') return send(res, 200, { ...demoTurn({ speaker, log, ctx }), demo: true });

    if (!AI_ENABLED) throw new AIError('disabled', 'AI 会話は現在停止しています。', { status: 503 });
    if (!hasCredentials()) throw new AIError('no_key', 'サーバーに API キーが設定されていません。', { status: 503 });
    // Gemini が混雑中なら、呼ばずに待ち時間を返す（上限の回数も消費しない）
    gate.check();
    const ip = clientIp(req);
    const end = limiter.begin(ip);
    try {
      const turn = await generateTurn({ speaker, log, ctx, reserve: () => limiter.take(ip), allowRegenerate: gate.failures === 0 });
      gate.onSuccess();
      return send(res, 200, { ...turn, demo: false });
    } catch (err) {
      if (isUpstreamTransient(err)) {
        const wait = gate.onFailure(err.upstream?.httpStatus ? `HTTP ${err.upstream.httpStatus}${err.upstream.status ? ` ${err.upstream.status}` : ''}` : err.upstream?.status || err.code, err.retryAfterMs);
        err.retryAfterMs = Math.max(err.retryAfterMs || 0, wait);
        console.warn(`[gemini] cooldown ${wait}ms after ${err.code} (consecutive failures: ${gate.failures})`);
      }
      throw err;
    } finally {
      end();
    }
  }

  send(res, 404, { error: { code: 'not_found', message: 'Not found' } });
}

// ---------- 静的ファイル ----------
function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') return send(res, 200, 'ok');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url);
  } catch (err) {
    const e = err instanceof AIError ? err : new AIError('internal', 'サーバー内部でエラーが発生しました。', { status: 500 });
    if (!(err instanceof AIError)) console.error(err);
    else if (e.status >= 500 || e.code === 'upstream_quota') console.warn(`[${e.code}] (${e.source}) ${e.message}`);
    const headers = e.retryAfterMs ? { 'Retry-After': String(Math.ceil(e.retryAfterMs / 1000)) } : {};
    if (!res.headersSent) {
      send(res, e.status, { error: { code: e.code, message: e.message, retryable: e.retryable, source: e.source, retryAfterMs: e.retryAfterMs || undefined, upstreamStatus: e.upstream?.httpStatus ?? undefined } }, headers);
    }
  }
});
server.requestTimeout = 45_000;
server.headersTimeout = 15_000;

server.listen(PORT, HOST, () => {
  console.log(`TWO MINDS: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!AI_ENABLED) console.log('  AI 会話は無効です（AI_ENABLED=false）。デモモードのみ動作します。');
  else if (hasCredentials()) console.log(`  モデル: ${getConfig().model}`);
  else console.log('  ⚠ GEMINI_API_KEY が未設定です（デモモードのみ動作）。README を参照してください。');
});
