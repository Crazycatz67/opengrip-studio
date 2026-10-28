// Browser engine test: the real modules + real IndexedDB + a mock navigator.serial.
// Result: document.title 'PASS'|'FAIL' and window.__gate = { done, pass, results }.
import { SerialSource } from '../../src/sources.js';
import { Ingest } from '../../src/pipeline.js';
import { Session } from '../../src/session.js';
import { validateProtocol } from '../../src/protocol.js';
import { toCSV, fromCSV, sidecarJSON } from '../../src/csv.js';
import { analyzeRecording } from '../../src/quality.js';
import { AutoSaver, idbBackend, loadSession, listSessions } from '../../src/store.js';
import { createMockSerial } from '../../src/sim/mockserial.js';
import { LineBuffer } from '../../src/parse.js';
import { mulberry32 } from '../../src/sim/uart.js';
import { FIXTURES_B64, fixtureBytes, fixtureText } from './fixtures.js';

const logEl = document.getElementById('log');
const results = [];
window.__gate = { done: false, pass: false, results };
const log = (s) => { logEl.textContent += `${s}\n`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`);
}
const fixtureLines = (n) => fixtureText(n).split(/\r?\n/).filter(Boolean);

function installMock(opts) {
  const mock = createMockSerial(opts);
  // navigator.serial is a prototype getter; an own property shadows it for this page only.
  Object.defineProperty(navigator, 'serial', { value: mock.serial, configurable: true });
  return mock;
}

async function scenarioAllFixturesChunked() {
  for (const name of Object.keys(FIXTURES_B64)) {
    const bytes = fixtureBytes(name);
    const rand = mulberry32(5);
    const dec = new TextDecoder('latin1');
    const lb = new LineBuffer();
    let fmt = null;
    let n = 0;
    const ing = new Ingest({ onSample: () => n++, onFormat: (f) => { fmt = f; } });
    for (let i = 0; i < bytes.length;) {
      const k = 1 + Math.floor(rand() * 8);
      for (const l of lb.feed(dec.decode(bytes.subarray(i, i + k), { stream: true }))) ing.push(l, i);
      i += k;
    }
    for (const l of lb.flush()) ing.push(l, bytes.length);
    check(`${name}: detected as 1 channel, all ${fixtureLines(name).length} samples`, fmt?.kind === 'single' && fmt.channels === 1 && n === fixtureLines(name).length, `${fmt?.kind} ${n}`);
  }
}

// Full flow on synth_grip_fade at the club's likely 9600 baud, real SerialSource defaults
// (2 s reset wait, 1.5 s probe), byte-by-byte delivery, an unplug in the middle.
async function scenarioGuidedUnplug() {
  const dbName = `opengrip-gate-${Date.now()}`;
  localStorage.removeItem('opengrip.lastBaud');
  const mock = installMock({ text: fixtureText('synth_grip_fade.txt'), deviceBaud: 9600, lineRateHz: 100, speed: 1.5, maxChunk: 1, seed: 11 });
  const protocol = validateProtocol({ name: 'gate', steps: [
    { label: 'cal_rest', seconds: 1.5 }, { repeat: 2, steps: [{ label: 'cal_squeeze', seconds: 1 }, { label: 'cal_rest', seconds: 1 }] },
    { repeat: 2, steps: [{ label: 'grip@down', seconds: 1 }, { label: 'rest@down', seconds: 1 }] }, { label: 'elbow_bend', seconds: 1 }, { label: 'rest', seconds: 1 },
  ] }).protocol;
  const src = new SerialSource({});
  check('SerialSource sees the (mock) navigator.serial', SerialSource.supported());
  await src.choosePort();
  const t0 = performance.now();
  const det = await src.detectBaud();
  check('baud auto-detect finds 9600 after 115200 fails', det.baud === 9600 && det.results[0].baud === 115200 && det.results[0].fraction < 0.8,
    `${det.results.map((r) => `${r.baud}:${r.fraction.toFixed(2)}`).join(' ')} in ${Math.round(performance.now() - t0)} ms`);
  check('last good baud remembered', localStorage.getItem('opengrip.lastBaud') === '9600');

  const session = new Session({ protocol });
  const backend = await idbBackend(dbName);
  const saver = new AutoSaver({ backend, everySamples: 50, everyMs: 500 });
  const statuses = [];
  let format = null;
  const ing = new Ingest({ onSample: (s) => session.push(s), onFormat: (f) => { format = f; } });
  session.start({ person_id: 'P99' });
  await saver.begin({ meta: session.meta, channels: 1 });
  await src.start({
    onLine: (l, t) => { ing.push(l, t); saver.add(session.drain(), session.drainMarkers()); },
    onStatus: (s) => {
      statuses.push(s);
      if (s === 'disconnected') { session.disconnected(); setTimeout(() => mock.replug(), 500); }
      if (s === 'connected' && statuses.includes('disconnected')) { session.reconnected(); session.resume(); } // unplug auto-pauses the clock; the UI resumes on a press
    },
  });
  // Unplug once samples are flowing, not after a fixed time: the 2 s reset wait plus byte-by-byte
  // delivery can take longer than 3 s on a loaded laptop (gate:full saw 0 before the unplug).
  const tReady = performance.now();
  while (session.t.length <= 150 && performance.now() - tReady < 30000) await sleep(50);
  const beforeUnplug = session.t.length;
  mock.unplug();
  const tDone = performance.now();
  while (!session.protocolState()?.done && performance.now() - tDone < 60000) await sleep(100);
  check('protocol finishes after the replug (within 60 s)', session.protocolState()?.done === true, `${Math.round(performance.now() - tDone)} ms`);
  await src.stop();
  session.stop();
  await saver.add(session.drain(), session.drainMarkers());
  const rec = session.recording();
  const csv = toCSV(rec, { person_id: 'P99', sensors: 'FMG' });
  const report = analyzeRecording(fromCSV(csv));
  const sidecar = sidecarJSON(report, { person_id: 'P99' });
  await saver.finish();

  check('format detected: one number per line, 1 channel', format?.kind === 'single' && format.channels === 1, format?.reason);
  check('unplug -> disconnected -> reconnecting -> connected', statuses.join(',').includes('disconnected,reconnecting,connecting,connected'), statuses.join(','));
  check('samples kept from before the unplug', beforeUnplug > 100 && rec.t.length > beforeUnplug, `${beforeUnplug} before, ${rec.t.length} total`);
  check('markers for disconnect/reconnect', rec.markers.map((m) => m.note).join(',') === 'disconnected,reconnected,resumed');
  check('protocol labels recorded', ['cal_rest', 'cal_squeeze', 'grip@down', 'elbow_bend'].every((l) => rec.labels.includes(l)), [...new Set(rec.labels)].join(' '));
  check('time is monotonic', rec.t.every((x, i) => i === 0 || x >= rec.t[i - 1]));
  const back = fromCSV(csv);
  check('CSV round-trip identical', JSON.stringify(back.data) === JSON.stringify(rec.data) && JSON.stringify(back.labels) === JSON.stringify(rec.labels));
  check('quality report + sidecar produced', report.items.length > 0 && JSON.parse(sidecar).report.items.length === report.items.length, report.items.map((i) => i.code).join(' '));

  // "Reload": a fresh IndexedDB connection sees the whole session.
  const fresh = await idbBackend(dbName);
  const list = await listSessions(fresh);
  const saved = await loadSession(fresh, saver.id);
  check('IndexedDB: session listed and complete', list.length === 1 && list[0].complete === true);
  check('IndexedDB: recovered data identical', saved && saved.t.length === rec.t.length && JSON.stringify(saved.data) === JSON.stringify(rec.data), `${saved?.t.length}/${rec.t.length}`);
  indexedDB.deleteDatabase(dbName);
}

// 115200 board (our sketch's speed) replaying synth_dropouts: found on the first try.
async function scenarioFastBaud() {
  localStorage.removeItem('opengrip.lastBaud');
  installMock({ text: fixtureText('synth_dropouts.txt'), deviceBaud: 115200, lineRateHz: 100, speed: 5, maxChunk: 1, seed: 4 });
  const src = new SerialSource({});
  await src.choosePort();
  const det = await src.detectBaud();
  check('115200 found on the first try', det.baud === 115200 && det.results.length === 1, det.message);
  const session = new Session({});
  const ing = new Ingest({ onSample: (s) => session.push(s) });
  session.start({});
  await src.start({ onLine: (l, t) => ing.push(l, t), onStatus: () => {} });
  await sleep(4500);
  await src.stop();
  session.stop();
  const q = analyzeRecording(session.recording());
  check('synth_dropouts over serial: dropouts flagged', q.channels[0].dropouts.length >= 3, `${session.t.length} samples, ${q.channels[0].dropouts.length} dropouts`);
  const r = ing.rate();
  check('rate estimated from arrival times (≈)', r.approx && r.hz > 300 && r.hz < 700, `${r.hz} Hz (100 Hz x speed 5)`);
}

(async () => {
  const t0 = performance.now();
  for (const sc of [scenarioAllFixturesChunked, scenarioGuidedUnplug, scenarioFastBaud]) {
    log(`-- ${sc.name}`);
    try { await sc(); } catch (e) { check(`${sc.name} threw`, false, e?.stack || e); }
  }
  const pass = results.length > 0 && results.every((r) => r.ok);
  const s = document.getElementById('summary');
  s.textContent = `${pass ? 'PASS' : 'FAIL'}: ${results.filter((r) => r.ok).length}/${results.length} checks in ${Math.round((performance.now() - t0) / 1000)} s`;
  s.className = pass ? 'pass' : 'fail';
  Object.assign(window.__gate, { done: true, pass });
  document.title = pass ? 'PASS' : 'FAIL';
})();
