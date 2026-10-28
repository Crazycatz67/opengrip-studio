// relabel.js: movement-aligned labels ("restimulus"). Pure and deterministic.
//
// Why: a prompt says "grip" at time t, but the hand starts moving a few hundred ms later and
// lets go a few hundred ms after "relax" (RISKS B15). Training on prompt timing teaches a model
// that "grip" looks like rest for its first ~300 ms. Ninapro ships both: stimulus (the prompt)
// and restimulus (re-timed to the movement). This module makes the second one.
//
// Contract
//   relabel(recording, opts?) -> { labels, steps, rateHz, summary }
//     recording: { data: number[][] per channel, labels: string[] per sample, rateHz?, t? (ms),
//                  meta?: { sensors?: 'FMG,FMG,EMG' } }   (csv.js fromCSV and sim/twin.js
//                  generate both give this shape). Non-finite samples are carried forward.
//     opts: { channels (indices to use; default all), maxLagMs = 600, minHoldMs = 150,
//             minConfidence = 0.5, smoothMs = 40 }
//     labels: string[] same length; each prompted step's label now covers [onset, next onset):
//       the samples between a prompt and the movement keep the previous step's label.
//     steps[k] = { label, promptStart, promptEnd (exclusive), onset, offset (exclusive; the next
//       step's onset, or n), lagMs (onset - promptStart, ms), confidence 0..1, aligned: bool,
//       reason: string|null (plain words, set whenever aligned is false) }   indices are samples.
//     summary = { steps, aligned, kept, medianLagMs (aligned steps; null if none) }
//   Each step change is found from the signal: per channel a smoothed envelope (the level for
//   FMG; for channels the meta calls EMG, the mean absolute deviation from a 100 ms mean), its
//   settled level before the prompt (end of the previous step) and after (the step once maxLag
//   has passed). Channels are combined weighted by how clearly they change (z = change / noise,
//   z < 3 ignored), giving a progress curve 0 -> 1. The onset is the last sample before the 20%
//   crossing where progress is still at the noise floor (max(0.02, 3 / combined z)).
//   Kept at prompt timing, with a reason, when: no channel changes clearly (confidence below
//   minConfidence), the 20% crossing is later than maxLagMs, or the aligned step would be
//   shorter than minHoldMs. The first step is never moved (nothing before it to compare).
// Failure behaviour: never throws on odd signals; an empty or unlabelled recording gives
//   steps [] and a copy of the labels.

const median = (a) => {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function rateOf(rec) {
  if (rec.rateHz > 0) return rec.rateHz;
  const t = rec.t || [];
  const d = [];
  for (let i = 1; i < Math.min(t.length, 2000); i++) if (t[i] > t[i - 1]) d.push(t[i] - t[i - 1]);
  const m = median(d);
  return m > 0 ? 1000 / m : 100;
}

// Centered moving average (window w, odd); NaN-free input.
function movingAvg(x, w) {
  const n = x.length, h = w >> 1, out = new Float64Array(n);
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + x[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h), b = Math.min(n, i + h + 1);
    out[i] = (cs[b] - cs[a]) / (b - a);
  }
  return out;
}

function envelope(raw, emg, rate, smoothMs) {
  const n = raw.length;
  const x = new Float64Array(n);
  let last = NaN, finite = 0;
  for (let i = 0; i < n; i++) {
    const v = Number(raw[i]);
    if (Number.isFinite(v)) { last = v; finite++; }
    x[i] = last;
  }
  if (!finite) return null; // a missing channel
  const first = x.findIndex((v) => Number.isFinite(v));
  for (let i = 0; i < first; i++) x[i] = x[first];
  const w = Math.max(1, Math.round((smoothMs * rate) / 1000)) | 1;
  if (!emg) return movingAvg(x, w);
  const base = movingAvg(x, Math.max(3, Math.round(0.1 * rate)) | 1);
  for (let i = 0; i < n; i++) x[i] = Math.abs(x[i] - base[i]);
  return movingAvg(x, w);
}

// Robust spread (MAD as an sd), floored so a flat or quantised channel cannot give z = infinity.
function spread(env, a, b) {
  const v = Array.from(env.subarray(a, b));
  const m = median(v);
  return Math.max(0.5, 1.4826 * median(v.map((x) => Math.abs(x - m))));
}

function runsOf(labels) {
  const runs = [];
  for (let i = 0; i < labels.length;) {
    let j = i + 1;
    while (j < labels.length && labels[j] === labels[i]) j++;
    runs.push({ label: labels[i], start: i, end: j });
    i = j;
  }
  return runs;
}

// One step change at prompt index b (previous run A, this run B). Returns { onset, confidence, reason }.
function findChange(envs, A, B, L, rate) {
  const b = B.start, lenA = A.end - A.start, lenB = B.end - B.start;
  const half = Math.round(0.5 * rate);
  const pre0 = Math.max(A.start + (lenA >> 1), b - half);
  // The settled level after: the later half of the step (and never before maxLag). A release's
  // slow tail (FMG bands creep back for seconds) would otherwise pull the level up and make the
  // crossing fire on hold wobble before the hand lets go.
  const post0 = b + Math.max(Math.min(L, Math.floor(lenB * 0.6)), lenB >> 1);
  if (b - pre0 < 3 || B.end - post0 < 3) return { onset: b, confidence: 0, reason: 'steps too short to see a settled level before and after' };
  const tracks = [];
  for (const e of envs) {
    if (!e) continue;
    const before = median(Array.from(e.subarray(pre0, b)));
    const after = median(Array.from(e.subarray(post0, B.end)));
    const noise = Math.hypot(spread(e, pre0, b), spread(e, post0, B.end)) / Math.SQRT2;
    const z = Math.abs(after - before) / noise;
    if (z >= 3) tracks.push({ e, before, delta: after - before, w: Math.min(z, 50) ** 2 });
  }
  const zComb = Math.sqrt(tracks.reduce((s, k) => s + k.w, 0));
  const confidence = clamp01((zComb - 3) / 7);
  if (!tracks.length) return { onset: b, confidence: 0, reason: 'no channel changes clearly at this prompt (the change is within the noise)' };
  const W = tracks.reduce((s, k) => s + k.w, 0);
  const p = (i) => tracks.reduce((s, k) => s + (k.w * (k.e[i] - k.before)) / k.delta, 0) / W;
  // A crossing must hold for 30 ms so one noise spike cannot set it.
  const hold = Math.max(2, Math.round(0.03 * rate));
  const end = Math.min(B.end, b + L + half);
  const cross = (f, from) => {
    for (let i = from, run = 0; i < end; i++) {
      run = p(i) >= f ? run + 1 : 0;
      if (run >= hold) return i - hold + 1;
    }
    return -1;
  };
  const c20 = cross(0.2, b);
  if (c20 < 0 || c20 > b + L) return { onset: b, confidence, reason: `no movement found within ${Math.round((L * 1000) / rate)} ms of the prompt` };
  // Walk back from the 20% crossing to the last sample still at the noise floor. Shape-agnostic:
  // a line through two crossings is late on an S-shaped squeeze and early on a release, whose
  // drop is steepest at the start.
  const floor = Math.max(0.02, 3 / zComb);
  let onset = c20;
  while (onset > b && p(onset - 1) > floor) onset--;
  return { onset, confidence, reason: null };
}

export function relabel(recording, opts = {}) {
  const { channels = null, maxLagMs = 600, minHoldMs = 150, minConfidence = 0.5, smoothMs = 40 } = opts;
  const labels = Array.from(recording?.labels || []);
  const rate = rateOf(recording || {});
  const n = labels.length;
  const runs = runsOf(labels);
  if (!n || !runs.length) return { labels, steps: [], rateHz: rate, summary: { steps: 0, aligned: 0, kept: 0, medianLagMs: null } };
  const kinds = String(recording.meta?.sensors || '').split(',').map((s) => s.trim());
  const data = recording.data || [];
  const use = channels || data.map((_, c) => c);
  const envs = use.map((c) => (data[c] && data[c].length === n ? envelope(data[c], kinds[c] === 'EMG', rate, smoothMs) : null));
  const L = Math.max(1, Math.round((maxLagMs * rate) / 1000));
  const ms = (k) => Math.round((k * 1000) / rate);
  const steps = runs.map((R, k) => {
    const s = { label: R.label, promptStart: R.start, promptEnd: R.end, onset: R.start, offset: R.end, lagMs: 0, confidence: 1, aligned: false, reason: null };
    if (k === 0) { s.reason = 'first step: nothing before it to compare'; return s; }
    const f = findChange(envs, runs[k - 1], R, L, rate);
    s.confidence = Math.round(f.confidence * 100) / 100;
    if (f.reason) s.reason = f.reason;
    else if (f.confidence < minConfidence) s.reason = `low confidence (${s.confidence}): the signal change is small next to the noise`;
    else { s.onset = f.onset; s.aligned = true; }
    return s;
  });
  // A step squeezed below minHold by its own or the next step's lag goes back to prompt timing.
  const minHold = Math.round((minHoldMs * rate) / 1000);
  // Reverting one can shorten the step before it, so repeat until nothing changes.
  for (let changed = true; changed;) {
    changed = false;
    for (let k = 1; k < steps.length; k++) {
      const nextOn = k + 1 < steps.length ? steps[k + 1].onset : n;
      if (steps[k].aligned && nextOn - steps[k].onset < minHold) {
        steps[k].onset = steps[k].promptStart;
        steps[k].aligned = false;
        steps[k].reason = `the aligned step would be shorter than ${minHoldMs} ms`;
        changed = true;
      }
    }
  }
  const out = labels.slice();
  for (let k = 0; k < steps.length; k++) {
    const s = steps[k];
    s.offset = k + 1 < steps.length ? steps[k + 1].onset : n;
    s.lagMs = ms(s.onset - s.promptStart);
    for (let i = s.onset; i < s.offset; i++) out[i] = s.label;
  }
  const lags = steps.filter((s) => s.aligned).map((s) => s.lagMs);
  return { labels: out, steps, rateHz: rate, summary: { steps: steps.length, aligned: lags.length, kept: steps.length - lags.length, medianLagMs: lags.length ? median(lags) : null } };
}
