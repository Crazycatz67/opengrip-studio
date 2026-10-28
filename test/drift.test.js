import test from 'node:test';
import assert from 'node:assert/strict';
import { driftCheck, driftItems, DRIFT_DEFAULTS, DriftTracker, compareDrift } from '../src/drift.js';
import { generate, toLines } from '../src/sim/twin.js';
import { analyzeRecording } from '../src/quality.js';
import { parseText } from '../src/parse.js';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// withCreep bends a session after the fact (D1 tests; the twin also has a 'creep' fault now): every squeeze step's height above
// the rest just before it grows linearly to (1 + gain) by the end of the step.
function withCreep(S, ch, gain) {
  for (let i = 0; i < S.n;) {
    let j = i;
    while (j < S.n && S.labels[j] === S.labels[i]) j++;
    if (/squeeze/.test(S.labels[i])) {
      const rest = S.data[ch][Math.max(0, i - 1)];
      for (let k = i; k < j; k++) S.data[ch][k] = rest + (S.data[ch][k] - rest) * (1 + (gain * (k - i)) / (j - i));
    }
    i = j;
  }
  return S;
}

test('drift: clean twin sessions are Working on every channel (10 seeds x 6 channels)', () => {
  for (const seed of SEEDS) {
    const r = driftCheck(generate({ seed, channels: 6 }));
    assert.equal(r.checked, true, `seed ${seed}: ${r.reason}`);
    for (const ch of r.channels) assert.equal(ch.status, 'Working', `seed ${seed} ch${ch.channel + 1}: ${JSON.stringify(ch)}`);
    assert.deepEqual(r.items.map((it) => it.code), ['drift_ok']);
    assert.equal(r.items[0].status, 'Working');
  }
});

test('drift: a twin band shift raises rest_drift on that channel only (10/10 seeds)', () => {
  for (const seed of SEEDS) {
    const S = generate({ seed, channels: 6, faults: [{ type: 'shift', channel: 2 }] });
    const r = driftCheck(S);
    const flagged = r.items.filter((it) => it.level !== 'green');
    assert.deepEqual(flagged.map((it) => [it.code, it.channel]), [['rest_drift', 2]], `seed ${seed}`);
    const it = flagged[0];
    assert.ok(it.why.restDrift >= DRIFT_DEFAULTS.restCheck);
    assert.equal(it.status, it.level === 'red' ? 'Fix' : 'Check');
    assert.match(it.fix, /^ch3 does not go back to the same rest level/);
    assert.ok(Number.isInteger(it.at) && it.at >= S.n * 0.75 - 200, `at ${it.at}`);
  }
});

test('drift: rest_drift is Fix above restFix, Check between restCheck and restFix', () => {
  const S = generate({ seed: 3, channels: 2, faults: [{ type: 'shift', channel: 1, offset: 140 }] });
  assert.equal(driftCheck(S).channels[1].status, 'Fix');
  const mild = driftCheck(S, { restFix: 0.99 });
  assert.equal(mild.channels[1].status, 'Check');
  assert.equal(mild.items[0].level, 'amber');
});

test('drift: rising squeezes raise hold_creep (Check) on the creeping channel only', () => {
  for (const seed of SEEDS) {
    const r = driftCheck(withCreep(generate({ seed, channels: 6 }), 4, 1));
    const flagged = r.items.filter((it) => it.level !== 'green');
    assert.deepEqual(flagged.map((it) => [it.code, it.channel, it.status]), [['hold_creep', 4, 'Check']], `seed ${seed}`);
    assert.ok(flagged[0].why.holds.length >= 1 && flagged[0].why.creep >= DRIFT_DEFAULTS.creepCheck);
  }
});

test('drift: a hand easing off (falling squeeze) is not creep', () => {
  const r = driftCheck(withCreep(generate({ seed: 2, channels: 3 }), 0, -0.6));
  assert.ok(r.channels[0].creep < 0);
  assert.equal(r.channels[0].status, 'Working');
});

test('drift: unlabelled, empty and NaN input skip with a reason instead of throwing', () => {
  const S = generate({ seed: 1, channels: 2 });
  const cases = [
    [{ data: S.data, rateHz: 100 }, /no step labels/],
    [{ data: [] }, /no data/],
    [{}, /no data/],
    [{ data: [new Array(500).fill(NaN)], labels: new Array(500).fill('rest') }, /no settled rest|no squeeze/],
    [{ data: S.data.map((v) => v.slice(0, 50)), labels: S.labels.slice(0, 50) }, /no settled rest|no squeeze/],
  ];
  for (const [rec, re] of cases) {
    const r = driftCheck(rec);
    assert.equal(r.checked, false);
    assert.match(r.reason, re);
    assert.deepEqual(r.items.map((it) => [it.code, it.level, it.status]), [['drift_unchecked', 'green', 'Working']]);
    assert.ok(r.items[0].fix.length > 0);
  }
});

test('drift: no calibration falls back to the hold height for the span; driftItems = items', () => {
  const S = generate({ seed: 4, channels: 2, faults: [{ type: 'shift', channel: 0 }] });
  const noCal = { ...S, labels: S.labels.map((l) => (l === 'cal_rest' ? 'rest' : l)) };
  const r = driftCheck(noCal);
  assert.equal(r.channels[0].spanFrom, 'holds');
  assert.equal(r.channels[0].status === 'Check' || r.channels[0].status === 'Fix', true);
  assert.deepEqual(driftItems(S), driftCheck(S).items);
});

// Card D2: the twin's creep fault and the wiring into analyzeRecording.
test('twin creep fault: truth lists the >= 1 s squeezes it bent; only that channel changes', () => {
  const clean = generate({ seed: 2, channels: 4 });
  const S = generate({ seed: 2, channels: 4, faults: [{ type: 'creep', channel: 1, gain: 0.5 }] });
  const f = S.truth.faults[0];
  assert.equal(f.channel, 1);
  assert.ok(f.holds.length >= 1 && f.holds.every((h) => /squeeze/.test(h.label) && h.end - h.start >= S.rateHz), JSON.stringify(f.holds));
  assert.equal(f.start, f.holds[0].start);
  for (const c of [0, 2, 3]) assert.deepEqual(S.data[c], clean.data[c]);
  const h = f.holds[0];
  const late = (d) => d.slice(h.end - 20, h.end).reduce((a, b) => a + b, 0);
  assert.ok(late(S.data[1]) > late(clean.data[1]) * 1.15, 'reading rises by the end of the hold');
});

test('analyzeRecording: creep shows hold_creep (Check, fix + why); clean twin sessions show no drift items', () => {
  for (const seed of [1, 2, 3]) {
    const S = generate({ seed, channels: 6, faults: [{ type: 'creep', channel: 4 }] });
    const it = analyzeRecording(parseText(toLines(S, 'nxt').join('\n'))).items.find((x) => x.code === 'hold_creep');
    assert.ok(it && it.level === 'amber' && it.channel === 4, `seed ${seed}`);
    assert.ok(it.fix.length > 10 && it.why && it.why.creep >= DRIFT_DEFAULTS.creepCheck);
    const quiet = analyzeRecording(parseText(toLines(generate({ seed, channels: 6 }), 'nxt').join('\n'))).items;
    assert.deepEqual(quiet.filter((x) => /drift|creep/.test(x.code)).map((x) => x.code), [], `clean seed ${seed}`);
  }
});

test('analyzeRecording: a band shift shows once; its rest_drift turns green, caused by band_shift', () => {
  let demoted = 0;
  for (const seed of SEEDS) {
    const S = generate({ seed, channels: 6, faults: [{ type: 'shift', channel: 2 }] });
    const items = analyzeRecording(parseText(toLines(S, 'nxt').join('\n'))).items;
    for (const it of items.filter((x) => x.code === 'rest_drift' && x.channel === 2)) {
      if (items.some((x) => x.code === 'band_shift' && x.channel === 2 && x.level !== 'green')) { assert.equal(it.level, 'green'); assert.equal(it.causedBy, 'band_shift'); demoted++; }
    }
  }
  assert.ok(demoted >= 1, 'the rule was exercised at least once');
});

// ---------- Live drift (card L1) ----------
// Feed a generated session to a DriftTracker one finished step at a time, as LiveQuality does.
function feed(S, opts = {}) {
  const tr = new DriftTracker({ channels: S.data.length, rateHz: S.rateHz, ...opts });
  const history = [];
  for (let i = 1, start = 0; i <= S.n; i++) {
    if (i < S.n && S.labels[i] === S.labels[i - 1]) continue;
    history.push(tr.push({ label: S.labels[start], start, end: i }, S.data.map((v) => v.slice(start, i))));
    start = i;
  }
  return { tr, history };
}

test('live drift: the tracker fed step by step measures exactly what driftCheck does (shift + creep, 5 seeds)', () => {
  for (const seed of SEEDS.slice(0, 5)) {
    for (const faults of [[], [{ type: 'shift', channel: 2 }], [{ type: 'creep', channel: 1 }]]) {
      const S = generate({ seed, channels: 6, faults });
      const live = feed(S).tr.report();
      const full = driftCheck(S);
      assert.deepEqual(live.channels.map((c) => [c.status, c.restDrift, c.creep]), full.channels.map((c) => [c.status, c.restDrift, c.creep]), `seed ${seed} ${JSON.stringify(faults)}`);
    }
  }
});

test('live drift: clean sessions show nothing live; shift and creep show one item on their channel only', () => {
  let flagged = 0;
  for (const seed of SEEDS.slice(0, 5)) {
    assert.deepEqual(feed(generate({ seed, channels: 6, reps: 12 })).tr.items(), [], `clean seed ${seed}`);
    for (const [type, ch, code] of [['shift', 2, 'rest_drift'], ['creep', 1, 'hold_creep']]) {
      const S = generate({ seed, channels: 6, reps: 12, faults: [{ type, channel: ch }] }); // ~1 min, like a real session
      const it = feed(S).tr.items();
      // Live says what the whole-session report says (creep sits near its first-guess limit on
      // some seeds, e.g. seed 4 = 0.14 < 0.15, so both stay quiet there).
      const want = driftItems(S).filter((x) => x.level !== 'green').map((x) => [x.code, x.channel]);
      assert.deepEqual(it.map((x) => [x.code, x.channel]), want, `${type} seed ${seed}`);
      if (type === 'shift') assert.deepEqual(want, [[code, ch]], `${type} seed ${seed}`);
      else flagged += want.length ? 1 : 0;
      if (!it.length) continue;
      assert.equal(it[0].why.live, true);
      assert.ok(it[0].fix && it[0].message, 'fix line and message for the strip');
      // The report after Save agrees, so compareDrift has nothing to explain.
      assert.deepEqual(compareDrift(it, driftItems(S)), [], `${type} seed ${seed}`);
    }
  }
  assert.ok(flagged >= 2, `creep flagged on ${flagged}/5 seeds`);
});

test('live drift: calm rules: nothing before minSec, confirmed twice, never removed, one per channel', () => {
  const S = generate({ seed: 3, channels: 6, faults: [{ type: 'shift', channel: 2 }, { type: 'creep', channel: 2 }] });
  const { history } = feed(S);
  const firstAt = history.findIndex((h) => h.length);
  assert.ok(firstAt > 0, 'appears only after some steps');
  for (const h of history.slice(firstAt)) {
    assert.equal(h.length, 1, 'stays shown once shown, one item for ch3');
    assert.equal(h[0].code, history[firstAt][0].code, 'the chip never swaps code');
  }
  const eager = feed(S, { confirm: 1 }).history.findIndex((h) => h.length);
  assert.ok(eager < firstAt, `confirm 2 waits for a second check (${eager} < ${firstAt})`);
  assert.deepEqual(feed(S, { minSec: 1e6 }).tr.items(), [], 'too little data: nothing');
});

test('live drift: softened, not removed, when later checks pass; compareDrift says why the report differs', () => {
  const tr = new DriftTracker({ channels: 1, rateHz: 100, minSec: 0, confirm: 1 });
  const flat = (len, x) => [Array.from({ length: len }, () => x)];
  tr.push({ label: 'cal_rest', start: 0, end: 200 }, flat(200, 100));
  tr.push({ label: 'cal_squeeze', start: 200, end: 300 }, flat(100, 600));
  tr.push({ label: 'rest', start: 1600, end: 1800 }, flat(200, 250)); // up 30% of the span
  assert.equal(tr.items()[0].code, 'rest_drift');
  tr.push({ label: 'rest', start: 3000, end: 3400 }, flat(400, 100)); // back to the start level
  const [it] = tr.items();
  assert.equal(it.level, 'amber');
  assert.equal(it.why.settled, true);
  const diff = compareDrift([it], []);
  assert.equal(diff.length, 1);
  assert.match(diff[0].note, /came back/);
  assert.doesNotThrow(() => { tr.push(null, null); tr.push({ label: 'open', start: 0, end: 5 }, [[1]]); tr.push({ label: 'rest', start: 5, end: 5 }, [[]]); });
});

// Card B1: squeeze holds sag (the hand tires) and used to outvote the steady calibration
// squeezes, hiding creep (7/40 at gain 0.5). The steadiest task's median now reads it.
test('drift B1: creep on squeeze sessions is caught from the steady task; clean squeeze sessions stay quiet', () => {
  let hit = 0, old = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const S = generate({ seed, channels: 6, gesture: 'squeeze', faults: [{ type: 'creep', channel: 2, gain: 0.5 }] });
    const flags = (r) => r.items.filter((x) => x.code === 'hold_creep').map((x) => x.channel);
    const now = flags(driftCheck(S));
    assert.ok(now.every((c) => c === 2), `seed ${seed}: only the creeping channel`);
    if (now.includes(2)) hit++;
    if (flags(driftCheck(S, { creepBy: 'all' })).includes(2)) old++;
    const clean = driftCheck(generate({ seed, channels: 6, gesture: 'squeeze' }));
    assert.deepEqual(clean.items.filter((x) => x.code === 'hold_creep'), [], `clean squeeze seed ${seed}`);
  }
  assert.ok(hit >= 6 && hit > old, `caught ${hit}/10 (all-holds median ${old}/10)`);
});

test('drift B1: a single hold per task falls back to the all-holds median', () => {
  const S = withCreep(generate({ seed: 3, channels: 2 }), 1, 1);
  const a = driftCheck(S, { creepTaskHolds: 99 }).channels[1].creep;
  assert.equal(a, driftCheck(S, { creepBy: 'all' }).channels[1].creep);
});
