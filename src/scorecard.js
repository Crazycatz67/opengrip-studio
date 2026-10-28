// scorecard.js: the Design Scorecard (A/B). Settles hardware debates (spandex vs nylon sleeve,
// FSR glued flat vs in a printed puck, strap tightness) with numbers from two recordings of the
// same protocol, instead of opinions. Pure: no DOM, no fs; runs in Node and the browser.
//
// Contract
//   METRICS: [{ key, label, short, unit, scale: 'ratio'|'diff', direction: 'higher'|'lower',
//               weight, help }]  The weights are part of the output and shown on screen.
//   scoreRecording(rec, opts?) -> RecordingScore
//     rec: { data: number[][], labels?, rateHz?, channelNames?, meta?, markers?, synthetic? }
//          (a fromCSV() recording, a parsed log, or a twin Session)
//     opts: { blockSec = 5, minReps = 5 }
//     { version, n, channels, channelNames, rateHz, assumedRate, durationSec, synthetic,
//       meta: { personId, protocol, setup, startedAt }, setupSeconds|null, calibrated,
//       span: number[] (counts used to normalise; calibrated squeeze - rest, else median grip),
//       spanSource: ('calibration'|'grips'|null)[], repCounts: { label: n }, labels: string[],
//       units: { reps, rests, arms, blocks }, values: { key: { all, perChannel[] } } }
//   compareRecordings(a, b, opts?) -> Scorecard   a, b: a recording or RecordingScore, or an
//       array of them to pool one design's sessions (A1+A2 vs B1+B2). A one-element array is
//       the same as passing the recording itself; then the card is identical to before pooling.
//     opts: { names = ['A', 'B'], boot = 2000, seed = 1, today = 'YYYY-MM-DD' (default: now),
//             minReps = 5, blockSec = 5 }
//     { version, names, synthetic, pooled, context: { who, when, prefix }, fairness: Item[],
//       weights: [{ key, label, weight }], totalWeight, boot, seed,
//       a: Summary, b: Summary, views: View[] }
//     Summary also has pool: { recordings, volunteers, unknownPeople } and, when pooled,
//       recordings: Summary[] (one per session). Pooled values are the mean of the side's
//       recordings (equal weight, however long each is); intervals resample whole recordings,
//       then units inside them. Pooled fairness adds 'pool' (info: counts) and 'pool-small'
//       (warn: under 3 recordings in a side).
//     Item = { level: 'warn'|'info', code, message }
//     View = { id: 'all'|channelIndex, name, rows: Row[], overall }
//     Row = { key, label, unit, scale, direction, weight, a, b, effect, lo, hi,
//             verdict: 'A'|'B'|'none'|'na', winner: name|null, sentence }
//       effect is B / A for scale 'ratio' and B - A for 'diff'; lo..hi is the 95% bootstrap
//       percentile interval over repetitions (and rest periods, and 5 s blocks for counts).
//       A winner is named only when the interval excludes 1 (ratio) or 0 (diff).
//     overall = { verdict, points: { A, B }, undecided, na, sentence }
//   scorecardJSON(card) -> string;  scorecardHTML(card) -> printable standalone HTML string
//   intervalSVG(row, { width = 160, height = 22 }) -> SVG string: dot = effect, bar = 95% CI,
//     dashed line = no difference. Shared by the screen and the printable export.
// Units: raw ADC counts in; reported values are dimensionless or normalised to each
// recording's own calibrated range, because each fitting is calibrated separately and a raw
// count from a tighter sleeve is not the same signal as one from a looser sleeve.
// Failure behaviour: never throws on odd data. A metric that cannot be measured (no arm-only
// steps, under 2 repetitions, no rest periods) gives NaN values and verdict 'na' with a
// sentence saying what is missing; it gives no points to either side.

import { analyzeChannel, calibrate, DEFAULTS as Q } from './quality.js';
import { splitLabel } from './protocol.js';

export const METRICS = [
  { key: 'srr', label: 'Signal-to-rest ratio', short: 'signal-to-rest ratio', unit: '×', scale: 'ratio', direction: 'higher', weight: 3,
    help: 'Grip height divided by the rest noise just before it. Higher means grips stand out from rest more clearly.' },
  { key: 'restNoise', label: 'Rest noise', short: 'rest noise', unit: '% of range', scale: 'ratio', direction: 'lower', weight: 1,
    help: 'Sample-to-sample wobble while relaxed, as a share of the calibrated range.' },
  { key: 'cv', label: 'Burst consistency (CV)', short: 'burst-to-burst variation', unit: '%', scale: 'diff', direction: 'lower', weight: 2,
    help: 'How much the same gesture varies from one repetition to the next. Lower is steadier.' },
  { key: 'fade', label: 'Fade over repetitions', short: 'change per repetition', unit: '% per rep', scale: 'diff', direction: 'higher', weight: 1,
    help: 'How much each repetition grows (+) or shrinks (-) compared with the average one. Closer to 0 or above is better.' },
  { key: 'arm', label: 'Arm-position sensitivity', short: 'arm-only signal', unit: '% of grip', scale: 'diff', direction: 'lower', weight: 2,
    help: 'Signal from bending the elbow with the hand relaxed, as a share of a grip. Lower means fewer false grips.' },
  { key: 'dropouts', label: 'Dropouts', short: 'dropouts', unit: 'per min', scale: 'diff', direction: 'lower', weight: 2,
    help: 'Times the signal fell to 0 (lost contact or a wire).' },
  { key: 'spikes', label: 'Spikes', short: 'spikes', unit: 'per min', scale: 'diff', direction: 'lower', weight: 1,
    help: 'Sudden jumps that fade slowly, usually a sensor lifting or a loose wire.' },
  { key: 'saturation', label: 'Saturated samples', short: 'saturated samples', unit: '%', scale: 'diff', direction: 'lower', weight: 1,
    help: 'Samples stuck at the top of the range, where differences between grips are lost.' },
  { key: 'drift', label: 'Rest drift', short: 'rest drift', unit: '% of range', scale: 'diff', direction: 'lower', weight: 1,
    help: 'How far the rest level moved between the start and the end, as a share of the calibrated range.' },
];

const NOISE_FLOOR = 0.25; // counts: below ADC quantisation (about 0.29) a "noise" figure is meaningless
const MIN_SPAN = 10;      // counts: a calibration range smaller than this did not capture a squeeze
const REP_RE = /grip|squeeze|open|finger|pinch|point|fist/i;
const GRIP_RE = /grip|squeeze|fist/i;
const ARM_RE = /elbow|bend|distractor/i;

// Small seeded RNG (mulberry32) so a scorecard is reproducible: same files, same intervals.
function rngOf(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const finite = (a) => a.filter(Number.isFinite);
const mean = (a) => { const f = finite(a); return f.length ? f.reduce((x, y) => x + y, 0) / f.length : NaN; };
function quantile(a, p) {
  const s = finite(a).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
}
const median = (a) => quantile(a, 0.5);

function classOf(label) {
  const L = String(label || '');
  if (!L || L === 'paused' || L.startsWith('cal_')) return L.startsWith('cal_') ? 'cal' : null;
  const { gesture } = splitLabel(L);
  if (/^rest$/i.test(gesture)) return 'rest';
  if (ARM_RE.test(gesture)) return 'arm';
  if (REP_RE.test(gesture)) return 'rep';
  return 'rep'; // a free-mode hotkey label is a gesture the user chose to repeat
}

function segmentsOf(labels, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const L = labels[i] || '';
    const last = out[out.length - 1];
    if (last && last.label === L) last.end = i + 1;
    else out.push({ label: L, start: i, end: i + 1, cls: classOf(L) });
  }
  return out;
}

// Rest noise from first differences, made robust with the median absolute value: slow wander
// is not noise, and a dropout or spike inside a rest is already counted by its own row.
function robustNoise(v) {
  const d = [];
  for (let i = 1; i < v.length; i++) if (Number.isFinite(v[i]) && Number.isFinite(v[i - 1])) d.push(Math.abs(v[i] - v[i - 1]));
  return d.length ? (median(d) * 1.4826) / Math.SQRT2 : NaN;
}

// The second half of a rest: the first half still holds the decay of the previous grip.
const restPart = (v, sg) => v.slice(sg.start + Math.floor((sg.end - sg.start) / 2), sg.end);

function metaOf(rec) {
  const m = rec.meta || {};
  return {
    personId: m.person_id ? String(m.person_id) : null,
    protocol: m.protocol ? String(m.protocol) : null,
    setup: m.setup ? String(m.setup) : null,
    startedAt: m.started_at ? String(m.started_at) : null,
  };
}

function setupSecondsOf(rec) {
  const m = rec.meta || {};
  if (Number(m.setup_s) > 0) return Number(m.setup_s);
  const mk = rec.markers || [];
  const a = mk.find((x) => /^setup (start|begin)/i.test(x.note || ''));
  const b = mk.find((x) => /^setup (done|end|ready)/i.test(x.note || ''));
  return a && b && b.t > a.t ? Math.round((b.t - a.t) / 100) / 10 : null;
}

export function scoreRecording(rec, opts = {}) {
  const o = { blockSec: 5, minReps: 5, ...opts };
  const data = Array.isArray(rec.data) ? rec.data : [];
  const C = data.length;
  const n = C ? Math.max(...data.map((v) => v.length)) : 0;
  const rate = rec.rateHz || Q.assumedRateHz;
  const labels = Array.isArray(rec.labels) ? rec.labels : [];
  const segs = segmentsOf(labels, labels.length ? n : 0);
  const cal = labels.length ? calibrate({ data, labels }) : null;

  const restSegs = segs.filter((s) => s.cls === 'rest' && s.end - s.start >= 4);
  const third = (i) => (i < restSegs.length / 3 ? 'early' : i >= (2 * restSegs.length) / 3 ? 'late' : 'mid');
  const rests = restSegs.map((sg, i) => ({
    g: third(i), start: sg.start,
    ch: data.map((v) => { const p = restPart(v, sg); return { level: median(p), noise: robustNoise(p) }; }),
  }));
  const globalRest = data.map((_, c) => ({ level: median(rests.map((r) => r.ch[c].level)), noise: median(rests.map((r) => r.ch[c].noise)) }));
  // Each repetition is measured against the rest just before it, so a slow drift or an arm
  // position change does not count as grip height.
  const before = (sg) => { let r = null; for (const x of rests) if (x.start < sg.start) r = x; return r; };
  const burst = (sg, cls) => {
    const base = before(sg);
    return data.map((v, c) => {
      const b = base ? base.ch[c] : globalRest[c];
      const amp = quantile(v.slice(sg.start, sg.end), 0.9) - b.level;
      return { amp, srr: amp / Math.max(b.noise, NOISE_FLOOR), cls };
    });
  };
  const repSegs = segs.filter((s) => s.cls === 'rep');
  const reps = repSegs.map((sg, i) => ({ g: sg.label, order: i, label: sg.label, grip: GRIP_RE.test(splitLabel(sg.label).gesture), ch: burst(sg) }));
  const arms = segs.filter((s) => s.cls === 'arm').map((sg) => ({ g: 'arm', label: sg.label, ch: burst(sg) }));
  const repCounts = {};
  for (const r of reps) repCounts[r.label] = (repCounts[r.label] || 0) + 1;

  const span = []; const spanSource = [];
  for (let c = 0; c < C; c++) {
    const s = cal ? cal.squeeze[c] - cal.rest[c] : NaN;
    const g = median(reps.map((r) => r.ch[c].amp));
    if (s >= MIN_SPAN) { span.push(s); spanSource.push('calibration'); } else if (g > 0) { span.push(g); spanSource.push('grips'); } else { span.push(NaN); spanSource.push(null); }
  }

  // Event counts in fixed time blocks: the bootstrap resamples blocks, so a design with one
  // bad minute is not judged as if every minute were bad.
  const bl = Math.max(1, Math.round(o.blockSec * rate));
  const chRep = data.map((v) => analyzeChannel(v, { rateHz: rate }));
  const blocks = [];
  for (let s0 = 0; s0 < n; s0 += bl) {
    const s1 = Math.min(n, s0 + bl);
    if (s1 - s0 < bl / 2 && blocks.length) { blocks[blocks.length - 1].end = s1; continue; } // fold a short tail in
    blocks.push({ start: s0, end: s1 });
  }
  for (const b of blocks) {
    b.g = 'block';
    b.minutes = (b.end - b.start) / rate / 60;
    b.ch = data.map((v, c) => {
      let sat = 0;
      for (let i = b.start; i < b.end; i++) if (v[i] >= Q.saturation) sat++;
      return {
        drop: chRep[c].dropouts.filter((d) => d.start >= b.start && d.start < b.end).length,
        spk: chRep[c].spikes.filter((x) => x.index >= b.start && x.index < b.end).length,
        sat, n: b.end - b.start,
      };
    });
  }

  const sc = {
    version: 1, n, channels: C, channelNames: rec.channelNames || data.map((_, c) => `ch${c + 1}`),
    rateHz: rec.rateHz || null, assumedRate: rec.rateHz ? null : Q.assumedRateHz, durationSec: n / rate,
    synthetic: isSynthetic(rec), meta: metaOf(rec), setupSeconds: setupSecondsOf(rec), calibrated: !!cal,
    span, spanSource, repCounts, labels: [...new Set(labels.filter(Boolean))].sort(),
    units: { reps, rests, arms, blocks }, values: {},
  };
  const all = Array.from({ length: C }, (_, c) => c);
  for (const m of METRICS) sc.values[m.key] = { all: statOf(m.key, sc.units, sc, all), perChannel: all.map((c) => statOf(m.key, sc.units, sc, [c])) };
  return sc;
}

function isSynthetic(rec) {
  const m = rec.meta || {};
  return rec.synthetic === true || (rec.truth && rec.truth.synthetic === true) || String(m.synthetic) === 'true'
    || /twin|synthetic|demo|fake/i.test(String(m.source || m.device || ''));
}

function groupBy(units) {
  const g = new Map();
  for (const u of units) { if (!g.has(u.g)) g.set(u.g, []); g.get(u.g).push(u); }
  return [...g.values()];
}

function slope(xs, ys) {
  const mx = mean(xs); const my = mean(ys);
  let sxy = 0; let sxx = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  return sxx > 0 ? sxy / sxx : NaN;
}

// One channel's value of one metric on a (possibly resampled) set of units.
function chStat(key, U, sc, c) {
  const span = sc.span[c];
  switch (key) {
    case 'srr': return mean(U.reps.map((u) => u.ch[c].srr));
    case 'restNoise': return (mean(U.rests.map((u) => u.ch[c].noise)) / span) * 100;
    case 'cv': return mean(groupBy(U.reps).map((g) => {
      const a = finite(g.map((u) => u.ch[c].amp)); const m = mean(a);
      if (a.length < 2 || !(m > 0)) return NaN;
      return (Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) / m) * 100;
    }));
    case 'fade': return mean(groupBy(U.reps).map((g) => {
      const m = mean(g.map((u) => u.ch[c].amp));
      return m > 0 ? (slope(g.map((u) => u.order), g.map((u) => u.ch[c].amp)) / m) * 100 : NaN;
    }));
    case 'arm': {
      const grips = U.reps.filter((u) => u.grip);
      const g = mean((grips.length ? grips : U.reps).map((u) => u.ch[c].amp));
      return U.arms.length && g > 0 ? (mean(U.arms.map((u) => u.ch[c].amp)) / g) * 100 : NaN;
    }
    case 'dropouts': case 'spikes': {
      const f = key === 'dropouts' ? 'drop' : 'spk';
      const min = U.blocks.reduce((s, b) => s + b.minutes, 0);
      return min > 0 ? U.blocks.reduce((s, b) => s + b.ch[c][f], 0) / min : NaN;
    }
    case 'saturation': {
      const tot = U.blocks.reduce((s, b) => s + b.ch[c].n, 0);
      return tot ? (U.blocks.reduce((s, b) => s + b.ch[c].sat, 0) / tot) * 100 : NaN;
    }
    case 'drift': {
      const lv = (g) => mean(U.rests.filter((u) => u.g === g).map((u) => u.ch[c].level));
      return (Math.abs(lv('late') - lv('early')) / span) * 100;
    }
    default: return NaN;
  }
}

// Several channels: the plain mean of the channels' values (finite ones only).
function statOf(key, U, sc, chans) {
  return mean(chans.map((c) => chStat(key, U, sc, c)));
}

// Resample each unit type with replacement, within its stratum (gesture label, early/late
// rest, block), so every resample keeps the protocol's shape.
function resample(units, r) {
  const out = {};
  for (const [k, list] of Object.entries(units)) {
    out[k] = [];
    for (const g of groupBy(list)) for (let i = 0; i < g.length; i++) out[k].push(g[Math.floor(r() * g.length)]);
  }
  return out;
}

const fmt = (x) => (!Number.isFinite(x) ? 'n/a' : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(1) : x.toFixed(2));

function whenOf(a, b, today) {
  const d = (s) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
  const da = d(a.meta.startedAt); const db = d(b.meta.startedAt);
  if (!da || !db || da !== db) return 'in these two recordings';
  return da === today ? 'today' : `on ${da}`;
}

function rowSentence(m, row, names, ctx) {
  const [A, B] = names;
  if (row.verdict === 'na') return `Not enough data to compare ${m.short}: ${m.key === 'arm' ? 'record the elbow-only step in both' : 'needs at least 2 repetitions and rest periods in both recordings'}.`;
  let s;
  if (m.scale === 'ratio') {
    s = row.effect >= 1
      ? `${B} had a ${fmt(row.effect)}× higher ${m.short} than ${A} (95% CI ${fmt(row.lo)}-${fmt(row.hi)})`
      : `${B} had a ${fmt(1 / row.effect)}× lower ${m.short} than ${A} (95% CI ${fmt(1 / row.hi)}-${fmt(1 / row.lo)})`;
  } else {
    s = `${B} had ${fmt(Math.abs(row.effect))} ${m.unit} ${row.effect >= 0 ? 'more' : 'less'} ${m.short} than ${A} (95% CI of the difference ${fmt(row.lo)} to ${fmt(row.hi)} ${m.unit})`;
  }
  const better = m.direction === 'higher' ? 'Higher' : 'Lower';
  const tail = row.verdict === 'none'
    ? ` The interval includes ${m.scale === 'ratio' ? '1×' : '0'}, so: no clear difference.`
    : ` ${better} is better, so ${row.winner} comes out ahead here.`;
  return `${ctx.prefix}On ${ctx.who}, ${ctx.when}, ${s}.${tail}`;
}

function fairnessOf(a, b, names, o) {
  const [A, B] = names;
  const out = [];
  const add = (level, code, message) => out.push({ level, code, message });
  if (a.synthetic || b.synthetic) add('warn', 'synthetic', `Synthetic data in ${a.synthetic && b.synthetic ? 'both recordings' : a.synthetic ? A : B}: this only tests the scorecard, it is never evidence about a design.`);
  if (a.meta.protocol && b.meta.protocol) {
    if (a.meta.protocol !== b.meta.protocol) add('warn', 'protocol', `Different protocols (${a.meta.protocol} vs ${b.meta.protocol}). Record both with the same steps.`);
  } else if (a.labels.join('|') !== b.labels.join('|')) {
    add('warn', 'protocol', 'The recordings have different steps (their labels differ). Record both with the same protocol.');
  }
  if (a.meta.personId && b.meta.personId) {
    if (a.meta.personId !== b.meta.personId) add('warn', 'person', `Different people (${a.meta.personId} vs ${b.meta.personId}). Arms differ more than sleeves do: compare on the same person.`);
  } else add('warn', 'person', 'Person ID missing in one or both recordings, so it is not known that this is the same person.');
  if (a.channels !== b.channels) add('warn', 'channels', `Different channel counts (${a.channels} vs ${b.channels}); only the first ${Math.min(a.channels, b.channels)} are compared.`);
  const ra = a.rateHz || a.assumedRate; const rb = b.rateHz || b.assumedRate;
  if (!a.rateHz || !b.rateHz) add('warn', 'rate', `Sample rate unknown in ${!a.rateHz && !b.rateHz ? 'both recordings' : !a.rateHz ? A : B}; per-minute counts assume ${Q.assumedRateHz} Hz.`);
  else if (Math.abs(ra - rb) / Math.max(ra, rb) > 0.05) add('warn', 'rate', `Different sample rates (${Math.round(ra)} Hz vs ${Math.round(rb)} Hz). Spikes and dropouts look different at different rates.`);
  for (const [s, nm] of [[a, A], [b, B]]) {
    const few = Object.entries(s.repCounts).filter(([, k]) => k < o.minReps);
    if (!Object.keys(s.repCounts).length) add('warn', 'reps', `${nm}: no labelled repetitions found, so most rows cannot be compared.`);
    else if (few.length) add('warn', 'reps', `${nm}: fewer than ${o.minReps} repetitions of ${few.map(([l, k]) => `${l} (${k})`).join(', ')}. With so few, intervals are wide and a real difference can be missed.`);
    if (!s.calibrated) add('warn', 'calibration', `${nm} has no calibration steps, so its values are scaled by its own grips instead of a calibrated range.`);
  }
  const ta = Date.parse(a.meta.startedAt || ''); const tb = Date.parse(b.meta.startedAt || '');
  if (Number.isFinite(ta) && Number.isFinite(tb)) {
    const [first, second] = ta <= tb ? [A, B] : [B, A];
    add('info', 'order', `${first} was recorded first, ${Math.round(Math.abs(tb - ta) / 60000)} min before ${second}. Tiredness, sweat and the band settling build up over a session and can look like a design difference: record in the order A-B-B-A and compare again.`);
  } else add('info', 'order', 'Recording order unknown. Tiredness and sweat build up over a session: record in the order A-B-B-A so neither design always goes second.');
  return out;
}

function overallOf(rows, names, ctx, fairness) {
  const points = { A: 0, B: 0 }; let undecided = 0; let na = 0;
  for (const r of rows) {
    if (r.verdict === 'A' || r.verdict === 'B') points[r.verdict] += r.weight;
    else if (r.verdict === 'none') undecided += r.weight; else na += r.weight;
  }
  const verdict = points.A === points.B ? 'none' : points.A > points.B ? 'A' : 'B';
  const pts = `${names[0]} ${points.A} points, ${names[1]} ${points.B} points, ${undecided} undecided${na ? `, ${na} not measurable` : ''}`;
  const caveat = fairness.some((f) => f.level === 'warn') ? ' Check the warnings above before trusting this.' : '';
  const sentence = verdict === 'none'
    ? `${ctx.prefix}No clear overall difference ${ctx.when === 'today' ? 'today' : ctx.when} (${pts}).${caveat}`
    : `${ctx.prefix}On ${ctx.who}, ${ctx.when}, ${names[verdict === 'A' ? 0 : 1]} came out ahead overall (${pts}). Each row whose interval excludes no difference gives its weight to the better side.${caveat}`;
  return { verdict, points, undecided, na, sentence };
}

// Pooling (several recordings per design). Each side's value is the plain mean of its
// recordings' values, so a long recording counts the same as a short one, and each recording
// keeps its own calibrated range. The bootstrap is two-level: pick that side's recordings with
// replacement, then resample units inside each pick, so the interval carries session-to-session
// variation too. With one recording per side no extra random numbers are drawn: a single-pair
// card is exactly what it was before pooling.
const uniq = (a) => [...new Set(a)];
const plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;

function poolOf(list) {
  if (list.length === 1) return list[0];
  const ids = list.map((s) => s.meta.personId);
  const people = uniq(ids.filter(Boolean)).sort();
  const protos = uniq(list.map((s) => s.meta.protocol));
  const starts = list.map((s) => s.meta.startedAt).filter(Boolean).sort();
  const rates = list.map((s) => s.rateHz);
  const setups = list.map((s) => s.setupSeconds).filter(Number.isFinite);
  const repCounts = {};
  for (const s of list) for (const [l, k] of Object.entries(s.repCounts)) repCounts[l] = (repCounts[l] || 0) + k;
  return {
    channels: Math.min(...list.map((s) => s.channels)), channelNames: list[0].channelNames,
    rateHz: rates.every(Boolean) ? median(rates) : null, durationSec: list.reduce((t, s) => t + s.durationSec, 0),
    synthetic: list.some((s) => s.synthetic), people,
    meta: { personId: people.length === 1 && ids.every(Boolean) ? people[0] : null, protocol: protos.length === 1 ? protos[0] : null, setup: null, startedAt: starts[0] || null },
    setupSeconds: setups.length ? median(setups) : null, calibrated: list.every((s) => s.calibrated),
    repCounts, labels: uniq(list.flatMap((s) => s.labels)).sort(), spanSource: list[0].spanSource,
  };
}

const sideValue = (list, key, chans) => mean(list.map((s) => statOf(key, s.units, s, chans)));
function drawSide(list, r) {
  const pick = list.length > 1 ? list.map(() => list[Math.floor(r() * list.length)]) : list;
  return pick.map((s) => ({ s, units: resample(s.units, r) }));
}
const drawValue = (draw, key, chans) => mean(draw.map((d) => statOf(key, d.units, d.s, chans)));

// Fairness for pooled sides: who is in each side and how many sessions, protocol and rate
// across every recording, and the order the sessions were recorded in.
function poolFairnessOf(LA, LB, a, b, names, o) {
  const [A, B] = names;
  const out = [];
  const add = (level, code, message) => out.push({ level, code, message });
  const all = [...LA, ...LB];
  const side = (p, L) => {
    const ids = L.map((s) => s.meta.personId);
    const people = uniq(ids.filter(Boolean)).sort();
    const unk = ids.filter((x) => !x).length;
    return `${plural(L.length, 'recording')} from ${plural(people.length, 'volunteer')}${people.length ? ` (${people.join(', ')})` : ''}${unk ? ` plus ${unk} with no person ID` : ''}`;
  };
  if (a.synthetic || b.synthetic) add('warn', 'synthetic', `Synthetic data in ${a.synthetic && b.synthetic ? 'both sides' : a.synthetic ? A : B}: this only tests the scorecard, it is never evidence about a design.`);
  add('info', 'pool', `${A}: ${side(a, LA)}. ${B}: ${side(b, LB)}. Each recording counts equally, however long it is, and the interval resamples whole recordings as well as the repetitions inside them.`);
  for (const [L, nm] of [[LA, A], [LB, B]]) {
    if (L.length < 3) add('warn', 'pool-small', `Small sample: only ${plural(L.length, 'recording')} in ${nm}. With so few sessions the interval is rough and mostly shows how much they differ from each other; record more sessions to narrow it.`);
  }
  const protos = uniq(all.map((s) => s.meta.protocol).filter(Boolean));
  if (protos.length > 1) add('warn', 'protocol', `Different protocols across the recordings (${protos.join(', ')}). Record every session with the same steps.`);
  else if (uniq(all.map((s) => s.labels.join('|'))).length > 1) add('warn', 'protocol', 'Some recordings have different steps (their labels differ). Record every session with the same protocol.');
  const unknown = all.filter((s) => !s.meta.personId).length;
  const pa = uniq(LA.map((s) => s.meta.personId)).sort().join(', '); const pb = uniq(LB.map((s) => s.meta.personId)).sort().join(', ');
  if (unknown) add('warn', 'person', `Person ID missing in ${unknown} of the ${all.length} recordings, so it is not known who is in each side.`);
  else if (pa !== pb) add('warn', 'person', `The sides have different volunteers (${A}: ${pa}; ${B}: ${pb}). Arms differ more than sleeves do: pool the same volunteers on both sides.`);
  if (uniq(all.map((s) => s.channels)).length > 1) add('warn', 'channels', `Different channel counts across the recordings; only the first ${Math.min(a.channels, b.channels)} are compared.`);
  const rates = all.map((s) => s.rateHz);
  const noRate = rates.filter((x) => !x).length;
  if (noRate) add('warn', 'rate', `Sample rate unknown in ${noRate} of the ${all.length} recordings; per-minute counts assume ${Q.assumedRateHz} Hz there.`);
  else if ((Math.max(...rates) - Math.min(...rates)) / Math.max(...rates) > 0.05) add('warn', 'rate', `Different sample rates across the recordings (${Math.round(Math.min(...rates))} to ${Math.round(Math.max(...rates))} Hz). Spikes and dropouts look different at different rates.`);
  for (const [s, nm] of [[a, A], [b, B]]) {
    const few = Object.entries(s.repCounts).filter(([, k]) => k < o.minReps);
    if (!Object.keys(s.repCounts).length) add('warn', 'reps', `${nm}: no labelled repetitions found, so most rows cannot be compared.`);
    else if (few.length) add('warn', 'reps', `${nm}: fewer than ${o.minReps} repetitions of ${few.map(([l, k]) => `${l} (${k})`).join(', ')} across its recordings. With so few, intervals are wide and a real difference can be missed.`);
    if (!s.calibrated) add('warn', 'calibration', `${nm} has recordings without calibration steps; those are scaled by their own grips instead of a calibrated range.`);
  }
  const timed = all.map((s, i) => ({ t: Date.parse(s.meta.startedAt || ''), side: i < LA.length ? A : B }));
  if (timed.every((x) => Number.isFinite(x.t))) {
    const seq = timed.sort((x, y) => x.t - y.t).map((x) => x.side);
    const split = seq.findIndex((x) => x !== seq[0]);
    const blocked = split > 0 && seq.slice(split).every((x) => x === seq[split]);
    add('info', 'order', `Recording order: ${seq.join(', ')}.${blocked ? ` Every ${seq[0]} session came before every ${seq[split]} session, so tiredness, sweat and the band settling can look like a design difference: interleave them (A-B-B-A).` : ' The sides are interleaved, so tiredness and sweat do not all fall on one design.'}`);
  } else add('info', 'order', 'Recording order unknown for some recordings. Tiredness and sweat build up over a session: interleave the sessions (A-B-B-A) so neither design always goes second.');
  return out;
}

function poolContextOf(LA, LB, a, b, today) {
  const all = [...LA, ...LB];
  const ids = all.map((s) => s.meta.personId);
  const people = uniq(ids.filter(Boolean));
  const who = ids.every(Boolean) ? (people.length === 1 ? `this person (${people[0]})` : `these ${people.length} volunteers`) : 'the volunteers in these recordings';
  const days = uniq(all.map((s) => (s.meta.startedAt && /^\d{4}-\d{2}-\d{2}/.test(s.meta.startedAt) ? s.meta.startedAt.slice(0, 10) : null)));
  const when = days.length === 1 && days[0] ? (days[0] === today ? 'today' : `on ${days[0]}`) : `in these ${all.length} recordings`;
  return { who, when, prefix: a.synthetic || b.synthetic ? 'Synthetic data: ' : '' };
}

export function compareRecordings(ra, rb, opts = {}) {
  const o = { names: ['A', 'B'], boot: 2000, seed: 1, minReps: 5, blockSec: 5, today: new Date().toISOString().slice(0, 10), ...opts };
  const names = [String(o.names[0] || 'A'), String(o.names[1] || 'B')];
  const scoreAll = (x) => (Array.isArray(x) ? x : [x]).map((s) => (s && s.units ? s : scoreRecording(s, o)));
  const LA = scoreAll(ra); const LB = scoreAll(rb);
  const pooled = LA.length > 1 || LB.length > 1;
  const a = poolOf(LA); const b = poolOf(LB);
  const C = Math.min(a.channels, b.channels);
  let fairness; let ctx;
  if (pooled) {
    fairness = poolFairnessOf(LA, LB, a, b, names, o);
    ctx = poolContextOf(LA, LB, a, b, o.today);
  } else {
    fairness = fairnessOf(a, b, names, o);
    const same = a.meta.personId && a.meta.personId === b.meta.personId;
    ctx = {
      who: same ? `this person (${a.meta.personId})` : a.meta.personId && b.meta.personId ? 'these two people' : 'this person',
      when: whenOf(a, b, o.today),
      prefix: a.synthetic || b.synthetic ? 'Synthetic data: ' : '',
    };
  }
  const views = [{ id: 'all', name: 'All channels', chans: Array.from({ length: C }, (_, c) => c) }];
  for (let c = 0; c < C; c++) views.push({ id: c, name: a.channelNames[c] || `ch${c + 1}`, chans: [c] });

  // Bootstrap: one resample of A and one of B per draw, every metric and view read from the
  // same draw. A and B use different streams, so a file compared with a copy of itself gets
  // intervals around "no difference", as it should.
  const r = rngOf(o.seed);
  const effects = views.map(() => METRICS.map(() => []));
  for (let d = 0; d < o.boot; d++) {
    const ua = drawSide(LA, r); const ub = drawSide(LB, r);
    views.forEach((v, vi) => METRICS.forEach((m, mi) => {
      const e = effectOf(m, drawValue(ua, m.key, v.chans), drawValue(ub, m.key, v.chans));
      if (Number.isFinite(e)) effects[vi][mi].push(e);
    }));
  }
  const outViews = views.map((v, vi) => {
    const rows = METRICS.map((m, mi) => {
      const va = sideValue(LA, m.key, v.chans);
      const vb = sideValue(LB, m.key, v.chans);
      const effect = effectOf(m, va, vb);
      const draws = effects[vi][mi];
      const row = { key: m.key, label: m.label, unit: m.unit, scale: m.scale, direction: m.direction, weight: m.weight, a: va, b: vb, effect, lo: NaN, hi: NaN, verdict: 'na', winner: null };
      if (Number.isFinite(effect) && draws.length >= o.boot / 2) {
        row.lo = quantile(draws, 0.025); row.hi = quantile(draws, 0.975);
        const zero = m.scale === 'ratio' ? 1 : 0;
        if (row.lo > zero || row.hi < zero) {
          const bHigher = row.lo > zero;
          row.verdict = bHigher === (m.direction === 'higher') ? 'B' : 'A';
          row.winner = names[row.verdict === 'A' ? 0 : 1];
        } else row.verdict = 'none';
      }
      row.sentence = rowSentence(m, row, names, ctx);
      return row;
    });
    return { id: v.id, name: v.name, rows, overall: overallOf(rows, names, ctx, fairness) };
  });
  const summary = (s) => ({ channels: s.channels, rateHz: s.rateHz, durationSec: Math.round(s.durationSec), synthetic: s.synthetic, meta: s.meta, setupSeconds: s.setupSeconds, calibrated: s.calibrated, repCounts: s.repCounts, spanSource: s.spanSource });
  const sideSummary = (s, L) => {
    const out = summary(s);
    const ids = L.map((x) => x.meta.personId);
    out.pool = { recordings: L.length, volunteers: uniq(ids.filter(Boolean)).length, unknownPeople: ids.filter((x) => !x).length };
    if (pooled) out.recordings = L.map(summary);
    return out;
  };
  return {
    version: 1, names, synthetic: a.synthetic || b.synthetic, pooled, context: ctx, fairness,
    weights: METRICS.map((m) => ({ key: m.key, label: m.label, weight: m.weight, direction: m.direction })),
    totalWeight: METRICS.reduce((s, m) => s + m.weight, 0), boot: o.boot, seed: o.seed,
    a: sideSummary(a, LA), b: sideSummary(b, LB), views: outViews,
  };
}

function effectOf(m, va, vb) {
  if (!Number.isFinite(va) || !Number.isFinite(vb)) return NaN;
  if (m.scale === 'ratio') return va > 0 && vb > 0 ? vb / va : NaN;
  return vb - va;
}

export function scorecardJSON(card) {
  // NaN is not JSON: write null so the file reloads cleanly.
  return JSON.stringify(card, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 2);
}

const escH = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Dot-and-interval chart. Ratios are drawn on a log scale so 2× and 0.5× sit equally far from
// the "no difference" line. The scale is symmetric around that line; the bar is clipped at the
// edge (an arrow-like cap shows it ran off) rather than squashing every other row.
export function intervalSVG(row, { width = 160, height = 22 } = {}) {
  const ratio = row.scale === 'ratio';
  const tf = (x) => (ratio ? Math.log(x) : x);
  const zero = ratio ? 0 : 0;
  const pts = [row.effect, row.lo, row.hi].map(tf);
  const ok = pts.every(Number.isFinite);
  const span = ok ? Math.max(...pts.map((x) => Math.abs(x - zero)), ratio ? Math.log(1.25) : 1e-9) * 1.15 : 1;
  const pad = 6; const mid = width / 2;
  const X = (x) => Math.max(pad, Math.min(width - pad, mid + ((x - zero) / span) * (mid - pad)));
  const y = height / 2;
  let body = `<line x1="${mid}" y1="2" x2="${mid}" y2="${height - 2}" stroke="currentColor" stroke-opacity=".55" stroke-dasharray="2 2"/>`;
  if (ok) {
    const [e, lo, hi] = pts.map(X);
    body += `<line x1="${lo.toFixed(1)}" y1="${y}" x2="${hi.toFixed(1)}" y2="${y}" stroke="currentColor" stroke-width="2"/>`
      + `<line x1="${lo.toFixed(1)}" y1="${y - 4}" x2="${lo.toFixed(1)}" y2="${y + 4}" stroke="currentColor" stroke-width="1.5"/>`
      + `<line x1="${hi.toFixed(1)}" y1="${y - 4}" x2="${hi.toFixed(1)}" y2="${y + 4}" stroke="currentColor" stroke-width="1.5"/>`
      + `<circle cx="${e.toFixed(1)}" cy="${y}" r="4" fill="currentColor"/>`;
  }
  return `<svg class="sc-ci" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false">${body}</svg>`;
}

const verdictText = (row, names) => (row.verdict === 'na' ? 'Not measurable' : row.verdict === 'none' ? '= No clear difference' : `${row.verdict === 'A' ? '◀' : '▶'} ${names[row.verdict === 'A' ? 0 : 1]} better`);
export { verdictText, fmt as formatValue };

export function scorecardHTML(card) {
  const [A, B] = card.names.map(escH);
  const v = card.views[0];
  const rows = v.rows.map((r) => `<tr><th scope="row">${escH(r.label)}<br><small>${r.direction === 'higher' ? 'higher' : 'lower'} is better · weight ${r.weight}</small></th>`
    + `<td>${escH(fmt(r.a))} <small>${escH(r.unit === '×' ? '' : r.unit)}</small></td><td>${escH(fmt(r.b))} <small>${escH(r.unit === '×' ? '' : r.unit)}</small></td>`
    + `<td>${intervalSVG(r)}<br><small>${r.scale === 'ratio' ? `${escH(B)} ÷ ${escH(A)}` : `${escH(B)} − ${escH(A)}`}: ${escH(fmt(r.effect))} (${escH(fmt(r.lo))} to ${escH(fmt(r.hi))})</small></td>`
    + `<td><b>${escH(verdictText(r, card.names))}</b><br><small>${escH(r.sentence)}</small></td></tr>`).join('\n');
  const warn = card.fairness.map((f) => `<li><b>${f.level === 'warn' ? 'Check' : 'Note'}:</b> ${escH(f.message)}</li>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Design scorecard: ${A} vs ${B}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#111;max-width:1100px}table{border-collapse:collapse;width:100%}
th,td{border-top:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top}small{color:#555}.overall{font-size:17px;border:2px solid #111;padding:10px;margin:12px 0}
.sc-ci{color:#111}@media print{body{margin:0}}</style></head><body>
<h1>Design scorecard: ${A} vs ${B}</h1>
${card.synthetic ? '<p><b>Synthetic data: this only tests the scorecard, it is never evidence about a design.</b></p>' : ''}
<ul>${warn}</ul>
<p class="overall">${escH(v.overall.sentence)}</p>
<table><thead><tr><th>Metric (${escH(v.name)})</th><th>${A}</th><th>${B}</th><th>Difference, 95% interval</th><th>Verdict</th></tr></thead>
<tbody>
${rows}
</tbody></table>
<p><small>Weights: ${card.weights.map((w) => `${escH(w.label)} ${w.weight}`).join(', ')} (total ${card.totalWeight}). Intervals: ${card.boot} bootstrap resamples over repetitions, rest periods and 5 s blocks (seed ${card.seed})${card.pooled ? ', and over whole recordings in each side' : ''}. These numbers describe ${card.pooled ? `these ${card.a.pool.recordings + card.b.pool.recordings} recordings` : 'these two recordings'} only.</small></p>
</body></html>
`;
}
