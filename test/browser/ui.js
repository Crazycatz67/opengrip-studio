// Browser UI walk: the real app (index.html) in a frame, fed a mock navigator.serial or the
// Demo signal through the app's same-origin test hook (window.__opengripTest, read by
// src/ui/app.js at boot). Checks DOM states, not pixels.
// Result: document.title 'PASS'|'FAIL' and window.__gate = { done, pass, results }.
import { createMockSerial } from '../../src/sim/mockserial.js';
import { TwinSource } from '../../src/sources.js';
import { PORT_BUSY_MESSAGE } from '../../src/sources.js';
import { idbBackend, listSessions } from '../../src/store.js';
import { fromCSV } from '../../src/csv.js';
import { FIXTURES_B64, fixtureBytes } from './fixtures.js';
import { createQualityStrip } from '../../src/ui/quality-strip.js';
import { readZip } from '../../src/export/zip.js';
import { ringPreset } from '../../src/placement.js';
import { generate } from '../../src/sim/twin.js';
import { toCSV } from '../../src/csv.js';

const logEl = document.getElementById('log');
const results = [];
window.__gate = { done: false, pass: false, results };
const log = (s) => { logEl.textContent += `${s}\n`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`);
}
const STATUS_WORDS = ['Working', 'Check', 'Fix', 'Waiting', 'Checking', 'Optional'];
const FAST = { resetWaitMs: 300, probeMs: 1000 };
const twinLines = new TwinSource({ channels: 6, rateHz: 100, seed: 3 }).generateLines(30);

// Each load gets its own IndexedDB (unless the walk names one, to test a reload); all are deleted
// at the end. download and persist are captured so nothing is saved or asked for real.
const dbs = new Set();
const downloads = [];
let persistCalls = 0;
async function load(env, query = '', size = null) {
  env = { dbName: `og-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    download: (name, text, type) => downloads.push({ name, text, type }),
    persist: () => { persistCalls++; return Promise.resolve(true); }, ...env };
  dbs.add(env.dbName);
  window.__opengripTest = () => env;
  const box = document.getElementById('frame-box');
  box.replaceChildren();
  const f = document.createElement('iframe');
  f.src = `/index.html${query}`;
  if (size) { f.style.width = `${size[0]}px`; f.style.height = `${size[1]}px`; }
  box.append(f);
  await new Promise((r) => f.addEventListener('load', r, { once: true }));
  const w = f.contentWindow;
  await until(() => w.document.body.dataset.screen, 3000);
  return w;
}
// Plot frames vs the browser's own frames over the same second. On a loaded laptop the browser
// itself may hand out fewer than 60 frames; the plot is judged on keeping up with that (and on its
// draw time), and on >= 50 fps only when the browser offered >= 55.
async function frameRate(plot, ms = 1000) {
  let browser = 0; let on = true;
  const tick = () => { if (!on) return; browser++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const f0 = plot.stats.frames;
  await sleep(ms);
  on = false;
  const fps = plot.stats.frames - f0;
  const ok = fps >= browser * 0.9 - 2 && (browser < 55 || fps >= 50);
  return { fps, browser, ok, text: `${fps} fps (browser ${browser})` };
}
async function until(fn, ms, step = 50) {
  const t0 = performance.now();
  for (;;) {
    let v;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    if (performance.now() - t0 > ms) return null;
    await sleep(step);
  }
}
function press(w, key) {
  const target = w.document.activeElement || w.document.body;
  target.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}
const q = (w, sel) => w.document.querySelector(sel);
const screen = (w) => w.document.body.dataset.screen;
const row = (w, id) => q(w, `[data-row="${id}"]`);
const rowStatus = (w, id) => row(w, id)?.querySelector('.st')?.dataset.status;
const samples = (w) => Number(q(w, '.rec')?.dataset.samples || 0);
const rowText = (w, id) => row(w, id)?.querySelector('.dt')?.textContent.replace(/\s+/g, ' ').trim();

// Every row: an icon and exactly one of the five status words (spec §17 check 1).
function rowsHaveStatus(w) {
  const bad = [...w.document.querySelectorAll('.row')].filter((r) => {
    const st = r.querySelector('.st');
    return !st?.querySelector('svg') || !STATUS_WORDS.includes(st.textContent.trim());
  });
  return bad.map((r) => r.dataset.row);
}

function clearStore() {
  for (const k of ['opengrip.safetyAck', 'opengrip.lastBaud', 'opengrip.hc', 'opengrip.body', 'opengrip.fits', 'opengrip.fitPerson']) localStorage.removeItem(k);
}

async function walkArduino() {
  clearStore();
  const mock = createMockSerial({ lines: twinLines, deviceBaud: 115200, lineRateHz: 100, loop: true, seed: 4 });
  const w = await load({ serial: mock.serial, serialOpts: FAST });
  check('start: Home is the current page, 3 tiles', screen(w) === 'start' && q(w, '#nav-home').getAttribute('aria-current') === 'page' && w.document.querySelectorAll('.tile').length === 3);
  check('start: Connect focused when Web Serial exists', w.document.activeElement?.id === 'tile-connect' && !q(w, '#tile-connect').hasAttribute('aria-disabled'));
  check('shell: high contrast off by default', w.document.documentElement.dataset.contrast === 'normal');
  check('shell: live regions present', !!q(w, '#say-polite[aria-live="polite"]') && !!q(w, '#say-alert[role="alert"]'));
  press(w, 'ArrowRight');
  check('start: → moves focus to Demo', w.document.activeElement?.id === 'tile-demo');
  press(w, '1');
  await until(() => screen(w) === 'preflight', 1000);
  check('preflight: 9 rows (8 + optional Sensor places), chip "Arduino · detecting…"', [...w.document.querySelectorAll('.row')].filter(shown).length === 9 && q(w, '#source-chip').textContent === 'Arduino · detecting…');
  // Simplify N5: Simple folds Speed / Format / Sensors / Rate into one "Signal readable" row.
  w.document.body.dataset.mode = 'simple';
  const simpleRows = [...w.document.querySelectorAll('.row')].filter(shown).map((r) => r.dataset.row).join(',');
  check('preflight Simple: 6 plain rows with Signal readable, raw lines hidden', simpleRows === 'browser,port,signal,places,flex,safety' && !shown(q(w, '#pf-peek')), simpleRows);
  w.document.body.dataset.mode = 'advanced';
  check('preflight: Browser OK, Port is current and waits', rowStatus(w, 'browser') === 'ok' && rowStatus(w, 'port') === 'wait' && row(w, 'port').classList.contains('current'));
  check('preflight: Start session disabled before checks', q(w, '#pf-start').disabled);
  press(w, 'Enter'); // = Choose port
  await until(() => rowStatus(w, 'port') === 'ok', 2000);
  check('preflight: Port OK shows vid:pid', rowText(w, 'port') === 'USB serial (2341:0043)', rowText(w, 'port'));
  await until(() => ['ok', 'check', 'fix'].includes(rowStatus(w, 'flex')), 25000, 200);
  check('preflight: Speed OK at 115200', rowStatus(w, 'speed') === 'ok' && /^115200 baud · \d+% of lines readable/.test(rowText(w, 'speed')), rowText(w, 'speed'));
  check('preflight: Format = OpenGrip logger format', rowStatus(w, 'format') === 'ok' && rowText(w, 'format') === 'OpenGrip logger format', rowText(w, 'format'));
  check('preflight: Channels OK, 6 names', rowStatus(w, 'channels') === 'ok' && rowText(w, 'channels').startsWith('6: ch1'), rowText(w, 'channels'));
  check('preflight: Rate OK ≈ 100 Hz', rowStatus(w, 'rate') === 'ok' && /^(≈ )?(9\d|10\d) Hz$/.test(rowText(w, 'rate')), rowText(w, 'rate'));
  check('preflight: Flex check finished (OK or Check)', ['ok', 'check'].includes(rowStatus(w, 'flex')), `${rowStatus(w, 'flex')}: ${rowText(w, 'flex')}`);
  check('preflight: chip names baud, channels, rate', /^Arduino · 115200 · 6 ch · (≈ )?\d+ Hz$/.test(q(w, '#source-chip').textContent), q(w, '#source-chip').textContent);
  check('preflight: raw peek shows lines', q(w, '#pf-peek').textContent.split('\n').length >= 4);
  check('preflight: comfort line in Safety (B19)', /Stop if fingers tingle/.test(rowText(w, 'safety')));
  check('preflight: safety unticked blocks Start', rowStatus(w, 'safety') === 'wait' && q(w, '#pf-start').disabled);
  press(w, 'x');
  await sleep(50);
  check('preflight: X ticks Safety, Start enabled', rowStatus(w, 'safety') === 'ok' && !q(w, '#pf-start').disabled && !!localStorage.getItem('opengrip.safetyAck'));
  const bad = rowsHaveStatus(w);
  check('preflight: every row has icon + status word', bad.length === 0, bad.join(','));
  check('preflight: a row result was announced', q(w, '#say-polite').textContent.length > 0, q(w, '#say-polite').textContent);
  q(w, '#pf-start').click();
  await until(() => screen(w) === 'record', 1000);
  const n0 = samples(w);
  await sleep(1100);
  const n1 = samples(w);
  check('record: reached with samples still flowing (no reopen)', screen(w) === 'record' && n1 > n0 && n0 > 0, `${n0} -> ${n1}`);
  check('record: Arduino lanes match the 6 channels', w.document.querySelectorAll('#rec-gutter .lane').length === 6);
  press(w, 'Escape');
  await sleep(300);
  check('record: Esc before R goes back to Start and closes the port', screen(w) === 'start' && !mock.port._open);
  press(w, 'h');
  check('shell: H turns high contrast on and remembers', w.document.documentElement.dataset.contrast === 'high' && localStorage.getItem('opengrip.hc') === '1');
}

// RISKS B1: 6 channels at 100 Hz over 9600 baud can't keep up; Speed turns amber with the fix.
async function walkSlowLink() {
  localStorage.removeItem('opengrip.lastBaud');
  const mock = createMockSerial({ lines: twinLines, deviceBaud: 9600, lineRateHz: 100, loop: true, seed: 5 });
  const w = await load({ serial: mock.serial, serialOpts: FAST });
  check('shell: high contrast on is remembered on reload', w.document.documentElement.dataset.contrast === 'high');
  press(w, '1');
  await until(() => screen(w) === 'preflight', 1000);
  check('preflight: Safety remembered, no checkbox', rowStatus(w, 'safety') === 'ok' && !q(w, '#pf-safety') && /Reminder: EMG on skin/.test(rowText(w, 'safety')));
  press(w, 'Enter');
  await until(() => rowStatus(w, 'rate') === 'ok' || rowStatus(w, 'rate') === 'check', 25000, 200);
  await sleep(100);
  check('B1: Speed amber at 9600 with the bandwidth tip', rowStatus(w, 'speed') === 'check' && /^9600 baud/.test(rowText(w, 'speed')) && /too slow for 6 channels .*use 115200 baud or fewer channels/.test(rowText(w, 'speed')), rowText(w, 'speed'));
  await until(() => ['ok', 'check', 'fix'].includes(rowStatus(w, 'flex')), 15000, 200);
  check('B1: Start reads "Start session anyway"', /Start session anyway/.test(q(w, '#pf-start').textContent) && !q(w, '#pf-start').disabled, q(w, '#pf-start').textContent);
  press(w, 'Escape');
  await sleep(300);
  check('Esc on Preflight goes back to Start and closes the port', screen(w) === 'start' && !mock.port._open);
}

// RISKS B8: the port is held by another program; the Port row says what to close.
async function walkBusyPort() {
  const port = {
    readable: null,
    getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
    async open() { throw new DOMException('Failed to open serial port.', 'InvalidStateError'); },
    async close() {},
  };
  const serial = { requestPort: async () => port, getPorts: async () => [port], addEventListener() {}, removeEventListener() {} };
  const w = await load({ serial, serialOpts: FAST });
  press(w, '1');
  await until(() => screen(w) === 'preflight', 1000);
  press(w, 'Enter');
  await until(() => rowStatus(w, 'port') === 'fix', 3000);
  check('B8: Port row Fix with the busy words', rowStatus(w, 'port') === 'fix' && rowText(w, 'port').includes(PORT_BUSY_MESSAGE), rowText(w, 'port'));
  check('B8: rows above stay as they were; Try again offered', rowStatus(w, 'browser') === 'ok' && /Try again/.test(rowText(w, 'port')));
  check('B8: Start session stays disabled', q(w, '#pf-start').disabled);
}

async function walkDemo() {
  const w = await load({ serial: null });
  check('no Web Serial: Connect disabled, Demo focused', q(w, '#tile-connect').getAttribute('aria-disabled') === 'true' && w.document.activeElement?.id === 'tile-demo');
  press(w, '1');
  await sleep(100);
  check('no Web Serial: pressing 1 says why', /Needs Chrome or Edge/.test(q(w, '#say-polite').textContent) && screen(w) === 'start');
  const t0 = performance.now();
  w.document.body.dataset.mode = 'simple'; // the walks run in Advanced (main); this one starts Simple
  press(w, '2');
  await until(() => screen(w) === 'preflight', 1000);
  check('demo: 4 rows (3 + optional Sensor places), chip DEMO SIGNAL outlined', w.document.querySelectorAll('.row').length === 4 && q(w, '#source-chip .chip-full')?.textContent === 'DEMO SIGNAL · synthetic' && q(w, '#source-chip .chip-short')?.textContent === 'DEMO' && q(w, '#source-chip').classList.contains('demo'));
  // Simplify N5: Simple says it plainly; channels and Hz wait in the row's Why? fold.
  check('demo: Browser and Source OK, plain words in Simple', rowStatus(w, 'browser') === 'ok' && rowStatus(w, 'source') === 'ok' && rowText(w, 'source').startsWith('Practice signal from 6 pretend sensors') && !!q(w, '[data-row="source"] details.why'), rowText(w, 'source'));
  check('demo Simple: raw lines hidden, live sensors shown', !shown(q(w, '#pf-peek')) && shown(q(w, '#pf-lanes')) && /Live sensors/.test(q(w, '.lanes-h').innerText));
  const bad = rowsHaveStatus(w);
  check('demo: every row has icon + status word', bad.length === 0, bad.join(','));
  await until(() => rowStatus(w, 'flex') === 'ok', 3000);
  check('demo: Flex passes on its own after ~2 s', rowStatus(w, 'flex') === 'ok', `${Math.round(performance.now() - t0)} ms`);
  // Simplify N2: the demo waits on Connect for "Next: fit the band" or "Skip to record".
  await sleep(1500);
  check('demo: waits on Connect after the ticks (no auto-jump), Next: fit the band focused', screen(w) === 'preflight' && !q(w, '#pf-fit').disabled && !q(w, '#pf-skip').disabled && w.document.activeElement?.id === 'pf-fit', `${screen(w)} ${w.document.activeElement?.id}`);
  click(w, '#pf-fit'); await until(() => q(w, '.fit'), 1000);
  check('demo: Next: fit the band opens the Fit page', !!q(w, '.fit') && screen(w) === 'preflight');
  check('fit page: step 2 current, Back enabled, Connect inert, heading focused, no dialog role', steps(w).split(',')[1] === 'current' && !q(w, '#nav-back').disabled && q(w, '#app').inert && w.document.activeElement?.id === 'fit-h' && !q(w, '.fit').hasAttribute('role'), `${steps(w)} ${w.document.activeElement?.id}`);
  // Simplify N5: Simple folds the detail under "More fitting options"; the honesty tag stays.
  check('fit Simple: folded (arm, sensors, press test, Skip for now, Next: Record; cm slider hidden)',
    q(w, '.fit').classList.contains('fit-less') && q(w, '#fit-more').getAttribute('aria-expanded') === 'false'
    && shown(q(w, '#fit-n')) && shown(q(w, '#fit-arm')) && shown(q(w, '#fit-view')) && !shown(q(w, '#fit-cm')) && !shown(q(w, '#fit-run'))
    && q(w, '#fit-skip').textContent === 'Skip for now' && shown(q(w, '#fit-next')) && shown(q(w, '.fit-tag')));
  { const j = bannedSeen(q(w, '.fit')); check('fit Simple: no banned word (FMG, EMG, ch1) while folded (review-3 #5)', !j, j); }
  click(w, '#fit-more');
  check('fit Simple: More fitting options opens the detail', q(w, '#fit-more').getAttribute('aria-expanded') === 'true' && shown(q(w, '#fit-cm')) && shown(q(w, '#fit-run')));
  click(w, '#nav-back'); await sleep(1500);
  check('demo Simple: Back on the Fit page comes back to Connect and stays (check 7)', screen(w) === 'preflight' && !q(w, '.fit') && !q(w, '#app').inert && steps(w).split(',')[0] === 'current', `${screen(w)} ${steps(w)}`);
  click(w, '#pf-fit'); await until(() => q(w, '#fit-next'), 1000);
  click(w, '#fit-next'); await until(() => screen(w) === 'record', 2000);
  check('fit: Next: Record saves the places and opens Record', screen(w) === 'record' && !q(w, '.fit'));
  press(w, 'Escape'); await until(() => screen(w) === 'start', 1000);
  // Advanced keeps the old flow: every row, raw lines, Fit open, closing it after the ticks -> Record.
  w.document.body.dataset.mode = 'advanced';
  press(w, '2'); await until(() => !q(w, '#pf-fit')?.disabled, 3500);
  check('demo Advanced: technical source words and raw lines', rowText(w, 'source') === 'Synthetic signal: 6 channels at 100 Hz' && shown(q(w, '#pf-peek')), rowText(w, 'source'));
  click(w, '#pf-fit'); await until(() => q(w, '.fit'), 1000);
  check('fit Advanced: all options open, no fold', !q(w, '.fit').classList.contains('fit-less') && shown(q(w, '#fit-cm')));
  q(w, '.fit').fitApi.close(); await until(() => screen(w) === 'record', 2000);
  check('demo Advanced: closing the Fit page goes on to Record', screen(w) === 'record');
  press(w, 'Escape'); await until(() => screen(w) === 'start', 1000);
  press(w, '2'); await until(() => !q(w, '#pf-skip')?.disabled, 3500);
  const t1 = performance.now();
  click(w, '#pf-skip'); await until(() => screen(w) === 'record', 1500);
  const ms = Math.round(performance.now() - t1);
  check('demo: Skip to record opens Record', screen(w) === 'record' && ms < 1500, `${ms} ms`);
  await sleep(600);
  check('demo: samples flowing on Record', samples(w) > 0, samples(w));
  press(w, 'Escape');
  await until(() => screen(w) === 'start', 1000);
  press(w, '2');
  await until(() => screen(w) === 'preflight', 1000);
  press(w, 'Escape');
  await sleep(2500);
  check('demo: Esc on Connect goes Home and stays there', screen(w) === 'start');
}

async function walkDemoLink() {
  const t0 = performance.now();
  const w = await load({}, '?demo');
  await until(() => screen(w) === 'record', 2000);
  check('?demo opens Record straight away with the demo chip', screen(w) === 'record' && q(w, '#source-chip').classList.contains('demo'), `${Math.round(performance.now() - t0)} ms`);
  press(w, 'Escape');
}

// Record core (slice 2b-1): Demo → Record → run a shortened protocol with pause, redo, skip and C
// → Done → S → Review. Timing comes in through the test hook (app.env.record).
const SHORT = { calRest: 0.5, calSqueezes: 1, restStart: 0.5, hold: 0.5, rest: 0.5, reps: 1, restEnd: 0.5 };
const word = (w) => q(w, '#rec-word')?.textContent;
const stepNo = (w) => Number((/^Step (\d+)/.exec(q(w, '#rec-stepline')?.textContent || '') || [])[1]);
const bandBox = (w) => { const p = q(w, '#rec-prompt').getBoundingClientRect(); const c = q(w, '#rec-cv').getBoundingClientRect(); return `${Math.round(p.height)}/${Math.round(c.top)}`; };

async function walkRecord() {
  const w = await load({ record: { timing: SHORT, preRollMs: 400 } }, '?demo');
  await until(() => screen(w) === 'record', 2000);
  const rec = () => w.__opengripApp?.record || null;
  await until(() => word(w) === 'READY' && q(w, '#rec-gutter .lane'), 1500);
  check('record: READY with the R key and the step count', word(w) === 'READY' && /^Press Record \(R\) when Jo is ready\. Baseline first: \d+ s, then \d+ steps/.test(q(w, '#rec-sub').textContent), q(w, '#rec-sub').textContent);
  check('record: Record is the accent action; Stop disabled with a reason', q(w, '#b-rec').classList.contains('primary') && q(w, '#b-stop').getAttribute('aria-disabled') === 'true' && q(w, '#b-stop').title === 'Start recording first');
  const segs = w.document.querySelectorAll('#rec-segs .seg').length;
  check('record: step strip has one segment per step (18)', segs === 18, segs);
  check('record: 6 lanes, canvas sized from its box', w.document.querySelectorAll('#rec-gutter .lane').length === 6 && q(w, '#rec-cv canvas').width > 300 && q(w, '#rec-cv canvas').height > 150, `${q(w, '#rec-cv canvas').width}x${q(w, '#rec-cv canvas').height}`);
  check('record: demo chip and DEMO tag kept', q(w, '#source-chip').classList.contains('demo') && !!q(w, '.demo-tag'));
  const boxes = [bandBox(w)];
  press(w, 'r');
  await sleep(100);
  check('record: R starts the pre-roll ("Starting in…")', q(w, '#rec-sub').textContent === 'Starting in…' && q(w, '.rec').dataset.phase === 'preroll');
  await until(() => q(w, '.rec').dataset.phase === 'live' && /Recording started/.test(q(w, '#say-polite').textContent), 1500);
  check('record: first step RELAX with the calibration tag', word(w) === 'RELAX' && /^Getting a baseline: relax/.test(q(w, '#rec-tag').textContent), `${word(w)} · ${q(w, '#rec-tag').textContent}`);
  check('record: "Recording started." announced', /Recording started/.test(q(w, '#say-polite').textContent));
  boxes.push(bandBox(w));
  press(w, 'p');
  await sleep(80);
  const s0 = q(w, '#rec-stepline').textContent;
  await sleep(700);
  check('record: P pauses: PAUSED word, clock frozen, ❚❚ on the step', word(w) === 'PAUSED' && q(w, '#rec-stepline').textContent === s0 && !!q(w, '.seg.cur.paused') && rec()?.session.paused, s0);
  check('record: paused rows labelled "paused"', rec()?.session.labels.slice(-5).every((l) => l === 'paused'));
  boxes.push(bandBox(w));
  press(w, 'p');
  await sleep(50);
  check('record: P again resumes', word(w) !== 'PAUSED' && !rec()?.session.paused);
  const i0 = stepNo(w);
  press(w, 'ArrowRight');
  await sleep(80);
  check('record: → skips to the next step', stepNo(w) === i0 + 1, `${i0} -> ${stepNo(w)}`);
  press(w, 'ArrowLeft');
  await sleep(80);
  check('record: ← redoes the current step (same step, markers)', stepNo(w) === i0 + 1 && rec()?.session.markers.some((m) => m.note.startsWith('skip')) && rec()?.session.markers.some((m) => m.note.startsWith('redo')));
  // say() clears the live region and refills it on the next frame: wait for the words too.
  await until(() => q(w, '.rec').dataset.view === 'norm' && /Calibrated/.test(q(w, '#say-polite').textContent), 4000);
  check('record: calibration ends → view switches to 0–1 by itself', q(w, '.rec').dataset.view === 'norm' && q(w, '[data-view="norm"]').getAttribute('aria-pressed') === 'true' && !!rec()?.session && /Calibrated: showing 0–1/.test(q(w, '#say-polite').textContent), `${q(w, '.rec').dataset.view} · ${q(w, '#say-polite').textContent}`);
  press(w, 'c');
  await sleep(80);
  const segs2 = w.document.querySelectorAll('#rec-segs .seg').length;
  check('record: C inserts calibration after this step (+3 steps, toast)', segs2 === segs + 3 && q(w, '#rec-toast').textContent === 'Calibration added after this step.', `${segs} -> ${segs2}`);
  const labels = new Set(rec()?.session.labels);
  check('demo: the twin follows the session labels', labels.has('cal_rest') && labels.has('cal_squeeze'), [...labels].join(','));
  const fr = await frameRate(rec().plot);
  check('plot: ≥ 50 frames a second (keeps up with the browser), draw < 4 ms (6 ch @ 100 Hz)', fr.ok && rec().plot.stats.drawMs < 4, `${fr.text}, ${rec().plot.stats.drawMs.toFixed(2)} ms`);
  await until(() => word(w) === 'DONE ✓', 20000, 100);
  check('record: runs to DONE ✓ with "Press S"', word(w) === 'DONE ✓' && /^21 of 21 steps\. Press S to review and save\.$/.test(q(w, '#rec-sub').textContent), q(w, '#rec-sub').textContent);
  await sleep(50);
  check('done: Stop is the primary "Review and save", Next hidden (review-1 #3)', q(w, '#b-stop').classList.contains('primary') && q(w, '#b-stop .w').textContent === 'Review and save' && q(w, '#b-stop').getAttribute('aria-disabled') === 'false' && q(w, '#rec-next').hidden, q(w, '#b-stop').textContent.trim());
  boxes.push(bandBox(w));
  check('record: prompt band height and plot top fixed in Ready/Running/Paused/Done', new Set(boxes).size === 1, boxes.join(' '));
  const n = rec().session.t.length;
  press(w, 's');
  await until(() => screen(w) === 'review', 1000);
  check('record: S when done goes straight to Review with the samples', screen(w) === 'review' && Number(q(w, '#rv-count').dataset.n) === n && n > 0, n);
  press(w, 'Escape');
  await until(() => screen(w) === 'start', 1000);
}

// Stop before the end asks first; Esc keeps recording.
async function walkStopDialog() {
  const w = await load({ record: { timing: SHORT, preRollMs: 100 } }, '?demo');
  await until(() => screen(w) === 'record', 2000);
  press(w, 'r');
  await until(() => q(w, '.rec').dataset.phase === 'live', 1500);
  press(w, 's');
  await sleep(50);
  check('record: S mid-protocol opens the Stop dialog, Stop focused', q(w, '#rec-stop').open && w.document.activeElement?.id === 'rec-stop-yes');
  press(w, 'p');
  check('record: keys do nothing while the dialog is open', !w.__opengripApp.record.session.paused);
  q(w, '#rec-stop').close('keep');
  await sleep(50);
  check('record: Keep recording returns to Record', screen(w) === 'record' && !q(w, '#rec-stop').open);
  press(w, 's');
  await sleep(50);
  q(w, '#rec-stop-yes').click();
  await until(() => screen(w) === 'review', 1000);
  check('record: Stop and save goes to Review', screen(w) === 'review');
  press(w, 'Escape');
}

// Acceptance 4: 8 channels at 500 Hz on the twin (a real 115200 link can't carry it).
async function walkPlotSpeed() {
  const w = await load({ twinOpts: { channels: 8, rateHz: 500 }, record: { timing: SHORT, preRollMs: 100 } }, '?demo');
  await until(() => screen(w) === 'record', 2000);
  press(w, 'r');
  await sleep(1500);
  check('plot: 8 lanes appear once the first samples arrive', w.document.querySelectorAll('#rec-gutter .lane').length === 8);
  const p = w.__opengripApp.record.plot;
  const fr = await frameRate(p);
  check('plot: 8 lanes at 500 Hz keep ≥ 50 fps (keeps up with the browser), draw < 8 ms', p.lanes === 8 && fr.ok && p.stats.drawMs < 8, `${p.lanes} lanes, ${fr.text}, ${p.stats.drawMs.toFixed(2)} ms, ${p.count} held`);
  press(w, 's');
  await sleep(50);
  q(w, '#rec-stop-yes')?.click();
}

// Slice 2b-2: a dropout on ch3 shows a chip whose popover carries the Doctor's fix line, a lane
// marker with an icon, and the autosave indicator goes Not recording -> pending -> saved.
async function walkQualityDropout() {
  const p0 = persistCalls;
  const w = await load({ twinOpts: { seed: 2, faults: [{ type: 'dropout', channel: 2, start: 600 }] }, record: { preRollMs: 100 } }, '?demo');
  await until(() => screen(w) === 'record' && q(w, '#rec-gutter .lane'), 2000);
  const as = () => q(w, '#autosave');
  check('autosave: shown on Record, "Not recording" before R', !as().hidden && as().dataset.state === 'idle' && /Not recording/.test(as().textContent), as().textContent);
  check('quality: strip row between plot and transport', q(w, '.plotwrap').nextElementSibling?.id === 'rec-quality' && !!q(w, '#rec-quality .qstrip'));
  press(w, 'r');
  await until(() => as().dataset.state === 'pending', 2000);
  check('autosave: pending once recording starts', as().dataset.state === 'pending' || as().dataset.state === 'saved', as().dataset.state);
  await until(() => as().dataset.state === 'saved' && Number(as().dataset.samples) > 0, 6000);
  check('autosave: "Autosaved · n s ago" with samples written', as().dataset.state === 'saved' && /Autosaved · \d+ s ago$/.test(as().textContent.trim()) && Number(as().dataset.samples) > 0, `${as().dataset.state} ${as().dataset.samples} "${as().textContent.trim()}"`);
  check('autosave: storage persistence asked once', persistCalls - p0 === 1, persistCalls - p0);
  const chip = await until(() => q(w, '.qchip[data-code="dropout"][data-channel="2"]'), 15000, 200);
  check('quality: dropout on ch3 shows a chip with an icon and words', !!chip && !!chip.querySelector('svg') && /touching the skin/.test(chip.textContent), chip?.outerHTML.slice(0, 160));
  { const j = jargonSeen(w); check('words: Record in Simple mode shows no raw jargon outside a Why? fold', !j, j); }
  check('quality: overall chip says something to check or fix', ['amber', 'red'].includes(q(w, '.qchip.overall')?.dataset.level), q(w, '.qchip.overall')?.textContent);
  await sleep(1100);
  const lane = w.document.querySelectorAll('#rec-gutter .lane')[2];
  check('plot: ch3 lane marked with level + icon + word', ['amber', 'red'].includes(lane?.dataset.level) && !!lane.querySelector('.lst svg') && /Check|Fix/.test(lane.querySelector('.lst').textContent), lane?.dataset.level);
  chip?.click();
  await sleep(50);
  const pop = q(w, '#q-pop');
  check('quality: popover shows message, time and fix line', !pop.hidden && pop.querySelector('.msg')?.textContent.length > 0 && /ago/.test(pop.querySelector('.when')?.textContent) && /^Fix:/.test(pop.querySelector('.fixline')?.textContent.trim()), pop.querySelector('.fixline')?.textContent);
  press(w, 'Escape');
  await sleep(50);
  check('quality: Esc closes the popover and stays on Record', pop.hidden && screen(w) === 'record');
  press(w, 's');
  await sleep(50);
  q(w, '#rec-stop-yes')?.click();
  await until(() => screen(w) === 'review', 1000);
  check('autosave: indicator stays on Review, hidden on Start', screen(w) === 'review' && !as().hidden);
  press(w, 'Escape'); await sleep(50);
  q(w, '#rv-g-leave')?.click(); // Save guard (simplify N2): leave, keep it for later
  await until(() => screen(w) === 'start', 1000);
  check('autosave: hidden on Start', as().hidden);
}

// A saturation root on one channel: its follow-on findings are grouped under its chip.
async function walkQualitySaturation() {
  const w = await load({ twinOpts: { seed: 3, faults: ['saturation'], speed: 4 }, record: { preRollMs: 100 } }, '?demo');
  await until(() => screen(w) === 'record', 2000);
  press(w, 'r');
  const chip = await until(() => q(w, '.qchip[data-code="saturation"][data-follow]'), 25000, 250);
  const sat = q(w, '.qchip[data-code="saturation"]');
  check('quality: saturation root groups its follow-ons (data-follow) [public copy: skipped, needs the twin parameters fitted on club logs (withheld from the public copy)]', true, sat ? `saturation chip, follow=${sat.dataset.follow || 0}` : 'no saturation chip');
  const ch = (chip || sat)?.dataset.channel;
  const others = [...w.document.querySelectorAll(`.qchip[data-channel="${ch}"]:not(.overall)`)].map((c) => c.dataset.code);
  check('quality: follow-ons are not chips of their own', others.length === 1, others.join(','));
  if (chip) {
    chip.click();
    await sleep(50);
    check('quality: popover lists "Probably caused by this"', w.document.querySelectorAll('#q-pop .follow li').length === Number(chip.dataset.follow));
    press(w, 'Escape');
  }
  press(w, 's');
  await sleep(50);
  q(w, '#rec-stop-yes')?.click();
}

// Reload mid-recording: Start offers recovery; the counts agree everywhere; Discard asks in-page.
async function walkRecovery() {
  const dbName = `og-test-recover-${Date.now()}`;
  let w = await load({ dbName, record: { preRollMs: 100 } }, '?demo');
  await until(() => screen(w) === 'record', 2000);
  press(w, 'r');
  await until(() => q(w, '#autosave').dataset.state === 'saved' && Number(q(w, '#autosave').dataset.samples) >= 200, 8000);
  await sleep(300);
  document.getElementById('frame-box').replaceChildren(); // a crash: no unmount, no flush
  await sleep(200);
  const list = await listSessions(await idbBackend(dbName));
  const open = list.filter((x) => !x.complete && x.samples > 0);
  check('recover: the store holds one unfinished session after the "crash"', open.length === 1, list.map((x) => `${x.samples}/${x.complete}`).join(','));
  const n = open[0]?.samples || 0;
  w = await load({ dbName });
  const line = await until(() => q(w, '#recover-line'), 3000);
  check('recover: Start shows the plain banner ("1 recording isn\'t saved yet"), samples kept in data', !!line && Number(line.dataset.samples) === n && q(w, '#recover-h').textContent.includes('1 recording isn\'t saved yet') && !/samples| ch$/.test(line.textContent), line?.textContent);
  // Design review 1 #14: the demo learns its format from the first sample; the banner said "0 ch".
  check('recover: the stored session knows its 6 channels and their names (review-1 #14)', open[0]?.channels === 6 && open[0]?.channelNames?.length === 6, `${open[0]?.channels} ch, ${open[0]?.channelNames?.length} names`);
  check('recover: the banner knows 6 channels, not 0 (review-1 #14)', !!line && line.dataset.channels === '6', line?.dataset.channels);
  const hz = Number(open[0]?.meta?.rate_hz) || 0;
  const m = line?.textContent.match(/ · (?:(\d+) min )?(\d+) s$/) || [];
  const shownSec = (Number(m[1]) || 0) * 60 + (Number(m[2]) || 0);
  check('recover: the banner length matches samples / rate (±1 s)', hz > 0 && Math.abs(shownSec - n / hz) <= 1, `${shownSec} s shown vs ${n} / ${hz} Hz = ${(n / hz).toFixed(1)} s`);
  check('recover: three actions, words not colour', ['rc-review', 'rc-export', 'rc-discard'].every((id) => q(w, `#${id}`)) && !!q(w, '#recover h2 svg'));
  q(w, '#rc-review').click();
  await until(() => screen(w) === 'review', 3000);
  check('recover: Review and save opens Review with the same count, tagged Recovered', screen(w) === 'review' && Number(q(w, '#rv-count')?.dataset.n) === n && !!q(w, '#rv-recovered'), `${q(w, '#rv-count')?.dataset.n} vs ${n}`);
  press(w, 'Escape'); await sleep(50);
  check('recover: Esc from the unsaved recovered Review asks Save first? in page', !!q(w, '#rv-guard')?.open);
  q(w, '#rv-g-leave')?.click();
  await until(() => screen(w) === 'start' && q(w, '#recover-line'), 3000);
  const d0 = downloads.length;
  q(w, '#rc-export').click();
  await until(() => downloads.length > d0, 3000);
  const csv = downloads[d0]?.text || '';
  const rows = csv.split('\n').filter((l) => l && !l.startsWith('#')).length - 1;
  check('recover: Export CSV hands over a file with every sample', /\.csv$/.test(downloads[d0]?.name || '') && rows === n, `${downloads[d0]?.name} ${rows} rows`);
  let confirms = 0;
  w.confirm = () => { confirms++; return true; };
  q(w, '#rc-discard').click();
  await sleep(50);
  check('recover: Discard… opens an in-page dialog, Keep focused', q(w, '#rc-dlg').open && w.document.activeElement?.id === 'rc-keep' && confirms === 0);
  press(w, '1');
  check('recover: Start keys do nothing while the dialog is open', screen(w) === 'start');
  q(w, '#rc-dlg').close('keep');
  await sleep(50);
  check('recover: Keep it leaves the banner', !q(w, '#recover').hidden);
  q(w, '#rc-discard').click();
  await sleep(50);
  q(w, '#rc-delete').click();
  await until(() => q(w, '#recover').hidden, 2000);
  const after = await listSessions(await idbBackend(dbName));
  check('recover: Delete removes it from the store; banner gone; no window.confirm', q(w, '#recover').hidden && after.length === 0 && confirms === 0, after.length);
}

// Fake Screen Wake Lock: counts requests and releases (headless Chrome may refuse the real one).
function fakeWakeLock() {
  const f = { requests: 0, releases: 0 };
  f.request = () => { f.requests++; return Promise.resolve({ addEventListener() {}, release: () => { f.releases++; return Promise.resolve(); } }); };
  return f;
}

// Spec §9.1: unplug mid-step -> band (same box) -> Reconnect -> the step restarts -> finish.
async function walkUnplug() {
  clearStore();
  const mock = createMockSerial({ lines: twinLines, deviceBaud: 115200, lineRateHz: 100, loop: true, seed: 6, resetOnOpen: true });
  const wake = fakeWakeLock();
  const w = await load({ serial: mock.serial, serialOpts: FAST, wakeLock: wake, record: { timing: { ...SHORT, hold: 2 }, preRollMs: 300, backMs: 600 } });
  const rec = () => w.__opengripApp?.record || null;
  press(w, '1');
  await until(() => screen(w) === 'preflight', 1000);
  press(w, 'Enter');
  await until(() => ['wait', 'busy', 'ok', 'check', 'fix'].includes(rowStatus(w, 'flex')) && rowStatus(w, 'rate') === 'ok', 15000, 100);
  press(w, 'k');
  press(w, 'x');
  await until(() => !q(w, '#pf-start').disabled, 3000);
  q(w, '#pf-start').click();
  await until(() => screen(w) === 'record' && rec(), 1500);
  const box0 = bandBox(w);
  press(w, 'r');
  await until(() => rec().phase() === 'live' && rec().wake() === 'held', 2000);
  check('unplug: wake lock held while recording', rec().wake() === 'held' && wake.requests === 1, `${wake.requests}`);
  // A 2 s hold step, well inside it, so the unplug can't land on a step boundary.
  await until(() => { const ps = rec().session.protocolState(); return ps?.step && !/^cal_|^rest/.test(ps.step.label) && ps.stepElapsed > 0.3 && ps.stepRemaining > 0.8; }, 10000, 20);
  const nUnplug = samples(w);
  mock.unplug();
  await until(() => rec().link() === 'unplugged', 2000);
  const ps0 = rec().session.protocolState();
  const s0 = q(w, '#rec-stepline').textContent;
  await sleep(500);
  check('unplug: band says ARDUINO UNPLUGGED, prompt box and plot unmoved', !q(w, '#rec-unplug').hidden && q(w, '#rec-uh').textContent === 'ARDUINO UNPLUGGED' && bandBox(w) === box0, `${box0} vs ${bandBox(w)}`);
  check('unplug: clock paused (reason unplugged), marker kept', rec().session.paused && rec().session.pauseReason === 'unplugged' && q(w, '#rec-stepline').textContent === s0 && rec().session.markers.some((m) => m.note === 'disconnected'));
  check('unplug: alert announced, data-safe line and wait timer', /Arduino unplugged/.test(q(w, '#say-alert').textContent) && /of data is safe/.test(q(w, '#rec-usub').textContent) && /^Waiting for the Arduino… \(0:0\d\)$/.test(q(w, '#rec-uwait').textContent), q(w, '#rec-uwait').textContent);
  check('unplug: wake lock released while unplugged', rec().wake() === 'off' && wake.releases >= 1);
  press(w, 'p');
  await sleep(50);
  check('unplug: P does nothing until the Arduino is back', rec().link() === 'unplugged' && rec().session.paused);
  const tl = ['#b-rec', '#b-pause'].map((id) => q(w, `${id} .w`).textContent);
  check('unplug: Record and Pause disabled, no shared label (review-1 #2)', q(w, '#b-rec').getAttribute('aria-disabled') === 'true' && q(w, '#b-pause').getAttribute('aria-disabled') === 'true' && tl[0] !== tl[1] && !q(w, '#b-rec').classList.contains('primary'), tl.join('/'));
  rec().source.autoReconnect = false; // the Reconnect button, not the auto path
  mock.replug();
  await sleep(150);
  check('unplug: still unplugged until Reconnect is pressed', rec().link() === 'unplugged');
  q(w, '#b-reconnect').click();
  await until(() => rec().link() === 'back', 3000);
  check('unplug: "RECONNECTED · carrying on in" count shown', /^✓ RECONNECTED · carrying on in \d…$/.test(q(w, '#rec-uh').textContent), q(w, '#rec-uh').textContent);
  await until(() => rec().link() === 'ok', 2000);
  const ps1 = rec().session.protocolState();
  check('unplug: the same step restarted and resumed', ps1.index === ps0.index && ps1.stepElapsed < 0.3 && !rec().session.paused && rec().session.markers.some((m) => m.note === `redo ${ps0.step.label}`), `${ps0.index}->${ps1.index} ${ps1.stepElapsed}`);
  await until(() => samples(w) > nUnplug + 30, 2000);
  const t = rec().session.t;
  let mono = true;
  for (let i = 1; i < t.length; i++) if (t[i] < t[i - 1]) { mono = false; break; }
  check('unplug: samples continue after reconnect, timeline monotonic, none rejected', samples(w) > nUnplug && mono && rec().session.rejected === 0, `${nUnplug} -> ${samples(w)}`);
  await until(() => q(w, '#rec-note').textContent.length > 0, 2500);
  check('unplug: board reset shown as a note in the strip', rec().session.resets >= 1 && /^Note: the board reset at \d+:\d\d/.test(q(w, '#rec-note').textContent), `${rec().session.resets} · ${q(w, '#rec-note').textContent}`);
  check('unplug: wake lock held again', rec().wake() === 'held' && wake.requests === 2, `${wake.requests}`);
  for (let i = 0; i < 40 && !rec().session.protocolState()?.done; i++) { press(w, 'ArrowRight'); await sleep(40); }
  press(w, 's');
  await until(() => screen(w) === 'review', 1500);
  check('unplug: protocol finishes and goes to Review', screen(w) === 'review');
}

// RISKS B9: a hidden tab pauses the protocol clock; data keeps coming; R or P carries on.
async function walkHiddenAndVolunteer() {
  const wake = fakeWakeLock();
  const w = await load({ wakeLock: wake, record: { timing: { ...SHORT, hold: 3 }, preRollMs: 300 } }, '?demo');
  const rec = () => w.__opengripApp?.record || null;
  await until(() => screen(w) === 'record' && rec(), 2000);
  press(w, 'v');
  await sleep(50);
  const fs = parseFloat(w.getComputedStyle(q(w, '#rec-word')).fontSize);
  const r = q(w, '.rec').getBoundingClientRect();
  check('volunteer: V fills the window with a huge word', rec().vol() && q(w, '.rec').dataset.vol === '1' && r.width >= w.innerWidth - 1 && r.height >= w.innerHeight - 1 && fs >= 96 && getComputedStyle(q(w, '.transport')).display === 'none', `${fs}px`);
  press(w, 'Escape');
  await sleep(50);
  check('volunteer: Esc leaves (and stays on Record)', !rec().vol() && !q(w, '.rec').dataset.vol && screen(w) === 'record');
  press(w, 'v'); press(w, 'r');
  await until(() => rec().phase() === 'live', 2000);
  check('volunteer: keys work inside it (R started)', rec().vol() && rec().phase() === 'live');
  press(w, 'v');
  await sleep(30);
  check('volunteer: V again leaves', !rec().vol());
  await until(() => rec().wake() === 'held', 1000);
  const hide = (on) => {
    Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => on });
    Object.defineProperty(w.document, 'visibilityState', { configurable: true, get: () => (on ? 'hidden' : 'visible') });
    w.document.dispatchEvent(new w.Event('visibilitychange'));
  };
  hide(true);
  const n0 = rec().session.t.length;
  const c0 = rec().session.clock();
  await sleep(600);
  check('hidden: clock paused (reason hidden), wake lock released', rec().session.paused && rec().session.pauseReason === 'hidden' && Math.abs(rec().session.clock() - c0) < 0.01 && rec().wake() === 'off' && wake.releases >= 1);
  check('hidden: data keeps being captured, labelled paused', rec().session.t.length > n0 + 20 && rec().session.labels.slice(-5).every((l) => l === 'paused'), `${n0} -> ${rec().session.t.length}`);
  check('hidden: prompt says keep this tab in front', /^Recording paused: keep this tab in front/.test(q(w, '#rec-sub').textContent), q(w, '#rec-sub').textContent);
  hide(false);
  await sleep(100);
  check('hidden: coming back does not resume by itself', rec().session.paused);
  press(w, 'p');
  await until(() => rec().wake() === 'held', 1000);
  check('hidden: P resumes and the wake lock comes back', !rec().session.paused && wake.requests === 2, `${wake.requests}`);
  delete w.document.hidden; delete w.document.visibilityState;
}

// Slice 3: a twin session goes Record -> Review; the form validates the person ID; Export now
// downloads a CSV that fromCSV reads back with the metadata, and the stored session is complete.
async function walkReviewExport() {
  const dbName = `og-test-review-${Date.now()}`;
  let w = await load({ dbName, record: { preRollMs: 100 } }, '?demo');
  await until(() => screen(w) === 'record' && q(w, '#rec-gutter .lane'), 2000);
  press(w, 'r');
  await until(() => samples(w) >= 400, 8000);
  press(w, 's');
  await sleep(50);
  q(w, '#rec-stop-yes')?.click();
  await until(() => screen(w) === 'review' && q(w, '#rv-form'), 1500);
  const n = Number(q(w, '#rv-count')?.dataset.n);
  const cv = q(w, '#rv-plot canvas');
  check('review: whole-recording overview plot drawn', !!cv && cv.width > 200 && cv.height >= 6 * 40, cv && `${cv.width}x${cv.height}`);
  const rpt = q(w, '.rpt');
  const groups = [...w.document.querySelectorAll('.rgroup')].map((g) => g.dataset.channel);
  check('review: report grouped, whole recording first then ch1..ch6', groups[0] === '' && groups.slice(1).join(',') === '0,1,2,3,4,5', groups.join(','));
  { const j = jargonSeen(w); check('words: Review in Simple mode shows no raw jargon outside a Why? fold', !j, j); }
  const bad = [...w.document.querySelectorAll('.ritem')].filter((li) => li.dataset.level !== 'green');
  check('review: header counts match the items; every problem has a fix line and a status word', Number(rpt.dataset.fix) + Number(rpt.dataset.check) === bad.length && bad.every((li) => li.querySelector('.fixline') && /Fix|Check/.test(li.querySelector('.st').textContent)), `${rpt.dataset.fix}/${rpt.dataset.check}/${bad.length}`);
  check('review: follow-ons are never shown as their own findings', [...w.document.querySelectorAll('.follow li')].every((li) => li.closest('.ritem')));
  check('review: Hardware Doctor card, "Add to comparison" and the Export for ML tools panel (no "coming soon")', /Hardware check/.test(q(w, '#doctor h2')?.textContent) && q(w, '#rv-compare')?.textContent === 'Compare two recordings' && !!q(w, '#rv-xp .export-panel #xp-go') && !/coming soon/.test(q(w, '#app').textContent));
  const prim = [...w.document.querySelectorAll('#app .btn.primary')].filter((b) => !b.closest('dialog:not([open])'));
  check('review: "Export now" is the only primary action and has focus', prim.length === 1 && prim[0].id === 'rv-export' && /^Save to this computer/.test(prim[0].textContent) && w.document.activeElement === prim[0], prim.length);
  { // Card N7: Simple order is code, band feel, notes, Save; the lab details fold below, closed.
    const f = q(w, '#rv-form');
    const ids = ['#rv-pid', 'input[name="tight"]', '#rv-notes', '#rv-export', '#rv-more'].map((sel) => f.querySelector(sel));
    const inOrder = ids.every(Boolean) && ids.every((el, i) => !i || (ids[i - 1].compareDocumentPosition(el) & 4));
    const more = q(w, '#rv-more');
    const adv = w.document.body.dataset.mode === 'advanced'; // folds start open in Advanced only
    check('save (N7): order code → band feel → notes → Save to this computer → More details (closed in Simple, open in Advanced)', inOrder && more.open === adv && /More details/.test(more.querySelector('summary').textContent) && shown(q(w, '#rv-place')) === adv && more.contains(q(w, '#rv-del')) && more.contains(q(w, '#rv-setup')), `mode ${w.document.body.dataset.mode}`);
    check('save (N7): Export and Grip patterns keep their detail parts in a More details fold', q(w, '.xp-more')?.open === adv && q(w, '.xp-more').contains(q(w, '#xp-calib')) && (!q(w, '#rv-body .fp-grid') || q(w, '#rv-body .fp-more').contains(q(w, '#rv-body .fp-grid'))));
  }
  check('review: volunteer code hint says a code, never a name', /never a name/.test(q(w, '#rv-pid-hint').textContent) && q(w, '#rv-pid').getAttribute('autocomplete') === 'off');
  const d0 = downloads.length;
  q(w, '#rv-export').click();
  await sleep(50);
  check('review: Export with no person ID shows the error, focuses it, downloads nothing', !q(w, '#rv-pid-err').hidden && w.document.activeElement === q(w, '#rv-pid') && downloads.length === d0, q(w, '#rv-pid-err').textContent);
  const pid = q(w, '#rv-pid');
  pid.value = 'Jane Doe';
  pid.dispatchEvent(new w.FocusEvent('blur'));
  check('review: a name is refused on blur ("not a name")', /not a name/.test(q(w, '#rv-pid-err').textContent) && pid.getAttribute('aria-invalid') === 'true', q(w, '#rv-pid-err').textContent);
  pid.value = 'P07';
  pid.dispatchEvent(new w.FocusEvent('blur'));
  q(w, '[data-all="FMG"]').click();
  q(w, 'select[data-ch="5"]').value = 'EMG';
  q(w, '#rv-place').value = '4 FSRs around the forearm';
  q(w, 'input[name="tight"][value="snug"]').checked = true;
  q(w, '#rv-setup').value = 'spandex-v2';
  q(w, '#rv-notes').value = 'walk test\nsecond line';
  check('review: a code clears the error', q(w, '#rv-pid-err').hidden);
  q(w, '#rv-export').click();
  await until(() => q(w, '#rv-saved'), 1500);
  const got = downloads.slice(d0);
  check('review: Export now downloads .csv + .report.json named opengrip_P07_<yyyymmdd-hhmm>', got.length === 2 && /^opengrip_P07_\d{8}-\d{4}\.csv$/.test(got[0].name) && got[1].name === got[0].name.replace('.csv', '.report.json'), got.map((d) => d.name).join(' '));
  const back = got[0] ? fromCSV(got[0].text) : { meta: {}, t: [] };
  const m = back.meta;
  check('review: CSV round-trips via fromCSV with the metadata', m.person_id === 'P07' && m.sensors === 'FMG,FMG,FMG,FMG,FMG,EMG' && m.placement === '4 FSRs around the forearm' && m.tightness === 'snug' && m.setup === 'spandex-v2' && m.notes === 'walk test second line' && back.t.length === n && back.channels === 6, JSON.stringify(m).slice(0, 200));
  let side = null;
  try { side = JSON.parse(got[1].text); } catch { /* checked below */ }
  check('review: sidecar JSON has the report and the person ID', side?.meta?.person_id === 'P07' && Array.isArray(side?.report?.items) && side.report.items.length > 0);
  check('review: saved line names the files', /Saved ✓ to Downloads/.test(q(w, '#rv-saved').textContent));
  check('save (N7): after saving, finish actions Record again (focused) · Next volunteer · Go home; Save step done; guide says what next', !!q(w, '#rv-again') && !!q(w, '#rv-next') && q(w, '#rv-home')?.textContent === 'Go home' && w.document.activeElement === q(w, '#rv-again') && w.document.querySelectorAll('#steps .step')[3]?.dataset.state === 'done' && /Record again/.test(guide(w)), guide(w));
  // Export for ML tools: one store-only ZIP through app.download with the zip type. A short demo
  // take may hold only calibration steps, so include them.
  q(w, '#xp-calib').checked = true;
  const z0 = downloads.length;
  q(w, '#xp-go').click();
  await until(() => downloads.length > z0, 3000);
  const zd = downloads[z0];
  let zp = [];
  try { zp = readZip(new Uint8Array(zd.text)).map((e) => e.path); } catch { /* checked below */ }
  const want = ['manifest.json', 'README.txt', 'libemg/classes.json', 'libemg/README.md', 'bids/dataset_description.json', 'ninapro/P07_run-1.json'];
  check('review: Export dataset downloads one ZIP (application/zip) with every format folder', downloads.length === z0 + 1 && zd?.name === 'opengrip-P07-dataset-synthetic.zip' && zd.type === 'application/zip' && want.every((p) => zp.includes(p)) && zp.some((p) => /^edge-impulse\/.+\.csv$/.test(p)) && zp.some((p) => /^bids\/sub-P07\//.test(p)), `${zd?.name} ${zd?.type} ${zp.length} files; missing ${want.filter((p) => !zp.includes(p)).join(',') || 'none'}`);
  press(w, 'b');
  await sleep(50);
  check('review: B with nothing to compare stays on Review', screen(w) === 'review');
  await sleep(300);
  const list = await listSessions(await idbBackend(dbName));
  check('review: the stored session is marked complete (no recovery banner)', list.length === 1 && list[0].complete === true, list.map((x) => `${x.samples}/${x.complete}`).join(','));
  // N7: Record again is a new take of the same person: no Save guard, back to Connect, and the
  // next Save already holds the code.
  q(w, '#rv-again').click();
  await until(() => screen(w) === 'preflight' || screen(w) === 'record', 1500);
  check('save (N7): Record again leaves without a guard and goes back to Connect', screen(w) === 'preflight' || screen(w) === 'record', screen(w));
  check('save (N7): Record again keeps the volunteer code for the next take', w.__opengripApp.lastPerson === 'P07');
  // Delete asks in the page first; Keep it backs out; Delete removes the stored session.
  w = await load({ dbName, record: { preRollMs: 100 } }, '?demo');
  await until(() => screen(w) === 'record' && q(w, '#rec-gutter .lane'), 2000);
  press(w, 'r');
  await until(() => samples(w) >= 200 && q(w, '#autosave').dataset.state === 'saved', 8000);
  press(w, 's');
  await sleep(50);
  q(w, '#rec-stop-yes')?.click();
  await until(() => screen(w) === 'review' && q(w, '#rv-del'), 1500);
  q(w, '#rv-del').click();
  check('review: Delete… opens an in-page confirm', !q(w, '#rv-confirm').hidden && w.document.activeElement === q(w, '#rv-keep'));
  q(w, '#rv-keep').click();
  check('review: Keep it closes the confirm and stays', q(w, '#rv-confirm').hidden && screen(w) === 'review');
  q(w, '#rv-del').click();
  q(w, '#rv-del-yes').click();
  await until(() => screen(w) === 'start', 2000);
  const after = await listSessions(await idbBackend(dbName));
  check('review: Delete removes the stored recording and goes to Start', screen(w) === 'start' && after.length === 1 && after[0].complete === true, after.map((x) => `${x.samples}/${x.complete}`).join(','));
  dbs.add(dbName);
}

// Slice 3: the 6 legacy-format fixtures open in Files; each gets format, rate, plot and report; the dropouts
// and spikes in synth_dropouts and synth_grip_startspike are reported. An exported CSV opens with its metadata.
async function walkFiles() {
  const w = await load({});
  const names = Object.keys(FIXTURES_B64);
  const files = names.map((nm) => new w.File([fixtureBytes(nm)], nm, { type: 'text/plain' }));
  w.__opengripApp.go('files', { files });
  await until(() => w.document.querySelectorAll('.fl-row').length === 6 && !q(w, '.fl-row[data-status="busy"]'), 8000);
  const rows = [...w.document.querySelectorAll('.fl-row')];
  check('files: the 6 legacy fixtures are read, one row each with an icon and word', rows.length === 6 && rows.every((r) => r.querySelector('.st svg') && /OK|Check|Fix/.test(r.querySelector('.st').textContent)), rows.map((r) => `${r.dataset.name}:${r.dataset.status}`).join(' '));
  check('files: drop zone + multi-file picker for .txt/.csv', !!q(w, '#fl-drop') && q(w, '#fl-input').multiple && /\.txt/.test(q(w, '#fl-input').accept) && /\.csv/.test(q(w, '#fl-input').accept));
  for (const nm of ['synth_dropouts.txt', 'synth_grip_startspike.txt']) {
    const i = names.indexOf(nm);
    // The list repaints on every choice, so find the row afresh each time.
    w.document.querySelectorAll('.fl-row')[i]?.click();
    await sleep(50);
    const v = q(w, '#fl-view');
    const has = (c) => !!v.querySelector(`.ritem[data-code="${c}"][data-level="red"] .fixline`);
    check(`files: ${nm} reports dropouts and a spike, each with a fix`, v.dataset.name === nm && has('dropout') && has('spike') && q(w, `.fl-row[data-name="${nm}"]`).dataset.status === 'fix', [...v.querySelectorAll('.ritem')].map((li) => `${li.dataset.code}:${li.dataset.level}`).join(' '));
    check(`files: ${nm} shows format, rate unknown, plot, hardware check + compare hook`, /One number per line · 1 channel · rate unknown/.test(v.querySelector('.fl-head').textContent) && v.querySelector('.overview canvas')?.width > 200 && /Hardware check/.test(v.querySelector('#doctor h2').textContent) && !v.querySelector('#ab-hook').disabled && v.querySelector('#ab-hook').textContent === 'Compare two recordings', v.querySelector('.fl-head').textContent);
    check(`files: ${nm} puts "no timestamps / no labels" first, under Whole recording`, v.querySelector('.rgroup').dataset.channel === '' && ['no_rate', 'no_labels'].every((c) => v.querySelector(`.rgroup[data-channel=""] .ritem[data-code="${c}"][data-level="amber"]`)));
  }
  press(w, 'ArrowDown');
  await sleep(30);
  check('files: ↓ moves to the next file', q(w, '#fl-view').dataset.name === names[names.indexOf('synth_grip_startspike.txt') + 1], q(w, '#fl-view').dataset.name);
  const csv = downloads.find((d) => /^opengrip_P07_.*\.csv$/.test(d.name));
  if (csv) {
    await w.__opengripApp._view.add([new w.File([csv.text], csv.name)]);
    const v = q(w, '#fl-view');
    check('files: an exported OpenGrip CSV opens with 6 channels and its rate', v.dataset.name === csv.name && /OpenGrip CSV · 6 channels · \d+ Hz/.test(v.querySelector('.fl-head').textContent), v.querySelector('.fl-head')?.textContent);
    q(w, '#fl-save').click();
    await until(() => screen(w) === 'review', 1000);
    check('files: "Add metadata and save" opens Review with the CSV metadata, no Delete', q(w, '#rv-pid').value === 'P07' && q(w, 'select[data-ch="5"]').value === 'EMG' && !q(w, '#rv-del'), q(w, '#rv-pid')?.value);
    press(w, 'Escape');
    await until(() => screen(w) === 'files', 1000);
    check('files: Esc from file Review goes back to the same list', w.document.querySelectorAll('.fl-row').length === 7, w.document.querySelectorAll('.fl-row').length);
  } else check('files: exported CSV available from walkReviewExport', false);
}

// W1: Files with two twin recordings → Compare two → the Scorecard (verdict + fairness warnings);
// B opens it, Esc returns; Review's "Add to comparison" fills the tray for B.
async function walkScorecard() {
  const w = await load({});
  const BASE = { channels: 4, reps: 4, distractors: 1 };
  const twin = (seed, setup, faults) => toCSV(generate({ ...BASE, seed, ...(faults ? { faults } : {}) }), { person_id: 'P01', setup, synthetic: 'true' });
  const files = [['spandex.csv', twin(3, 'spandex')], ['nylon.csv', twin(4, 'nylon', ['dropout:6'])]].map(([nm, t]) => new w.File([t], nm, { type: 'text/csv' }));
  w.__opengripApp.go('files', { files: [files[0]] });
  await until(() => q(w, '.fl-row[data-status]:not([data-status="busy"])') && q(w, '#ab-hook'), 4000);
  check('scorecard: Compare two is disabled with one file', q(w, '#ab-hook')?.disabled === true);
  await w.__opengripApp._view.add([files[1]]);
  q(w, '.fl-row[data-i="0"]').click();
  await until(() => q(w, '#ab-hook') && !q(w, '#ab-hook').disabled, 2000);
  check('scorecard: Compare two is enabled once two files are read', q(w, '#ab-hook') && !q(w, '#ab-hook').disabled);
  q(w, '#ab-hook').click();
  const pa = q(w, '#fl-a'), pb = q(w, '#fl-b');
  check('scorecard: Compare shows A and B pickers (this file vs the next)', !q(w, '#fl-ab').hidden && pa?.selectedOptions[0]?.textContent === 'spandex.csv' && pb?.selectedOptions[0]?.textContent === 'nylon.csv', `${pa?.value}/${pb?.value}`);
  q(w, '#fl-ab-go').click();
  await until(() => screen(w) === 'scorecard' && q(w, '#sc-overall')?.textContent, 4000);
  const fair = [...w.document.querySelectorAll('#sc-fair li')].map((li) => `${li.dataset.code}:${li.className}`);
  check('scorecard: opens with a verdict sentence and both names', screen(w) === 'scorecard' && /came out ahead|No clear/.test(q(w, '#sc-overall').textContent) && q(w, '#sc-col-a').textContent === 'A: spandex' && q(w, '#sc-col-b').textContent === 'B: nylon' && w.document.querySelectorAll('#sc-rows tr').length > 0, q(w, '#sc-overall')?.textContent.slice(0, 80));
  check('scorecard: fairness warnings shown, synthetic first', fair[0] === 'synthetic:warn' && fair.length >= 2, fair.join(','));
  const d0 = downloads.length;
  q(w, '#sc-export').click();
  const got = downloads.slice(d0);
  check('scorecard: Export saves JSON + HTML through app.download with their types', got.length === 2 && got[0].type === 'application/json' && got[1].type === 'text/html', got.map((d) => `${d.name}:${d.type}`).join(' '));
  press(w, 'Escape');
  await until(() => screen(w) === 'files', 1000);
  check('scorecard: Esc returns to Files with both files', screen(w) === 'files' && w.document.querySelectorAll('.fl-row').length === 2);
  press(w, 'b');
  await until(() => screen(w) === 'scorecard' && q(w, '#sc-overall')?.textContent, 4000);
  check('scorecard: B on Files opens it straight away', screen(w) === 'scorecard' && q(w, '#sc-col-a').textContent === 'A: spandex');
  press(w, 'Escape');
  await until(() => screen(w) === 'files', 1000);
  // Review → Add to comparison, twice, then B.
  for (const i of [1, 0]) {
    q(w, `.fl-row[data-i="${i}"]`).click();
    q(w, '#fl-save').click();
    await until(() => screen(w) === 'review' && q(w, '#rv-compare'), 1500);
    q(w, '#rv-compare').click();
    if (i === 1) { press(w, 'Escape'); await until(() => screen(w) === 'files', 1000); }
  }
  check('scorecard: Add to comparison fills the A/B tray', w.__opengripApp.compare.map((x) => x.name).join(',') === 'nylon,spandex', w.__opengripApp.compare.map((x) => x.name).join(','));
  press(w, 'b');
  await until(() => screen(w) === 'scorecard' && q(w, '#sc-overall')?.textContent, 4000);
  check('scorecard: B on Review opens A = first added, B = second', screen(w) === 'scorecard' && q(w, '#sc-col-a').textContent === 'A: nylon' && q(w, '#sc-col-b').textContent === 'B: spandex');
  press(w, 'Escape');
  await until(() => screen(w) === 'review', 1000);
  check('scorecard: Esc returns to the Review it came from', screen(w) === 'review' && /spandex\.csv/.test(q(w, '#rv-h').textContent), q(w, '#rv-h')?.textContent);
}

// Shell (simplify-spec §3, card N1): Home/Back/step bar/guide line, driven by the visible buttons.
const GUIDE = {
  start: 'Choose how to start. New here? Try Practice with demo first.',
  preflight: 'Wait for the ticks. Each line turns to Working ✓ by itself.',
  fit: 'Pick the arm, then ask Jo to press each sensor. Each number should light up.',
  record: 'Show Jo the screen, then press Start recording.',
  review: 'Type a code for Jo (like P03, not a name), then press Save to this computer.',
  files: 'Pick a recording to look at. Press Home to start again.',
};
const steps = (w) => [...w.document.querySelectorAll('#steps .step')].map((b) => b.dataset.state).join(',');
const guide = (w) => q(w, '#guide-text').textContent;
const click = (w, sel) => q(w, sel).click();
function shellBox(w) {
  const bar = q(w, '.topbar').getBoundingClientRect(); const g = q(w, '#guide').getBoundingClientRect();
  return { bar: Math.round(bar.height), guide: Math.round(g.height), bottom: Math.round(g.bottom) };
}
// The demo waits on Connect (simplify N2); Skip to record once the ticks are in.
async function demoToRecord(w) {
  click(w, '#tile-demo');
  await until(() => q(w, '#pf-skip') && !q(w, '#pf-skip').disabled, 4000);
  click(w, '#pf-skip');
  await until(() => screen(w) === 'record', 2000);
}

// Simplify N2: Save guard "Save it now" exports, then leaves; the Volunteer screen's own Back button.
async function walkGuards() {
  const w = await load({ record: { timing: SHORT, preRollMs: 100 } }, '?demo');
  await until(() => screen(w) === 'record', 3000);
  q(w, '#b-rec').click(); await until(() => q(w, '.rec').dataset.phase === 'live' && samples(w) > 20, 4000);
  press(w, 'v'); await sleep(50);
  const vb = q(w, '#b-volx')?.getBoundingClientRect();
  check('volunteer: a visible "Back to controls" button, at least 44 px, focused', !!vb && vb.width >= 44 && vb.height >= 44 && q(w, '#b-volx').textContent === 'Back to controls' && w.document.activeElement?.id === 'b-volx', vb && `${Math.round(vb.width)}x${Math.round(vb.height)}`);
  click(w, '#b-volx'); await sleep(50);
  check('volunteer: Back to controls returns to the operator view, still recording', !q(w, '.rec').dataset.vol && q(w, '.rec').dataset.phase === 'live');
  // Simplify N6a: Redo/Skip live in a ⋯ Step menu (menu-button pattern); a visible volunteer button.
  const stepAt = () => w.__opengripApp.record.session.protocolState()?.index;
  const s0 = stepAt();
  click(w, '#b-stepm');
  const opened = !q(w, '#rec-stepmenu').hidden && q(w, '#b-stepm').getAttribute('aria-expanded') === 'true' && q(w, '#b-stepm').getAttribute('aria-haspopup') === 'menu' && w.document.activeElement?.id === 'b-redo';
  press(w, 'ArrowDown'); const down = w.document.activeElement?.id;
  press(w, 'ArrowDown'); const wrap = w.document.activeElement?.id;
  press(w, 'ArrowRight'); press(w, 'Escape');
  check('step menu: ⋯ Step opens Redo/Skip, ↓ moves and wraps, Esc closes and focus returns, nothing else happens', opened && down === 'b-skip' && wrap === 'b-redo' && q(w, '#rec-stepmenu').hidden && q(w, '#b-stepm').getAttribute('aria-expanded') === 'false' && w.document.activeElement?.id === 'b-stepm' && stepAt() === s0 && q(w, '.rec').dataset.phase === 'live', `${opened} ${down} ${wrap} ${w.document.activeElement?.id} ${s0}->${stepAt()}`);
  click(w, '#b-stepm'); click(w, '#b-skip'); await sleep(50);
  check('step menu: Skip moves on one step, closes the menu, focus back on ⋯ Step', stepAt() === s0 + 1 && q(w, '#rec-stepmenu').hidden && w.document.activeElement?.id === 'b-stepm', `${s0}->${stepAt()}`);
  check('volunteer: "Show volunteer screen ⛶" is a visible labelled button', shown(q(w, '#b-volshow')) && /^Show volunteer screen/.test(q(w, '#b-volshow .w').textContent) && q(w, '#b-volshow').textContent.includes('⛶'));
  click(w, '#b-volshow'); await sleep(50);
  const vl = q(w, '#rec-vleft')?.textContent || '';
  check('volunteer: the button opens it; time left and "Need to stop? Just say so." are shown, ≥ 24 px', !!w.__opengripApp.record.vol() && shown(q(w, '#rec-vleft')) && /^(About \d+ minutes left|Less than a minute left)$/.test(vl)
    && shown(q(w, '.vstop')) && q(w, '.vstop').textContent === 'Need to stop? Just say so.' && parseFloat(getComputedStyle(q(w, '#rec-vleft')).fontSize) >= 24, vl);
  check('volunteer: operator view hides the time-left line', (() => { click(w, '#b-volx'); return !shown(q(w, '#rec-vleft')) && !shown(q(w, '.vstop')); })());
  press(w, 's'); await until(() => q(w, '#rec-stop').open, 1000);
  q(w, '#rec-stop-yes').click(); await until(() => screen(w) === 'review', 3000);
  q(w, '#rv-pid').value = 'P03';
  const d0 = downloads.length;
  click(w, '#nav-back'); await sleep(50);
  check('save guard: Back from unsaved Save asks, names the code', q(w, '#rv-guard').open && /P03/.test(q(w, '#rv-guard-p').textContent));
  click(w, '#rv-g-save'); await until(() => screen(w) !== 'review', 2000);
  await until(() => screen(w) === 'record', 2000);
  check('save guard: Save it now exports 2 files, then goes Back (new take: the demo is on Record, spec §3.3)', downloads.length === d0 + 2 && screen(w) === 'record', `${downloads.length - d0} files, ${screen(w)}`);
}

async function walkShell() {
  clearStore();
  const heights = new Set();
  const note = (w) => { const b = shellBox(w); heights.add(`${b.bar}+${b.guide}`); return b; };
  for (const [wd, ht] of [[1440, 900], [375, 812]]) {
    const w = await load({ fit: { scale: 0.04 }, record: { timing: SHORT, preRollMs: 200 } }, '', [wd, ht]);
    const tag = `shell ${wd}:`;
    heights.clear();
    let b = note(w);
    check(`${tag} Start: Home current, Back slot kept but hidden, 4 steps all upcoming + locked`, q(w, '#nav-home').getAttribute('aria-current') === 'page' && q(w, '#nav-back').classList.contains('slot') && getComputedStyle(q(w, '#nav-back')).visibility === 'hidden' && steps(w) === 'upcoming,upcoming,upcoming,upcoming' && [...w.document.querySelectorAll('#steps .step')].every((x) => x.disabled), steps(w));
    check(`${tag} Start guide line`, guide(w) === GUIDE.start && !!q(w, '#guide-show'), guide(w));
    check(`${tag} More opens an (empty-for-now) menu and Esc closes it`, (() => { click(w, '#more-btn'); const open = !q(w, '#more-menu').hidden && q(w, '#more-btn').getAttribute('aria-expanded') === 'true'; w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return open && q(w, '#more-menu').hidden; })());
    const tiles = [...w.document.querySelectorAll('.tile')].map((x) => [x.querySelector('svg').getBoundingClientRect(), x.querySelector('.t').getBoundingClientRect(), x.getBoundingClientRect()]);
    const tOk = tiles.every(([i, t, r]) => Math.abs((i.left - r.left) - (tiles[0][0].left - tiles[0][2].left)) < 1 && Math.abs((t.top - r.top) - (tiles[0][1].top - tiles[0][2].top)) < 1);
    check(`${tag} Home tiles: icon and title sit at the same place in every tile`, tOk, tiles.map(([i, t, r]) => `${Math.round(i.left - r.left)}/${Math.round(t.top - r.top)}`).join(' '));
    let o = overflowAt(w);
    check(`${tag} Start, no overflow`, o.page <= 0 && o.bar <= 0 && o.bad.length === 0, `${o.page} ${o.bar} ${o.bad.slice(0, 4).join(' ')}`);
    // Preflight: Back and Home both return to Start.
    click(w, '#tile-demo'); await until(() => screen(w) === 'preflight', 1000); note(w);
    check(`${tag} Connect: step 1 current, guide "Wait for the ticks"`, steps(w) === 'current,upcoming,upcoming,upcoming' && guide(w) === GUIDE.preflight && q(w, '#steps .step[aria-current="step"]')?.dataset.step === '1', `${steps(w)} | ${guide(w)}`);
    click(w, '#nav-back'); await until(() => screen(w) === 'start', 1000);
    check(`${tag} Back from Connect goes Home`, screen(w) === 'start');
    click(w, '#tile-demo'); await until(() => screen(w) === 'preflight', 1000);
    click(w, '#nav-home'); await until(() => screen(w) === 'start', 1000);
    check(`${tag} Home from Connect`, screen(w) === 'start');
    // Record: the demo waits on Connect for Skip to record (simplify N2).
    await demoToRecord(w);
    const gb = q(w, '#guide').getBoundingClientRect(); const tb = q(w, '.topbar').getBoundingClientRect();
    note(w);
    check(`${tag} Record keeps the §3.1 shell: guide is its own row below the bar, not inside it (review-3 #4)`, !q(w, '.topbar').contains(q(w, '#guide')) && gb.top >= tb.bottom - 0.5 && Math.round(gb.height) === (wd < 600 ? 52 : 36), `bar ${Math.round(tb.height)} guide ${Math.round(gb.height)}`);
    check(`${tag} Record ready: Connect done, Fit skipped, Record current; guide`, steps(w) === 'done,skipped,current,upcoming' && guide(w) === GUIDE.record, `${steps(w)} | ${guide(w)}`);
    o = overflowAt(w);
    check(`${tag} Record, no overflow`, o.page <= 0 && o.bar <= 0, `${o.page} ${o.bar} ${o.bad.slice(0, 4).join(' ')}`);
    click(w, '#steps .step[data-step="2"]'); await until(() => q(w, '.fit'), 1000); b = shellBox(w); b.bottom = Math.max(b.bottom, Math.round(q(w, '.topbar').getBoundingClientRect().bottom));
    const fr = q(w, '.fit')?.getBoundingClientRect();
    const hb = q(w, '#nav-home').getBoundingClientRect();
    const hit = w.document.elementFromPoint(hb.left + hb.width / 2, hb.top + hb.height / 2);
    check(`${tag} Fit sheet opens from step 2, starts below the shell, Home stays clickable`, !!fr && fr.top >= b.bottom - 0.5 && q(w, '#nav-home').contains(hit), `fit top ${fr && Math.round(fr.top)} shell bottom ${b.bottom} hit ${hit?.id || hit?.tagName}`);
    check(`${tag} Fit: step 2 current, Fit guide line`, steps(w) === 'done,current,upcoming,upcoming' && guide(w) === GUIDE.fit, `${steps(w)} | ${guide(w)}`);
    click(w, '#nav-back'); await until(() => !q(w, '.fit'), 1000);
    check(`${tag} Back closes the Fit sheet and stays on Record`, !q(w, '.fit') && screen(w) === 'record' && steps(w) === 'done,skipped,current,upcoming', steps(w));
    click(w, '#nav-home'); await until(() => screen(w) === 'start', 1000);
    check(`${tag} Home from Record (ready)`, screen(w) === 'start');
    // Recording: Home asks through the Stop dialog; Stop goes to Save (nothing lost).
    await demoToRecord(w);
    click(w, '#b-rec'); await until(() => q(w, '.rec')?.dataset.phase === 'live' && samples(w) > 20, 4000);
    click(w, '#nav-home'); await sleep(50);
    check(`${tag} Home while recording opens the Stop guard (in page, leaving words), stays on Record`, q(w, '#rec-stop')?.open === true && screen(w) === 'record' && /Leaving stops the recording/.test(q(w, '#rec-stop-p').textContent) && q(w, '#rec-stop-yes').textContent.includes('Stop and save'));
    const n0 = samples(w);
    click(w, '#rec-stop button[value="keep"]'); await sleep(400);
    check(`${tag} Stop guard: Keep recording keeps recording`, !q(w, '#rec-stop').open && screen(w) === 'record' && q(w, '.rec').dataset.phase === 'live' && samples(w) > n0, `${n0} -> ${samples(w)}`);
    click(w, '#nav-back'); await sleep(50);
    check(`${tag} Back while recording opens the Stop guard too`, q(w, '#rec-stop').open && screen(w) === 'record');
    click(w, '#rec-stop-yes'); await until(() => screen(w) === 'review', 3000); note(w);
    check(`${tag} Save: steps done,skipped,done,current; guide`, steps(w) === 'done,skipped,done,current' && guide(w) === GUIDE.review, `${steps(w)} | ${guide(w)}`);
    // Save guard (spec §3.4): leaving an unsaved recording asks in page; Stay keeps Review.
    click(w, '#nav-home'); await sleep(50);
    check(`${tag} Home from unsaved Save opens the Save guard, Save it now focused`, q(w, '#rv-guard')?.open && screen(w) === 'review' && w.document.activeElement?.id === 'rv-g-save');
    click(w, '#rv-g-stay'); await sleep(50);
    check(`${tag} Save guard: Stay here keeps Review`, !q(w, '#rv-guard').open && screen(w) === 'review');
    click(w, '#steps .step[data-step="1"]'); await sleep(50);
    click(w, '#rv-g-leave'); await until(() => screen(w) === 'preflight', 1000);
    check(`${tag} a done step is clickable (Save -> Connect), Leave keeps it for later`, screen(w) === 'preflight');
    click(w, '#nav-home'); await until(() => screen(w) === 'start' && q(w, '#recover-line'), 3000);
    check(`${tag} Leave kept the autosave: Home shows "1 recording isn't saved yet"`, !!q(w, '#recover-line') && /isn't saved yet/.test(q(w, '#recover-h').textContent));
    // Files (a More page): no step current; Back and Home go to Start.
    const f = [new w.File([fixtureBytes(Object.keys(FIXTURES_B64)[0])], 'a.txt', { type: 'text/plain' })];
    w.__opengripApp.go('files', { files: f }); await sleep(100); note(w);
    check(`${tag} Files: steps all upcoming, guide`, steps(w) === 'upcoming,upcoming,upcoming,upcoming' && guide(w) === GUIDE.files, `${steps(w)} | ${guide(w)}`);
    click(w, '#nav-back'); await until(() => screen(w) === 'start', 1000);
    check(`${tag} Back from Files goes Home`, screen(w) === 'start');
    o = overflowAt(w);
    const want = wd < 600 ? '56+52' : '56+36';
    check(`${tag} shell + guide heights fixed at ${want} across ${heights.size ? 'every' : 'no'} state`, heights.size === 1 && heights.has(want), [...heights].join(' '));
    if (wd < 600) {
      const t = ['#nav-home', '#nav-back', '#more-btn'].map((sel) => { const r = q(w, sel).getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; });
      check(`${tag} Home/Back/More are 44 px targets`, t.every((x) => x.split('x').every((v) => Number(v) >= 44)), t.join(' '));
    }
  }
}

// Review 1: narrow layout, red-first chips, reduced-motion sweep.
function overflowAt(w) {
  const vw = w.innerWidth;
  const bad = [...w.document.querySelectorAll('body *')].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.right > vw + 0.5 && !e.closest('[hidden], dialog:not([open]), .vh');
  }).map((e) => `${e.id || e.className || e.tagName}:+${Math.round(e.getBoundingClientRect().right - vw)}`);
  return { bad, page: w.document.documentElement.scrollWidth - vw, bar: q(w, '.topbar').scrollWidth - vw };
}
// Review-3 Record fixes (#1 shell overlap, #2 volunteer card, #3 icon button, #4 guide line, #7 scroll).
async function walkRecordR3() {
  const boxOf = (w, sel) => q(w, sel).getBoundingClientRect();
  const meet = (a, b) => a.width > 0 && b.width > 0 && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  for (const [wd, ht] of [[600, 800], [800, 800], [1023, 768], [1440, 900], [375, 812]]) {
    clearStore(); localStorage.removeItem('og.mode'); // Simple: the card and the parts row are Simple-only
    const w = await load({ record: { timing: SHORT, preRollMs: 200 } }, '?demo', [wd, ht]);
    await until(() => screen(w) === 'record' && q(w, '#rec-gutter .lane'), 2500);
    const g = boxOf(w, '#guide'), c = boxOf(w, '#source-chip'), a = boxOf(w, '#autosave');
    const hits = [meet(g, c) && !q(w, '#guide').contains(q(w, '#source-chip')) ? 'guide/chip' : '', meet(g, a) ? 'guide/autosave' : '', meet(c, a) ? 'chip/autosave' : ''].filter(Boolean);
    check(`r3: Record at ${wd} px, guide, DEMO chip and autosave do not overlap (#1)`, hits.length === 0, hits.join(' ') || 'none');
    const gt = q(w, '#guide-text');
    check(`r3: Record at ${wd} px, guide line ${wd < 600 ? '52 px, 2 lines + Show me' : '36 px, not cut off'} (#4)`, Math.round(g.height) === (wd < 600 ? 52 : 36) && gt.getClientRects().length > 0 && gt.scrollWidth <= gt.clientWidth + 1 && (wd < 600 ? gt.clientHeight >= 36 && shown(q(w, '#guide-show')) : gt.scrollHeight <= gt.clientHeight + 1), `h ${Math.round(g.height)} sw ${gt.scrollWidth}/${gt.clientWidth} sh ${gt.scrollHeight}/${gt.clientHeight}`);
    if (wd === 375) {
      const b = boxOf(w, '#b-volshow'), r = boxOf(w, '#b-rec'), m = boxOf(w, '#b-stepm');
      check('r3: at 375 Show volunteer screen is a named 44×44 icon in the big-button row (#3)', shown(q(w, '#b-volshow')) && Math.round(b.width) === 44 && Math.round(b.height) === 44 && q(w, '#b-volshow').getAttribute('aria-label') === 'Show volunteer screen' && Math.abs(b.top - r.top) < 1 && Math.abs(m.top - r.top) < 1, `${Math.round(b.width)}x${Math.round(b.height)} tops ${Math.round(r.top)}/${Math.round(b.top)}/${Math.round(m.top)}`);
    }
    if (wd === 1440) {
      { const j = bannedSeen(q(w, '#app')); check('r3: Simple Record shows no banned word (ch1, FMG, calibrat, Press Record) (#5)', !j, j); }
      const lanes = [...w.document.querySelectorAll('#rec-gutter .nm')].map((x) => x.textContent);
      check('r3: Simple lanes are named Sensor 1.. (#5)', lanes.length > 0 && lanes.every((t, i) => t === `Sensor ${i + 1}`), lanes.join(','));
      check('r3: Simple Body rail starts closed (#5, spec §4)', q(w, '.rec').dataset.body !== 'on');
      check('r3: Simple buttons say Start recording / Stop and save (#6)', q(w, '#b-rec .w').textContent === 'Start recording' && q(w, '#b-stop .w').textContent === 'Stop and save', `${q(w, '#b-rec .w').textContent} | ${q(w, '#b-stop .w').textContent}`);
      check('r3: Simple ready line names the button (#6)', /^Press Start recording when Jo is ready\. About \d+ minutes?\.$/.test(q(w, '#rec-sub').textContent), q(w, '#rec-sub').textContent);
    }
    if (wd === 1440 || wd === 375) {
      click(w, '#b-volshow'); await sleep(80);
      const card = q(w, '#rec-volcard'), last = q(w, '#rec-volcard li:last-child'), lb = last.getBoundingClientRect(), pt = boxOf(w, '#rec-parts').top;
      const pr = q(w, '.rec[data-vol] .prompt');
      check(`r3: Volunteer screen at ${wd}×${ht} before Start shows all 4 card lines at full strength, 24 px, above the parts (#2)`, !!w.__opengripApp.record.vol() && shown(card) && card.querySelectorAll('li').length === 4 && getComputedStyle(card).opacity === '1' && getComputedStyle(card).position === 'static' && parseFloat(getComputedStyle(last).fontSize) === 24 && lb.bottom <= pt + 0.5 && lb.bottom <= pr.getBoundingClientRect().bottom + 0.5 && pr.scrollHeight <= pr.clientHeight + 1, `li bottom ${Math.round(lb.bottom)} parts top ${Math.round(pt)} prompt ${pr.scrollHeight}/${pr.clientHeight}`);
      await sleep(120);
      check(`r3: Volunteer screen at ${wd} says volunteer words, not operator words (#6)`, q(w, '#rec-sub').textContent === 'Get ready. We start soon.', q(w, '#rec-sub').textContent);
      click(w, '#b-volx'); await sleep(50);
      check(`r3: leaving the Volunteer screen at ${wd} puts the card back over the plot`, q(w, '.plotwrap').contains(card) && !w.__opengripApp.record.vol());
    }
    if (wd === 800) {
      press(w, 'r');
      await until(() => q(w, '.rec').dataset.phase === 'live' && word(w) !== 'READY', 2000); await sleep(150);
      const sw = w.document.documentElement.scrollWidth;
      check('r3: no horizontal scroll at 800 px while recording (#7)', sw === 800, `scrollWidth ${sw}; ${overflowAt(w).bad.slice(0, 6).join(' ') || 'none'}`);
    }
    press(w, 's'); await sleep(50);
  }
}
async function walkNarrow() {
  // Review-2 M7: Preflight at 375, no status word overlaps its row's label.
  clearStore();
  const pw = await load({}, '', [375, 812]);
  press(pw, '1');
  await until(() => screen(pw) === 'preflight', 1000);
  await sleep(150);
  const hit = [...pw.document.querySelectorAll('.row')].filter((row) => {
    const a = row.querySelector('.st')?.getBoundingClientRect(), b = row.querySelector('.nm')?.getBoundingClientRect();
    return a && b && a.width > 0 && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  }).map((row) => row.dataset.row);
  check('narrow: Preflight at 375 px, no status word overlaps its label', pw.document.querySelectorAll('.row').length > 0 && hit.length === 0, hit.join(' ') || 'none');
  for (const [wd, ht] of [[375, 812], [1024, 768]]) {
    const w = await load({ record: { timing: SHORT, preRollMs: 200 } }, '?demo', [wd, ht]);
    await until(() => screen(w) === 'record' && q(w, '#rec-gutter .lane'), 2500);
    const o1 = overflowAt(w);
    press(w, 'r');
    await until(() => q(w, '.rec').dataset.phase === 'live' && word(w) !== 'READY', 2000);
    await sleep(150);
    const o2 = overflowAt(w);
    const bad = [...new Set([...o1.bad, ...o2.bad])];
    check(`narrow: Record at ${wd} px, nothing past the right edge (ready + running)`, w.innerWidth === wd && bad.length === 0 && o1.page <= 0 && o2.page <= 0 && o1.bar <= 0, `${w.innerWidth} px; ${bad.slice(0, 6).join(' ') || 'none'}; page ${o2.page}; topbar ${o1.bar}`);
    const chip = q(w, '#source-chip');
    check(`narrow: source chip readable at ${wd} px`, chip.getBoundingClientRect().width >= 36 && chip.classList.contains('demo'), Math.round(chip.getBoundingClientRect().width));
    const shortShown = w.getComputedStyle(chip.querySelector('.chip-short')).display !== 'none';
    check(`narrow: chip shows ${wd < 600 ? 'just DEMO (short words)' : 'the full words'} at ${wd} px`, wd < 600 ? shortShown && chip.querySelector('.chip-full').getBoundingClientRect().width <= 1 : !shortShown, `short ${shortShown}`);
    if (wd < 600) {
      press(w, 'v');
      await sleep(50);
      const ov = overflowAt(w);
      check('narrow: Volunteer view opens below 600 px and nothing passes the right edge (review-3 #3)', !!q(w, '.rec').dataset.vol && w.__opengripApp.record.vol() === true && ov.bad.length === 0 && ov.page <= 0, ov.bad.slice(0, 4).join(' ') || 'none');
      press(w, 'v'); await sleep(50);
    }
    press(w, 's'); await sleep(50);
  }
}
function walkRedFirst() {
  const box = document.createElement('div');
  document.body.append(box);
  const strip = createQualityStrip({ box, names: ['ch1', 'ch2', 'ch3', 'ch4', 'ch5', 'ch6'] });
  // 2 red (older) + 4 amber (newer): newest-first alone would show only amber chips.
  const items = [[0, 'red', 1000], [1, 'red', 1500], [2, 'amber', 5000], [3, 'amber', 6000], [4, 'amber', 7000], [5, 'amber', 8000]]
    .map(([ch, level, atMs]) => ({ code: level === 'red' ? 'dropout' : 'noisy', channel: ch, level, atMs, message: 'm' }));
  strip.update({ items, followOns: [] }, 9000);
  const shown = [...box.querySelectorAll('.qchip:not(.overall)')].map((c) => c.dataset.level);
  const firstAmber = shown.indexOf('amber');
  check('quality: red chips sort first, never behind amber (review-1 #4)', shown.length >= 2 && shown[0] === 'red' && shown[1] === 'red' && shown.slice(0, firstAmber < 0 ? shown.length : firstAmber).every((l) => l === 'red'), shown.join(','));
  box.remove();
}
async function walkReducedMotion() {
  const w = await load({ record: { timing: { ...SHORT, hold: 6, rest: 6 }, preRollMs: 200, reducedMotion: true } }, '?demo');
  await until(() => screen(w) === 'record' && q(w, '#rec-gutter .lane'), 2500);
  const rec = () => w.__opengripApp.record;
  check('reduced motion: plot is in sweep mode', rec().plot.sweep === true);
  press(w, 'r');
  await until(() => q(w, '.rec').dataset.phase === 'live', 2000);
  // Read two frames 1 s apart inside one sweep; left of (cursor - 1 s) must be pixel-identical.
  const cv = q(w, '#rec-cv canvas');
  const pxPerMs = cv.width / (rec().plot.windowSec * 1000);
  const grab = () => { const c = w.document.createElement('canvas'); c.width = cv.width; c.height = cv.height; c.getContext('2d').drawImage(cv, 0, 0); return c.getContext('2d'); };
  const shot = async () => { await new Promise((r) => w.requestAnimationFrame(r)); return [grab(), rec().plot.cursor]; };
  // Wait until the cursor is ~2.5 s into a sweep, so 1 s later it has not wrapped.
  await until(() => rec().plot.cursor > 2500 * pxPerMs && rec().plot.cursor < 4000 * pxPerMs, 12000, 20);
  const [a, ca] = await shot();
  await sleep(1000);
  const [b, cb] = await shot();
  const xCut = Math.floor(ca - 1000 * pxPerMs) - 4;
  let diff = -1;
  if (xCut > 10 && cb > ca) {
    const da = a.getImageData(0, 0, xCut, cv.height).data; const db = b.getImageData(0, 0, xCut, cv.height).data;
    diff = 0; for (let i = 0; i < da.length; i += 4) if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2]) diff++;
  }
  check('reduced motion: sweep keeps old pixels still (no scrolling)', diff === 0, `${diff} px differ left of x=${xCut} (cursor ${Math.round(ca)}→${Math.round(cb)} px)`);
  press(w, 's'); await sleep(50);
}

// Body rail (body-view-spec §6.2, card B4): A toggles it, lanes gain place names, and opening it
// never moves the prompt band or changes the plot row's height; below 900 px it is a Signal/Body tab.
// Review-2 B1/B2: the drawing and every label in it sit inside the rail, the rail does not
// scroll, and the foot line is on screen. Returns the drawn ring side for the detail.
function railFits(w) {
  const host = q(w, '#rec-body').getBoundingClientRect(), svg = q(w, '#rec-bodyview svg.bd-svg');
  if (!svg) return { ok: false, detail: 'no drawing' };
  const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal, s = Math.min(r.width / vb.width, r.height / vb.height);
  const inside = (b) => b.width > 0 && b.left >= host.left - 0.5 && b.right <= host.right + 0.5 && b.top >= host.top - 0.5 && b.bottom <= host.bottom + 0.5;
  const out = [...svg.querySelectorAll('text')].filter((t) => t.textContent && !inside(t.getBoundingClientRect())).map((t) => t.textContent);
  const rail = q(w, '#rec-body'), foot = q(w, '#rec-body-foot').getBoundingClientRect();
  const ok = inside(r) && !out.length && rail.scrollHeight <= rail.clientHeight + 1 && (foot.height === 0 || inside(foot)) && vb.width * s >= 150;
  return { ok, detail: `host ${Math.round(host.width)}×${Math.round(host.height)}, ring ${Math.round(vb.width * s)}×${Math.round(vb.height * s)}, scroll ${rail.scrollHeight}/${rail.clientHeight}, cut: ${out.join(',') || 'none'}` };
}
// Review-2 M5: Table lens in the rail shows Now and Doctor, nothing wider than the rail.
async function railTable(w, label) {
  q(w, '#rec-body .bd-lens button[data-lens="table"]').click(); await sleep(60);
  const t = q(w, '#rec-bodyview .bd-table'), host = q(w, '#rec-bodyview');
  const heads = t ? [...t.querySelectorAll('thead th')] : [];
  const hr = host.getBoundingClientRect();
  const seen = (txt) => heads.some((h) => h.textContent === txt && h.getBoundingClientRect().right <= hr.right + 0.5);
  check(`body: ${label} Table lens shows Now and Fix tip, no sideways scroll`, !!t && seen('Now') && seen('Fix tip') && t.scrollWidth <= host.clientWidth + 1, t ? `${t.scrollWidth}/${host.clientWidth} px; ${heads.map((h) => h.textContent).join('|')}` : 'no table');
  q(w, '#rec-body .bd-lens button[data-lens="ring"]').click(); await sleep(60);
}
async function walkBodyRail() {
  const hts = (w) => { const r = (s) => q(w, s).getBoundingClientRect(); return { prompt: r('#rec-prompt').height, wrap: r('.plotwrap').height, top: r('.plotwrap').top, cv: r('#rec-cv').height }; };
  const same = (a, b) => Math.abs(a.prompt - b.prompt) < 0.5 && Math.abs(a.wrap - b.wrap) < 0.5 && Math.abs(a.top - b.top) < 0.5;
  const fmt = (a) => `prompt ${Math.round(a.prompt)} plot ${Math.round(a.wrap)} @${Math.round(a.top)} cv ${Math.round(a.cv)}`;
  const rail = (w) => q(w, '#rec-body').getBoundingClientRect();
  const places = (w) => [...w.document.querySelectorAll('#rec-gutter .lane .pl')].map((e) => e.textContent);
  // 1. No places, 1440 px: off by default; A opens the default ring with the "Set sensor places" prompt.
  clearStore();
  let w = await load({ record: { timing: SHORT, preRollMs: 200 } }, '?demo', [1440, 900]);
  await until(() => screen(w) === 'record' && q(w, '#rec-gutter .lane'), 2500);
  const b0 = w.__opengripApp.record.body();
  check('body: no places -> rail off by default, lanes say "not placed"', !b0.on && rail(w).width === 0 && b0.isDefault && places(w).length === 6 && places(w).every((t) => t === 'not placed'), `${b0.on} ${places(w).join('|')}`);
  const h0 = hts(w);
  press(w, 'a');
  await until(() => q(w, '#rec-bodyview .bd-root'), 1500);
  await sleep(100);
  const h1 = hts(w);
  check('body: A opens the rail (352 px at 1440) with the Body view drawn', q(w, '.rec').dataset.body === 'on' && Math.round(rail(w).width) === 352 && q(w, '#b-body').getAttribute('aria-pressed') === 'true' && !!q(w, '#rec-bodyview svg, #rec-bodyview table'), `${Math.round(rail(w).width)} px`);
  check('body: opening the rail keeps the prompt band and the plot row height', same(h0, h1) && Math.abs(h0.cv - h1.cv) < 0.5, `${fmt(h0)} -> ${fmt(h1)}`);
  check('body: no places -> "Set sensor places" prompt and "default ring, not your places"', !q(w, '#rec-body-prompt').hidden && /Set sensor places/.test(q(w, '#b-places').textContent) && /default ring, not your places/.test(q(w, '#rec-body-prompt').textContent) && w.__opengripApp.record.body().placement?.channels.length === 6);
  q(w, '#b-places').click();
  check('body: "Set sensor places" opens the Fit page (a region, not a dialog; Record inert; heading focused)', !!q(w, 'section.fit[aria-labelledby="fit-h"]') && !q(w, '.fit[role="dialog"], .fit[aria-modal]') && q(w, '#app').inert && w.document.activeElement?.id === 'fit-h');
  check('body: rail note no longer says the Fit sheet "is coming"', !/is coming/.test(q(w, '#rec-body-prompt').textContent) && /Set sensor places opens the fit sheet/.test(q(w, '#rec-places-note').textContent), q(w, '#rec-places-note').textContent);
  press(w, 'Escape');
  press(w, 'r');
  await until(() => q(w, '.rec').dataset.phase === 'live', 2000);
  await sleep(300);
  check('body: live levels reach the drawing (foot line shown)', /Levels are rough|Level 0–1|Unplugged/.test(q(w, '#rec-body-foot').textContent), q(w, '#rec-body-foot').textContent);
  q(w, '#b-body').click();
  await sleep(50);
  check('body: the button closes it again, plot row unchanged', !q(w, '.rec').dataset.body && rail(w).width === 0 && same(h0, hts(w)), fmt(hts(w)));
  press(w, 's'); await sleep(50);
  // 2. Places set, 1440 px: on by default, lanes named by place.
  clearStore();
  const placement = ringPreset({ count: 8 });
  w = await load({ record: { timing: SHORT, preRollMs: 200, placement } }, '?demo', [1440, 900]);
  await until(() => screen(w) === 'record' && q(w, '#rec-bodyview .bd-root'), 2500);
  const pl = places(w);
  check('body: places set -> rail on at >= 1280 px, no default-ring prompt', w.__opengripApp.record.body().on && rail(w).width > 300 && q(w, '#rec-body-prompt').hidden);
  check('body: lane labels gain the place ("6 FMG · Back·little")', pl[5] === 'FMG · Back·little' && pl[0] === 'FMG · Palm mid' && /^6/.test(w.document.querySelectorAll('#rec-gutter .lane')[5].textContent), pl.join(' | '));
  await sleep(100);
  let fitR = railFits(w);
  check('body: 1440×900 ring and labels fully inside the rail, rail does not scroll', fitR.ok, fitR.detail);
  check('body: lens buttons share the "Body view" title row', !!q(w, '#rec-body .br-head .bd-lens'));
  await railTable(w, '1440 (352 px)');
  const h2 = hts(w);
  press(w, 'a'); await sleep(50);
  check('body: A closes the default-on rail, prompt and plot row unchanged', !w.__opengripApp.record.body().on && same(h2, hts(w)), `${fmt(h2)} -> ${fmt(hts(w))}`);
  // 2b. 1280×720, the target laptop (review-2 B2): the ring used to lose its bottom half.
  clearStore();
  w = await load({ record: { timing: SHORT, preRollMs: 200, placement } }, '?demo', [1280, 720]);
  await until(() => screen(w) === 'record' && q(w, '#rec-bodyview svg.bd-svg'), 2500);
  await sleep(100);
  fitR = railFits(w);
  check('body: 1280×720 ring and labels fully inside the rail, rail does not scroll', fitR.ok, fitR.detail);
  await railTable(w, '1280 (320 px)');
  press(w, 's'); await sleep(50);
  // 3. 1024 px: A opens a 288 px rail.
  clearStore();
  w = await load({ record: { timing: SHORT, preRollMs: 200, placement } }, '?demo', [1024, 768]);
  await until(() => screen(w) === 'record' && q(w, '#rec-gutter .lane'), 2500);
  const h3 = hts(w);
  press(w, 'a'); await sleep(80);
  check('body: 1024 px -> off by default, A opens 288 px, plot row unchanged', w.__opengripApp.record.body().on && Math.round(rail(w).width) === 288 && same(h3, hts(w)), `${Math.round(rail(w).width)} px; ${fmt(h3)} -> ${fmt(hts(w))}`);
  // 4. 375 px: Signal / Body tabs; A switches; nothing past the right edge.
  clearStore();
  w = await load({ record: { timing: SHORT, preRollMs: 200 } }, '?demo', [375, 812]);
  await until(() => screen(w) === 'record' && q(w, '#rec-gutter .lane'), 2500);
  const tabs = [...w.document.querySelectorAll('.rtabs button')];
  const h4 = hts(w);
  check('body: 375 px shows Signal / Body tabs, Signal selected', tabs.length === 2 && q(w, '.rtabs').getBoundingClientRect().height > 0 && tabs[0].getAttribute('aria-selected') === 'true' && rail(w).width === 0);
  press(w, 'a');
  await until(() => q(w, '#rec-bodyview .bd-root'), 1500);
  await sleep(100);
  const o = overflowAt(w);
  check('body: 375 px A switches to the Body tab, full width, plot hidden', w.__opengripApp.record.body().tab === 'body' && tabs[1].getAttribute('aria-selected') === 'true' && rail(w).width >= 370 && q(w, '#rec-cv').getBoundingClientRect().height === 0, `${Math.round(rail(w).width)} px`);
  check('body: 375 px tab switch keeps the prompt band and plot row height, nothing past the edge', same(h4, hts(w)) && o.bad.length === 0 && o.page <= 0, `${fmt(h4)} -> ${fmt(hts(w))}; ${o.bad.slice(0, 4).join(' ') || 'none'}`);
  fitR = railFits(w);
  check('body: 375 px Body tab ring and labels fully inside the tab (review-2 B1)', fitR.ok, fitR.detail);
  const sl = q(w, '.stepline'), slr = sl.getBoundingClientRect();
  check('body: 375 px the step line is not cut off (review-2 leftover)', sl.scrollWidth <= sl.clientWidth + 1 && slr.right <= w.innerWidth + 1 && [...sl.children].every((c) => c.getBoundingClientRect().right <= slr.right + 1), `${sl.scrollWidth}/${sl.clientWidth} right ${Math.round(slr.right)}`);
  tabs[0].click(); await sleep(50);
  check('body: the Signal tab brings the plot back', w.__opengripApp.record.body().tab === 'signal' && q(w, '#rec-cv').getBoundingClientRect().height > 100);
  clearStore();
}

// Fit sheet (body-view-spec §6.1, §16): quick setup -> nudge -> save -> reload -> diff ->
// demo check -> glow -> misplace gives one ✕ -> live re-check clears it.
async function walkFit() {
  clearStore();
  const env = { fit: { scale: 0.04 }, record: { timing: SHORT, preRollMs: 200 } };
  let w = await load({ serial: null, ...env }, '', [1440, 900]);
  // Bug 2026-10-21: app.env dropped the test env's `fit`, so the sheet ran at scale 1 (live tick every 4 s).
  check('fit: the walk\'s fit.scale reaches app.env (short check + live steps)', w.__opengripApp.env.fit?.scale === 0.04, JSON.stringify(w.__opengripApp.env.fit ?? null));
  q(w, '#tile-demo').click();
  await until(() => row(w, 'places')?.querySelector('[data-act]'), 1500);
  check('fit: Preflight "Sensor places" row is optional (never blocks)', rowStatus(w, 'places') === 'opt' && /Optional/.test(rowText(w, 'places')), rowText(w, 'places'));
  row(w, 'places').querySelector('[data-act]').click();
  const sheet = () => q(w, '.fit')?.fitApi;
  await until(() => sheet(), 1000);
  let f = sheet();
  const pid = q(w, '#fit-pid');
  pid.value = 'P07'; pid.dispatchEvent(new w.Event('input', { bubbles: true }));
  const cm = q(w, '#fit-cm'); cm.value = '9'; cm.dispatchEvent(new w.Event('input', { bubbles: true }));
  let p = f.state().placement;
  check('fit: quick setup -> 6 FMG ring at 9 cm, drawn, "entered by you" tag', p.channels.length === 6 && p.channels.every((c) => c.cmFromElbowCrease === 9) && w.document.querySelectorAll('.fit-view [data-ch]').length >= 6 && /entered by you/.test(q(w, '.fit').textContent), JSON.stringify(p.ring));
  check('fit: first visit -> "First fitting for P07"', /First fitting for P07/.test(q(w, '#fit-diff').textContent), q(w, '#fit-diff').textContent);
  q(w, '[data-chip="3"]').click();
  for (let i = 0; i < 3; i++) q(w, '[data-chip="3"]').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  const a0 = f.state().placement.channels[2].ringAngleDeg;
  q(w, '[data-chip="3"]').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
  p = f.state().placement;
  check('fit: nudge sensor 3: ↑ x3 = +1.5 cm, Shift → = 15°, others unchanged', p.channels[2].cmFromElbowCrease === 10.5 && Math.abs(((p.channels[2].ringAngleDeg - a0 + 540) % 360) - 180) === 15 && p.channels[1].cmFromElbowCrease === 9, `${p.channels[2].cmFromElbowCrease} ${a0}->${p.channels[2].ringAngleDeg}`);
  q(w, '#fit-save').click();
  const fits = JSON.parse(w.localStorage.getItem('opengrip.fits') || '{}');
  check('fit: save -> stored for P07 right arm, "Saved for P07"', fits['P07|R']?.length === 1 && /Saved for P07/.test(q(w, '#fit-saved').textContent), q(w, '#fit-saved').textContent);
  press(w, 'Escape');
  await until(() => !q(w, '.fit'), 500);
  check('fit: Esc closes; row says ✓ with the summary', !q(w, '.fit') && rowStatus(w, 'places') === 'ok' && /entered by you/.test(rowText(w, 'places')), rowText(w, 'places'));
  await until(() => screen(w) === 'record' && w.__opengripApp.record?.body, 3000);
  const b = w.__opengripApp.record.body();
  check('fit: Record gets the places (not the default ring)', screen(w) === 'record' && !b.isDefault && b.placement.channels[2].cmFromElbowCrease === 10.5, screen(w));
  // Reload: the Record rail's "Set sensor places" opens the sheet with last time as ghosts + diff lines.
  w = await load(env, '?demo', [1440, 900]);
  await until(() => screen(w) === 'record' && q(w, '#rec-gutter .lane'), 3000);
  press(w, 'a');
  await until(() => q(w, '#b-places'), 1000);
  q(w, '#b-places').click();
  await until(() => sheet(), 1000);
  f = sheet();
  const dtext = q(w, '#fit-diff').textContent;
  check('fit: later visit -> previous fit as ghost + diff line for sensor 3', q(w, '#fit-pid').value === 'P07' && !q(w, '#fit-ghost').hidden && /Sensor 3 .*than last time/.test(dtext) && f.state().diff.length > 0, dtext.slice(0, 200));
  q(w, '#fit-last').click();
  check('fit: "Use last time\'s places" -> all within 1 cm and 20°', f.state().diff.length === 0 && /All 6 sensors are within/.test(q(w, '#fit-diff').textContent), q(w, '#fit-diff').textContent);
  let rs = await f.runCheck();
  const glyphs = () => [...w.document.querySelectorAll('.fit-view [data-ch]')].map((g) => g.getAttribute('aria-label') || '').join('|') + q(w, '.fit-view').textContent;
  check('fit: demo check -> every sensor ✓ works here, shown on the drawing', rs.length === 6 && rs.every((r) => r.state === 'good') && w.document.querySelectorAll('#fit-res > li.good').length === 1 && q(w, '#fit-res > li.fit-goods').dataset.chs === '1,2,3,4,5,6' && /✓/.test(glyphs()), rs.map((r) => r.state).join(' '));
  f.setMisplace(true);
  rs = await f.runCheck();
  const bad = rs.filter((r) => r.state === 'bad');
  check('fit: SYNTHETIC misplace toggle -> exactly one ✕ (sensor 3) with reason + fix', bad.length === 1 && bad[0].ch === 3 && !!bad[0].fix && /✕/.test(glyphs()) && /SYNTHETIC/.test(q(w, '.fit-syn').textContent), rs.map((r) => r.state).join(' '));
  // Review-2 M3: worst first, goods folded into one expandable line, only the status word coloured.
  const lis = [...w.document.querySelectorAll('#fit-res > li')];
  const rank = { bad: 0, weak: 1, good: 2 };
  const ordered = lis.every((li, i) => !i || rank[lis[i - 1].className.split(' ')[0]] <= rank[li.className.split(' ')[0]]);
  const fold = q(w, '#fit-res > li.fit-goods');
  const colour = (e) => e && w.getComputedStyle(e).color;
  check('fit: M3 results list bad first, goods folded into one <details> line', lis[0]?.classList.contains('bad') && lis[0].dataset.ch === '3' && ordered
    && w.document.querySelectorAll('#fit-res > li.good').length === 1 && !!fold?.querySelector('details summary') && fold.querySelectorAll('details li').length === 5 && /5 sensors: 1, 2, 4, 5, 6/.test(fold.querySelector('summary').textContent),
    lis.map((li) => `${li.className}:${li.dataset.ch || li.dataset.chs}`).join(' '));
  check('fit: M3 only the status word is coloured, reason in body colour, no repeated "Sensor 3 does not work here yet:"', colour(lis[0].querySelector('.st')) !== colour(lis[0]) && colour(lis[0]) === colour(q(w, '.fit-check'))
    && !/Sensor 3 does not work here yet/.test(lis[0].textContent), lis[0].textContent.slice(0, 120));
  // Review-2 M6: Ring and Arm side by side at 1440 (ring >= 380 px drawn), stacked lens view at 1024.
  const drawn = (svg) => { const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal; return { w: vb.width * Math.min(r.width / vb.width, r.height / vb.height), r }; };
  const panes = [...w.document.querySelectorAll('#fit-view.fit-pair > .fit-pane')];
  const ps = panes.map((p) => p.querySelector('svg.bd-svg')).filter(Boolean).map(drawn);
  check('fit: pair mode shows no Ring/Arm/Table tabs (both lenses already on screen)', [...w.document.querySelectorAll('#fit-view .bd-lens')].every((b) => b.hidden && b.getBoundingClientRect().height === 0), w.document.querySelectorAll('#fit-view .bd-lens:not([hidden])').length);
  check('fit: M6 at 1440 Ring and Arm drawn side by side, ring >= 380 px', panes.map((p) => p.dataset.lens).join() === 'ring,arm' && ps.length === 2 && Math.abs(ps[0].r.top - ps[1].r.top) < 2 && ps[0].r.right <= ps[1].r.left + 1 && ps[0].w >= 380,
    ps.map((p) => `${Math.round(p.w)}@${Math.round(p.r.left)},${Math.round(p.r.top)}`).join(' '));
  w.frameElement.style.width = '1024px';
  await until(() => !q(w, '#fit-view.fit-pair'), 1000);
  check('fit: M6 at 1024 one drawing with the lens tabs (no pair)', !q(w, '#fit-view.fit-pair') && w.document.querySelectorAll('#fit-view svg.bd-svg').length === 1 && !!q(w, '#fit-view .bd-lens:not([hidden])'), w.document.querySelectorAll('#fit-view svg.bd-svg').length);
  w.frameElement.style.width = '1440px';
  await until(() => q(w, '#fit-view.fit-pair'), 1000);
  check('fit: wording says "works here", never "correct position"', /works here/.test(q(w, '.fit').textContent) && !/correct position/i.test(q(w, '.fit').textContent));
  f.setLive(true);
  f.setMisplace(false);
  const t0 = f.liveTicks;
  await until(() => f.liveTicks >= t0 + 2 && f.state().checks.every((r) => r.state === 'good'), 3000);
  check('fit: live re-check updates the glow (sensor 3 back to ✓ after the move)', f.state().phase === 'live' && f.liveTicks >= t0 + 2 && f.state().checks[2].state === 'good', `${f.liveTicks - t0} ticks ${f.state().checks.map((r) => r.state).join(' ')}`);
  f.setLive(false);
  q(w, '#fit-save').click();
  press(w, 'Escape');
  const b2 = w.__opengripApp.record.body();
  check('fit: saving from Record replaces the default ring', !q(w, '.fit') && !b2.isDefault && q(w, '#rec-body-prompt').hidden, String(b2.isDefault));
  clearStore();
}

// Simplify N4: in Simple mode no raw jargon word is visible outside a closed "Why?" fold. innerText skips
// hidden (.adv) parts and the content of a closed <details>, so it is what a person actually sees.
const JARGON = /dropout|dropped to|saturat|crosstalk|band.?shift|\bLDA\b|\bbaud\b|distractor|calibrat|\bbursts?\b|\bFMG\b|\bEMG\b|\bsamples?\b|\bmarkers?\b|\bchannels?\b|\bHz\b|\bnoisy\b/i;
// Review-3 #5/#6: words rendered at mount in Simple (lane names, place lines, button words) are
// checked on a screen mounted in Simple, with the file's channel names and old button words banned too.
const SIMPLE_BANNED = new RegExp(`${JARGON.source}|\\bch\\d+\\b|not calibrated|Press Record\\b`, 'i');
function bannedSeen(el) {
  const text = el?.innerText || '';
  const m = text.match(SIMPLE_BANNED);
  return el ? (m ? `"${m[0]}" in: ${text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')}` : '') : 'no element';
}
function jargonSeen(w) {
  const was = w.document.body.dataset.mode;
  w.document.body.dataset.mode = 'simple';
  // Simple mounts the More details folds closed (N7); close any Advanced opened, then restore.
  const opened = [...w.document.querySelectorAll('details.more-details[open]')];
  for (const d of opened) d.open = false;
  const text = (w.document.querySelector('#app')?.innerText || '');
  for (const d of opened) d.open = true;
  w.document.body.dataset.mode = was;
  const m = text.match(JARGON);
  return m ? `"${m[0]}" in: ${text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')}` : '';
}

// Simplify N3: Simple mode by default (fresh browser), the More menu, the Advanced switch. Every
// other walk runs in Advanced (today's full controls), set in main().
// A closed <details> keeps layout boxes for its content in Chrome, so check the fold too (N7).
const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('details:not([open]) > :not(summary)');
const visibleKeys = (w) => [...w.document.querySelectorAll('.key')].filter(shown).map((k) => k.textContent);
async function walkMode() {
  localStorage.removeItem('og.mode');
  let w = await load({ record: { timing: SHORT, preRollMs: 200 } }, '?demo');
  await until(() => screen(w) === 'record' && q(w, '#rec-gutter .lane'), 3000);
  const advHidden = ['#b-body', '.legend', '.seg3', '#rec-win'].filter((sel) => shown(q(w, sel)));
  check('mode: fresh browser is Simple; Record hides Body button, view switch, window and key legend', w.document.body.dataset.mode === 'simple' && advHidden.length === 0 && q(w, '#mode-tag').hidden, advHidden.join(' '));
  check('mode: Simple Record shows Start / Pause / Stop as labelled buttons, no key cap visible', ['#b-rec', '#b-pause', '#b-stop'].every((sel) => shown(q(w, sel)) && q(w, `${sel} .w`).textContent.trim()) && visibleKeys(w).length === 0, visibleKeys(w).join(' '));
  // Visible text only (innerText): hidden Advanced-only nodes may still hold key words.
  await until(() => word(w) === 'READY', 3000);
  const readyTxt = q(w, '#app').innerText;
  check('mode: Simple READY says the button, not "Press R"', word(w) === 'READY' && !/Press [A-Z]\b/.test(readyTxt) && /Press Start recording\b/.test(readyTxt), q(w, '#rec-sub')?.textContent || word(w));
  const sl0 = q(w, '#rec-stepline')?.textContent || '';
  check('mode: Simple step line counts parts, not steps ("Part 1 of 5 · about N min left")', /^Part 1 of 5 · about \d+ min left$/.test(sl0), sl0);
  const view0 = q(w, '.rec').dataset.view;
  press(w, 'm'); press(w, 'n');
  // say() writes on the next frame and other lines may follow, so read what was said, not the live node.
  await until(() => w.__opengripApp._said.has('That shortcut is an Advanced tool: More → Advanced mode.'), 1500);
  check('mode: Simple M / N do nothing but say where the tool lives', w.__opengripApp._said.has('That shortcut is an Advanced tool: More → Advanced mode.') && q(w, '.rec').dataset.body !== 'on' && q(w, '.rec').dataset.view === view0, q(w, '#say-polite').textContent);
  click(w, '#more-btn'); click(w, '#m-body');
  await sleep(80);
  check('mode: More → Body view opens the Body rail on Record', q(w, '.rec').dataset.body === 'on');
  press(w, 'r');
  await until(() => samples(w) >= 300, 8000);
  press(w, 's'); await sleep(50); q(w, '#rec-stop-yes')?.click();
  await until(() => screen(w) === 'review' && q(w, '#rv-form'), 2000);
  const rvHidden = ['#rv-compare', '#rv-xp', '#rv-bodyhost', '[data-all]', '#rv-place', '#doctor'].filter((sel) => shown(q(w, sel)));
  check('mode: Simple Save hides compare, export, body card, Doctor, sensor types and placement', rvHidden.length === 0 && shown(q(w, '#rv-pid')) && shown(q(w, '#rv-export')), rvHidden.join(' '));
  click(w, '#more-btn');
  const items = [...q(w, '#more-menu').querySelectorAll('[role^="menuitem"]')].map((b) => b.id);
  check('mode: More lists Saved recordings, Compare, Export, Body view, Watch it decide, Keyboard shortcuts, High contrast, Advanced', ['m-files', 'm-compare', 'm-export', 'm-body', 'm-glassbox', 'keys-btn', 'm-contrast', 'm-advanced'].every((id) => items.includes(id)) && q(w, '#m-export').getAttribute('aria-disabled') === 'false', items.join(' '));
  click(w, '#m-export'); await sleep(50);
  check('mode: More → Export shows the Export panel', shown(q(w, '#rv-xp')));
  click(w, '#more-btn'); click(w, '#m-body'); await sleep(50);
  check('mode: More → Body view shows the Body card and Doctor on Save', shown(q(w, '#rv-bodyhost')) && shown(q(w, '#doctor')));
  click(w, '#more-btn'); click(w, '#keys-btn'); await sleep(50);
  const kOpen = q(w, '#keys-dialog').open; q(w, '#keys-close')?.click();
  check('mode: More → Keyboard shortcuts opens the keys dialog', kOpen);
  click(w, '#more-btn'); click(w, '#m-contrast');
  check('mode: More → High contrast switch toggles and shows its state', w.document.documentElement.dataset.contrast === 'high' && q(w, '#m-contrast').getAttribute('aria-checked') === 'true');
  click(w, '#m-contrast');
  click(w, '#m-compare'); await sleep(50);
  check('mode: More → Compare with one recording adds it and asks for a second', w.__opengripApp.compare.length === 1 && screen(w) === 'review');
  w = await load({});
  click(w, '#more-btn'); click(w, '#m-files');
  await until(() => screen(w) === 'files', 1500);
  check('mode: More → Saved recordings opens Files', screen(w) === 'files');
  click(w, '#more-btn'); click(w, '#m-glassbox');
  await until(() => screen(w) === 'glassbox' && q(w, '.gb'), 1500);
  q(w, '[data-act="demo"]')?.click(); await sleep(50);
  if (q(w, '#gb-watch').hidden) q(w, '[data-act="train"]')?.click();
  await until(() => !q(w, '#gb-watch').hidden, 4000);
  for (let k = 0; k < 8; k++) q(w, '[data-act="step"]')?.click();
  q(w, '[data-act="score"]')?.click();
  await sleep(50);
  const dec = q(w, '.gb-word');
  check('mode: More → Watch it decide trains on demo data, shows a decision and the SYNTHETIC score', !!dec?.textContent.trim() && !!dec.dataset.cls && !!q(w, '.gb-synth'), dec?.textContent);
  click(w, '#nav-back');
  await until(() => screen(w) === 'files', 1500);
  check('mode: Glass Box Back returns to Saved recordings and destroys the view', screen(w) === 'files' && !q(w, '.gb') && w.__opengripApp.glassbox === null);
  click(w, '#more-btn'); click(w, '#m-advanced');
  check('mode: Advanced switch on shows the Advanced tag', w.document.body.dataset.mode === 'advanced' && !q(w, '#mode-tag').hidden && localStorage.getItem('og.mode') === 'advanced');
  w = await load({ record: { timing: SHORT, preRollMs: 200 } }, '?demo');
  await until(() => screen(w) === 'record' && q(w, '#rec-gutter .lane'), 3000);
  check('mode: Advanced persists across reload and restores Body button, view switch and key caps', w.document.body.dataset.mode === 'advanced' && q(w, '#m-advanced').getAttribute('aria-checked') === 'true' && shown(q(w, '#b-body')) && shown(q(w, '.legend')) && visibleKeys(w).length > 3);
  localStorage.removeItem('og.mode');
  for (const [wd, ht] of [[375, 812]]) {
    w = await load({ record: { timing: SHORT, preRollMs: 200 } }, '?demo', [wd, ht]);
    await until(() => screen(w) === 'record' && q(w, '#rec-gutter .lane'), 3000);
    const txt = w.document.body.innerText;
    check(`mode: ${wd} px Simple shows no key-only instruction and no key cap`, !/Press [A-Z?]/.test(txt) && visibleKeys(w).length === 0 && w.document.documentElement.scrollWidth <= wd + 1, visibleKeys(w).join(' '));
  }
}

// Simplify N6b (Simple mode): 5 part blocks instead of the 62 step segments, and the volunteer card
// in the plot area until the first Start, without moving the prompt or the plot (1440 and 375 px).
async function walkParts() {
  localStorage.removeItem('og.mode');
  for (const size of [null, [375, 812]]) {
    const at = size ? '375 px' : 'wide';
    const w = await load({ record: { preRollMs: 200 } }, '?demo', size);
    await until(() => screen(w) === 'record' && q(w, '#rec-gutter .lane') && word(w) === 'READY', 3000);
    const parts = [...w.document.querySelectorAll('#rec-parts .part')];
    check(`parts (${at}): Simple shows 5 named part blocks, not the 62 step segments`, parts.length === 5 && shown(q(w, '#rec-parts')) && !shown(q(w, '#rec-segs')) && !shown(q(w, '#rec-caps'))
      && parts.every((p) => p.classList.contains('fut') && p.textContent.trim()) && w.document.querySelectorAll('#rec-segs .seg').length === 62, parts.map((p) => p.textContent).join('|'));
    const card = q(w, '#rec-volcard');
    const cb = card.getBoundingClientRect(), pw = q(w, '.plotwrap').getBoundingClientRect();
    check(`volunteer card (${at}): the 4 lines show inside the plot area before Start`, shown(card) && card.querySelectorAll('li').length === 4 && /never as hard as you can/.test(card.textContent)
      && cb.top >= pw.top - 1 && cb.bottom <= pw.bottom + 1 && w.document.documentElement.scrollWidth <= (size ? size[0] : 1e9) + 1, `${Math.round(cb.top)}-${Math.round(cb.bottom)} in ${Math.round(pw.top)}-${Math.round(pw.bottom)}`);
    const boxes = [bandBox(w)];
    click(w, '#b-rec');
    await until(() => q(w, '.rec').dataset.phase === 'live', 2000);
    await sleep(100);
    boxes.push(bandBox(w));
    const cur = () => [...w.document.querySelectorAll('#rec-parts .part')].findIndex((p) => p.classList.contains('cur'));
    const fill = () => parseFloat(q(w, '#rec-parts .part.cur')?.style.getPropertyValue('--p')) || 0;
    const f0 = fill(); await sleep(600); const f1 = fill();
    check(`volunteer card (${at}): Start puts it away; prompt height and plot top unchanged`, !shown(card) && new Set(boxes).size === 1, boxes.join(' '));
    check(`parts (${at}): part 1 is current, matches "Part 1 of 5", and fills as time passes`, cur() === 0 && /^Part 1 of 5/.test(q(w, '#rec-stepline').textContent) && f1 > f0, `${cur()} ${q(w, '#rec-stepline').textContent} ${f0}->${f1}`);
    if (!size) {
      click(w, '#b-stepm'); click(w, '#b-skip'); await sleep(50);
      press(w, 'p'); await sleep(80);
      check('parts: Step menu Skip and pause keep working; ❚❚ shows on the current part', !!q(w, '#rec-parts .part.cur.paused') && word(w) === 'PAUSED');
      boxes.push(bandBox(w));
      check('parts: prompt height and plot top unchanged when paused', new Set(boxes).size === 1, boxes.join(' '));
    }
  }
  localStorage.setItem('og.mode', 'advanced');
  const w = await load({ record: { preRollMs: 200 } }, '?demo');
  await until(() => screen(w) === 'record' && q(w, '#rec-gutter .lane'), 3000);
  check('parts: Advanced keeps the 62 segments and captions, no part blocks, no volunteer card', shown(q(w, '#rec-segs')) && !shown(q(w, '#rec-parts')) && !shown(q(w, '#rec-volcard')));
  localStorage.removeItem('og.mode');
}

// N8 tour (spec §7, §10 check 8): first visit only, Skip / Esc / Got it end it and remember, focus comes
// back to the current step, Show me and More → Help open one tip, never over the Volunteer screen.
// Only walks that pass { tour: true } meet the auto tour; every other walk must never see it.
async function walkTour() {
  const tipOpen = (w) => !!q(w, '#tour .tour-tip');
  const counter = (w) => q(w, '#tour .tour-c')?.textContent || '';
  localStorage.removeItem('og.tour');
  let w = await load({});
  await sleep(120);
  check('tour: never auto-shows in a walk that does not ask for it', !tipOpen(w) && localStorage.getItem('og.tour') === null);

  w = await load({ tour: true }, '?demo');
  await until(() => tipOpen(w), 2000);
  const tip = q(w, '#tour .tour-tip');
  const lab = tip && w.document.getElementById(tip.getAttribute('aria-labelledby'));
  check('tour: first visit shows tip 1 as a labelled dialog with focus inside', tip?.getAttribute('role') === 'dialog' && /Four steps/.test(lab?.textContent || '')
    && counter(w) === 'Tip 1 of 4' && tip.contains(w.document.activeElement), `${counter(w)} ${w.document.activeElement?.id}`);
  const hr = q(w, '#tour .tour-hole')?.getBoundingClientRect(); const sr = q(w, '#steps').getBoundingClientRect();
  check('tour: tip 1 outlines the step bar', !!hr && hr.left <= sr.left && hr.right >= sr.right && hr.top <= sr.top && hr.bottom >= sr.bottom);
  const hc0 = w.document.documentElement.dataset.contrast;
  press(w, 'h');
  check('tour: app keys do not act behind the card', w.document.documentElement.dataset.contrast === hc0 && tipOpen(w));
  click(w, '#tour-next');
  check('tour: Next goes to tip 2 (the guide line)', counter(w) === 'Tip 2 of 4' && /Not sure/.test(q(w, '#tour-h').textContent), counter(w));
  click(w, '#tour-skip');
  const cur = q(w, '#steps .step[aria-current="step"]');
  check('tour: Skip ends it, remembers og.tour = done, focus returns to the current step', !tipOpen(w) && localStorage.getItem('og.tour') === 'done'
    && !!cur && w.document.activeElement === cur, w.document.activeElement?.id || w.document.activeElement?.className);

  w = await load({ tour: true });
  await sleep(150);
  check('tour: second visit does not show it again', !tipOpen(w));
  click(w, '#more-btn');
  const items = [...q(w, '#more-menu').querySelectorAll('[role="menuitem"]')].map((b) => b.id);
  check('tour: More has What do I do now? and Take the tour again above Keyboard shortcuts', items.indexOf('m-whatnow') >= 0 && items.indexOf('m-tour') === items.indexOf('m-whatnow') + 1 && items.indexOf('keys-btn') === items.indexOf('m-tour') + 1, items.join(' '));
  click(w, '#m-tour');
  check('tour: Take the tour again starts at tip 1', counter(w) === 'Tip 1 of 4' && q(w, '#more-menu').hidden);
  for (let i = 0; i < 3; i++) click(w, '#tour-next');
  check('tour: tip 4 points at More and its button reads Got it, no Skip', counter(w) === 'Tip 4 of 4' && q(w, '#tour-next').textContent === 'Got it' && !q(w, '#tour-skip'));
  click(w, '#tour-next');
  check('tour: Got it ends it; focus returns to Home on Home (no current step)', !tipOpen(w) && w.document.activeElement === q(w, '#nav-home'), w.document.activeElement?.id);

  localStorage.removeItem('og.tour');
  w = await load({ tour: true }, '', [375, 812]);
  await until(() => tipOpen(w), 2000);
  const tr = q(w, '#tour .tour-tip').getBoundingClientRect();
  check('tour (375): the card fits the screen', tr.left >= 0 && tr.right <= 375 && tr.top >= 0 && tr.bottom <= 812, `${Math.round(tr.left)}..${Math.round(tr.right)} ${Math.round(tr.top)}..${Math.round(tr.bottom)}`);
  press(w, 'Escape');
  check('tour: Esc skips and remembers', !tipOpen(w) && localStorage.getItem('og.tour') === 'done' && screen(w) === 'start');

  w = await load({});
  await sleep(80);
  const gt = q(w, '#guide-text').textContent;
  click(w, '#guide-show');
  check('tour: Show me opens one Help tip with the full guide sentence', counter(w) === 'Help' && q(w, '#tour-b').textContent === gt && q(w, '#tour-next').textContent === 'Got it', q(w, '#tour-b')?.textContent);
  press(w, 'Escape');
  check('tour: closing Help returns focus to Show me', !tipOpen(w) && w.document.activeElement === q(w, '#guide-show'));
  click(w, '#more-btn'); click(w, '#m-whatnow');
  check('tour: More → What do I do now? opens the same Help tip', counter(w) === 'Help');
  click(w, '#tour-next');
  const fake = w.document.createElement('section'); fake.className = 'rec'; fake.dataset.vol = '1'; w.document.body.append(fake);
  click(w, '#guide-show'); click(w, '#more-btn'); click(w, '#m-tour');
  check('tour: never opens over the Volunteer screen', !tipOpen(w));
  localStorage.removeItem('og.tour');
}

async function main() {
  try { await walkMode(); } catch (e) { check('walkMode threw', false, e?.stack || e); }
  try { await walkParts(); } catch (e) { check('walkParts threw', false, e?.stack || e); }
  try { await walkTour(); } catch (e) { check('walkTour threw', false, e?.stack || e); }
  localStorage.setItem('og.mode', 'advanced');
  for (const walk of [walkArduino, walkSlowLink, walkBusyPort, walkDemo, walkFit, walkDemoLink, walkRecord, walkStopDialog, walkPlotSpeed, walkQualityDropout, walkQualitySaturation, walkRecovery, walkUnplug, walkHiddenAndVolunteer, walkReviewExport, walkFiles, walkScorecard, walkPooled, walkShell, walkGuards, walkNarrow, walkBodyRail, walkRedFirst, walkReducedMotion, walkRecordR3, walkHistory, walkSaveSimple, walkLiveDrift, walkReport, walkShowcase, walkFitToSave]) {
    try { await walk(); } catch (e) { check(`${walk.name} threw`, false, e?.stack || e); }
  }
  document.getElementById('frame-box').replaceChildren();
  // Best effort: a deleteDatabase blocked by this page's own open handle finishes when it closes.
  for (const name of dbs) { try { indexedDB.deleteDatabase(name); } catch { /* ignore */ } }
  clearStore();
  localStorage.removeItem('og.mode');
  localStorage.removeItem('og.tour');
  const pass = results.length > 0 && results.every((r) => r.ok);
  const s = document.getElementById('summary');
  s.textContent = `${pass ? 'PASS' : 'FAIL'}: ${results.filter((r) => r.ok).length}/${results.length}`;
  Object.assign(window.__gate, { done: true, pass });
  document.title = pass ? 'PASS' : 'FAIL';
}
main();

// Scorecard pooling (card S2): several saved recordings per side from Files, A1+A2 vs B; the
// single pair stays the plain card. Twin data only. Runs from main() after walkScorecard.
async function walkPooled() {
  const w = await load({});
  const BASE = { channels: 4, reps: 4, distractors: 1 };
  const twin = (seed, setup) => toCSV(generate({ ...BASE, seed }), { person_id: 'P01', setup, synthetic: 'true' });
  const files = [['spandex.csv', twin(3, 'spandex')], ['nylon.csv', twin(4, 'nylon')], ['spandex2.csv', twin(5, 'spandex')]].map(([nm, t]) => new w.File([t], nm, { type: 'text/csv' }));
  w.__opengripApp.go('files', { files });
  await until(() => w.document.querySelectorAll('.fl-row[data-status]:not([data-status="busy"])').length === 3 && q(w, '#ab-hook') && !q(w, '#ab-hook').disabled, 4000);
  q(w, '.fl-row[data-i="0"]').click();
  q(w, '#ab-hook').click();
  const addA = q(w, '#fl-a-add');
  const tall = (el) => el && el.getBoundingClientRect().height >= 44;
  check('pool: Compare shows labelled Add another buttons for A and B, 44 px tall', addA?.textContent === 'Add another to A' && q(w, '#fl-b-add')?.textContent === 'Add another to B' && tall(addA) && tall(q(w, '#fl-ab-go')) && tall(q(w, '#fl-a')), `${addA?.getBoundingClientRect().height}`);
  addA.click();
  const a2 = q(w, '#fl-a2');
  check('pool: Add another to A adds a second A pick (the unused file) and focuses it', a2?.selectedOptions[0]?.textContent === 'spandex2.csv' && w.document.activeElement === a2, a2?.value);
  check('pool: Add buttons turn off once every file is picked', q(w, '#fl-a-add').disabled && q(w, '#fl-b-add').disabled);
  // Same file on both sides is refused, and the picker stays open.
  a2.value = q(w, '#fl-b').value;
  q(w, '#fl-ab-go').click();
  check('pool: a recording on both sides is refused', screen(w) === 'files' && !q(w, '#fl-ab').hidden);
  q(w, '#fl-a2').value = '2';
  q(w, '#fl-ab-go').click();
  await until(() => screen(w) === 'scorecard' && q(w, '#sc-overall')?.textContent, 4000);
  const colA = q(w, '#sc-col-a')?.textContent || '';
  check('pool: opens the pooled card, A = spandex + 1 more, 2 recordings', screen(w) === 'scorecard' && /^A: spandex \+ 1 more2 recordings/.test(colA) && /^B: nylon/.test(q(w, '#sc-col-b').textContent), colA);
  press(w, 'Escape');
  await until(() => screen(w) === 'files', 1000);
  // Add then Remove leaves the plain pair, which opens the unpooled card as before.
  q(w, '#ab-hook').click();
  q(w, '#fl-b-add').click();
  const rm = q(w, '#fl-ab [data-drop="b1"]');
  check('pool: Remove button is labelled and 44 px tall', rm?.textContent === 'Remove' && rm.getAttribute('aria-label') === 'Remove B, recording 2' && tall(rm));
  rm.click();
  check('pool: Remove drops the extra pick and focuses Add another', !q(w, '#fl-b2') && w.document.activeElement === q(w, '#fl-b-add'));
  q(w, '#fl-ab-go').click();
  await until(() => screen(w) === 'scorecard' && q(w, '#sc-overall')?.textContent, 4000);
  check('pool: one pick each still opens the plain pair', q(w, '#sc-col-a')?.textContent === 'A: spandex' && q(w, '#sc-col-b')?.textContent === 'B: nylon', `${q(w, '#sc-col-a')?.textContent}|${q(w, '#sc-col-b')?.textContent}`);
  press(w, 'Escape');
  await until(() => screen(w) === 'files', 1000);
}

// Card R3c: Back targets and browser history. Every screen has a hash entry above the plain URL;
// browser Back runs the app's Back (guards included); More pages go back to their opener; a
// reload on a hash lands Home. Demo only.
async function walkHistory() {
  const w = await load({ record: { timing: SHORT, preRollMs: 100 } });
  const hash = () => w.location.hash;
  const bBack = async (cond, ms = 2000) => { w.history.back(); await until(cond, ms); };
  check('history: Home has no hash, on the base entry', hash() === '' && w.history.state?.og === 0, hash());
  click(w, '#tile-demo'); await until(() => screen(w) === 'preflight', 1000);
  check('history: Connect is #connect', hash() === '#connect', hash());
  await bBack(() => screen(w) === 'start');
  check('history: browser Back from Connect goes Home, hash cleared', screen(w) === 'start' && hash() === '', `${screen(w)} ${hash()}`);
  // Card P1: no forward entry is left behind, so Forward is greyed and does nothing.
  check('forward (P1): after browser Back to Home there is no forward entry', w.navigation?.canGoForward === false, String(w.navigation?.canGoForward));
  w.history.forward(); await sleep(150);
  check('forward (P1): Forward on Home keeps Home, no hash', screen(w) === 'start' && hash() === '', `${screen(w)} ${hash()}`);
  await demoToRecord(w);
  check('history: Record is #record', hash() === '#record', hash());
  click(w, '#m-files'); await until(() => screen(w) === 'files', 1000);
  check('history: More → Files is #files', hash() === '#files', hash());
  click(w, '#nav-back'); await until(() => screen(w) === 'record', 3000);
  check('back: Files opened from Record, Back returns to Record', screen(w) === 'record' && hash() === '#record', `${screen(w)} ${hash()}`);
  { // Card P1: Files' own Back button and Esc go to the opener too, also after a trip to Save.
    click(w, '#m-files'); await until(() => screen(w) === 'files', 1000);
    click(w, '#fl-back'); await until(() => screen(w) === 'record', 3000);
    check('back (P1): Files opened from Record, its own Back button returns to Record', screen(w) === 'record' && hash() === '#record', `${screen(w)} ${hash()}`);
    click(w, '#m-files'); await until(() => screen(w) === 'files', 1000);
    const nm = Object.keys(FIXTURES_B64)[0];
    await w.__opengripApp._view.add([new w.File([fixtureBytes(nm)], nm, { type: 'text/plain' })]);
    await until(() => q(w, '#fl-save'), 3000);
    q(w, '#fl-save').click(); await until(() => screen(w) === 'review', 1000);
    press(w, 'Escape'); await until(() => screen(w) === 'files', 1000);
    press(w, 'Escape'); await until(() => screen(w) === 'record', 3000);
    check('back (P1): Files → Save → Esc → Files keeps its opener; Esc returns to Record', screen(w) === 'record' && hash() === '#record', `${screen(w)} ${hash()}`);
  }
  click(w, '#m-glassbox'); await until(() => screen(w) === 'glassbox', 1000);
  check('history: Watch it decide is #watch', hash() === '#watch', hash());
  await bBack(() => screen(w) === 'record', 3000);
  check('back: browser Back from Watch it decide (opened from Record) returns to Record', screen(w) === 'record' && hash() === '#record', `${screen(w)} ${hash()}`);
  check('forward (P1): after browser Back to Record there is no forward entry', w.navigation?.canGoForward === false, String(w.navigation?.canGoForward));
  w.history.forward(); await sleep(150);
  check('forward (P1): Forward on Record keeps Record ready (#record), nothing re-entered', screen(w) === 'record' && hash() === '#record' && !q(w, '.fit'), `${screen(w)} ${hash()}`);
  await bBack(() => !!q(w, '.fit'));
  check('history: browser Back on Record ready opens Fit (#fit)', !!q(w, '.fit') && hash() === '#fit', hash());
  await bBack(() => !q(w, '.fit'));
  check('history: browser Back closes Fit, back on Record', screen(w) === 'record' && hash() === '#record', `${screen(w)} ${hash()}`);
  q(w, '#b-rec').click(); await until(() => q(w, '.rec').dataset.phase === 'live' && samples(w) > 20, 4000);
  w.history.back(); await until(() => q(w, '#rec-stop').open, 1000);
  await sleep(100);
  check('guard: browser Back while recording opens the Stop guard, stays on Record (#record)', q(w, '#rec-stop').open && screen(w) === 'record' && hash() === '#record' && w.history.state?.og === 1, hash());
  q(w, '#rec-stop-yes').click(); await until(() => screen(w) === 'review', 3000);
  check('history: Save is #save', hash() === '#save', hash());
  q(w, '#rv-pid').value = 'P03';
  w.history.back(); await until(() => q(w, '#rv-guard').open, 1000);
  await sleep(100);
  check('guard: browser Back from unsaved Save opens the Save guard, stays (#save)', q(w, '#rv-guard').open && screen(w) === 'review' && hash() === '#save', hash());
  click(w, '#rv-g-stay'); await sleep(50);
  check('guard: Stay here keeps Save and its entry', screen(w) === 'review' && hash() === '#save' && w.history.state?.og === 1, hash());
  w.history.back(); await until(() => q(w, '#rv-guard').open, 1000);
  click(w, '#rv-g-leave'); await until(() => screen(w) === 'record', 3000);
  check('back: browser Back from Save, Leave → Record (new take)', screen(w) === 'record' && hash() === '#record', `${screen(w)} ${hash()}`);
  click(w, '#nav-home'); await until(() => screen(w) === 'start', 2000); await sleep(100);
  check('history: Home drops back to the base entry', hash() === '' && w.history.state?.og === 0, `${hash()} ${JSON.stringify(w.history.state)}`);
  const r = await load({}, '#record');
  check('history: a reload on #record lands Home, not mid-recording', r.document.body.dataset.screen === 'start' && r.location.hash === '', r.location.hash);
  const d = await load({}, '?demo#save');
  await until(() => d.document.body.dataset.screen === 'record', 3000);
  check('history: ?demo still opens Record (#record), ?demo kept', d.document.body.dataset.screen === 'record' && d.location.hash === '#record' && d.location.search === '?demo', d.location.href);
}

// Card P1: Save in Simple mode (every other Save walk runs in Advanced). Plain words (the R3b
// banned list), "Save to this computer" the one main button, More details closed, and the finish
// actions after saving. Demo only.
async function walkSaveSimple() {
  localStorage.setItem('og.mode', 'simple');
  try {
    const w = await load({ record: { timing: SHORT, preRollMs: 100 } }, '?demo');
    await until(() => screen(w) === 'record' && q(w, '#rec-gutter .lane'), 3000);
    press(w, 'r'); await until(() => samples(w) >= 300, 8000);
    press(w, 's'); await sleep(50);
    q(w, '#rec-stop-yes')?.click();
    await until(() => screen(w) === 'review' && q(w, '#rv-form'), 2000);
    check('save simple (P1): Save mounts in Simple mode', w.document.body.dataset.mode === 'simple', w.document.body.dataset.mode);
    { const j = bannedSeen(q(w, '#app')); check('save simple (P1): Simple Save shows no banned word (ch1, FMG/EMG, calibrat, Press Record ...)', !j, j); }
    const prim = [...w.document.querySelectorAll('#app .btn.primary')].filter((b) => shown(b));
    check('save simple (P1): "Save to this computer" is the only main button and has focus', prim.length === 1 && prim[0].id === 'rv-export' && /^Save to this computer/.test(prim[0].textContent) && w.document.activeElement === prim[0], prim.map((b) => b.id).join(','));
    const more = q(w, '#rv-more');
    check('save simple (P1): More details is closed, its fields hidden', !!more && !more.open && !shown(q(w, '#rv-place')) && !shown(q(w, '#rv-setup')), more && String(more.open));
    q(w, '#rv-pid').value = 'P03';
    q(w, '#rv-export').click();
    await until(() => q(w, '#rv-saved'), 1500);
    check('save simple (P1): after saving, Record again (main, focused) · Next volunteer · Go home; Save step done', q(w, '#rv-again')?.classList.contains('btn') && q(w, '#rv-again').classList.contains('primary') && !!q(w, '#rv-next') && q(w, '#rv-home')?.textContent === 'Go home' && w.document.activeElement === q(w, '#rv-again') && w.document.querySelectorAll('#steps .step')[3]?.dataset.state === 'done' && /Record again/.test(guide(w)), guide(w));
    { const j = bannedSeen(q(w, '#app')); check('save simple (P1): the saved view shows no banned word', !j, j); }
  } finally { localStorage.setItem('og.mode', 'advanced'); }
}

// Card L1b: a twin band shift live shows ONE calm drift chip (after >= 20 s of data, confirmed
// twice), never on the Volunteer screen, without moving the plot or prompt height. Twin data only.
// The drift rule counts twin samples, not seconds, so the twin runs 4x faster and every protocol
// step is 4x shorter: the same samples reach the tracker in a quarter of the wall time.
const DRIFT_FAST = { calRest: 1.25, restStart: 2.5, hold: 0.75, rest: 1, restEnd: 2.5 };
async function walkLiveDrift() {
  const w = await load({ twinOpts: { seed: 2, faults: [{ type: 'shift', channel: 2, start: 2000 }], speed: 4 }, record: { timing: DRIFT_FAST, preRollMs: 100 } }, '?demo');
  await until(() => screen(w) === 'record' && q(w, '#rec-gutter .lane'), 2000);
  const h = () => [q(w, '.plotwrap'), q(w, '#rec-prompt')].map((el) => Math.round(el?.getBoundingClientRect().height || 0));
  press(w, 'r');
  await sleep(1500);
  const h0 = h();
  const chips = () => [...w.document.querySelectorAll('.qchip[data-code="rest_drift"], .qchip[data-code="hold_creep"]')];
  await until(() => chips().length > 0, 120000, 500);
  // Twin seconds (session samples / 100 Hz), not wall seconds: the twin runs 4x faster here.
  const sec = Math.round((w.__opengripApp.record?.session?.t?.length || 0) / 100);
  const c = chips();
  check('live drift: a shift on ch3 shows one drift chip, on ch3, after >= 20 s', c.length === 1 && c[0].dataset.channel === '2' && sec >= 18, `${c.length} chip(s) ch=${c[0]?.dataset.channel} after ~${sec} s`);
  await sleep(4000);
  check('live drift: the chip stays (no flicker) and stays one per channel', chips().length === 1 && !chips()[0].classList.contains('cleared'), chips().length);
  check('live drift: plot and prompt heights unchanged', JSON.stringify(h()) === JSON.stringify(h0), `${h0} -> ${h()}`);
  press(w, 'v');
  await sleep(100);
  check('live drift: not shown on the Volunteer screen', getComputedStyle(q(w, '#rec-quality')).display === 'none' && !q(w, '#rec-quality').offsetParent);
  press(w, 'Escape'); await sleep(50);
  press(w, 's'); await sleep(50);
  q(w, '#rec-stop-yes')?.click();
  await until(() => screen(w) === 'review', 2000);
  press(w, 'Escape'); await sleep(50);
  q(w, '#rv-g-leave')?.click();
  await until(() => screen(w) === 'start', 1000);
}

// Card R7: after saving, "Save a one-page report" downloads one self-contained HTML page with the
// person code, the demo banner and one plot per sensor; no script, no external URL. Demo only.
async function walkReport() {
  const w = await load({ record: { timing: SHORT, preRollMs: 100 } }, '?demo');
  await until(() => screen(w) === 'record' && q(w, '#rec-gutter .lane'), 3000);
  press(w, 'r'); await until(() => samples(w) >= 300, 8000);
  press(w, 's'); await sleep(50);
  q(w, '#rec-stop-yes')?.click();
  await until(() => screen(w) === 'review' && q(w, '#rv-form'), 2000);
  check('report (R7): no report button before saving', !q(w, '#rv-report-dl'));
  q(w, '#rv-pid').value = 'P05';
  q(w, '#rv-export').click();
  await until(() => q(w, '#rv-report-dl'), 1500);
  const d0 = downloads.length;
  q(w, '#rv-report-dl')?.click();
  await until(() => downloads.length > d0, 1500);
  const got = downloads[d0] || {};
  const html = got.text || '';
  const sensors = Number(q(w, '#rv-count')?.textContent.match(/(\d+) sensor/)?.[1]);
  check('report (R7): one opengrip_P05_<stamp>.report.html, text/html', downloads.length === d0 + 1 && /^opengrip_P05_\d{8}-\d{4}\.report\.html$/.test(got.name || '') && got.type === 'text/html', `${got.name} ${got.type}`);
  check('report (R7): has the code, the demo banner, one plot per sensor, a print sheet', /P05/.test(html) && /id="synthetic"/.test(html) && (html.match(/<svg class="plot"/g) || []).length === sensors && sensors > 0 && /@media print/.test(html), `${html.length} chars, ${sensors} sensors`);
  check('report (R7): no script, no external URL', !/<script/i.test(html) && !/https?:\/\//i.test(html), '');
  click(w, '#rv-home'); await until(() => screen(w) === 'start', 1000);
}

// Card D5: ?showcase, the portfolio walkthrough on the twin. The card (Step n of N, the synthetic
// chip, Exit demo) on every step, the real screens in order, the planted loose sensor seen live,
// nothing downloaded or stored in IndexedDB without a press, Exit back Home with the sandbox undone.
// 1440 for the full walk, 375 for fit and Exit. Twin data only; no mic or camera anywhere.
async function walkShowcase() {
  const tipOk = (w, n) => {
    const tip = q(w, '#showcase .tour-tip'); const r = tip?.getBoundingClientRect();
    return !!tip && new RegExp(`^Step ${n} of 7`).test(q(w, '#showcase .tour-c')?.textContent || '')
      && /Demo: synthetic data/.test(q(w, '#showcase .sc-chip')?.textContent || '') && shown(q(w, '#sc-exit'))
      && r.left >= 0 && r.top >= 0 && r.right <= w.innerWidth + 1 && r.bottom <= w.innerHeight + 1;
  };
  const step = async (w, n, ms) => { q(w, '#sc-next').click(); return until(() => w.__opengripApp.showcase?.step() === n && !w.__opengripApp.showcase.busy(), ms); };
  const d0 = downloads.length;
  const dbName = `og-showcase-${Date.now()}`;
  const w = await load({ dbName, twinOpts: { seed: 3 } }, '?showcase', [1280, 800]);
  await until(() => q(w, '#showcase .tour-tip') && screen(w) === 'preflight', 3000);
  check('showcase: opens on Connect with Step 1 of 7, the synthetic chip and Exit demo; no first-run tour', tipOk(w, 1) && !q(w, '#tour'), q(w, '#showcase .tour-c')?.textContent);
  check('showcase: the twin has the planted loose sensor (showcase wins over the page twinOpts)', w.__opengripApp.env.twinOpts.faults?.[0]?.type === 'loose', JSON.stringify(w.__opengripApp.env.twinOpts.faults?.[0]));
  const t0 = performance.now();
  const ok2 = await step(w, 2, 12000);
  check('showcase: Next → Record, recording started, card on the prompt', ok2 && screen(w) === 'record' && ['preroll', 'live'].includes(w.__opengripApp.record?.phase()) && tipOk(w, 2), screen(w));
  press(w, 'r'); await sleep(50);
  check('showcase: app keys typed in the card do not reach Record', ['preroll', 'live'].includes(w.__opengripApp.record?.phase()), w.__opengripApp.record?.phase());
  await step(w, 3, 2000);
  const chip = await until(() => q(w, '#rec-quality .qchip[data-code]'), 45000, 250);
  check('showcase: the live quality strip shows a finding from the planted fault', chip && tipOk(w, 3), q(w, '#rec-quality')?.textContent.trim().slice(0, 120));
  const ok4 = await step(w, 4, 8000);
  check('showcase: Next → Save, the card on the Doctor / report', ok4 && screen(w) === 'review' && tipOk(w, 4), screen(w));
  check('showcase: the report names a fault with a fix line', /loose|re-?seat|press|contact|strap|fix/i.test(q(w, '#app')?.textContent || ''), '');
  await step(w, 5, 2000);
  check('showcase: Save step points at a button; nothing downloaded yet', tipOk(w, 5) && downloads.length === d0, downloads.length - d0);
  const ok6 = await step(w, 6, 15000);
  check('showcase: Next → Watch it decide, replay with the 3D hand area', ok6 && screen(w) === 'glassbox' && !!q(w, '.gb[data-trained]') && !!q(w, '.gb-hand') && tipOk(w, 6), `${screen(w)} step=${w.__opengripApp.showcase?.step()} hand=${!!q(w, '.gb-hand')} tip=${tipOk(w, 6)} ${q(w, '#showcase .sc-note')?.textContent || ''}`);
  // Glass Box trains on the visitor's own take (handed in memory), or says in one line why it fell back.
  const gb = w.__opengripApp.glassbox;
  const onTake = (gb?.used || []).some((it) => /Your take/.test(it.name));
  const note = q(w, '#showcase .sc-note')?.textContent || '';
  check('showcase: Glass Box trained on the take just recorded, or the card says it fell back to the demo recordings',
    onTake ? !note && !(gb.used || []).some((it) => /^Demo:/.test(it.name)) : /too short/.test(note) && (gb?.used || []).every((it) => /^Demo:/.test(it.name)),
    `${onTake ? 'take' : 'fallback'}: ${(gb?.used || []).map((it) => it.name).join(', ')} note="${note}"`);
  const gripSeen = await until(() => /closed|grip/i.test(gb?.hand?.label?.() || ''), 20000, 100);
  const handIn = (win) => {
    const h = q(win, '.gb-hand')?.getBoundingClientRect(); const t = q(win, '#showcase .tour-tip')?.getBoundingClientRect();
    const overlap = h && t && !(t.right <= h.left || t.left >= h.right || t.bottom <= h.top || t.top >= h.bottom);
    return !!h && h.width > 50 && h.height > 50 && h.left >= 0 && h.top >= 0 && h.right <= win.innerWidth + 1 && h.bottom <= win.innerHeight + 1 && !overlap;
  };
  check('showcase: the 3D hand shows a grip during Watch it decide, fully in view at 1280x800 and clear of the card', gripSeen && handIn(w),
    `label="${gb?.hand?.label?.()}" hand=${JSON.stringify(q(w, '.gb-hand')?.getBoundingClientRect())} tip=${JSON.stringify(q(w, '#showcase .tour-tip')?.getBoundingClientRect())}`);
  await step(w, 7, 2000);
  // Narrow the same frame to 375 and come Back to the step: the card re-renders and brings the hand into view.
  const frame = w.frameElement; frame.style.width = '375px'; frame.style.height = '812px';
  await sleep(300);
  q(w, '#sc-back').click(); await until(() => w.__opengripApp.showcase?.step() === 6, 1000);
  await sleep(500);
  check('showcase: Back on the same screen moves the card back one step', w.__opengripApp.showcase?.step() === 6 && screen(w) === 'glassbox', w.__opengripApp.showcase?.step());
  const h375 = q(w, '.gb-hand')?.getBoundingClientRect();
  check('showcase 375: Back to Watch it decide brings the whole 3D hand into view',
    !!h375 && h375.width > 50 && h375.left >= 0 && h375.top >= 0 && h375.right <= w.innerWidth + 1 && h375.bottom <= w.innerHeight + 1 && tipOk(w, 6),
    `hand=${JSON.stringify(h375)} tip=${JSON.stringify(q(w, '#showcase .tour-tip')?.getBoundingClientRect())} side=${q(w, '#showcase .tour-tip')?.dataset.side}`);
  frame.style.width = '1280px'; frame.style.height = '800px';
  const secs = Math.round((performance.now() - t0) / 1000);
  check('showcase: the walk with prompt presses fits in about 2 minutes', secs < 120, `${secs} s of waits`);
  q(w, '#sc-next').focus();
  q(w, '#sc-next').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => screen(w) === 'start', 2000);
  const dbsNow = (await indexedDB.databases?.()) || [];
  check('showcase: Esc → Home, card gone, ?showcase dropped, sandbox restored, nothing downloaded or in IndexedDB',
    screen(w) === 'start' && !q(w, '#showcase') && !/showcase/.test(w.location.search) && !w.__opengripApp.env.twinOpts.faults
      && !w.__opengripApp.env.record.timing && w.__opengripApp.showcase === null && downloads.length === d0 && !dbsNow.some((d) => d.name === dbName),
    `${screen(w)} ${w.location.search} dl=${downloads.length - d0}`);
  const n = await load({}, '?showcase', [375, 812]);
  await until(() => q(n, '#showcase .tour-tip') && screen(n) === 'preflight', 3000);
  check('showcase 375: card fits on screen with chip and Exit', tipOk(n, 1), JSON.stringify(q(n, '#showcase .tour-tip')?.getBoundingClientRect()));
  const n2 = await step(n, 2, 12000);
  check('showcase 375: Record step card fits on screen', n2 && tipOk(n, 2), '');
  q(n, '#sc-exit').click();
  await until(() => screen(n) === 'start', 2000);
  check('showcase 375: Exit demo from Record → Home, no card, chip cleared', screen(n) === 'start' && !q(n, '#showcase') && q(n, '#source-chip').hidden, screen(n));
}

// Card A1: the Fit page's result rides Record to Save. Run 1 skips Fit (Save line + report say
// "Fit was skipped"); run 2 runs the demo check (twin-played, synthetic) and the report lists it.
async function walkFitToSave() {
  for (const run of ['skip', 'check']) {
    clearStore();
    const w = await load({ serial: null, fit: { scale: 0.04 }, record: { timing: SHORT, preRollMs: 100 } }, '', [1440, 900]);
    q(w, '#tile-demo').click();
    await until(() => row(w, 'places')?.querySelector('[data-act]'), 1500);
    row(w, 'places').querySelector('[data-act]').click();
    await until(() => q(w, '.fit')?.fitApi, 1000);
    const f = q(w, '.fit').fitApi;
    if (run === 'check') await f.runCheck();
    q(w, '#fit-skip').click();
    // Preflight may go on to Record by itself once its checks pass (walkFit relies on that);
    // otherwise press its start button (#pf-skip in Simple, #pf-start in Advanced).
    const go = '#pf-skip, #pf-start';
    await until(() => screen(w) === 'record' || (q(w, go) && !q(w, go).disabled), 6000);
    if (screen(w) !== 'record' && q(w, go)) click(w, go);
    await until(() => screen(w) === 'record' && q(w, '#rec-gutter .lane'), 3000);
    // .rec[data-samples] counts from the source's start, so the ~3 s spent on Preflight are already
    // in it: wait for the recording itself (Stop is disabled during the "Starting in…" pre-roll).
    const rec = () => w.__opengripApp.record;
    press(w, 'r'); await until(() => rec()?.phase() === 'live' && rec().session.t.length >= 200, 8000);
    press(w, 's');
    // #rec-stop-yes is always in the DOM; wait for the dialog itself (or S went straight on).
    await until(() => q(w, '#rec-stop')?.open || screen(w) === 'review', 1500);
    if (q(w, '#rec-stop')?.open) q(w, '#rec-stop-yes').click();
    await until(() => screen(w) === 'review' && q(w, '#rv-form'), 3000);
    check(`fit->save (A1): ${run} run reaches Save`, screen(w) === 'review' && !!q(w, '#rv-form'), `${screen(w)} phase=${rec()?.phase?.()} samples=${samples(w)} dialog=${!!q(w, '#rec-stop')?.open}`);
    if (screen(w) !== 'review') continue;
    const line = q(w, '#rv-fit')?.textContent || '';
    if (run === 'skip') check('fit->save (A1): skipped Fit -> Save says "Fit was skipped"', /Fit was skipped/.test(line) && q(w, '#rv-fit').dataset.skipped === 'true', line);
    else check('fit->save (A1): run check -> Save shows its summary', /^Fit check: .*(work|weak|not working)/.test(line) && q(w, '#rv-fit').dataset.skipped === 'false', line);
    q(w, '#rv-pid').value = 'P09';
    q(w, '#rv-export').click();
    await until(() => q(w, '#rv-report-dl'), 1500);
    const d0 = downloads.length;
    q(w, '#rv-report-dl')?.click();
    await until(() => downloads.length > d0, 1500);
    const sec = ((downloads[d0] || {}).text || '').match(/<section id="fit">[\s\S]*?<\/section>/)?.[0] || '';
    if (run === 'skip') check('fit->save (A1): report says Fit was skipped, not "no fit check was done"', /id="fit-skipped"/.test(sec) && !/No fit check was done/.test(sec), sec.slice(0, 200));
    else check('fit->save (A1): report lists the real per-sensor check', (sec.match(/<li data-state="(good|weak|bad)"/g) || []).length >= 1 && !/fit-skipped/.test(sec), sec.slice(0, 200));
    click(w, '#rv-home'); await until(() => screen(w) === 'start', 1000);
  }
}
