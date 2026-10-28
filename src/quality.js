// quality.js: per-channel recording checks with plain-language messages. Pure.
//
// Contract
//   analyzeChannel(values: number[], opts?) -> ChannelReport
//     { n, baseline, restNoise, threshold, bursts: Burst[], burstCount,
//       fade: { peaks, ratio, perRep, flagged } (labelled: one peak per main-task step), dropouts: [{ start, length }],
//       saturation: { count, fraction }, spikes: [{ index, height, decayRatio }] }
//     Burst = { start, end, peakIndex, peak, amplitude (peak - baseline), artifact }
//     Indices are sample indices into `values`. Units are raw ADC counts (0-1023).
//   analyzeRecording(rec, opts?) -> Report
//     rec: { data: number[][], labels?: (string|null)[], rateHz?: number|null, channelNames? }
//     { version, rateHz, assumedRate, calibration: {rest[], squeeze[]}|null, bandShift: []|null,
//       channels: ChannelReport[], position: PositionReport[]|null,
//       items: [{ level: 'green'|'amber'|'red', channel: number|null, code, message }] }
//     Each item also has `at`: the sample index where the problem was first seen, or null
//     when it is about the whole recording. opts.calibration (from calibrate()) replaces the
//     recording's own; opts.skipPosition leaves the position check out.
//   windowOf(src, from, to?) -> rec   src is row-major like Session ({ t, rows, labels,
//     channelNames }); returns the analyzeRecording input for rows from..to-1.
//   new LiveQuality({ windowSec = 15, ...DEFAULTS overrides }).update(src) -> { items, followOns, from, to }
//     Rolling check for the Record screen: the last windowSec of src, calibration-aware
//     (calibration taken from the full recording once a cal_* segment ends), position check
//     on the full recording after each arm-only segment ends. Items are amber/red only:
//     { level, channel, code, message, at (absolute sample index), atMs (src.t at that index) }.
//     An item that stays present keeps its first `at`, so "12 s ago" keeps counting.
//     Also returns followOns: the window's green items with `causedBy` (same shape plus causedBy),
//     to be shown under the root item on the same channel; never counted as problems.
//   movementCheck(rec, { windowSec = 5 }) -> [{ channel, moved, bursts, amplitude }]
//     Flex check: bursts per channel over the last windowSec of a column rec (see windowOf).
//   Windows are given in ms and converted with the rate; legacy logs have no rate, so
//   DEFAULTS.assumedRateHz stands in (and the report says so).
//   Every item also has `fix`: the Hardware Doctor's plain "what to do" line (doctor.js).
//   Hardware Doctor items (doctor.js) are appended by analyzeRecording: board_reset, slow_link,
//   gap, jitter, floating, hum, crosstalk, and green information items boot_junk and
//   hum_unchecked. opts.doctor === false leaves them out (LiveQuality does: its window is short).
//   One root cause per channel: saturation, floating, hum or dropout on a channel turns that
//   channel's follow-on items green with `causedBy: <root code>` (see ROOT_CAUSES).
//   bandShift(rec, cal, limit=0.3, { restLimit=0.2 }) -> [{ restShift, squeezeShift, flagged,
//     reason: 'rest'|'gain'|null, fatigue: bool, stepRatio }] per channel, or null.
// Failure behaviour: empty or all-NaN channels give an 'amber' "no data" item, never a throw.

import { doctorItems, fixFor } from './doctor.js';
import { driftItems, DriftTracker } from './drift.js';

export const DEFAULTS = {
  assumedRateHz: 100,     // legacy club logs: unknown rate; ~100 Hz matches their burst lengths
  smoothMs: 50,
  minBurstMs: 150,
  mergeGapMs: 300,
  burstFrac: 0.25,        // on-threshold = baseline + max(k*noise, frac*(p99 - baseline))
  noiseK: 6,
  minBurstAmp: 15,        // below this a "burst" is just noise on a quiet channel
  fadeRatio: 0.75,        // first guess: later half of the reps < 75% of the earlier half ...
  fadePerRep: 0.9,        // ... AND (first guess) a log-linear fit over all reps loses > 10% per rep
                          // (card F1: per rep, so a long session is not judged like a short one;
                          // the twin's clean squeeze fades ~6% per rep, the club grip log ~14%)
  minFadeBursts: 4,
  dropoutMin: 5,          // samples at exactly 0
  saturation: 1015,
  saturationWarnFrac: 0.005,
  spikeJump: 300,         // counts within spikeRiseSamples
  spikeRiseSamples: 2,
  spikeDecaySamples: 10,
  positionAmberRatio: 0.3,
  bandShiftLimit: 0.3,     // fraction of the calibrated rest->squeeze range
  bandShiftRestLimit: 0.2, // rest level moved by this much of the range: the band moved
  bandStepRatio: 0.7,      // every later grip below 70% of every earlier one: a gain step, not fatigue
};

const POSITION_RE = /elbow|position|distractor|bend|bent/i;
const GRIP_RE = /grip|squeeze/i;

// Label "gesture@position": classify for the position check. Calibration is kept out.
function labelClass(label) {
  const s = String(label || '');
  if (!s || s.startsWith('cal_')) return null;
  const at = s.indexOf('@');
  const gesture = at < 0 ? s : s.slice(0, at);
  const pos = at < 0 ? null : s.slice(at + 1);
  if (GRIP_RE.test(gesture)) return 'grip';
  if (/open/i.test(gesture)) return null;
  if (POSITION_RE.test(gesture)) return 'arm';
  if (/rest/i.test(gesture) && pos && !/^(down|none|table)$/i.test(pos)) return 'arm';
  return null;
}

function segments(labels) {
  const segs = [];
  for (let i = 0; i < labels.length; i++) {
    const L = labels[i] || '';
    const last = segs[segs.length - 1];
    if (last && last.label === L) { last.end = i; continue; }
    segs.push({ label: L, start: i, end: i });
  }
  return segs;
}

function medianOf(a) {
  const s = a.filter(Number.isFinite).slice().sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

function segMax(v, sg) {
  let m = -Infinity;
  for (let i = sg.start; i <= sg.end; i++) if (Number.isFinite(v[i]) && v[i] > m) m = v[i];
  return m;
}

// Per-fitting calibration from cal_rest / cal_squeeze segments.
//   calibrate(rec) -> { rest: number[], squeeze: number[] } per channel, or null if no cal segments.
// rest = median of cal_rest samples; squeeze = median of the per-squeeze peaks.
export function calibrate(rec) {
  if (!Array.isArray(rec.labels)) return null;
  const segs = segments(rec.labels);
  const restSegs = segs.filter((s) => s.label === 'cal_rest');
  const sqSegs = segs.filter((s) => s.label === 'cal_squeeze');
  if (!restSegs.length || !sqSegs.length) return null;
  const rest = rec.data.map((v) => medianOf(restSegs.flatMap((sg) => v.slice(sg.start, sg.end + 1))));
  const squeeze = rec.data.map((v) => medianOf(sqSegs.map((sg) => segMax(v, sg))));
  return { rest, squeeze };
}

// normalize(value, rest, squeeze) -> 0 at rest, 1 at the calibration squeeze (not clipped).
export function normalize(x, rest, squeeze) {
  const span = squeeze - rest;
  return span > 0 ? (x - rest) / span : 0;
}

// Band shift: later rest/grip levels vs calibration, as a fraction of the calibrated range
// (a % of the raw rest value is meaningless when rest is ~5 counts).
// Fatigue fade looks like a shift if only grip height is compared: late grips sink ~45% below
// calibration in a tiring session. So a lower grip alone only counts when it drops in a step
// (see `step` below), or when this channel dropped much
// more than the others (fatigue weakens every channel together). A rest-level move is the band
// itself sliding or loosening, which fatigue does not cause, so it counts on its own.
export function bandShift(rec, cal, limit = 0.3, { restLimit = DEFAULTS.bandShiftRestLimit, stepRatio = DEFAULTS.bandStepRatio } = {}) {
  if (!cal) return null;
  const segs = segments(rec.labels || []).filter((s) => !s.label.startsWith('cal_'));
  const restSegs = segs.filter((s) => /^rest(@|$)/.test(s.label));
  const gripSegs = segs.filter((s) => labelClass(s.label) === 'grip');
  const out = rec.data.map((v, c) => {
    const span = cal.squeeze[c] - cal.rest[c];
    if (!(span > 0)) return { restShift: null, squeezeShift: null, flagged: false, reason: null, fatigue: false, stepRatio: null };
    // Use the last third of the session: drift shows up late.
    const late = (arr) => arr.slice(Math.floor((arr.length * 2) / 3));
    const r = medianOf(late(restSegs).flatMap((sg) => v.slice(sg.start, sg.end + 1)));
    const g = medianOf(late(gripSegs).map((sg) => segMax(v, sg)));
    const restShift = Number.isFinite(r) ? Math.round(((r - cal.rest[c]) / span) * 100) / 100 : null;
    const squeezeShift = Number.isFinite(g) ? Math.round(((g - cal.squeeze[c]) / span) * 100) / 100 : null;
    const peaks = gripSegs.map((sg) => segMax(v, sg) - cal.rest[c]).filter((x) => x > 0);
    // Step: some repeat after which every grip is below stepRatio of every grip before it.
    // One weak repeat between normal ones is effort, not the band; a tiring arm declines a
    // little each time, so it never clears this.
    let best = null;
    for (let k = 1; k < peaks.length; k++) {
      const r = Math.max(...peaks.slice(k)) / Math.min(...peaks.slice(0, k));
      if (best == null || r < best) best = r;
    }
    const step = best != null && best < stepRatio;
    return { restShift, squeezeShift, flagged: false, reason: null, fatigue: false, stepRatio: best == null ? null : Math.round(best * 100) / 100, step };
  });
  out.forEach((sh, c) => {
    if (sh.restShift == null && sh.squeezeShift == null) return;
    const others = out.filter((x, k) => k !== c && x.squeezeShift != null).map((x) => x.squeezeShift);
    const apart = others.length >= 2 && sh.squeezeShift != null && sh.squeezeShift - medianOf(others) < -limit;
    if (Math.abs(sh.restShift ?? 0) > restLimit) sh.reason = 'rest';
    else if ((sh.squeezeShift ?? 0) > limit) sh.reason = 'gain';
    else if ((sh.squeezeShift ?? 0) < -limit) {
      // A step on every channel at once is the whole hand easing off (effort), and a band
      // that slid on all channels moves the rest level too (caught above). Only a step that
      // this channel has and the others do not is its sensor's gain changing.
      const otherSteps = out.filter((x, k) => k !== c && x.stepRatio != null).map((x) => x.stepRatio);
      const ownStep = sh.step && (otherSteps.length < 2 || sh.stepRatio < medianOf(otherSteps) - 0.15);
      if (ownStep || apart) sh.reason = 'gain';
      else sh.fatigue = true;
    }
    sh.flagged = sh.reason != null;
  });
  for (const sh of out) delete sh.step;
  return out;
}

function quantile(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

function movingAverage(v, w) {
  if (w <= 1) return v.slice();
  const out = new Array(v.length);
  let sum = 0;
  const half = Math.floor(w / 2);
  // Centred window, clipped at the edges, so burst timing is not shifted.
  const pre = [0];
  for (let i = 0; i < v.length; i++) { sum += v[i]; pre.push(sum); }
  for (let i = 0; i < v.length; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(v.length, i + half + 1);
    out[i] = (pre[b] - pre[a]) / (b - a);
  }
  return out;
}

function findRuns(values, pred, minLen) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= values.length; i++) {
    const hit = i < values.length && pred(values[i]);
    if (hit && start < 0) start = i;
    if (!hit && start >= 0) {
      if (i - start >= minLen) runs.push({ start, length: i - start });
      start = -1;
    }
  }
  return runs;
}

// A contact glitch: a jump far larger than muscle can produce in a couple of samples,
// then a slow (RC-like) decay. A one-sample glitch returns at once, a grip plateaus.
function findSpikes(v, o) {
  const spikes = [];
  for (let i = o.spikeRiseSamples; i < v.length; i++) {
    const before = v[i - o.spikeRiseSamples];
    const jump = v[i] - before;
    if (jump < o.spikeJump) continue;
    // Walk to the local peak.
    let p = i;
    while (p + 1 < v.length && v[p + 1] >= v[p]) p++;
    const k = Math.min(v.length - 1, p + o.spikeDecaySamples);
    if (k - p < 3) continue;
    let falls = 0;
    for (let j = p + 1; j <= k; j++) if (v[j] <= v[j - 1]) falls++;
    const height = v[p] - before;
    const decayRatio = (v[k] - before) / height; // still well above start = slow decay
    if (falls >= (k - p) * 0.8 && decayRatio > 0.2 && decayRatio < 0.95) {
      spikes.push({ index: p, height, decayRatio: Math.round(decayRatio * 100) / 100 });
      i = k; // one report per event
    }
  }
  return spikes;
}

export function analyzeChannel(values, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const rate = o.rateHz || o.assumedRateHz;
  const ms = (x) => Math.max(1, Math.round((x * rate) / 1000));
  const v = values.filter((x) => Number.isFinite(x));
  const rep = {
    n: v.length, baseline: NaN, restNoise: NaN, threshold: NaN, bursts: [], burstCount: 0,
    fade: { peaks: [], ratio: null, perRep: null, flagged: false }, dropouts: [], saturation: { count: 0, fraction: 0 }, spikes: [],
  };
  if (!v.length) return rep;

  rep.dropouts = findRuns(v, (x) => x === 0, o.dropoutMin);
  const satCount = v.filter((x) => x >= o.saturation).length;
  rep.saturation = { count: satCount, fraction: satCount / v.length };
  rep.spikes = findSpikes(v, o);

  // Baseline/noise from the quiet part of the signal, ignoring dropout zeros, which
  // would otherwise drag the baseline to 0 on a bad-contact file.
  const inDrop = new Uint8Array(v.length);
  for (const d of rep.dropouts) inDrop.fill(1, d.start, d.start + d.length);
  const live = v.filter((_, i) => !inDrop[i]);
  const sorted = (live.length ? live : v).slice().sort((a, b) => a - b);
  rep.baseline = quantile(sorted, 0.1);
  const quiet = sorted.filter((x) => x <= quantile(sorted, 0.3));
  const mean = quiet.reduce((a, b) => a + b, 0) / quiet.length;
  rep.restNoise = Math.sqrt(quiet.reduce((a, b) => a + (b - mean) ** 2, 0) / quiet.length);
  const top = quantile(sorted, 0.99);
  const amp = Math.max(o.noiseK * rep.restNoise, o.burstFrac * (top - rep.baseline), o.minBurstAmp);
  rep.threshold = rep.baseline + amp;
  const offThr = rep.baseline + amp * 0.5; // hysteresis: a dip mid-grip doesn't split it

  const s = movingAverage(v, ms(o.smoothMs));
  let raw = [];
  let on = -1;
  for (let i = 0; i <= s.length; i++) {
    const x = i < s.length ? s[i] : -Infinity;
    if (on < 0 && x >= rep.threshold) on = i;
    else if (on >= 0 && x < offThr) { raw.push([on, i - 1]); on = -1; }
  }
  // Merge bursts separated by a short gap (one grip that wobbles), drop very short ones.
  const merged = [];
  for (const b of raw) {
    const last = merged[merged.length - 1];
    if (last && b[0] - last[1] <= ms(o.mergeGapMs)) last[1] = b[1];
    else merged.push(b);
  }
  const spikeIdx = rep.spikes.map((x) => x.index);
  for (const [a, b] of merged) {
    if (b - a + 1 < ms(o.minBurstMs)) continue;
    let pk = a;
    for (let i = a; i <= b; i++) if (v[i] > v[pk]) pk = i;
    // A burst that starts at a contact spike or right after a dropout is an artifact.
    const artifact = spikeIdx.some((x) => x >= a - 3 && x <= b)
      || rep.dropouts.some((d) => Math.abs(a - (d.start + d.length)) <= 3);
    rep.bursts.push({ start: a, end: b, peakIndex: pk, peak: v[pk], amplitude: v[pk] - rep.baseline, artifact });
  }
  const real = rep.bursts.filter((b) => !b.artifact);
  rep.burstCount = real.length;

  rep.fade = fadeOf(real.map((b) => b.amplitude), o);
  return rep;
}

// Fade (tiredness, band loosening, sliding) over the repeats. Flagged only when the later half
// is below fadeRatio of the earlier half AND a least-squares fit to log(peak) over ALL reps loses
// more than 1 - fadePerRep per rep: one low rep at the end, or a session that is merely long,
// no longer trips it (card F1). Both are needed: the fit alone flags the club squeeze log, whose
// unlabelled holds split into sagging ripples, so the half ratio stays as the first gate.
// -> { peaks, ratio, perRep, flagged }
function fadeOf(peaks, o) {
  const fade = { peaks, ratio: null, perRep: null, flagged: false };
  if (peaks.length < o.minFadeBursts) return fade;
  const h = Math.floor(peaks.length / 2);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  fade.ratio = Math.round((avg(peaks.slice(peaks.length - h)) / avg(peaks.slice(0, h))) * 100) / 100;
  const y = peaks.map((p) => Math.log(Math.max(p, 1)));
  const xm = (y.length - 1) / 2, ym = avg(y);
  let sxy = 0, sxx = 0;
  y.forEach((v, i) => { sxy += (i - xm) * (v - ym); sxx += (i - xm) ** 2; });
  const per = Math.exp(sxy / sxx);
  fade.perRep = Math.round(per * 100) / 100;
  fade.flagged = fade.ratio < o.fadeRatio && per < o.fadePerRep;
  return fade;
}

// With labels, one peak per step of the main repeated task instead of per burst: calibration
// squeezes and distractor steps are not reps (with them every calibrated 6-channel twin session
// flagged fade), a hold that wobbles across the threshold is one rep not three, and a rep that
// faded below the burst threshold still counts (it used to vanish and hide the fade).
// Peak = max of the smoothed signal in the step minus the channel baseline; steps with a contact
// spike or dropout are skipped. Returns null when no labelled task has >= 1 real burst.
function stepPeaks(v, labels, r, o, rateHz) {
  const segs = segments(labels.slice(0, v.length)).filter((g) => g.label && !/^cal_|^rest(@|$)/i.test(g.label));
  const real = r.bursts.filter((b) => !b.artifact);
  const count = {};
  for (const g of segs) if (real.some((b) => b.peakIndex >= g.start && b.peakIndex <= g.end)) count[g.label] = (count[g.label] || 0) + 1;
  const top = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  const sm = movingAverage(v, Math.max(1, Math.round((o.smoothMs * (rateHz || o.assumedRateHz)) / 1000)));
  const bad = (g) => r.spikes.some((x) => x.index >= g.start && x.index <= g.end)
    || r.dropouts.some((d) => d.start <= g.end && d.start + d.length > g.start);
  const peaks = [];
  for (const g of segs) {
    if (g.label !== top[0] || bad(g)) continue;
    let m = -Infinity;
    for (let i = g.start; i <= g.end; i++) if (sm[i] > m) m = sm[i];
    if (Number.isFinite(m)) peaks.push(m - r.baseline);
  }
  return peaks;
}

// Segment amplitudes by label: compares "arm moved, hand relaxed" with "gripping".
function positionCheck(values, labels, base, o) {
  const segs = segments(labels);
  const amp = (sg) => segMax(values, sg) - base;
  const grip = segs.filter((sg) => labelClass(sg.label) === 'grip').map(amp).filter(Number.isFinite);
  const pos = segs.filter((sg) => labelClass(sg.label) === 'arm').map(amp).filter(Number.isFinite);
  if (!grip.length || !pos.length) return null;
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const gripMed = med(grip);
  // What a naive on/off controller would use: halfway between rest and a typical grip.
  const gripThreshold = base + gripMed / 2;
  const posMax = Math.max(...pos);
  return {
    gripSegments: grip.length, positionSegments: pos.length,
    gripMedianAmp: gripMed, positionMedianAmp: med(pos), positionMaxAmp: posMax,
    ratio: gripMed > 0 ? Math.round((med(pos) / gripMed) * 100) / 100 : null,
    gripThreshold, crosses: base + posMax >= gripThreshold,
  };
}

export function analyzeRecording(rec, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const rateHz = rec.rateHz || null;
  const channels = rec.data.map((ch) => analyzeChannel(ch, { ...o, rateHz }));
  const names = rec.channelNames || rec.data.map((_, i) => `ch${i + 1}`);
  const items = [];
  const add = (level, channel, code, message, at = null) => items.push({ level, channel, code, message, at });

  if (!rateHz) add('amber', null, 'no_rate', `No timestamps, so the sample rate is unknown; timing checks assume ${o.assumedRateHz} Hz.`);
  const hasLabels = Array.isArray(rec.labels) && rec.labels.some((l) => l);
  if (!hasLabels) add('amber', null, 'no_labels', 'No labels in this recording, so it cannot be used to train a model as-is.');

  let position = null;
  if (hasLabels && !o.skipPosition) position = rec.data.map((ch, c) => positionCheck(ch, rec.labels, channels[c].baseline, o));
  const cal = o.calibration || (hasLabels ? calibrate(rec) : null);
  const shift = cal ? bandShift(rec, cal, o.bandShiftLimit, { restLimit: o.bandShiftRestLimit, stepRatio: o.bandStepRatio }) : null;

  if (hasLabels) channels.forEach((r, c) => {
    const p = r.n ? stepPeaks(rec.data[c], rec.labels, r, o, rateHz) : null;
    if (p) r.fade = fadeOf(p, o);
  });

  channels.forEach((r, c) => {
    const nm = names[c];
    if (!r.n) { add('amber', c, 'no_data', `${nm}: no data.`); return; }
    if (r.dropouts.length) {
      const total = r.dropouts.reduce((a, d) => a + d.length, 0);
      add('red', c, 'dropout', `${nm}: signal dropped to 0 ${r.dropouts.length} time(s) (${total} samples). Check wires and that the sensor is touching the skin.`, r.dropouts[0].start);
    }
    if (r.spikes.length) add('red', c, 'spike', `${nm}: ${r.spikes.length} sudden spike(s) that fade slowly. Usually a loose electrode or wire, or the sensor lifting off.`, r.spikes[0].index);
    if (r.saturation.fraction >= o.saturationWarnFrac) add('amber', c, 'saturation', `${nm}: ${(r.saturation.fraction * 100).toFixed(1)}% of samples at the top of the range (>= ${o.saturation}). Lower the gain or loosen the band.`, firstAtOrAbove(rec.data[c], o.saturation));
    if (r.restNoise > 20) add('amber', c, 'noisy_rest', `${nm}: noisy at rest (about ±${r.restNoise.toFixed(0)}). Check grounding and contact.`);
    if (r.fade.flagged) add('amber', c, 'fade', `${nm}: bursts get weaker over the repeats (later ones about ${Math.round(r.fade.ratio * 100)}% of the first ones). Tiredness, or the band loosening or sliding.`);
    if (r.burstCount === 0) add('amber', c, 'no_bursts', `${nm}: no clear bursts found.`);
    else add('green', c, 'bursts', `${nm}: ${r.burstCount} burst(s), rest level about ${Math.round(r.baseline)}, typical burst +${Math.round(median(r.fade.peaks))}.`);
    const sh = shift && shift[c];
    if (sh && sh.flagged) add('amber', c, 'band_shift', `${nm}: ${sh.reason === 'rest' ? 'rest level' : 'grip level'} moved from the calibration (rest ${pct(sh.restShift)}, squeeze ${pct(sh.squeezeShift)} of the calibrated range). The band may have loosened or moved; re-calibrate.`);
    const p = position && position[c];
    if (p) {
      if (p.crosses) add('red', c, 'position', `${nm}: moving the arm alone reaches the grip threshold (arm ${Math.round(p.positionMaxAmp)} vs grip ${Math.round(p.gripMedianAmp)}). A simple threshold would close the hand when the elbow bends.`);
      else if (p.ratio != null && p.ratio >= o.positionAmberRatio) add('amber', c, 'position', `${nm}: arm movement gives ${Math.round(p.ratio * 100)}% of a grip's signal. Watch for false triggers.`);
      else add('green', c, 'position', `${nm}: arm movement stays well below grip level.`);
    }
  });
  if (o.doctor !== false) {
    items.push(...doctorItems(rec, { channels, names, rateHz, opts }));
    // Only Check/Fix drift findings: its green "checked"/"could not check" line would add a
    // row to every clean report (and to the legacy-fixture expectations) for no news.
    items.push(...driftItems(rec, o.drift).filter((it) => it.level !== 'green'));
  }
  oneRootCause(items, names);
  if (!items.some((i) => i.level !== 'green')) add('green', null, 'ok', 'No problems found.');
  for (const it of items) if (it.fix == null) it.fix = fixFor(it.code, it.channel == null ? undefined : names[it.channel]);
  return { version: 1, rateHz, assumedRate: rateHz ? null : o.assumedRateHz, calibration: cal, bandShift: shift, channels, position, items };
}

// One root cause per channel: a saturated channel's amplified noise also looks like a floating
// pin, a band shift and contact spikes; a floating pin's walk hits 0 (dropout); hum clips a quiet
// channel to 0; a dropout drags the late rest/grip levels. Showing all of them sends the user
// after four problems when there is one. The later findings on that channel turn green, keep
// their text, and say what probably caused them (`causedBy`); the root item says so too.
const ROOT_CAUSES = [
  ['saturation', ['floating', 'band_shift', 'spike', 'noisy_rest']],
  ['floating', ['dropout', 'spike', 'band_shift', 'noisy_rest']],
  ['hum', ['dropout', 'noisy_rest']],
  ['dropout', ['band_shift']],
  // Both say the rest level moved (calibration -> late, start -> end): show it once.
  ['band_shift', ['rest_drift']],
];
function oneRootCause(items, names) {
  for (const [root, follows] of ROOT_CAUSES) {
    for (const r of items.filter((it) => it.code === root && it.channel != null && it.level !== 'green')) {
      const hit = items.filter((it) => it.channel === r.channel && it.level !== 'green' && follows.includes(it.code));
      if (!hit.length) continue;
      for (const it of hit) { it.level = 'green'; it.causedBy = root; }
      r.message += ` Other warnings on ${names[r.channel]} (${hit.map((it) => it.code.replace('_', ' ')).join(', ')}) are probably caused by this.`;
    }
  }
}

function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function pct(x) {
  return x == null ? 'n/a' : `${x > 0 ? '+' : ''}${Math.round(x * 100)}%`;
}

function firstAtOrAbove(v, x) {
  for (let i = 0; i < v.length; i++) if (v[i] >= x) return i;
  return null;
}

export function windowOf(src, from = 0, to = src.t.length) {
  const rows = src.rows.slice(from, to);
  const nch = rows.length ? rows[0].length : (src.channelNames ? src.channelNames.length : 0);
  const data = Array.from({ length: nch }, (_, c) => rows.map((r) => r[c]));
  const t = src.t.slice(from, to);
  return { data, t, labels: src.labels ? src.labels.slice(from, to) : null, rateHz: src.rateHz || rateOf(t), channelNames: src.channelNames };
}

// Median step is robust to USB bursts and the gap of an unplug.
function rateOf(t) {
  if (!t || t.length < 3) return null;
  const d = [];
  for (let i = 1; i < t.length; i++) { const x = t[i] - t[i - 1]; if (x > 0) d.push(x); }
  const m = median(d);
  return m > 0 ? 1000 / m : null;
}

function firstIndexAtOrAfter(t, x) {
  let lo = 0, hi = t.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (t[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

// Whole-recording conditions (no rate, no labels, no bursts in a quiet window, fade over a
// handful of repeats) are Review's job; live only shows what needs a fix now.
const LIVE_CODES = new Set(['dropout', 'spike', 'saturation', 'noisy_rest', 'band_shift', 'position', 'no_data']);

export class LiveQuality {
  constructor(opts = {}) {
    this.opts = { windowSec: 15, ...opts };
    this.calibration = null;
    this.position = [];   // non-green position items from the last full-recording check
    this._scanned = 0;
    this._calDirty = false;
    this._posDirty = false;
    this._seen = new Map(); // `${code}:${channel}` -> first at
    this._segStart = 0;
    this.drift = null;      // DriftTracker (card L1), made on the first finished step
  }

  // Live drift items (at most one per channel, latched; see drift.js DriftTracker).
  driftItems() { return this.drift ? this.drift.items() : []; }

  update(src) {
    const n = src.t.length;
    const labels = src.labels || [];
    // Incremental scan: where did calibration and arm-only segments end since last time?
    for (let i = Math.max(1, this._scanned); i < n; i++) {
      const a = labels[i - 1] || '', b = labels[i] || '';
      if (a === b) continue;
      if (a && this.opts.liveDrift !== false) this._pushDrift(src, a, this._segStart, i);
      this._segStart = i;
      if (a.startsWith('cal_') && !b.startsWith('cal_')) this._calDirty = true;
      if (labelClass(a) === 'arm' && labelClass(b) !== 'arm') this._posDirty = i;
    }
    this._scanned = n;
    if (!n) return { items: [], from: 0, to: 0 };
    if (this._calDirty) {
      this._calDirty = false;
      this.calibration = calibrate(windowOf(src, 0, n)) || this.calibration;
    }
    if (this._posDirty !== false) {
      // Full-recording run, but only a handful of times a session (once per arm-only segment).
      const at = this._posDirty;
      this._posDirty = false;
      const full = analyzeRecording(windowOf(src, 0, n), { ...this.opts, calibration: this.calibration, doctor: false });
      this.position = full.items.filter((it) => it.code === 'position' && it.level !== 'green').map((it) => ({ ...it, at }));
    }
    const from = firstIndexAtOrAfter(src.t, src.t[n - 1] - this.opts.windowSec * 1000);
    const rep = analyzeRecording(windowOf(src, from, n), { ...this.opts, calibration: this.calibration, skipPosition: true, doctor: false });
    const items = rep.items
      .filter((it) => it.level !== 'green' && LIVE_CODES.has(it.code))
      .map((it) => ({ ...it, at: from + (it.at ?? (n - 1 - from)) }))
      .concat(this.position.map((it) => ({ ...it })))
      .concat(this.driftItems());
    const seen = new Map();
    for (const it of items) {
      const key = `${it.code}:${it.channel}`;
      if (this._seen.has(key)) it.at = Math.min(it.at, this._seen.get(key));
      it.atMs = src.t[it.at];
      seen.set(key, it.at);
    }
    this._seen = seen;
    // Follow-on findings are green with `causedBy` (oneRootCause): kept apart so the strip can
    // group them under their root without anyone counting them as healthy or as extra problems.
    const followOns = rep.items
      .filter((it) => it.causedBy && LIVE_CODES.has(it.code))
      .map((it) => { const at = from + (it.at ?? (n - 1 - from)); return { ...it, at, atMs: src.t[at] }; });
    return { items, followOns, from, to: n };
  }

  // A rest or hold step just finished: hand its samples to the drift tracker. Only those steps
  // are copied (DriftTracker ignores the rest), a few times a minute.
  _pushDrift(src, label, start, end) {
    if (!/^(cal_)?(rest|squeeze|grip|pinch|fist)/i.test(label)) return;
    const rows = src.rows.slice(start, end);
    if (!rows.length) return;
    if (!this.drift) this.drift = new DriftTracker({ channels: rows[0].length, channelNames: src.channelNames, rateHz: src.rateHz || rateOf(src.t) || null, ...(this.opts.liveDriftOpts || {}) });
    this.drift.push({ label, start, end }, Array.from({ length: rows[0].length }, (_, c) => rows.map((r) => r[c])));
  }
}

export function movementCheck(rec, { windowSec = 5, ...opts } = {}) {
  const rateHz = rec.rateHz || rateOf(rec.t) || DEFAULTS.assumedRateHz;
  const keep = Math.max(1, Math.round(windowSec * rateHz));
  return rec.data.map((ch, channel) => {
    const r = analyzeChannel(ch.slice(-keep), { ...DEFAULTS, ...opts, rateHz });
    const amplitude = r.bursts.length ? Math.max(...r.bursts.map((b) => b.amplitude)) : 0;
    return { channel, moved: r.burstCount > 0, bursts: r.burstCount, amplitude };
  });
}
