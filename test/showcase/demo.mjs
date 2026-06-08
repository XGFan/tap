/**
 * demo.mjs — live walkthrough of the two showcase Rewrite Rules.
 *
 * Usage:  pnpm build && node test/showcase/demo.mjs
 *
 * Starts the mock upstream + gateway, installs the showcase rules via the config
 * API, then fires requests and prints BEFORE (no match) vs AFTER (match) so you
 * can see each rule fire end-to-end. Tears everything down at the end.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { showcaseRules } from './rules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const MOCK = path.join(ROOT, 'test', 'mock-upstream.mjs');
const SERVER = path.join(ROOT, 'server', 'dist', 'index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const buf = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: buf ? { 'Content-Type': 'application/json', 'Content-Length': buf.length } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    r.on('error', reject);
    r.end(buf);
  });
}

async function waitPort(port, maxMs = 10000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { await req('GET', `http://localhost:${port}/`); return; } catch { await sleep(100); }
  }
  throw new Error(`port ${port} not ready`);
}

const procs = [];
function spawnProc(args, env = {}) {
  const p = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'] });
  procs.push(p);
  return p;
}
function teardown() { for (const p of procs) { try { p.kill('SIGTERM'); } catch {} } }

function hr(t) { console.log(`\n${'─'.repeat(70)}\n${t}\n${'─'.repeat(70)}`); }

async function main() {
  spawnProc([MOCK, '9090']);
  spawnProc([SERVER], { PORT: '8080' });
  await Promise.all([waitPort(9090), waitPort(8080)]);

  await req('PUT', 'http://localhost:8080/__gateway/api/config', {
    baseUrl: 'http://localhost:9090',
    rewriteRules: showcaseRules,
  });
  console.log(`Installed ${showcaseRules.length} showcase rules: ${showcaseRules.map((r) => r.name).join(', ')}`);

  // ── Rule 1: hello -> inject echo tool_use into the response ─────────────────
  hr('Rule 1 — request contains "hello" → inject echo tool_use into response');
  const noHello = await req('POST', 'http://localhost:8080/v1/chat/completions', { messages: [{ role: 'user', content: 'hi there' }] });
  console.log('BEFORE (request has no "hello") response tool_calls:');
  console.log('  ', JSON.stringify(JSON.parse(noHello.body).choices[0].message.tool_calls));
  const withHello = await req('POST', 'http://localhost:8080/v1/chat/completions', { messages: [{ role: 'user', content: 'hello, what can you do?' }] });
  console.log('AFTER  (request has "hello") response tool_calls:');
  console.log('  ', JSON.stringify(JSON.parse(withHello.body).choices[0].message.tool_calls, null, 0));

  // ── Rule 2: time -> current timestamp in the forwarded request ──────────────
  hr('Rule 2 — request contains "time" → replace with current yyyy-MM-dd HH:mm:ss');
  const noTime = await req('POST', 'http://localhost:8080/json', { q: 'hello world' });
  console.log('BEFORE (request has no "time") upstream echo:');
  console.log('  ', JSON.parse(noTime.body).echo);
  const withTime = await req('POST', 'http://localhost:8080/json', { q: 'what is the time now, any time?' });
  console.log('AFTER  (request has "time") upstream echo (time → live timestamp):');
  console.log('  ', JSON.parse(withTime.body).echo);

  hr('Done. Open the SPA at http://localhost:8080/__gateway/app/ to see the "rewritten" badge + original/rewritten compare in the log detail.');
}

main()
  .catch((e) => { console.error('demo failed:', e); process.exitCode = 1; })
  .finally(async () => { teardown(); await sleep(300); });
