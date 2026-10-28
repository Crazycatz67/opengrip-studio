// Engine asks from the Recorder UI spec §16 and RISKS B1/B8/reset: protocol clock with
// pause/seek/insert, live quality with times, flex check, plain format names, link bandwidth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultProtocol, stepStart, insertSteps, calibrationSteps, totalSeconds } from '../src/protocol.js';
import { Session, PAUSED_LABEL } from '../src/session.js';
import { LiveQuality, movementCheck, windowOf, analyzeRecording } from '../src/quality.js';
import { formatName, bandwidthCheck, detectFormat } from '../src/detect.js';
import { portOpenError, PORT_BUSY_MESSAGE } from '../src/sources.js';

const proto = () => ({ name: 't', steps: [
  { label: 'rest', seconds: 2, instruction: '' },
  { label: 'grip', seconds: 3, instruction: '' },
  { label: 'rest', seconds: 4, instruction: '' },
] });

// A session on a fake clock; push() feeds a sample at the current fake time.
function rig(protocol = proto()) {
  let now = 0;
  const s = new Session({ channels: 1, protocol, now: () => now });
  s.start();
  return { s, at: (ms) => { now = ms; }, push: (ms) => { now = ms; s.push({ t: null, hostMs: ms, values: [1] }); } };
}

test('protocol: stepStart, calibrationSteps and insertSteps (pure, input unchanged)', () => {
  const p = proto();
  assert.equal(stepStart(p, 0), 0);
  assert.equal(stepStart(p, 2), 5);
  assert.equal(stepStart(p, 99), 9);
  const r = insertSteps(p, 1, calibrationSteps());
  assert.ok(r.ok, r.errors.join());
  assert.equal(p.steps.length, 3, 'input not mutated');
  assert.deepEqual(r.protocol.steps.slice(0, 3).map((x) => x.label), ['rest', 'cal_rest', 'cal_squeeze']);
  assert.equal(r.protocol.steps.length, 3 + 1 + 6);
  assert.equal(insertSteps(p, 1, [{ label: 'bad,label', seconds: 1 }]).ok, false);
  // defaultProtocol still starts with the same calibration block it always had.
  assert.equal(totalSeconds(defaultProtocol()), 5 + 21 + 10 + 3 * 39 + 35 + 35 + 10);
});

test('session clock: pause freezes the step, paused rows kept with label "paused", resume carries on', () => {
  const { s, at, push } = rig();
  push(1000);
  at(3000);
  assert.equal(s.protocolState().step.label, 'grip');
  assert.ok(s.pause());
  assert.equal(s.pause(), false, 'second pause is a no-op');
  push(10000); // 7 s later, still paused
  assert.equal(s.clock(), 3);
  assert.equal(s.protocolState().paused, true);
  assert.equal(s.labels[s.labels.length - 1], PAUSED_LABEL);
  assert.ok(s.resume(10000));
  push(10500);
  assert.equal(s.labels[s.labels.length - 1], 'grip');
  assert.equal(s.clock(), 3.5);
  assert.deepEqual(s.markers.map((m) => m.note), ['paused', 'resumed']);
  assert.equal(s.t.length, 3, 'no rows dropped');
});

test('session clock: redo goes to the step start, skip to the next step, insert lands after the current step', () => {
  const { s, at } = rig();
  at(4000); // grip, 2 s in
  assert.ok(s.redoStep());
  assert.equal(s.clock(), 2);
  at(5000);
  assert.equal(s.protocolState().stepElapsed, 1);
  assert.ok(s.skipStep());
  assert.equal(s.clock(), 5);
  assert.equal(s.protocolState().step.index, 2);
  at(6000);
  const r = s.insertSteps(calibrationSteps());
  assert.ok(r.ok);
  assert.equal(r.at, 3);
  assert.equal(s.protocol.steps[3].label, 'cal_rest');
  assert.equal(s.protocolState().step.label, 'rest', 'current step unchanged');
  assert.deepEqual(s.markers.map((m) => m.note), ['redo grip', 'skip grip', 'steps added after step 3']);
});

test('session: unplug auto-pauses (one "disconnected" marker), reconnect leaves it paused', () => {
  const { s, at, push } = rig();
  push(3000);
  s.disconnected(3000);
  assert.equal(s.paused, true);
  assert.equal(s.pauseReason, 'unplugged');
  at(9000);
  s.reconnected(9000);
  assert.equal(s.paused, true);
  assert.equal(s.clock(), 3);
  assert.deepEqual(s.markers.map((m) => m.note), ['disconnected', 'reconnected']);
});

test('session: device clock going backwards marks "board reset" and keeps time monotonic', () => {
  const s = new Session({ channels: 1, now: () => 0 });
  s.start();
  for (const t of [100, 110, 120, 5, 15]) s.push({ t, hostMs: 0, values: [1] });
  assert.equal(s.resets, 1);
  const m = s.markers.find((x) => x.note === 'board reset');
  assert.equal(m.index, 3);
  assert.ok(s.t.every((x, i) => i === 0 || x > s.t[i - 1]));
});

// Deterministic noise around `base`.
function noisy(n, base, seed = 7) {
  let x = seed;
  return Array.from({ length: n }, () => { x = (x * 1103515245 + 12345) % 2147483648; return base + (x % 7) - 3; });
}

function src(values, labels = null, hz = 100) {
  return { t: values.map((_, i) => i * (1000 / hz)), rows: values.map((v) => [v]), labels: labels || values.map(() => 'rest'), channelNames: ['ch1'] };
}

test('live quality: dropout reported with its absolute index, the time holds while it stays in the window', () => {
  const v = noisy(3000, 400);
  for (let i = 2500; i < 2510; i++) v[i] = 0;
  const lq = new LiveQuality({ windowSec: 15 });
  const r1 = lq.update(src(v.slice(0, 2700)));
  const d1 = r1.items.find((it) => it.code === 'dropout');
  assert.ok(d1, JSON.stringify(r1.items));
  assert.equal(d1.at, 2500);
  assert.equal(d1.atMs, 25000);
  assert.ok(r1.from > 0 && r1.to === 2700);
  const d2 = lq.update(src(v)).items.find((it) => it.code === 'dropout');
  assert.equal(d2.at, 2500);
  assert.ok(!r1.items.some((it) => it.level === 'green'));
  // 20 s later the dropout has left the 15 s window.
  const later = lq.update(src(v.concat(noisy(2000, 400))));
  assert.ok(!later.items.some((it) => it.code === 'dropout'));
});

test('live quality: calibration taken once the cal segment ends; whole-file analyzeRecording items carry at', () => {
  const v = noisy(500, 100).concat(noisy(300, 800), noisy(1200, 100));
  const labels = v.map((_, i) => (i < 500 ? 'cal_rest' : i < 800 ? 'cal_squeeze' : 'rest'));
  const lq = new LiveQuality();
  lq.update(src(v.slice(0, 700), labels.slice(0, 700)));
  assert.equal(lq.calibration, null, 'still calibrating');
  lq.update(src(v, labels));
  assert.ok(lq.calibration && Math.abs(lq.calibration.rest[0] - 100) < 5 && lq.calibration.squeeze[0] > 700);
  const rep = analyzeRecording(windowOf(src(v, labels)));
  assert.ok(rep.items.every((it) => 'at' in it));
});

test('movementCheck: a squeezed channel moved, a flat one did not', () => {
  const ch1 = noisy(500, 100);
  for (const [a, b] of [[100, 180], [300, 380]]) for (let i = a; i < b; i++) ch1[i] = 400;
  const ch2 = noisy(500, 100, 3);
  const r = movementCheck({ data: [ch1, ch2], rateHz: 100 });
  assert.deepEqual(r.map((x) => x.moved), [true, false]);
  assert.equal(r[0].bursts, 2);
  assert.ok(r[0].amplitude > 250);
});

test('formatName: plain names for the Preflight Format row', () => {
  const f = (lines) => formatName(detectFormat(lines));
  assert.equal(f(['t_ms,a,b,c,d,e,f', '0,1,2,3,4,5,6', '10,1,2,3,4,5,6', '20,1,2,3,4,5,6']), 'CSV with time · 6 values');
  assert.equal(f(['5', '6', '7', '8']), 'One number per line');
  assert.equal(f(['a:1 b:2', 'a:3 b:4', 'a:5 b:6']), 'Serial Plotter labels (a:1 b:2)');
  assert.equal(f(['A0: 1 A1: 2', 'A0: 3 A1: 4', 'A0: 5 A1: 4']), 'Named pins (A0: 123)');
  assert.equal(f(['1\t2\t3\t9', '4\t5\t6\t9', '4\t5\t7\t9']), 'Tab-separated · 4 values');
  assert.equal(formatName(detectFormat(['1,2', '3,4']), { nxt_logger: 'v1' }), 'OpenGrip logger format');
  assert.equal(formatName(null), 'Unknown format');
});

test('bandwidthCheck: 8 channels at 500 Hz is too much for 115200; 6 at 100 Hz on 9600 too; 6 at 100 Hz on 115200 is fine', () => {
  const a = bandwidthCheck({ baud: 115200, channels: 8, rateHz: 500 });
  assert.equal(a.ok, false);
  assert.match(a.message, /too slow for 8 channels at 500 Hz/);
  const b = bandwidthCheck({ baud: 9600, channels: 6, rateHz: 100 });
  assert.equal(b.ok, false);
  assert.equal(b.message, 'This link is too slow for 6 channels at 100 Hz: use 115200 baud or fewer channels.');
  const c = bandwidthCheck({ baud: 115200, channels: 6, rateHz: 100 });
  assert.equal(c.ok, true);
  assert.equal(c.available, 11520);
  assert.ok(c.load > 0.3 && c.load < 0.4, String(c.load));
  assert.equal(bandwidthCheck({ baud: 115200, channels: 6, rateHz: null }).ok, true);
});

test('port busy: InvalidStateError / NetworkError become the "close the Serial Monitor" message', () => {
  for (const name of ['InvalidStateError', 'NetworkError']) {
    const e = portOpenError(Object.assign(new Error('Failed to open serial port.'), { name }));
    assert.equal(e.message, PORT_BUSY_MESSAGE);
    assert.equal(e.code, 'port_busy');
  }
  const other = new Error('x');
  assert.equal(portOpenError(other), other);
});

test('live quality: follow-ons of a saturation root come back as followOns, never as items', async () => {
  const { generate } = await import('../src/sim/twin.js');
  const S = generate({ seed: 3, faults: ['saturation'] });
  const s = { t: S.t, rows: S.t.map((_, i) => S.data.map((d) => d[i])), labels: S.labels, channelNames: S.channelNames };
  const lq = new LiveQuality({ windowSec: 15 });
  let grouped = 0;
  for (let to = 1500; to <= S.n; to += 500) {
    const part = { t: s.t.slice(0, to), rows: s.rows.slice(0, to), labels: s.labels.slice(0, to), channelNames: s.channelNames };
    const r = lq.update(part);
    assert.ok(r.items.every((it) => it.level !== 'green' && !it.causedBy));
    for (const f of r.followOns) {
      assert.equal(f.level, 'green');
      assert.ok(r.items.some((it) => it.code === f.causedBy && it.channel === f.channel), `${f.code}<${f.causedBy}`);
      assert.ok(Number.isFinite(f.atMs));
      grouped++;
    }
  }
  assert.ok(grouped > 0, 'the saturated channel had follow-on findings');
});
