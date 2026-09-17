/**
 * ui.mjs — Browser verification for the redaction banner gate (AC5) and the
 * TTFT / token-speed readout (TS-UI).
 *
 * Separate from run.mjs on purpose: run.mjs must stay dependency-free and
 * headless, while this drives a real browser. The banner gate is a DOM-level
 * conditional (web/src/App.tsx) — asserting on the built bundle's text cannot
 * tell a gated banner from an unconditional one, so the only honest check is
 * to render the page and look. The same holds for the stats columns: only a
 * rendered table shows that a measured number reached the cell.
 *
 * Usage:
 *   pnpm build && node test/verify/ui.mjs
 *
 * Requires the `playwright-cli` binary (npx playwright-cli). SKIPS with exit 0
 * when it is unavailable, so this never breaks a machine that has not installed
 * it; it does NOT silently pass.
 */

import { execFileSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SERVER_ENTRY = path.join(ROOT, 'server', 'dist', 'index.js');
const MOCK = path.join(ROOT, 'test', 'mock-upstream.mjs');
const PORT = 8098;
const MOCK_PORT = 9098;
const APP_URL = `http://localhost:${PORT}/__gateway/app/`;
const CFG_URL = `http://localhost:${PORT}/__gateway/api/config`;
const SESSION = 'tap-ui-verify';

let passed = 0;
let failed = 0;

function pass(id, label, evidence) {
  passed++;
  console.log(`  ✓ ${id} ${label}\n      ${evidence}`);
}

function fail(id, label, evidence) {
  failed++;
  console.log(`  ✗ ${id} ${label}\n      ${evidence}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run a playwright-cli subcommand. Returns stdout (trimmed). */
function pw(...args) {
  return execFileSync(
    'npx',
    ['--no-install', 'playwright-cli', `-s=${SESSION}`, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
}

/**
 * Read the banner's text (null when absent) together with a positive anchor
 * proving the app actually rendered. Without the anchor, "no banner" is also
 * what a 404, a thrown bundle or a slow fetch looks like — so the absence
 * assertion in UI1 would pass on a blank page and prove nothing.
 */
function readPage() {
  const raw = pw(
    '--raw',
    'eval',
    "JSON.stringify({rendered: !!document.querySelector('.tab-btn'), banner: document.querySelector('.warning-banner') ? document.querySelector('.warning-banner').textContent : null})",
  );
  // --raw still wraps the eval result in quotes; unwrap twice.
  return JSON.parse(JSON.parse(raw));
}

/**
 * Read the /tokens-sse row's TTFT and Tok/s cells, located by header text so
 * the test does not encode the column order. `rendered` is the anchor: without
 * it, "no row" and "no page" look the same.
 */
function readStatsRow() {
  const raw = pw(
    '--raw',
    'eval',
    "JSON.stringify((function(){" +
      "var t=document.querySelector('.log-table');" +
      "if(!t)return{rendered:false};" +
      "var heads=Array.prototype.map.call(t.querySelectorAll('thead th'),function(th){return th.textContent.trim()});" +
      "var rows=Array.prototype.slice.call(t.querySelectorAll('tbody tr'));" +
      "var r=rows.filter(function(tr){return tr.cells[2]&&tr.cells[2].textContent.trim()==='/tokens-sse'})[0];" +
      "if(!r)return{rendered:true,heads:heads,row:null};" +
      "var c=Array.prototype.map.call(r.cells,function(td){return td.textContent.trim()});" +
      "return{rendered:true,heads:heads,ttft:c[heads.indexOf('TTFT')],tps:c[heads.indexOf('Tok/s')]}" +
      "})())",
  );
  return JSON.parse(JSON.parse(raw));
}

/** Open the /tokens-sse row's detail modal and return its stats line text. */
function readDetailStatsLine() {
  pw(
    'eval',
    "(function(){" +
      "var rows=Array.prototype.slice.call(document.querySelectorAll('.log-table tbody tr'));" +
      "var r=rows.filter(function(tr){return tr.cells[2]&&tr.cells[2].textContent.trim()==='/tokens-sse'})[0];" +
      "if(r)r.click();return!!r})()",
  );
  const raw = pw(
    '--raw',
    'eval',
    "JSON.stringify(document.querySelector('.stats-line')?document.querySelector('.stats-line').textContent:null)",
  );
  return JSON.parse(JSON.parse(raw));
}

async function putConfig(body) {
  const res = await fetch(CFG_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT /config -> ${res.status}`);
}

/** Resolves once the gateway answers, or rejects after ~10s. */
function waitForGateway() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const tick = () => {
      http
        .get(`http://localhost:${PORT}/__gateway/api/config`, (res) => {
          res.resume();
          resolve();
        })
        .on('error', () => {
          if (Date.now() > deadline) reject(new Error('gateway did not start'));
          else setTimeout(tick, 200);
        });
    };
    tick();
  });
}

async function main() {
  try {
    execFileSync('npx', ['--no-install', 'playwright-cli', '--version'], {
      stdio: 'ignore',
    });
  } catch {
    console.log('\n[UI] SKIPPED — playwright-cli not available.');
    console.log('     Install with: npm install -g @playwright/cli@latest');
    process.exit(0);
  }

  await fs.access(SERVER_ENTRY).catch(() => {
    console.error('[UI] server/dist not built. Run `pnpm build` first.');
    process.exit(1);
  });

  // Isolated data dir so this never touches the developer's config.json or logs/.
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tap-ui-'));
  const server = spawn('node', [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(PORT), TAP_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  // An upstream that reports token usage, so the stats columns have something
  // real to show — the numbers must come from a genuine exchange, not a fixture.
  const mock = spawn('node', [MOCK, String(MOCK_PORT)], { stdio: 'ignore' });

  try {
    await waitForGateway();
    console.log('\n[UI] Redaction banner gate (AC5)');

    pw('open', APP_URL);
    await sleep(1500);

    // UI1 — a fresh install defaults to redaction on, so no banner. The
    // `rendered` anchor is what makes the absence meaningful.
    const on = readPage();
    if (on.rendered && on.banner === null) {
      pass('UI1', 'Redaction ON (schema default) -> banner absent', 'app rendered, no .warning-banner node');
    } else if (!on.rendered) {
      fail('UI1', 'Redaction ON (schema default) -> banner absent',
        'app did not render (no .tab-btn) — absence of banner proves nothing here');
    } else {
      fail('UI1', 'Redaction ON (schema default) -> banner absent', `banner rendered: ${JSON.stringify(on.banner)}`);
    }

    // UI2 — turning redaction off must bring the warning back.
    await putConfig({ redact: { enabled: false } });
    pw('reload');
    await sleep(1500);
    const offText = readPage().banner;
    if (offText !== null && offText.includes('Redaction is off')) {
      pass('UI2', 'Redaction OFF -> banner present', JSON.stringify(offText));
    } else {
      fail('UI2', 'Redaction OFF -> banner present', `got ${JSON.stringify(offText)}`);
    }

    // UI3 — a failed config fetch must FAIL CLOSED: unknown state still warns.
    pw('route', '**/__gateway/api/config', '--status=500');
    pw('reload');
    await sleep(1500);
    const errText = readPage().banner;
    if (errText !== null && errText.includes('redaction state unknown')) {
      pass('UI3', 'Config fetch fails -> banner present (fail closed)', JSON.stringify(errText));
    } else {
      fail('UI3', 'Config fetch fails -> banner present (fail closed)', `got ${JSON.stringify(errText)}`);
    }
    pw('unroute');

    console.log('\n[UI] TTFT + token speed readout');

    // One real exchange through the gateway to a usage-reporting upstream.
    await putConfig({ baseUrl: `http://localhost:${MOCK_PORT}` });
    const exchange = await fetch(`http://localhost:${PORT}/tokens-sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"stream":true}',
    });
    await exchange.text();
    await sleep(300);
    pw('reload');
    await sleep(1500);

    // UI4 — the log table shows the measured TTFT and rate for that exchange.
    const row = readStatsRow();
    if (!row.rendered) {
      fail('UI4', 'Log table shows TTFT + Tok/s', 'log table did not render');
    } else if (row.row === null) {
      fail('UI4', 'Log table shows TTFT + Tok/s',
        `no /tokens-sse row; headers=${JSON.stringify(row.heads)}`);
    } else if (/^\d+ms$/.test(row.ttft) && Number(row.tps) > 0) {
      pass('UI4', 'Log table shows TTFT + Tok/s', `TTFT=${row.ttft} Tok/s=${row.tps}`);
    } else {
      fail('UI4', 'Log table shows TTFT + Tok/s',
        `TTFT=${JSON.stringify(row.ttft)} Tok/s=${JSON.stringify(row.tps)} headers=${JSON.stringify(row.heads)}`);
    }

    // UI5 — the detail modal spells out the token counts behind that rate.
    const line = readDetailStatsLine();
    if (line !== null && line.includes('TTFT:') && line.includes('In: 25 tok') &&
        line.includes('Out: 120 tok') && line.includes('tok/s')) {
      pass('UI5', 'Detail shows TTFT, token counts and rate', JSON.stringify(line));
    } else {
      fail('UI5', 'Detail shows TTFT, token counts and rate', `got ${JSON.stringify(line)}`);
    }
  } catch (e) {
    fail('UI', 'browser verification', String(e));
  } finally {
    try {
      pw('close');
    } catch {
      /* browser may already be gone */
    }
    server.kill();
    mock.kill();
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  console.log(`\n=== UI RESULT: PASS ${passed} | FAIL ${failed} ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
