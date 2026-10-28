#!/usr/bin/env node
// browser-gate.mjs: runs the browser test pages (engine, then the UI walk) in headless Chrome,
// one tab each, and exits 0 when every page passes. GATE_PAGES=ui (or engine) runs one.
// No dependencies: a tiny static server on a free port (started and stopped here), Chrome
// over the DevTools protocol with Node's built-in WebSocket, a temp profile deleted after.
// Owner rule: fake media devices and no audio output on every Chrome we launch.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL_PAGES = { engine: '/test/browser/engine.html', ui: '/test/browser/ui.html', export: '/test/browser/export.html', scorecard: '/test/browser/scorecard.html', body: '/test/browser/body.html', fingerprint: '/test/browser/fingerprint.html', glassbox: '/test/browser/glassbox.html', hand3d: '/test/browser/hand3d.html' };
const PAGES = (process.env.GATE_PAGES || Object.keys(ALL_PAGES).join(',')).split(',').map((k) => ALL_PAGES[k.trim()] || (k.trim().startsWith('/') ? k.trim() : null)).filter(Boolean); // a /path runs an ad-hoc page
// Per page. The ui walk takes ~95 s on a laptop on battery; keep about 2x headroom.
const TIMEOUT_MS = Number(process.env.GATE_TIMEOUT_MS || 360000);
// One status poll (Runtime.evaluate) may wait this long; longer means the page's main thread is
// blocked, which is a FAIL with the blocking stack, not a hang.
const EVAL_TIMEOUT_MS = Number(process.env.GATE_EVAL_TIMEOUT_MS || 20000);
// GATE_CPU_THROTTLE=4 slows every page's CPU 4x (DevTools throttling), to rehearse a loaded laptop.
const CPU_THROTTLE = Number(process.env.GATE_CPU_THROTTLE || 1);
const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => fs.existsSync(p));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain' };

function serve() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.normalize(path.join(ROOT, url));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  // Port 0 = any free port; 127.0.0.1 counts as a secure context for Web Serial.
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

function launchChrome(profile) {
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio', '--disable-audio-output',
    'about:blank',
  ];
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const ws = new Promise((resolve, reject) => {
    let buf = '';
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    proc.on('exit', (c) => reject(new Error(`Chrome exited (${c}) before DevTools was ready`)));
  });
  return { proc, ws };
}

function cdp(wsUrl) {
  const sock = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  sock.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else listeners.forEach((fn) => fn(msg));
  };
  // timeoutMs: reject (and forget the reply) if Chrome has not answered in time, so a page whose
  // main thread is blocked (a dialog, a long loop) can never hang the gate.
  const send = (method, params = {}, sessionId, timeoutMs = 0) => new Promise((resolve, reject) => {
    const mid = ++id;
    let timer = null;
    const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
    pending.set(mid, { resolve: done(resolve), reject: done(reject) });
    if (timeoutMs > 0) timer = setTimeout(() => { pending.delete(mid); reject(Object.assign(new Error(`${method} timed out after ${timeoutMs / 1000} s`), { timedOut: true })); }, timeoutMs);
    sock.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const opened = new Promise((r, j) => { sock.onopen = r; sock.onerror = () => j(new Error('DevTools socket failed')); });
  return { opened, send, on: (fn) => listeners.push(fn), close: () => sock.close() };
}

// Where a blocked page is stuck: pause the debugger (it interrupts a running loop) and read the
// top frames, then let it go. Best effort; returns '' if the pause does not land in time.
async function blockedStack(client, sessionId) {
  const paused = new Promise((resolve) => client.on((m) => { if (m.sessionId === sessionId && m.method === 'Debugger.paused') resolve(m.params); }));
  try {
    await client.send('Debugger.pause', {}, sessionId, 5000);
    const p = await Promise.race([paused, new Promise((r) => setTimeout(() => r(null), 5000))]);
    if (!p) return '';
    return p.callFrames.slice(0, 6).map((f) => `${f.functionName || '(anon)'} ${(f.url || '').replace(/^https?:\/\/[^/]+/, '')}:${f.location.lineNumber + 1}`).join(' <- ');
  } catch { return ''; }
}

async function runPage(client, url, page) {
  const errors = [];
  const dialogs = [];
  let blocking = false;
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  client.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(`${m.params.entry.text} ${m.params.entry.url || ''}`);
    // A page dialog (alert/confirm/prompt/beforeunload) blocks the page and every evaluate:
    // dismiss it at once and fail the page, naming it.
    if (m.method === 'Debugger.paused' && !blocking) client.send('Debugger.resume', {}, sessionId, 5000).catch(() => {});
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs.push(`${m.params.type}("${String(m.params.message).slice(0, 120)}")`);
      client.send('Page.handleJavaScriptDialog', { accept: false }, sessionId, 5000).catch(() => {});
    }
  });
  // Parallel pages share one headless Chrome; tabs that are not "focused" get no animation
  // frames (rAF) and throttled timers, so replays stall. Treat every page as focused and active.
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
  await client.send('Page.setWebLifecycleState', { state: 'active' }, sessionId).catch(() => {});
  await client.send('Runtime.enable', {}, sessionId);
  await client.send('Log.enable', {}, sessionId);
  await client.send('Page.enable', {}, sessionId);
  // Enabled now (a busy page cannot answer Debugger.enable later); pauses the gate did not ask
  // for (a stray `debugger;`) are resumed at once, in the listener above.
  await client.send('Debugger.enable', {}, sessionId);
  // The throttle must be set after the page commits: about:blank -> page swaps the renderer.
  const committed = new Promise((r) => client.on((m) => { if (m.sessionId === sessionId && m.method === 'Page.frameNavigated' && !m.params.frame.parentId) r(); }));
  await client.send('Page.navigate', { url }, sessionId);
  if (CPU_THROTTLE > 1) { await committed; await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE }, sessionId); }
  const t0 = Date.now();
  let gate = null;
  let blocked = '';
  while (Date.now() - t0 < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await client.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__gate || null)', returnByValue: true }, sessionId, EVAL_TIMEOUT_MS);
      gate = JSON.parse(r.result.value || 'null');
    } catch (e) {
      if (!e.timedOut) throw e;
      if (dialogs.length) continue; // being dismissed; the next poll should answer
      blocking = true;
      const at = await blockedStack(client, sessionId);
      blocked = `main thread blocked > ${EVAL_TIMEOUT_MS / 1000} s${at ? ` at ${at}` : ''}`;
      break;
    }
    if (gate?.done) break;
  }
  await client.send('Target.closeTarget', { targetId }, undefined, 10000).catch(() => {});
  const seconds = Math.round((Date.now() - t0) / 1000);
  const results = gate?.results || [];
  const extra = [...dialogs.map((d) => ({ name: `page opened a blocking dialog: ${d}`, ok: false, detail: 'dismissed by the gate' })),
    ...(blocked ? [{ name: 'page stopped answering', ok: false, detail: blocked }] : [])];
  if (!gate?.done || extra.length) {
    const why = blocked || (dialogs.length ? `${dialogs.length} dialog(s)` : `did not finish within ${TIMEOUT_MS / 1000} s`);
    console.log(`gate:browser ${page} FAIL: ${why}`);
    [...results, ...extra].forEach((x) => { if (!x.ok || process.env.GATE_VERBOSE || !gate?.done) console.log(`  ${x.ok ? 'pass' : 'FAIL'} ${x.name} ${x.detail}`); });
    errors.forEach((e) => console.log(`  console error: ${e}`));
    return { page, ok: false, pass: results.filter((x) => x.ok).length, total: results.length + extra.length, errors: errors.length, seconds, timedOut: !gate?.done, blocked: blocked || undefined, dialogs, failed: [...results, ...extra].filter((x) => !x.ok).map((x) => x.name) };
  }
  for (const x of results) if (!x.ok || process.env.GATE_VERBOSE) console.log(`  ${x.ok ? 'pass' : 'FAIL'} ${x.name} ${x.detail}`);
  errors.forEach((e) => console.log(`  console error: ${e}`));
  const ok = gate.pass && errors.length === 0;
  const summary = { page, ok, pass: results.filter((x) => x.ok).length, total: results.length, errors: errors.length, seconds, failed: results.filter((x) => !x.ok).map((x) => x.name) };
  console.log(`gate:browser ${page} ${ok ? 'PASS' : 'FAIL'}: ${summary.pass}/${summary.total} checks, ${summary.errors} console errors, ${summary.seconds} s`);
  return summary;
}

// Run record (gate:full): docs/testing/runs/<time>-<commit>.json, so results can be checked
// later without re-running. Records the commit and whether the tree had uncommitted changes.
// Machine sleep (lid closed on battery: only short DarkWakes) freezes Chrome and this process,
// so timing checks fail and polls look hung. A 1 s heartbeat that lands > 5 s late means the
// machine was suspended; the total goes in the output and the record.
const sleep = { seconds: 0, gaps: [] };
function watchSleep() {
  let last = Date.now();
  const t = setInterval(() => {
    const now = Date.now(); const gap = now - last - 1000; last = now;
    if (gap > 5000) { sleep.seconds += Math.round(gap / 1000); sleep.gaps.push(`${new Date(now - gap).toISOString().slice(11, 19)}+${Math.round(gap / 1000)}s`); }
  }, 1000);
  t.unref();
  return () => clearInterval(t);
}

function writeRecord(results, ok, ms) {
  const git = (c) => { try { return execSync(`git ${c}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
  const commit = git('rev-parse --short HEAD') || 'nogit';
  const dirty = git('status --porcelain') !== '';
  const when = new Date().toISOString();
  const dir = path.join(ROOT, 'docs', 'testing', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const unit = (() => { try { return JSON.parse(process.env.GATE_UNIT_SUMMARY); } catch { return process.env.GATE_UNIT_SUMMARY || null; } })();
  const rec = { when, commit, dirty, ok, seconds: Math.round(ms / 1000), sleptSeconds: sleep.seconds, sleptAt: sleep.gaps, unit, pages: results };
  const file = path.join(dir, `${when.replace(/[:.]/g, '-')}-${commit}${dirty ? '-dirty' : ''}.json`);
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  console.log(`gate:browser record: ${path.relative(ROOT, file)}`);
}

async function main() {
  if (!CHROME) { console.error('gate:browser: Chrome not found (set CHROME_PATH).'); return 2; }
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'opengrip-gate-'));
  const { proc, ws } = launchChrome(profile);
  let client = null;
  try {
    client = cdp(await ws);
    await client.opened;
    const t0 = Date.now();
    const stopWatch = watchSleep();
    // GATE_PARALLEL=1 runs every page in its own tab at once (used by gate:full).
    const results = process.env.GATE_PARALLEL === '1'
      ? await Promise.all(PAGES.map((page) => runPage(client, base + page, page)))
      : await (async () => { const out = []; for (const page of PAGES) out.push(await runPage(client, base + page, page)); return out; })();
    const allOk = results.length > 0 && results.every((r) => r.ok);
    stopWatch();
    if (sleep.seconds) console.log(`gate:browser WARNING: the machine was asleep ~${sleep.seconds} s during this run (${sleep.gaps.join(', ')}); timing results are not trustworthy. Re-run awake (lid open, on power or caffeinate -i).`);
    console.log(`gate:browser ${allOk ? 'PASS' : 'FAIL'}: ${PAGES.length} page(s), ${Math.round((Date.now() - t0) / 1000)} s`);
    if (process.env.GATE_RECORD === '1') writeRecord(results, allOk, Date.now() - t0);
    return allOk ? 0 : 1;
  } finally {
    client?.close();
    // Delete the profile only after Chrome has gone: a late write (TransportSecurity) after the
    // delete left an empty profile behind. SIGKILL after 5 s; sweep once more just after.
    const exited = proc.exitCode !== null ? Promise.resolve() : new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    const t = setTimeout(() => proc.kill('SIGKILL'), 5000);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
    clearTimeout(t);
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code), (e) => { console.error(`gate:browser error: ${e.message}`); process.exit(1); });
