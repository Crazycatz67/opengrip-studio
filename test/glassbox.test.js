// Glass Box classifier core: features, LDA, honest evaluation (RISKS B13/B14/B18).
// The twin checks show the pipeline handles the twin; synthetic data is never evidence of accuracy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { featuresAt, windowStarts, windowSamples, featureNames } from '../src/glassbox/features.js';
import { fitLDA, predict, predictProba } from '../src/glassbox/lda.js';
import { prepare, evaluate, smoothVote, defaultClassOf } from '../src/glassbox/evaluate.js';
import { generate } from '../src/sim/twin.js';
import { fingerprints } from '../src/fingerprint.js';
import { mulberry32 } from '../src/sim/uart.js';

test('features match the feasibility.py definitions on a hand-worked window', () => {
  // x = 0, 2, -1, 3, -2; threshold 1. d = 2, -3, 4, -5.
  const f = featuresAt([[0, 2, -1, 3, -2]], 4, 5, { features: ['mav', 'rms', 'wl', 'zc', 'ssc', 'mean'] });
  assert.equal(f[0], 1.6);
  assert.ok(Math.abs(f[1] - Math.sqrt(3.6)) < 1e-12);
  assert.deepEqual(f.slice(2), [14, 3, 3, 0.4]);
  // Below the threshold a sign change is noise, not a crossing.
  assert.deepEqual(featuresAt([[0.2, -0.2, 0.2, -0.2]], 3, 4, { features: ['zc', 'ssc'] }), [0, 0]);
  // Feature-major layout, like np.concatenate([mav, rms, ...]).
  assert.deepEqual(featuresAt([[1, 1, 1], [3, 3, 3]], 2, 3, { features: ['mav', 'mean'] }), [1, 3, 1, 3]);
  assert.deepEqual(featureNames(['mav', 'wl'], ['a', 'b']), ['mav:a', 'mav:b', 'wl:a', 'wl:b']);
});

test('features are causal; windows follow Python range(0, n - win, step)', () => {
  const x = Array.from({ length: 50 }, (_, i) => Math.sin(i) * 10);
  const y = x.slice(); y[30] = 999; y[49] = -999;
  assert.deepEqual(featuresAt([x], 29, 20), featuresAt([y], 29, 20));
  assert.notDeepEqual(featuresAt([x], 30, 20), featuresAt([y], 30, 20));
  assert.throws(() => featuresAt([x], 18, 20), RangeError);
  assert.deepEqual(windowStarts(100, 40, 10), [0, 10, 20, 30, 40, 50]);
  assert.deepEqual(windowSamples(200), { win: 40, step: 10 });
  assert.deepEqual(windowSamples(100), { win: 20, step: 5 });
  // center: offset removed for the time-domain features only (FMG has an ADC offset).
  const c = featuresAt([[500, 502, 499, 503, 498]], 4, 5, { features: ['zc', 'mean'], center: true });
  assert.deepEqual(c, [4, 500.4]); // -0.4, 1.6, -1.4, 2.6, -2.4
});

function blobs(seed, n = 60) {
  const r = mulberry32(seed);
  const g = () => { let s = 0; for (let k = 0; k < 6; k++) s += r(); return s - 3; };
  const X = [], y = [];
  for (let i = 0; i < n; i++) { const k = i % 3; X.push([k * 3 + g(), -k * 2 + g(), 7]); y.push(['rest', 'open', 'grip'][k]); }
  return { X, y };
}

test('LDA separates blobs, is deterministic and survives a constant feature', () => {
  const { X, y } = blobs(1);
  const m = fitLDA(X, y);
  assert.deepEqual(m.classes, ['grip', 'open', 'rest']);
  assert.equal(m.rank, 2); // the constant third column is dropped, not a crash
  const t = blobs(2);
  const right = t.X.filter((x, i) => predict(m, x) === t.y[i]).length;
  assert.ok(right / t.X.length > 0.9, `blob accuracy ${right}/${t.X.length}`);
  const p = predictProba(m, t.X[0]);
  assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.deepEqual(JSON.stringify(fitLDA(X, y)), JSON.stringify(m));
  assert.deepEqual(fitLDA([[0], [1], [5], [6]], [5, 0, 6, 1]).classes, [0, 1, 5, 6]);
});

test('LDA shrinkage: fits with more features than windows; auto stays in 0..1', () => {
  const r = mulberry32(4);
  const X = Array.from({ length: 8 }, (_, i) => Array.from({ length: 20 }, () => r() + (i % 2) * 2));
  const y = X.map((_, i) => (i % 2 ? 'grip' : 'rest'));
  const m = fitLDA(X, y, { shrinkage: 0.5 });
  assert.equal(predict(m, X[1]), 'grip');
  const a = fitLDA(X, y, { shrinkage: 'auto' });
  assert.ok(a.shrinkage >= 0 && a.shrinkage <= 1, `auto shrinkage ${a.shrinkage}`);
  assert.throws(() => fitLDA([[1], [NaN]], ['a', 'b']), /NaN/);
  assert.throws(() => fitLDA([[1], [2]], ['a', 'a']), /two classes/);
});

test('majority vote: last k decisions, ties to the first class (like np.bincount().argmax())', () => {
  assert.deepEqual(smoothVote(['b', 'a', 'a', 'b', 'b'], 3, ['a', 'b']), ['b', 'a', 'a', 'a', 'b']);
  assert.deepEqual(smoothVote([1, 0, 1], 1, [0, 1]), [1, 0, 1]);
  assert.equal(defaultClassOf('grip@elbow90'), 'grip');
  assert.equal(defaultClassOf('rest@raised'), 'rest');
  assert.equal(defaultClassOf('cal_squeeze'), null);
  assert.equal(defaultClassOf('elbow_bend'), null);
});

// Two FMG sensors, palm and back side, `cm` from the elbow crease.
const place = (cm) => ({ channels: [{ ch: 1, sensor: 'FMG', side: 'palm', cmFromElbowCrease: cm }, { ch: 2, sensor: 'FMG', side: 'back', cmFromElbowCrease: cm }] });
const session = (gesture, seed, cm, id) => ({ ...generate({ seed, channels: 2, gesture, reps: 6, holdS: 2, distractors: 6, positions: ['down'], placement: place(cm) }), session: id });
const twinSet = (cm, base = 10) => [session('grip', base, cm, 'A'), session('open', base + 1, cm, 'A'), session('grip', base + 2, cm, 'B'), session('open', base + 3, cm, 'B')];
const FMG = { features: ['mean'] };

test('twin: rest/open/grip separate on a new session; far from the elbow, bends do not trigger', () => {
  for (const base of [10, 20, 30]) {
    const r = evaluate(prepare(twinSet(8, base), FMG), { split: { by: 'session', testSessions: ['B'] }, vote: 3 });
    assert.deepEqual(r.classes, ['grip', 'open', 'rest']);
    assert.ok(r.balancedAccuracy >= 0.8, `seed ${base}: balanced ${r.balancedAccuracy}`);
    assert.ok(Math.abs(r.balancedAccuracy - Object.values(r.recall).reduce((a, b) => a + b, 0) / 3) < 1e-12);
    assert.equal(r.falseTriggers.rest.count, 0);
    assert.equal(r.falseTriggers.distractor.count, 0);
    assert.ok(r.falseTriggers.distractor.minutes > 0.1);
    assert.ok(r.delay.medianMs > 0 && r.delay.medianMs < 600, `delay ${r.delay.medianMs}`);
    assert.equal(r.confusion.matrix.flat().reduce((a, b) => a + b, 0), r.nTest);
  }
});

test('twin: a ring near the elbow makes bends trigger gestures (and fingerprint sees the bigger bend)', () => {
  const bendCounts = (cm) => {
    const fp = fingerprints(session('grip', 12, cm, 'B'), { placement: place(cm) });
    return fp.cells.find((c) => c.gesture === 'elbow_bend').counts.reduce((a, b) => a + b, 0);
  };
  assert.ok(bendCounts(1) > 2 * bendCounts(8), `bend counts near ${bendCounts(1)} vs far ${bendCounts(8)}`);
  for (const base of [10, 20, 30]) {
    const far = evaluate(prepare(twinSet(8, base), FMG), { split: { by: 'session', testSessions: ['B'] }, vote: 3 });
    const near = evaluate(prepare(twinSet(1, base), FMG), { split: { by: 'session', testSessions: ['B'] }, vote: 3 });
    assert.ok(near.falseTriggers.distractor.perMin >= 20 && near.falseTriggers.distractor.perMin > far.falseTriggers.distractor.perMin,
      `seed ${base}: near ${near.falseTriggers.distractor.perMin}/min vs far ${far.falseTriggers.distractor.perMin}/min`);
    const line = near.summary.find((s) => /while bending the elbow/.test(s));
    assert.match(line, /^\d+ false (grips|opens) per minute while bending the elbow/);
  }
  const s = evaluate(prepare(twinSet(1), FMG), { split: { by: 'session', testSessions: ['B'] }, vote: 3 }).summary;
  assert.match(s[0], /^On this recording, grip\/open\/rest \d+% balanced \(chance 33%\), tested on unseen sessions\.$/);
  assert.match(s[s.length - 1], /^Offline result/);
});

// Public copy: needs the twin parameters fitted on club logs (withheld from the public copy).
test.skip('leakage: a window-level split inflates accuracy, and the evaluator refuses it', () => {
  // One session per gesture, split by repetition (reps 2 and 5 held out).
  const recs = [session('grip', 7, 8, 'A'), session('open', 8, 8, 'A')];
  const ds = prepare(recs, FMG);
  const honest = evaluate(ds, { split: { by: 'repetition', testReps: [2, 5] } });
  // What a window-level split would report: every 3rd window to test, neighbours to train.
  const idx = ds.windows.map((w, i) => i).filter((i) => ds.windows[i].pure && ds.windows[i].cls != null);
  const tr = idx.filter((i) => i % 3), te = idx.filter((i) => !(i % 3));
  const m = fitLDA(tr.map((i) => ds.X[i]), tr.map((i) => ds.windows[i].cls));
  const rec = {};
  for (const i of te) { const c = ds.windows[i].cls; rec[c] ??= [0, 0]; rec[c][1]++; if (predict(m, ds.X[i]) === c) rec[c][0]++; }
  const leaky = Object.values(rec).reduce((a, [k, n]) => a + k / n, 0) / Object.keys(rec).length;
  assert.ok(leaky - honest.balancedAccuracy >= 0.05, `leaky ${leaky} vs honest ${honest.balancedAccuracy}`);
  assert.throws(() => evaluate(ds, { split: { by: 'window' } }), (e) => e.code === 'LEAK' && /window-level/.test(e.message));
  assert.throws(() => evaluate(ds, { split: { assign: (w, i) => (i % 3 ? 'train' : 'test') } }), (e) => e.code === 'LEAK' && /both train and test/.test(e.message));
  // A rest-by-time cut needs a gap: 66% / 70% passes, a cut with no gap is refused.
  assert.ok(evaluate(ds, { split: { by: 'repetition', testReps: [2, 5], rest: 'time' } }).nTest > 0);
  assert.throws(() => evaluate(ds, { split: { by: 'repetition', testReps: [2, 5], rest: 'time', restTrainBefore: 0.5, restTestFrom: 0.5 } }), (e) => e.code === 'LEAK');
});

// L2: movement-aligned labels on twin sessions with a 200-400 ms reaction lag. Synthetic: this
// shows the plumbing and the direction, not a real-data gain (RISKS B17).
test('aligned labels improve or match balanced accuracy on lagged twin sessions', () => {
  const rows = [];
  for (let seed = 1; seed <= 6; seed++) {
    const S = generate({ seed, channels: 6, positions: ['down'], reps: 6, reactionMs: [200, 400], holdS: 3, gapS: 7 });
    const ds = prepare([S], { align: true });
    const split = { by: 'repetition', testReps: [2, 5] };
    const p = evaluate(ds, { split, labels: 'prompt' });
    const a = evaluate(ds, { split, labels: 'aligned' });
    assert.equal(p.labels, 'prompt');
    assert.equal(a.labels, 'aligned');
    rows.push([p.balancedAccuracy, a.balancedAccuracy]);
  }
  const mean = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
  // Printed so the numbers can be reported honestly, gain or not.
  console.log(`L2 balanced accuracy, prompt vs aligned: ${rows.map((r) => r.map((x) => x.toFixed(3)).join('/')).join(' ')}; mean ${mean(0).toFixed(3)} -> ${mean(1).toFixed(3)}`);
  assert.ok(mean(1) >= mean(0) - 0.005, `aligned ${mean(1)} vs prompt ${mean(0)}`);
  assert.throws(() => evaluate(prepare([generate({ seed: 1 })]), { labels: 'aligned' }), /No movement-aligned labels/);
});
