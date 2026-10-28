import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/sim/twin.js';
import { ringPreset } from '../src/placement.js';
import { fingerprints, cellAt, cosine, FP_POSITIONS, SIZE_RATIO } from '../src/fingerprint.js';

// The twin records one gesture per session, so a grip + open recording is two sessions end to end.
const join = (a, b) => ({ ...a, data: a.data.map((d, c) => d.concat(b.data[c])), labels: a.labels.concat(b.labels) });
function twinRing({ cm, seed = 1, count = 8, emg = [] }) {
  const placement = ringPreset({ count, cmFromElbowCrease: cm, emg });
  const ch = count + emg.length;
  const g = generate({ seed, channels: ch, gesture: 'grip', placement, positions: ['down', 'elbow90'] });
  const o = generate({ seed: seed + 10, channels: ch, gesture: 'open', placement, calibration: false, distractors: 0 });
  return { rec: join(g, o), placement };
}
const pairOf = (fp, a, b) => fp.pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));

test('cosine: same direction 1, orthogonal 0, zero vector 0', () => {
  assert.equal(cosine([1, 2], [2, 4]).toFixed(6), '1.000000');
  assert.equal(cosine([1, 0], [0, 3]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

test('cells: one per gesture x position, steps counted, means 0-1, calibration basis', () => {
  const { rec, placement } = twinRing({ cm: 3 });
  const fp = fingerprints(rec, { placement });
  assert.equal(fp.basis, 'calibration');
  assert.deepEqual(fp.positions, FP_POSITIONS);
  assert.deepEqual(fp.cells.map((c) => c.key).sort(), ['elbow_bend@down', 'grip@down', 'grip@elbow90', 'open@down']);
  assert.ok(cellAt(fp, 'elbow_bend', 'down').distractor);
  assert.equal(cellAt(fp, 'grip', 'raised'), null);
  for (const c of fp.cells) {
    assert.ok(c.steps >= 1 && c.samples > 10, c.key);
    assert.equal(c.mean.length, 8);
    for (const m of c.mean) assert.ok(m >= 0 && m <= 1, `${c.key} ${m}`);
    for (const s of c.spread) assert.ok(Number.isFinite(s) && s >= 0);
  }
});

test('grip vs open: different patterns, never flagged (seeds 1-3, 2-8 cm)', () => {
  for (const cm of [2, 3, 5, 8]) for (const seed of [1, 2, 3]) {
    const { rec, placement } = twinRing({ cm, seed });
    const p = pairOf(fingerprints(rec, { placement }), 'grip@down', 'open@down');
    assert.ok(p.similarity < 0.6 && !p.flagged, `${cm} cm seed ${seed}: ${p.similarity}`);
  }
});

// Ratio table (size/cosine, seeds 1-5) is in the B5 hand-back: 2 cm size 1.01-1.75, 8 cm 0.13-0.26
// against SIZE_RATIO 0.35, the same with 6 FMG + 2 EMG and with a dropout fault.
const CONFIGS = [{ count: 8 }, { count: 6, emg: [{ muscle: 'flexors' }, { muscle: 'extensors' }] }, { count: 8, faults: ['dropout'] }];
function gripOnly({ cm, seed, count, emg = [], faults = [] }) {
  const placement = ringPreset({ count, cmFromElbowCrease: cm, emg });
  const rec = generate({ seed, channels: count + emg.length, gesture: 'grip', placement, positions: ['down', 'elbow90'], faults });
  return fingerprints(rec, { placement });
}

test('grip vs elbow bend: flagged with the ring near the elbow, not at 8 cm (seeds 1-5, 3 setups)', () => {
  for (const c of CONFIGS) for (const seed of [1, 2, 3, 4, 5]) {
    const near = gripOnly({ cm: 2, seed, ...c });
    const p = pairOf(near, 'grip@down', 'elbow_bend@down');
    assert.ok(p.flagged, `2 cm ${c.count} seed ${seed}: ${p.similarity} ${p.size}`);
    assert.match(p.text, /^GRIP \(arm down\) looks \d+% like ELBOW BEND \(arm down\) on (these sensors|the FMG sensors alone)\. ELBOW BEND reaches \d+% of GRIP \(arm down\) on the same sensors\./);
    assert.ok(near.lookAlike.includes(p));
    assert.match(near.summary, /look alike on this recording/);

    const far = gripOnly({ cm: 8, seed, ...c });
    const q = pairOf(far, 'grip@down', 'elbow_bend@down');
    assert.ok(!q.flagged && q.size < SIZE_RATIO, `8 cm ${c.count} seed ${seed}: size ${q.size}`);
    assert.equal(far.lookAlike.length, 0);
    assert.equal(far.summary, 'Each gesture has its own pattern on this recording.');
  }
});

test('EMG channels: similarity on FMG only, and an EMG channel that tells them apart is named', () => {
  const { rec, placement } = twinRing({ cm: 3, count: 6, emg: [{ muscle: 'flexors' }, { muscle: 'extensors' }] });
  const fp = fingerprints(rec, { placement });
  assert.deepEqual(fp.fmg, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(fp.channels.map((c) => c.sensor), ['FMG', 'FMG', 'FMG', 'FMG', 'FMG', 'FMG', 'EMG', 'EMG']);
  const p = pairOf(fp, 'grip@down', 'elbow_bend@down');
  assert.match(p.text, /on the FMG sensors alone/);
  if (p.tell) assert.match(p.text, new RegExp(`EMG channel ${p.tell.ch} tells them apart \\(\\d\\.\\d\\d vs \\d\\.\\d\\d\\)`));
});

test('no calibration: recording basis; no labels / empty input: no cells, no throw', () => {
  const placement = ringPreset({ count: 6, cmFromElbowCrease: 3 });
  const g = generate({ seed: 4, channels: 6, gesture: 'grip', placement, calibration: false });
  const fp = fingerprints(g, { placement });
  assert.equal(fp.basis, 'recording');
  assert.ok(fp.cells.length >= 2);
  assert.equal(fingerprints({ ...g, labels: [] }).cells.length, 0);
  const empty = fingerprints({ data: [], labels: [] });
  assert.equal(empty.cells.length, 0);
  assert.match(empty.summary, /No gesture steps/);
  assert.doesNotThrow(() => fingerprints({ data: [[NaN, NaN, 3]], labels: ['grip', 'grip', 'grip'] }));
  assert.doesNotThrow(() => fingerprints(null));
});
