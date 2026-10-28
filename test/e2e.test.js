// End to end without hardware: FakeSource and a mock Arduino on a mock navigator.serial,
// through detection, session, autosave, CSV and quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeSource, SerialSource } from '../src/sources.js';
import { Ingest } from '../src/pipeline.js';
import { Session } from '../src/session.js';
import { defaultProtocol, totalSeconds } from '../src/protocol.js';
import { toCSV, fromCSV } from '../src/csv.js';
import { analyzeRecording } from '../src/quality.js';
import { AutoSaver, memoryBackend, loadSession, listSessions } from '../src/store.js';
import { createMockSerial } from '../src/sim/mockserial.js';
import { fixtureText } from './helpers.js';

test('FakeSource -> Ingest -> guided Session -> autosave -> CSV -> quality', async () => {
  let clock = 0;
  const protocol = defaultProtocol();
  const session = new Session({ protocol, now: () => clock });
  const fake = new FakeSource({ channels: 6, rateHz: 100, labelProvider: () => session.currentLabel(clock) });
  const backend = memoryBackend();
  const saver = new AutoSaver({ backend, everySamples: 1000, now: () => clock });
  let format = null;
  const ing = new Ingest({ onSample: (s) => session.push(s), onFormat: (f) => { format = f; }, onMeta: (m) => Object.assign(session.meta, m) });
  session.start({ person_id: 'P01' });
  await saver.begin({ meta: session.meta, channels: 6 });
  ing.push(fake.header(), 0);
  const n = Math.round(totalSeconds(protocol) * 100);
  for (let i = 0; i < n; i++) {
    clock = i * 10;
    ing.push(fake.nextLine(), clock);
    if (i % 250 === 0) await saver.add(session.drain(), session.drainMarkers());
  }
  // The first 20 lines wait in the detector, so the tail is still pending in Ingest only if
  // detection never finished; it did, so every line reached the session.
  session.stop();
  await saver.add(session.drain(), session.drainMarkers());
  await saver.finish();
  assert.equal(format.kind, 'timed');
  assert.equal(format.channels, 6);
  const rec = session.recording();
  assert.equal(rec.t.length, n);
  assert.equal(rec.rateHz, 100);
  assert.equal(ing.rate().hz, 100);
  assert.equal(rec.labels[0], 'cal_rest');
  assert.ok(rec.labels.includes('grip@raised'));

  const back = fromCSV(toCSV(rec, { person_id: 'P01', sensors: 'FMG,FMG,FMG,FMG,FMG,FMG' }));
  assert.deepEqual(back.data, rec.data);
  assert.deepEqual(back.labels, rec.labels);

  const q = analyzeRecording(back);
  assert.ok(q.calibration, 'calibration found');
  assert.ok(q.calibration.squeeze[0] > q.calibration.rest[0] + 100);
  assert.equal(q.channels[1].dropouts.length, 4, 'fake dropout at 20 s of each minute');
  assert.ok(q.items.some((i) => i.code === 'position' && i.level === 'red'), 'elbow artifact flagged');
  // Grips in the bent/raised positions ride on the arm offset and can merge; >= 10 of 18.
  assert.ok(q.channels[0].burstCount >= 10, `bursts ${q.channels[0].burstCount}`);

  const saved = await loadSession(backend, saver.id);
  assert.equal(saved.t.length, n);
  assert.deepEqual(saved.data, rec.data);
  assert.equal((await listSessions(backend))[0].complete, true);
});

test('mock Arduino at 9600 (legacy fixture): baud + format auto-detect, unplug, reconnect, recover', async () => {
  const text = fixtureText('synth_grip_fade.txt');
  const total = text.split(/\r?\n/).filter(Boolean).length;
  const mock = createMockSerial({ text, deviceBaud: 9600, lineRateHz: 100, speed: 4, resetOnOpen: true, seed: 3 });
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const src = new SerialSource({ serial: mock.serial, storage, resetWaitMs: 150, probeMs: 400 });
  const session = new Session({});
  const backend = memoryBackend();
  const saver = new AutoSaver({ backend, everySamples: 100 });
  const statuses = [];
  let format = null;
  const ing = new Ingest({ onSample: (s) => session.push(s), onFormat: (f) => { format = f; } });

  await src.choosePort();
  const det = await src.detectBaud();
  assert.equal(det.baud, 9600, det.message);
  assert.equal(det.results[0].baud, 115200);
  assert.ok(det.results[0].fraction < 0.8);
  assert.equal(store.get('opengrip.lastBaud'), '9600');

  session.start({ person_id: 'P02' });
  await saver.begin({ meta: session.meta, channels: 1 });
  const done = new Promise((resolve) => {
    src.start({
      onLine: (l, t) => { ing.push(l, t); saver.add(session.drain(), session.drainMarkers()); if (statuses.includes('disconnected') && mock.atEnd()) resolve(); },
      onStatus: (s) => {
        statuses.push(s);
        if (s === 'disconnected') { session.disconnected(); setTimeout(() => mock.replug(), 100); }
        if (s === 'connected' && statuses.includes('disconnected')) session.reconnected();
      },
    });
  });
  await new Promise((r) => setTimeout(r, 900));
  mock.unplug();
  await done;
  await new Promise((r) => setTimeout(r, 100));
  await src.stop();
  session.stop();
  await saver.add(session.drain(), session.drainMarkers());
  await saver.flush();

  assert.equal(format.kind, 'single');
  assert.ok(statuses.includes('disconnected') && statuses.includes('reconnecting'), statuses.join(','));
  assert.deepEqual(session.markers.map((m) => m.note), ['disconnected', 'reconnected']);
  const rec = session.recording();
  // The Uno resets on every open, so after the reconnect the sketch (here: the replay)
  // starts again. Everything after the 'reconnected' marker is the whole file, intact.
  const from = session.markers[1].index;
  const after = rec.data[0].slice(from);
  const ref = text.split(/\r?\n/).filter(Boolean).slice(1).map(Number);
  assert.ok(after.length >= total - 2, `${after.length}/${total}`);
  assert.deepEqual(after.slice(-ref.length), ref);
  assert.ok(from > 50, `kept ${from} samples from before the unplug`);
  const q = analyzeRecording({ data: [after] });
  assert.ok(q.channels[0].burstCount >= 4 && q.channels[0].burstCount <= 6, String(q.channels[0].burstCount));
  assert.ok(ing.rate().approx && ing.rate().hz > 0);

  // "Page reload": everything recorded is recoverable from the store.
  const saved = await loadSession(backend, saver.id);
  assert.equal(saved.t.length, rec.t.length);
  assert.deepEqual(saved.data, rec.data);
  assert.equal(saved.markers.length, 2);
  assert.equal(saved.complete, false);
});
