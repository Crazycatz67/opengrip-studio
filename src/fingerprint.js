// fingerprint.js: gesture fingerprints for Review (spec docs/design/body-view-spec.md §5.5).
// For each gesture x arm position on one recording: the mean 0-1 level per channel during the
// steady part of its steps, how much it wobbles, and which pairs of gestures look alike on the
// FMG sensors (the classic case: a grip and an elbow bend both squeeze an FMG band near the elbow).
// Pure; Node + browser.
//
// Contract
//   fingerprints(rec, opts?) -> Fingerprints
//     rec: column rec { data: number[][] (per channel), labels: string[], meta?, placement? }.
//       Labels are "gesture" or "gesture@position" (protocol.js); no position = 'down'.
//       Rest steps: rest / relax (any position). Calibration steps (cal_*) are never gestures.
//     opts: { placement (placement.js model; default rec.placement or rec.meta.placement_map),
//       sensors: string[] per channel ('FMG'|'EMG'|...; default placement, then meta.sensors, then
//       'FMG'), threshold = 0.8 (cosine similarity that counts as "looks alike"),
//       sizeRatio = SIZE_RATIO (see below), steady = 0.6 (middle part of a step),
//       apart = 0.2 (level gap on a non-FMG channel that "tells them apart") }
//   Fingerprints = {
//     basis: 'calibration' | 'recording',   1.0 = the calibration squeeze (per channel), or with
//       no calibration the strongest step seen on this recording. Means are clamped to 0-1.
//     channels: [{ ch (1-based), sensor }], fmg: ch[] (the channels the similarity is taken on),
//     positions: ['down','elbow90','raised'] (always all three, for the grid columns),
//     gestures: [{ gesture, distractor }] in first-seen order,
//     cells: [{ key 'gesture@position', gesture, position, distractor, steps, samples,
//               mean: number[] 0-1 per channel, counts: number[] (mean counts above rest), spread: number[] (SD of the per-sample level) }],
//     pairs: [{ a: key, b: key, similarity 0-1 (cosine on the fmg channels' counts above rest),
//               size (FMG vector length of the distractor, or the weaker, over the other), flagged, tell: { ch, sensor, a, b } | null, text }]
//       every pair of cells with different gestures, most similar first,
//     lookAlike: the flagged pairs, summary: one plain line for the card }
//   cellAt(fp, gesture, position) -> cell | null;  cosine(a, b) -> -1..1 (0 for a zero vector).
//   FP_POSITIONS: the three arm positions in grid order. SIZE_RATIO: the look-alike size limit.
// Failure behaviour: never throws on empty, NaN or unlabelled input; no gesture steps -> cells [],
//   pairs [], summary says so. Levels are clamped to >= 0 (below rest is noise for a fingerprint).

import { calibrate } from './quality.js';
import { splitLabel } from './protocol.js';
import { decodePlacementMap } from './placement.js';

export const FP_POSITIONS = ['down', 'elbow90', 'raised'];
const POS_WORD = { down: 'arm down', elbow90: 'elbow 90°', raised: 'arm raised' };
// Look-alike size test: the distractor's (or weaker gesture's) FMG vector, counts above rest, must
// reach this fraction of the other's. FIRST GUESS from twin rings; tune on club data.
export const SIZE_RATIO = 0.35;
const DISTRACTORS = new Set(['elbow_bend', 'elbow']);
const REST = new Set(['rest', 'relax', 'cal_rest']);
// The smallest range a channel is divided by (counts on a 0-1023 ADC): a dead channel stays near 0
// instead of blowing its noise up to 1.
const MIN_SCALE = 20;

const isGesture = (g) => !!g && !REST.has(g) && !g.startsWith('cal_');
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const posOf = (p) => (FP_POSITIONS.includes(p) ? p : 'down');
const nameOf = (g) => String(g).replace(/_/g, ' ').toUpperCase();
const cellName = (c) => `${nameOf(c.gesture)} (${POS_WORD[c.position]})`;

export function cosine(a, b) {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = Number.isFinite(a[i]) ? a[i] : 0, y = Number.isFinite(b[i]) ? b[i] : 0;
    ab += x * y; aa += x * x; bb += y * y;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

export function cellAt(fp, gesture, position) {
  return fp.cells.find((c) => c.gesture === gesture && c.position === position) || null;
}

// Runs of one label: [{ label, start, end (exclusive) }].
function runsOf(labels, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const l = labels[i] || '';
    if (out.length && out[out.length - 1].label === l) out[out.length - 1].end = i + 1;
    else out.push({ label: l, start: i, end: i + 1 });
  }
  return out;
}

function steadyIdx(run, frac) {
  const len = run.end - run.start, cut = Math.floor((len * (1 - frac)) / 2);
  return [run.start + cut, Math.max(run.start + cut + 1, run.end - cut)];
}

function sensorsOf(rec, opts, nCh) {
  if (Array.isArray(opts.sensors)) return Array.from({ length: nCh }, (_, i) => opts.sensors[i] || 'FMG');
  const P = opts.placement !== undefined ? opts.placement : rec.placement || decodePlacementMap(rec.meta?.placement_map);
  const meta = String(rec.meta?.sensors || '').split(',').map((s) => s.trim());
  return Array.from({ length: nCh }, (_, i) => {
    const e = P?.channels?.find((c) => c.ch === i + 1);
    return (e && e.sensor) || (meta[i] && meta[i] !== 'unknown' ? meta[i] : 'FMG');
  });
}

export function fingerprints(rec, opts = {}) {
  const o = { threshold: 0.8, sizeRatio: SIZE_RATIO, steady: 0.6, apart: 0.2, ...opts };
  const data = Array.isArray(rec?.data) ? rec.data : [];
  const nCh = data.length;
  const n = nCh ? Math.max(...data.map((d) => d.length)) : 0;
  const labels = rec?.labels || [];
  const sensors = sensorsOf(rec || {}, o, nCh);
  const channels = sensors.map((sensor, i) => ({ ch: i + 1, sensor }));
  let fmg = channels.filter((c) => c.sensor === 'FMG').map((c) => c.ch);
  if (!fmg.length) fmg = channels.map((c) => c.ch); // no FMG at all: compare on what there is
  const val = (c, i) => (Number.isFinite(data[c][i]) ? data[c][i] : NaN);

  // Steady windows, grouped: rest by position, gestures by gesture@position.
  const rest = {}, groups = new Map();
  for (const run of runsOf(labels, n)) {
    const { gesture, position } = splitLabel(run.label);
    const pos = posOf(position);
    const win = steadyIdx(run, o.steady);
    if (REST.has(gesture)) (rest[pos] ||= []).push(win);
    else if (isGesture(gesture)) {
      const key = `${gesture}@${pos}`;
      if (!groups.has(key)) groups.set(key, { key, gesture, position: pos, distractor: DISTRACTORS.has(gesture), wins: [] });
      groups.get(key).wins.push(win);
    }
  }
  const winMean = (c, wins) => {
    const xs = [];
    for (const [a, b] of wins) for (let i = a; i < b; i++) { const v = val(c, i); if (Number.isFinite(v)) xs.push(v); }
    return mean(xs);
  };
  const allRest = Object.values(rest).flat();
  const cal = nCh ? calibrate(rec) : null;
  // Rest per position and channel: the same position's rest, else any rest, else calibration rest,
  // else the channel's 5th percentile (an unlabelled-rest recording still gets a floor).
  const restAt = (pos, c) => {
    const r = rest[pos] ? winMean(c, rest[pos]) : NaN;
    if (Number.isFinite(r)) return r;
    const any = allRest.length ? winMean(c, allRest) : NaN;
    if (Number.isFinite(any)) return any;
    if (cal && Number.isFinite(cal.rest[c])) return cal.rest[c];
    const s = data[c].filter(Number.isFinite).sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length * 0.05)] : 0;
  };
  const cells = [...groups.values()];
  const raw = cells.map((g) => channels.map((_, c) => winMean(c, g.wins) - restAt(g.position, c)));
  const scale = channels.map((_, c) => {
    const seen = Math.max(0, ...raw.map((r) => (Number.isFinite(r[c]) ? r[c] : 0)));
    const calR = cal && Number.isFinite(cal.squeeze[c] - cal.rest[c]) ? cal.squeeze[c] - cal.rest[c] : 0;
    // Calibration wins when there is one: dividing by the strongest step seen instead would let a
    // big elbow bend shrink every grip, so the two could never look alike however confusable.
    return Math.max(MIN_SCALE, calR > 0 ? calR : seen);
  });
  const basis = cal ? 'calibration' : 'recording';

  for (const g of cells) {
    g.steps = g.wins.length;
    g.mean = []; g.counts = []; g.spread = []; g.samples = 0;
    channels.forEach((_, c) => {
      const r0 = restAt(g.position, c), xs = [];
      for (const [a, b] of g.wins) for (let i = a; i < b; i++) { const v = val(c, i); if (Number.isFinite(v)) xs.push((v - r0) / scale[c]); }
      const m = mean(xs);
      g.counts.push(Number.isFinite(m) ? Math.max(0, m * scale[c]) : null);
      g.mean.push(Number.isFinite(m) ? Math.min(1, Math.max(0, m)) : null);
      g.spread.push(xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)) : null);
      g.samples = Math.max(g.samples, xs.length);
    });
    delete g.wins;
  }

  // Shape is compared in counts above rest, not calibrated levels: calibration divides each channel
  // by its own squeeze, so every grip comes out flat by definition and "looks like grip" would only
  // mean "is flat". Measured on twin rings (seeds 1-3, 2-8 cm): calibrated levels gave grip vs
  // elbow bend 0.57-0.93 with no link to distance; counts give the same shape at every distance and
  // the size test below then separates a strong elbow bend from a faint one.
  const pick = (cell) => fmg.map((ch) => cell.counts[ch - 1] ?? 0);
  const others = channels.filter((c) => !fmg.includes(c.ch));
  const onlyWord = others.length ? 'on the FMG sensors alone' : 'on these sensors';
  const pairs = [];
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
    const A = cells[i], B = cells[j];
    if (A.gesture === B.gesture) continue;
    const va = pick(A), vb = pick(B);
    const similarity = Math.max(0, cosine(va, vb));
    // Cosine ignores size: an elbow bend 8 cm from the crease points the same way as a grip but is
    // a fraction of it, and easy to tell apart. So the size must match too, measured on the whole
    // FMG vector (one channel's peak was tried first: it swung 0.08-0.46 at 8 cm with the sensor
    // count and faults). One-sided for a distractor: an elbow bend near the crease that presses
    // HARDER than the grip is the worst look-alike, not a safe one. Two real gestures: weaker/stronger.
    const na = Math.hypot(...va), nb = Math.hypot(...vb);
    const [D, G, nd, ng] = B.distractor && !A.distractor ? [B, A, nb, na] : A.distractor && !B.distractor ? [A, B, na, nb]
      : na <= nb ? [A, B, na, nb] : [B, A, nb, na];
    const size = ng > 0 ? nd / ng : 0;
    const sized = D.distractor !== G.distractor ? size : Math.min(size, 1);
    const flagged = similarity >= o.threshold && sized >= o.sizeRatio;
    const sizeLine = ` ${nameOf(D.gesture)} reaches ${Math.round(size * 100)}% of ${nameOf(G.gesture)} (${POS_WORD[G.position]}) on the same sensors.`;
    let tell = null;
    for (const c of others) {
      const a = A.mean[c.ch - 1], b = B.mean[c.ch - 1];
      if (a == null || b == null) continue;
      if (Math.abs(a - b) >= o.apart && (!tell || Math.abs(a - b) > Math.abs(tell.a - tell.b))) tell = { ch: c.ch, sensor: c.sensor, a, b };
    }
    const pct = Math.round(similarity * 100);
    const tail = tell ? ` ${tell.sensor} channel ${tell.ch} tells them apart (${tell.a.toFixed(2)} vs ${tell.b.toFixed(2)}).`
      : ' No other sensor tells them apart on this recording.';
    pairs.push({ a: A.key, b: B.key, similarity, size, flagged, tell,
      text: `${cellName(A)} looks ${pct}% like ${cellName(B)} ${onlyWord}.${flagged ? sizeLine + tail : ''}` });
  }
  pairs.sort((x, y) => y.similarity - x.similarity);
  const lookAlike = pairs.filter((p) => p.flagged);
  const summary = !cells.length ? 'No gesture steps on this recording, so no fingerprints.'
    : lookAlike.length ? `${lookAlike.length} pair${lookAlike.length > 1 ? 's' : ''} of gestures look alike on this recording.`
      : 'Each gesture has its own pattern on this recording.';
  const gestures = [];
  for (const c of cells) if (!gestures.some((g) => g.gesture === c.gesture)) gestures.push({ gesture: c.gesture, distractor: c.distractor });
  return { basis, channels, fmg, positions: FP_POSITIONS.slice(), gestures, cells, pairs, lookAlike, summary };
}
