// glassbox/evaluate.js: honest offline evaluation of the Glass Box classifier on recordings.
// Pure ES module (Node + browser).
//
// The rules from docs/RISKS.md are built in, not optional:
//   B13  split by repetition or by session, never by window. Overlapping windows from one
//        repetition in both train and test inflate accuracy, so evaluate() checks every split and
//        throws (code 'LEAK') when a repetition, or any stretch of samples, is on both sides.
//   B14  balanced accuracy + confusion matrix + false triggers per minute, never plain accuracy
//        alone (rest dominates; "always rest" must not look good). Plain accuracy is returned too,
//        only because feasibility.py reports it (golden test).
//   B18  offline is not live: the summary says so.
//
// Contract
//   prepare(recordings, opts?) -> Dataset
//     recordings: [{ data: number[][] per channel, labels: (string|number)[] per sample, rateHz,
//       session? (id; default the index), reps? (per-sample repetition numbers, e.g. Ninapro's
//       rerepetition; default: the k-th run of a class in that recording is repetition k) }]
//       csv.js fromCSV() and sim/twin.js generate() both give this shape.
//     opts { classOf(label) -> class | null (default: protocol.js gesture, rest/relax -> 'rest',
//            cal_* and distractors -> null), isDistractor(label) (default: elbow / bend /
//            distractor, as in protocol.js), rest = 'rest' (the class a distractor should get),
//            features, zcThreshold, center (features.js), winMs=200, stepMs=50 | win, step }
//            align = false: true also builds ds.aligned, the same dataset on movement-aligned
//              labels (rec.alignedLabels when it has them, else relabel.js); recordings carrying
//              alignedLabels get ds.aligned without asking.
//     Each window is [start, start+win) and belongs to the label run holding its LAST sample
//     (causal: the decision at time t only knows samples up to t). pure = one run throughout.
//     nearDistractor = the window holds a distractor sample or starts within distractorTailMs
//     (default 500) after one: a bend's band pressure takes about that long to settle, and a
//     trigger it causes there is the bend's fault, so it is counted "while bending the elbow".
//   evaluate(ds, opts?) -> Result
//     opts { labels = 'prompt' | 'aligned' (train AND test on movement-aligned labels: ds.aligned;
//              throws when ds has none), split = { by: 'repetition', testReps: [2, 5], rest: 'repetition' | 'time',
//              restTrainBefore = 0.66, restTestFrom = 0.70, restThin = 1 }
//            | { by: 'session', testSessions: [ids] } | { assign(window, i) -> 'train'|'test'|null }
//            ({ by: 'window' } throws: refused, see B13),
//            vote = 1 (majority over the last `vote` decisions), channels (indices to use; default
//            all), lda (fitLDA opts, e.g. { shrinkage: 'auto' }) }
//     Training and scoring use pure windows of known classes. Ties in a vote go to the first class.
//     Result = { classes, accuracy, balancedAccuracy, recall: { cls: 0..1 }, confusion: { classes,
//       matrix[true][pred] }, nTrain, nTest, falseTriggers: { rest, distractor } each
//       { count, minutes, perMin, byClass }, delay: { medianMs, n, missed }, model, summary: string[] }
//     Stream metrics run on every test window in time order (pure or not), vote-smoothed within each
//     unbroken run. A false trigger = a new non-rest decision (different from the previous one)
//     while the truth is rest or a distractor; a run's first decision is never one (what came
//     before it is unknown, e.g. a grip still fading out of the band). Delay = from a test repetition's first labelled
//     sample to the end of the first window whose smoothed decision is right; never right = missed.
//   smoothVote(preds, k, classes) -> preds  (majority of the last k; tie -> lowest class index)
//   leakCheck(ds, assignment) -> { ok, reasons: string[] }
//   summaryLines(result, { scope = 'On this recording', names = {} }) -> string[]
// Failure behaviour: throws Error('...') with code 'LEAK' for a leaky split, plain Error when a
//   side of the split is empty or has under 2 classes (nothing honest to report).

import { featuresAt, featureNames, windowSamples, windowStarts, DEFAULT_FEATURES } from './features.js';
import { fitLDA, predict } from './lda.js';
import { splitLabel } from '../protocol.js';
import { relabel } from '../relabel.js';

const DISTRACTOR_RE = /elbow|bend|distractor/i;
export const defaultIsDistractor = (label) => DISTRACTOR_RE.test(splitLabel(label).gesture);
export function defaultClassOf(label) {
  const g = splitLabel(label).gesture.trim().toLowerCase();
  if (!g || /^cal_/.test(g) || DISTRACTOR_RE.test(g)) return null;
  return g === 'rest' || g === 'relax' ? 'rest' : g;
}

export function prepare(recordings, opts = {}) {
  const { classOf = defaultClassOf, isDistractor = defaultIsDistractor, rest = 'rest', distractorTailMs = 500,
    features = DEFAULT_FEATURES, zcThreshold = 1, center = false } = opts;
  const X = [], windows = [], segments = [];
  let win0 = null, step0 = null;
  recordings.forEach((rec, r) => {
    const n = rec.labels.length;
    const { win, step } = windowSamples(rec.rateHz, opts);
    win0 ??= win; step0 ??= step;
    // Label runs; repetition k = the k-th run of that class (or the given per-sample reps).
    const segOf = new Int32Array(n);
    const seen = new Map();
    let cur = null;
    for (let i = 0; i < n; i++) {
      if (!cur || rec.labels[i] !== cur.label) {
        const label = rec.labels[i];
        const distractor = !!isDistractor(label);
        const cls = distractor ? null : classOf(label);
        const key = distractor ? '\u0000distractor' : cls;
        seen.set(key, (seen.get(key) || 0) + 1);
        cur = { id: segments.length, rec: r, label, cls, distractor, start: i, end: i,
          rep: rec.reps ? Number(rec.reps[i]) : seen.get(key) };
        segments.push(cur);
      }
      cur.end = i + 1;
      segOf[i] = cur.id;
    }
    let ord = 0;
    const bends = segments.filter((g) => g.rec === r && g.distractor);
    const tail = Math.round((distractorTailMs * (rec.rateHz || 100)) / 1000);
    for (const s of windowStarts(n, win, step)) {
      const end = s + win - 1;
      const seg = segments[segOf[end]];
      if (seg.cls == null && !seg.distractor) continue;
      const pure = segOf[s] === segOf[end];
      const w = { rec: r, session: rec.session ?? r, start: s, end, rateHz: rec.rateHz, seg: seg.id,
        cls: seg.cls, truth: seg.distractor ? rest : seg.cls, distractor: seg.distractor,
        nearDistractor: bends.some((g) => g.start <= end && g.end + tail > s), rep: seg.rep,
        pure, pos: s / n, ord: pure && seg.cls != null ? ord++ : -1, step };
      windows.push(w);
      X.push(featuresAt(rec.data, end, win, { features, zcThreshold, center }));
    }
  });
  const nCh = recordings[0]?.data.length || 0;
  const names = recordings[0]?.channelNames || Array.from({ length: nCh }, (_, i) => `ch${i + 1}`);
  const ds = { X, windows, segments, features, nChannels: nCh, featureNames: featureNames(features, names),
    win: win0, step: step0, rest, labels: opts._labels || 'prompt' };
  const own = (rec) => Array.isArray(rec.alignedLabels) && rec.alignedLabels.length === rec.labels.length;
  if (!opts._labels && (opts.align || recordings.some(own))) {
    // Per-sample reps (if given) stay as they are: relabel only moves boundaries.
    const re = recordings.map((rec) => ({ ...rec, labels: own(rec) ? rec.alignedLabels : relabel(rec).labels, alignedLabels: undefined }));
    ds.aligned = prepare(re, { ...opts, align: false, _labels: 'aligned' });
  }
  return ds;
}

function assignment(ds, split) {
  const W = ds.windows;
  if (typeof split.assign === 'function') return W.map((w, i) => split.assign(w, i) ?? null);
  if (split.by === 'window') {
    const e = new Error('Refused: a window-level split puts overlapping windows from the same repetition in both train and test, which inflates accuracy (RISKS B13). Split by repetition or by session.');
    e.code = 'LEAK';
    throw e;
  }
  if (split.by === 'session') {
    const test = new Set(split.testSessions || []);
    return W.map((w) => (test.has(w.session) ? 'test' : 'train'));
  }
  if (split.by !== 'repetition' && split.by != null) throw new Error(`unknown split "${split.by}"`);
  const testReps = new Set(split.testReps || [2, 5]);
  const { rest: restMode = 'repetition', restTrainBefore = 0.66, restTestFrom = 0.70, restThin = 1 } = split;
  return W.map((w) => {
    if (w.distractor) return 'test'; // never trained on, so every one is unseen
    if (w.cls === ds.rest && restMode === 'time') {
      if (w.ord % restThin !== 0) return null;
      return w.pos < restTrainBefore ? 'train' : w.pos >= restTestFrom ? 'test' : null;
    }
    return testReps.has(w.rep) ? 'test' : 'train';
  });
}

export function leakCheck(ds, assign) {
  const reasons = [];
  const sides = new Map();
  ds.windows.forEach((w, i) => {
    if (!w.pure || w.cls == null || w.cls === ds.rest || !assign[i]) return;
    const s = sides.get(w.seg) || new Set();
    s.add(assign[i]); sides.set(w.seg, s);
  });
  const shared = [...sides].filter(([, s]) => s.size > 1).length;
  if (shared) reasons.push(`${shared} repetition(s) have windows in both train and test`);
  // Any pure train window sharing samples with a pure test window of the same recording.
  const byRec = new Map();
  ds.windows.forEach((w, i) => {
    if (!w.pure || w.cls == null || !assign[i]) return;
    const r = byRec.get(w.rec) || { train: [], test: [] };
    r[assign[i]].push(w); byRec.set(w.rec, r);
  });
  let overlaps = 0;
  for (const { train, test } of byRec.values()) {
    const starts = test.map((w) => w.start).sort((a, b) => a - b);
    for (const w of train) {
      let lo = 0, hi = starts.length; // first test start > w.start - win
      while (lo < hi) { const m = (lo + hi) >> 1; if (starts[m] <= w.start - (w.end - w.start + 1)) lo = m + 1; else hi = m; }
      if (lo < starts.length && starts[lo] <= w.end) overlaps++;
    }
  }
  if (overlaps) reasons.push(`${overlaps} training window(s) share samples with test windows`);
  return { ok: reasons.length === 0, reasons };
}

export function smoothVote(preds, k, classes) {
  if (!(k > 1)) return preds.slice();
  const idx = new Map(classes.map((c, i) => [c, i]));
  const out = new Array(preds.length);
  const counts = new Array(classes.length).fill(0);
  for (let i = 0; i < preds.length; i++) {
    counts[idx.get(preds[i])]++;
    if (i >= k) counts[idx.get(preds[i - k])]--;
    let best = 0;
    for (let c = 1; c < counts.length; c++) if (counts[c] > counts[best]) best = c;
    out[i] = classes[best];
  }
  return out;
}

const pick = (x, cols) => (cols ? cols.map((j) => x[j]) : x);
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function evaluate(ds, opts = {}) {
  if (opts.labels === 'aligned' && ds.labels !== 'aligned') {
    if (!ds.aligned) throw new Error('No movement-aligned labels: prepare(recordings, { align: true }) first.');
    return evaluate(ds.aligned, opts);
  }
  const { split = { by: 'repetition', testReps: [2, 5] }, vote = 1, channels = null, lda = {} } = opts;
  const assign = assignment(ds, split);
  const leak = leakCheck(ds, assign);
  if (!leak.ok) {
    const e = new Error(`Refused: this split leaks (${leak.reasons.join('; ')}). Split by repetition or by session (RISKS B13).`);
    e.code = 'LEAK';
    throw e;
  }
  const nCh = ds.nChannels;
  const cols = channels ? ds.features.flatMap((_, f) => channels.map((c) => f * nCh + c)) : null;
  const W = ds.windows;
  const tr = [], te = [];
  W.forEach((w, i) => {
    if (!w.pure || w.cls == null) return;
    if (assign[i] === 'train') tr.push(i); else if (assign[i] === 'test') te.push(i);
  });
  if (!tr.length || !te.length) throw new Error('Nothing to evaluate: the split leaves the training or the test side empty.');
  const model = fitLDA(tr.map((i) => pick(ds.X[i], cols)), tr.map((i) => W[i].cls), lda);
  const classes = model.classes;
  const yTrue = te.map((i) => W[i].cls);
  const yPred = smoothVote(te.map((i) => predict(model, pick(ds.X[i], cols))), vote, classes);
  const ci = new Map(classes.map((c, k) => [c, k]));
  const matrix = classes.map(() => new Array(classes.length).fill(0));
  let correct = 0;
  yTrue.forEach((t, k) => { if (!ci.has(t)) return; matrix[ci.get(t)][ci.get(yPred[k])]++; if (t === yPred[k]) correct++; });
  const recall = {};
  classes.forEach((c, k) => { const s = matrix[k].reduce((a, b) => a + b, 0); if (s) recall[c] = matrix[k][k] / s; });
  const rs = Object.values(recall);
  const balancedAccuracy = rs.reduce((a, b) => a + b, 0) / rs.length;

  // Stream: every test window in time order, in unbroken runs, smoothed within each run.
  const stream = [];
  W.forEach((w, i) => { if (assign[i] === 'test' && (w.truth != null)) stream.push(i); });
  const ft = { rest: { count: 0, windows: 0, byClass: {} }, distractor: { count: 0, windows: 0, byClass: {} } };
  const firstRight = new Map(); // seg -> delay ms
  const testSegs = new Map();
  let runStart = 0;
  for (let k = 0; k <= stream.length; k++) {
    const brk = k === stream.length || (k > runStart && (W[stream[k]].rec !== W[stream[k - 1]].rec || W[stream[k]].start !== W[stream[k - 1]].start + W[stream[k - 1]].step));
    if (!brk) continue;
    const run = stream.slice(runStart, k);
    const sm = smoothVote(run.map((i) => predict(model, pick(ds.X[i], cols))), vote, classes);
    run.forEach((i, j) => {
      const w = W[i];
      const p = sm[j];
      if (w.truth === ds.rest) {
        const bucket = w.nearDistractor ? ft.distractor : ft.rest;
        bucket.windows++;
        if (p !== ds.rest && j > 0 && sm[j - 1] !== p) { bucket.count++; bucket.byClass[p] = (bucket.byClass[p] || 0) + 1; }
      } else if (w.cls != null) {
        const seg = ds.segments[w.seg];
        testSegs.set(w.seg, seg);
        if (p === w.cls && !firstRight.has(w.seg)) firstRight.set(w.seg, ((w.end - seg.start) / w.rateHz) * 1000);
      }
    });
    runStart = k;
  }
  for (const b of Object.values(ft)) {
    const rate = W[0]?.rateHz || 100;
    b.minutes = (b.windows * ds.step) / rate / 60;
    b.perMin = b.minutes > 0 ? b.count / b.minutes : null;
    delete b.windows;
  }
  const delays = [...firstRight.values()];
  const result = { labels: ds.labels || 'prompt', classes, accuracy: correct / yTrue.length, balancedAccuracy, recall, confusion: { classes, matrix },
    nTrain: tr.length, nTest: te.length, falseTriggers: ft,
    delay: { medianMs: median(delays), n: delays.length, missed: testSegs.size - delays.length },
    split, vote, model };
  result.summary = summaryLines(result, opts);
  return result;
}

const pct = (v) => `${Math.round(v * 100)}%`;
const per = (v) => (v == null ? '—' : v < 10 ? v.toFixed(1) : String(Math.round(v)));

export function summaryLines(res, { scope = 'On this recording', names = {} } = {}) {
  const nm = (c) => names[c] ?? String(c);
  const by = res.split?.by || (res.split?.assign ? 'a custom rule' : 'repetition');
  const lines = [`${scope}, ${res.classes.map(nm).join('/')} ${pct(res.balancedAccuracy)} balanced (chance ${pct(1 / res.classes.length)}), tested on ${by === 'session' ? 'unseen sessions' : `unseen ${by}s`}.`];
  const ftLine = (b, where) => {
    if (!(b.minutes > 0)) return null;
    const top = Object.entries(b.byClass).sort((a, c) => c[1] - a[1])[0];
    const what = top ? `false ${nm(top[0])}${/s$/.test(nm(top[0])) ? '' : 's'}` : 'false gestures';
    return `${per(b.perMin)} ${what} per minute ${where} (${b.minutes.toFixed(1)} min tested).`;
  };
  const a = ftLine(res.falseTriggers.rest, 'at rest');
  const d = ftLine(res.falseTriggers.distractor, 'while bending the elbow');
  if (a) lines.push(a);
  if (d) lines.push(d);
  if (res.delay.n) lines.push(`Median ${Math.round(res.delay.medianMs)} ms from the start of a movement to the right answer (${res.delay.n} of ${res.delay.n + res.delay.missed} repetitions caught).`);
  // The worst off-diagonal cell: the mix-up a person should practise or re-record.
  let worst = null;
  res.confusion.matrix.forEach((row, t) => {
    const s = row.reduce((x, y) => x + y, 0);
    row.forEach((v, p) => { if (p !== t && s && (!worst || v / s > worst.f)) worst = { t, p, f: v / s }; });
  });
  if (worst && worst.f >= 0.05) lines.push(`Most mix-ups: ${nm(res.classes[worst.t])} taken as ${nm(res.classes[worst.p])} (${pct(worst.f)} of the time).`);
  lines.push('Offline result on recorded data; live use is usually lower.');
  return lines;
}
