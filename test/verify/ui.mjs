/**
 * ui.mjs — Browser verification for the redaction banner gate (AC5), the
 * per-exchange measurement readout (TS-UI), and the detail modal's layout and
 * beautified event-stream body.
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
 * Read the /tokens-sse row's TTFT, token-count and Tok/s cells, located by
 * header text so the test does not encode the column order. `rendered` is the
 * anchor: without it, "no row" and "no page" look the same.
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
      "return{rendered:true,heads:heads,ttft:c[heads.indexOf('TTFT')]," +
      "inTok:c[heads.indexOf('In')],outTok:c[heads.indexOf('Out')],tps:c[heads.indexOf('Tok/s')]}" +
      "})())",
  );
  return JSON.parse(JSON.parse(raw));
}

/**
 * Where the close button sits relative to the summary row: every child of the
 * row whose box intersects the button's. A screenshot is the only other way to
 * catch two absolutely-positioned things sharing a corner.
 */
function readCloseButtonOverlap() {
  const raw = pw(
    '--raw',
    'eval',
    "JSON.stringify((function(){" +
      "var btn=document.querySelector('.log-detail-close');" +
      "var row=document.querySelector('.detail-summary');" +
      "if(!btn||!row)return{found:false};" +
      "var b=btn.getBoundingClientRect();" +
      "var hits=Array.prototype.slice.call(row.children).filter(function(el){" +
      "var r=el.getBoundingClientRect();" +
      "return r.width>0&&r.height>0&&r.left<b.right&&r.right>b.left&&r.top<b.bottom&&r.bottom>b.top})" +
      ".map(function(el){return el.textContent.trim()});" +
      "return{found:true,hits:hits}" +
      "})())",
  );
  return JSON.parse(JSON.parse(raw));
}

/** The response pane's rendered body text and the labels of its buttons. */
function readResponseBody() {
  const raw = pw(
    '--raw',
    'eval',
    "JSON.stringify((function(){" +
      "var panes=document.querySelectorAll('.log-detail-modal .pane');" +
      "var p=panes[panes.length-1];" +
      "if(!p)return{found:false};" +
      "var pre=p.querySelector('.code-block pre');" +
      "var labels=Array.prototype.map.call(p.querySelectorAll('.body-section-label button')," +
      "function(b){return b.textContent.trim()});" +
      "return{found:true,text:pre?pre.textContent:null,labels:labels}" +
      "})())",
  );
  return JSON.parse(JSON.parse(raw));
}

/** Click the response pane's format toggle (Raw <-> Beautify). */
function toggleResponseFormat() {
  pw(
    'eval',
    "(function(){" +
      "var panes=document.querySelectorAll('.log-detail-modal .pane');" +
      "var p=panes[panes.length-1];" +
      "if(!p)return false;" +
      "var b=Array.prototype.slice.call(p.querySelectorAll('.body-section-label button'))" +
      ".filter(function(x){var t=x.textContent.trim();return t==='Raw'||t==='Beautify'})[0];" +
      "if(b)b.click();return!!b})()",
  );
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

    console.log('\n[UI] Measurement readout + detail modal');

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

    // UI4 — the log table shows that exchange's TTFT, token counts and rate.
    const row = readStatsRow();
    const cells = `TTFT=${JSON.stringify(row.ttft)} In=${JSON.stringify(row.inTok)} ` +
      `Out=${JSON.stringify(row.outTok)} Tok/s=${JSON.stringify(row.tps)}`;
    if (!row.rendered) {
      fail('UI4', 'Log table shows TTFT, token counts + Tok/s', 'log table did not render');
    } else if (row.row === null) {
      fail('UI4', 'Log table shows TTFT, token counts + Tok/s',
        `no /tokens-sse row; headers=${JSON.stringify(row.heads)}`);
    } else if (/^\d+ms$/.test(row.ttft) && row.inTok === '25' && row.outTok === '120' &&
        Number(row.tps) > 0) {
      pass('UI4', 'Log table shows TTFT, token counts + Tok/s', cells);
    } else {
      fail('UI4', 'Log table shows TTFT, token counts + Tok/s',
        `${cells} headers=${JSON.stringify(row.heads)}`);
    }

    // UI5 — the detail modal reads duration and TTFT off one line, with the
    // token counts behind the rate. Opens the modal for UI6 and UI7.
    const line = readDetailStatsLine();
    if (line !== null && /Duration: \d+ms/.test(line) && line.includes('TTFT:') &&
        line.includes('In: 25 tok') && line.includes('Out: 120 tok') && line.includes('tok/s')) {
      pass('UI5', 'Detail line carries duration, TTFT, token counts and rate', JSON.stringify(line));
    } else {
      fail('UI5', 'Detail line carries duration, TTFT, token counts and rate',
        `got ${JSON.stringify(line)}`);
    }

    // UI6 — nothing in the summary row sits under the close button.
    const overlap = readCloseButtonOverlap();
    if (!overlap.found) {
      fail('UI6', 'Close button overlaps nothing', 'close button or summary row not rendered');
    } else if (overlap.hits.length === 0) {
      pass('UI6', 'Close button overlaps nothing', 'no summary-row child intersects its box');
    } else {
      fail('UI6', 'Close button overlaps nothing', `overlapped by ${JSON.stringify(overlap.hits)}`);
    }

    // UI7 — the captured event stream reads as beautified frames by default,
    // and the toggle puts the recorded bytes back.
    const beautified = readResponseBody();
    if (!beautified.found || beautified.text === null) {
      fail('UI7', 'SSE body beautified, toggle restores raw',
        `response pane body not rendered: ${JSON.stringify(beautified)}`);
    } else if (!beautified.text.includes('"type": "message_start"') ||
        !beautified.text.includes('event: message_start')) {
      fail('UI7', 'SSE body beautified, toggle restores raw',
        `not beautified: ${JSON.stringify(beautified.text.slice(0, 160))} labels=${JSON.stringify(beautified.labels)}`);
    } else {
      toggleResponseFormat();
      await sleep(300);
      const rawBody = readResponseBody();
      if (rawBody.text !== null && rawBody.text.includes('data: {"type":"message_start"')) {
        pass('UI7', 'SSE body beautified, toggle restores raw',
          `beautified=${JSON.stringify(beautified.text.slice(0, 80))} raw=${JSON.stringify(rawBody.text.slice(0, 80))}`);
      } else {
        fail('UI7', 'SSE body beautified, toggle restores raw',
          `toggle did not restore raw: ${JSON.stringify(rawBody)}`);
      }
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
