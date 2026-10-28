import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, rng } from '../src/sim/twin.js';
import { compareRecordings, scoreRecording, scorecardJSON, scorecardHTML, intervalSVG, METRICS } from '../src/scorecard.js';

// Known-better and known-worse designs from the twin. B is the same arm with a worse sleeve:
// extra noise on every channel, six contact dropouts and the band sliding on ch1.
const BASE = { channels: 4, reps: 8, distractors: 3 };
function clean(seed) { return generate({ ...BASE, seed }); }
function worse(seed) {
  const S = generate({ ...BASE, seed: seed + 1, faults: ['dropout:6', { type: 'shift', channel: 0 }] });
  const r = rng(seed * 31 + 7);
  S.data = S.data.map((v) => v.map((x) => (x === 0 ? 0 : Math.max(1, Math.min(1023, Math.round(x + r.normal(0, 6)))))));
  return S;
}
// A plain recording as fromCSV() gives it: no synthetic flag, with the session meta.
function asCSV(S, meta = {}) {
  return { data: S.data, labels: S.labels, rateHz: S.rateHz, channelNames: S.channelNames, markers: [], meta: { person_id: 'P03', protocol: 'OpenGrip default v2', started_at: '2026-10-21T14:02:00Z', ...meta } };
}
const row = (card, key, view = 0) => card.views[view].rows.find((r) => r.key === key);
const excludesNoDiff = (r) => (r.scale === 'ratio' ? r.lo > 1 || r.hi < 1 : r.lo > 0 || r.hi < 0);
const SHOULD_LOSE = ['srr', 'restNoise', 'dropouts', 'spikes', 'drift'];

for (const seed of [3, 11]) {
  test(`clean A beats noisy B on the right metrics, intervals exclude no difference (seed ${seed})`, () => {
    const card = compareRecordings(clean(seed), worse(seed), { names: ['Spandex', 'Nylon'], seed });
    for (const k of SHOULD_LOSE) {
      const r = row(card, k);
      assert.equal(r.verdict, 'A', `${k}: ${r.sentence}`);
      assert.equal(r.winner, 'Spandex');
      assert.ok(excludesNoDiff(r), `${k} interval ${r.lo}..${r.hi}`);
    }
    // The worse design never "wins" a row: no metric is fooled by noise or dropouts.
    assert.deepEqual(card.views[0].rows.filter((r) => r.verdict === 'B').map((r) => r.key), []);
    // The band slid on ch1 only: its own view shows the drift clearly.
    assert.equal(row(card, 'drift', 1).verdict, 'A');
    assert.ok(row(card, 'drift', 1).effect > 3 * row(card, 'drift', 2).effect, 'drift concentrated on ch1');
    assert.equal(card.views[0].overall.verdict, 'A');
    assert.ok(card.views[0].overall.points.A >= METRICS.filter((m) => SHOULD_LOSE.includes(m.key)).reduce((t, m) => t + m.weight, 0) && card.views[0].overall.points.B === 0, JSON.stringify(card.views[0].overall.points));
  });
}

test('swapping A and B swaps every verdict', () => {
  const ab = compareRecordings(clean(3), worse(3));
  const ba = compareRecordings(worse(3), clean(3));
  const flip = { A: 'B', B: 'A', none: 'none', na: 'na' };
  for (const k of SHOULD_LOSE) assert.equal(row(ba, k).verdict, flip[row(ab, k).verdict], k);
  assert.ok(Math.abs(row(ba, 'srr').effect * row(ab, 'srr').effect - 1) < 1e-9, 'ratio inverts');
});

test('A vs a copy of A: no clear difference on every metric, in every view', () => {
  for (const seed of [3, 7]) {
    const A = clean(seed);
    const card = compareRecordings(A, structuredClone(A), { seed });
    for (const v of card.views) {
      for (const r of v.rows) assert.equal(r.verdict, 'none', `${v.name} ${r.key} ${r.lo}..${r.hi}`);
      assert.equal(v.overall.verdict, 'none');
      assert.deepEqual(v.overall.points, { A: 0, B: 0 });
    }
    assert.equal(row(card, 'srr').effect, 1);
  }
});

test('fairness: a matched pair gives only the order note', () => {
  const card = compareRecordings(asCSV(clean(3)), asCSV(worse(3), { started_at: '2026-10-21T14:20:00Z' }), { names: ['Spandex', 'Nylon'] });
  assert.deepEqual(card.fairness.map((f) => `${f.level}:${f.code}`), ['info:order']);
  assert.match(card.fairness[0].message, /Spandex was recorded first, 18 min before Nylon.*A-B-B-A/);
  assert.equal(card.synthetic, false);
});

test('fairness: each mismatch fires its own warning', () => {
  const A = asCSV(clean(3));
  const few = generate({ ...BASE, seed: 5, channels: 3, reps: 4, calibration: false, rateHz: 200 });
  const B = asCSV(few, { person_id: 'P07', protocol: 'quick v1', started_at: undefined });
  const card = compareRecordings(A, B, { names: ['Flat', 'Puck'] });
  const codes = card.fairness.map((f) => f.code);
  for (const c of ['protocol', 'person', 'channels', 'rate', 'reps', 'calibration', 'order']) assert.ok(codes.includes(c), `${c} in ${codes}`);
  const msg = (c) => card.fairness.find((f) => f.code === c).message;
  assert.match(msg('reps'), /Puck: fewer than 5 repetitions of grip \(4\)/);
  assert.match(msg('channels'), /only the first 3/);
  assert.match(msg('order'), /order unknown/i);
  assert.equal(card.views.length, 1 + 3, 'all + the 3 shared channels');
  // Missing person ID is a warning too: nobody knows it is the same arm.
  const anon = compareRecordings(asCSV(clean(3), { person_id: '' }), asCSV(clean(4)));
  assert.match(anon.fairness.find((f) => f.code === 'person').message, /missing/);
  // Different label sets count as different protocols when no protocol name is saved.
  const noName = compareRecordings(asCSV(clean(3), { protocol: '' }), asCSV(generate({ ...BASE, seed: 4, gesture: 'squeeze' }), { protocol: '' }));
  assert.ok(noName.fairness.some((f) => f.code === 'protocol'));
});

test('a synthetic source is labelled in the warnings and in every sentence', () => {
  const card = compareRecordings(clean(3), worse(3));
  assert.equal(card.synthetic, true);
  assert.equal(card.fairness[0].code, 'synthetic');
  for (const r of card.views[0].rows) if (r.verdict !== 'na') assert.match(r.sentence, /^Synthetic data: /);
  assert.match(card.views[0].overall.sentence, /^Synthetic data: /);
});

test('honest wording: this person, today, factor and 95% CI; never beyond the data', () => {
  const card = compareRecordings(asCSV(worse(3)), asCSV(clean(3)), { names: ['Spandex', 'Nylon'], today: '2026-10-21' });
  const s = row(card, 'srr').sentence;
  assert.match(s, /^On this person \(P03\), today, Nylon had a \d+\.\d× higher signal-to-rest ratio than Spandex \(95% CI \d+\.\d-\d+\.\d\)\. Higher is better, so Nylon comes out ahead here\.$/);
  const later = compareRecordings(asCSV(worse(3)), asCSV(clean(3)), { today: '2026-11-02' });
  assert.match(row(later, 'srr').sentence, /^On this person \(P03\), on 2026-10-21, /);
  const none = compareRecordings(asCSV(clean(3)), asCSV(clean(3)));
  assert.match(row(none, 'cv').sentence, /includes 0, so: no clear difference\.$/);
  for (const v of card.views) for (const r of v.rows) assert.doesNotMatch(r.sentence, /always|in general|proves|everyone/i);
});

test('missing pieces give "not measurable", never a throw or a point', () => {
  const noArm = generate({ ...BASE, seed: 3, distractors: 0 });
  const card = compareRecordings(noArm, clean(4));
  assert.equal(row(card, 'arm').verdict, 'na');
  assert.match(row(card, 'arm').sentence, /elbow-only step/);
  assert.equal(card.views[0].overall.na, METRICS.find((m) => m.key === 'arm').weight);
  const bare = { data: [[1, 2, 3], [4, 5, 6]] };
  const c2 = compareRecordings(bare, bare);
  assert.ok(c2.views[0].rows.every((r) => r.verdict === 'na' || r.verdict === 'none'));
  assert.doesNotThrow(() => compareRecordings({ data: [] }, { data: [] }));
});

test('scores are reproducible, weights are exposed, export is clean', () => {
  const a = compareRecordings(clean(3), worse(3), { seed: 9 });
  const b = compareRecordings(clean(3), worse(3), { seed: 9 });
  assert.equal(scorecardJSON(a), scorecardJSON(b));
  assert.equal(a.totalWeight, a.weights.reduce((s, w) => s + w.weight, 0));
  const back = JSON.parse(scorecardJSON(compareRecordings(generate({ ...BASE, seed: 3, distractors: 0 }), clean(4))));
  assert.equal(back.views[0].rows.find((r) => r.key === 'arm').a, null, 'NaN written as null');
  const html = scorecardHTML(compareRecordings(clean(3), worse(3), { names: ['<b>x</b>', 'Nylon'] }));
  assert.match(html, /^<!doctype html>/);
  assert.ok(!html.includes('<b>x</b>') && html.includes('&lt;b&gt;x&lt;/b&gt;'), 'names escaped');
  assert.equal((html.match(/<svg class="sc-ci"/g) || []).length, METRICS.length);
  assert.match(intervalSVG(row(a, 'srr')), /<circle/);
  assert.doesNotMatch(intervalSVG({ scale: 'diff', effect: NaN, lo: NaN, hi: NaN }), /<circle/);
});

test('recording score: reps, normalisation source and setup time from markers', () => {
  const S = asCSV(clean(3));
  S.markers = [{ t: 1000, note: 'setup start' }, { t: 95000, note: 'setup done' }];
  const sc = scoreRecording(S);
  assert.deepEqual(sc.repCounts, { grip: 8 });
  assert.equal(sc.units.arms.length, 3);
  assert.ok(sc.spanSource.every((s) => s === 'calibration'));
  assert.equal(sc.setupSeconds, 94);
  const noCal = scoreRecording(generate({ ...BASE, seed: 3, calibration: false }));
  assert.ok(noCal.spanSource.every((s) => s === 'grips' || s === null));
});

// Pooling: several sessions per design (A1+A2 vs B1+B2).
test('single pair: a one-element array gives the same card as the recording itself', () => {
  const x = compareRecordings(clean(3), worse(3), { seed: 4, boot: 400 });
  const y = compareRecordings([clean(3)], [worse(3)], { seed: 4, boot: 400 });
  assert.equal(scorecardJSON(x), scorecardJSON(y));
  assert.equal(x.pooled, false);
  assert.deepEqual(x.a.pool, { recordings: 1, volunteers: 0, unknownPeople: 1 });
});

test('pooled: clean sessions beat noisy sessions, counts and small-sample label shown', () => {
  const A = [asCSV(clean(3), { started_at: '2026-10-21T14:00:00Z' }), asCSV(clean(11), { started_at: '2026-10-21T14:30:00Z' })];
  const B = [asCSV(worse(3), { started_at: '2026-10-21T14:10:00Z' }), asCSV(worse(11), { started_at: '2026-10-21T14:20:00Z' })];
  const card = compareRecordings(A, B, { names: ['Spandex', 'Nylon'], boot: 600, today: '2026-10-21' });
  assert.equal(card.pooled, true);
  for (const k of ['srr', 'restNoise', 'dropouts']) assert.equal(row(card, k).verdict, 'A', `${k}: ${row(card, k).sentence}`);
  assert.deepEqual(card.views[0].rows.filter((r) => r.verdict === 'B').map((r) => r.key), []);
  const f = Object.fromEntries(card.fairness.map((x) => [x.code, x.message]));
  assert.match(f.pool, /Spandex: 2 recordings from 1 volunteer \(P03\)\. Nylon: 2 recordings from 1 volunteer \(P03\)\. Each recording counts equally/);
  assert.equal(card.fairness.filter((x) => x.code === 'pool-small' && x.level === 'warn').length, 2);
  assert.match(f.order, /Recording order: Spandex, Nylon, Nylon, Spandex\. The sides are interleaved/);
  assert.ok(!f.person, 'same volunteer on both sides: no person warning');
  assert.match(row(card, 'srr').sentence, /On this person \(P03\), today, /);
  assert.equal(card.a.recordings.length, 2);
  assert.deepEqual(card.b.pool, { recordings: 2, volunteers: 1, unknownPeople: 0 });
  assert.match(scorecardHTML(card), /These numbers describe these 4 recordings only/);
});

test('pooled: a long recording does not dominate (equal weight per recording)', () => {
  const short = clean(3); const long = generate({ ...BASE, reps: 24, seed: 5 });
  const card = compareRecordings([short, long], clean(7), { boot: 200 });
  for (const k of ['srr', 'cv', 'restNoise']) {
    const each = [short, long].map((s) => row(compareRecordings(s, clean(7), { boot: 200 }), k).a);
    assert.ok(Math.abs(row(card, k).a - (each[0] + each[1]) / 2) < 1e-9, `${k}: ${row(card, k).a} vs ${each}`);
  }
  // One side of one recording against a pool still pools, and says so.
  assert.equal(card.pooled, true);
  assert.match(card.fairness.find((x) => x.code === 'pool').message, /A: 2 recordings from 0 volunteers plus 2 with no person ID\. B: 1 recording/);
});

test('pooled: different volunteers and blocked order are flagged; copies give no difference', () => {
  const A = [asCSV(clean(3), { person_id: 'P01', started_at: '2026-10-21T14:00:00Z' }), asCSV(clean(11), { person_id: 'P02', started_at: '2026-10-21T14:10:00Z' })];
  const B = [asCSV(clean(3), { person_id: 'P01', started_at: '2026-10-21T15:00:00Z' }), asCSV(clean(11), { person_id: 'P03', started_at: '2026-10-21T15:10:00Z' })];
  const card = compareRecordings(A, B, { boot: 400 });
  const f = Object.fromEntries(card.fairness.map((x) => [x.code, x.message]));
  assert.match(f.person, /different volunteers \(A: P01, P02; B: P01, P03\)/);
  assert.match(f.order, /Every A session came before every B session/);
  assert.match(row(card, 'srr').sentence, /On these 3 volunteers, on 2026-10-21, /);
  assert.ok(card.views[0].rows.every((r) => r.verdict === 'none' || r.verdict === 'na'), card.views[0].rows.map((r) => r.verdict).join(','));
  assert.match(card.views[0].overall.sentence, /No clear overall difference/);
});
