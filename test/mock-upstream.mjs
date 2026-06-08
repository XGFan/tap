/**
 * mock-upstream.mjs — Fake upstream server for gateway verification tests.
 * Usage: node test/mock-upstream.mjs [port]
 * Default port: 9090 (override via PORT env or first CLI arg)
 *
 * Endpoints:
 *   GET/POST /json           — fixed Content-Length JSON response
 *   POST     /sse            — text/event-stream, 3 events 100ms apart + [DONE]
 *   POST     /gemini-stream  — incremental JSON array (no CL), 3 chunks
 *   POST     /slow           — 1 chunk immediately, then 5s pause, then end
 *   GET      /gzip           — gzip-compressed JSON body
 *   GET      /badgzip        — Content-Encoding: gzip but garbage bytes
 *   GET      /hang           — headers + 1 chunk, then silent forever
 *   POST     /reset          — destroys socket mid-body
 *   GET      /__seen         — returns last recorded request info as JSON
 */

import http from 'node:http';
import zlib from 'node:zlib';

const port = parseInt(process.argv[2] ?? process.env.PORT ?? '9090', 10);

// In-memory store of last seen request per path.
const seen = {};

function recordRequest(req) {
  seen[req.url] = {
    method: req.method,
    path: req.url,
    headers: { ...req.headers },
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const server = http.createServer(async (req, res) => {
  recordRequest(req);

  const url = req.url.split('?')[0];

  // ── /json ──────────────────────────────────────────────────────────────────
  if (url === '/json') {
    const raw = await readBody(req);
    let echo = null;
    try { echo = raw ? JSON.parse(raw) : null; } catch { echo = null; }
    const body = JSON.stringify({ ok: true, echo });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  // ── /sse ───────────────────────────────────────────────────────────────────
  if (url === '/sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Transfer-Encoding': 'chunked',
    });
    for (let i = 0; i < 3; i++) {
      await sleep(100);
      res.write(`data: {"i":${i}}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // ── /gemini-stream ─────────────────────────────────────────────────────────
  if (url === '/gemini-stream') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      // Intentionally NO Content-Length
      'Transfer-Encoding': 'chunked',
    });
    res.write('[{"a":1},');
    await sleep(50);
    res.write('{"b":2},');
    await sleep(50);
    res.write('{"c":3}]');
    res.end();
    return;
  }

  // ── /slow ──────────────────────────────────────────────────────────────────
  if (url === '/slow') {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Transfer-Encoding': 'chunked',
    });
    res.write('first-chunk\n');
    await sleep(5000);
    res.end('done\n');
    return;
  }

  // ── /gzip ──────────────────────────────────────────────────────────────────
  if (url === '/gzip') {
    const payload = JSON.stringify({ compressed: true, data: 'hello gzip' });
    const compressed = zlib.gzipSync(Buffer.from(payload, 'utf8'));
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      'Content-Length': compressed.length,
    });
    res.end(compressed);
    return;
  }

  // ── /badgzip ───────────────────────────────────────────────────────────────
  if (url === '/badgzip') {
    // Claims gzip but sends truncated garbage bytes.
    const garbage = Buffer.from([0x1f, 0x8b, 0xde, 0xad, 0xbe, 0xef, 0x00]);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      'Content-Length': garbage.length,
    });
    res.end(garbage);
    return;
  }

  // ── /hang ──────────────────────────────────────────────────────────────────
  if (url === '/hang') {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Transfer-Encoding': 'chunked',
    });
    res.write('hanging…\n');
    // Never end — hold the connection open forever.
    // The socket is kept alive until the client closes or times out.
    return;
  }

  // ── /reset ─────────────────────────────────────────────────────────────────
  if (url === '/reset') {
    await readBody(req);
    // Destroy socket immediately, simulating upstream abort.
    req.socket.destroy();
    return;
  }

  // ── /__seen ────────────────────────────────────────────────────────────────
  if (url === '/__seen') {
    // Return the most-recent recorded request (last path that was hit),
    // or the full seen map so callers can look up any path.
    const body = JSON.stringify(seen, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  // ── 404 ────────────────────────────────────────────────────────────────────
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end(`Not found: ${req.method} ${req.url}\n`);
});

server.listen(port, () => {
  process.stdout.write(`mock-upstream listening on :${port}\n`);
});

// Graceful shutdown on SIGTERM/SIGINT.
function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
