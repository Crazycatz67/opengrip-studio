// doctor.js: the Hardware Doctor. Whole-recording checks that quality.js's per-channel burst
// analysis cannot see (timing, floating pins, mains hum, crosstalk, boot junk), plus the plain
// "what to do" line for every finding. Pure; runs in Node and the browser. quality.js calls
// doctorItems() from analyzeRecording(), so callers keep using analyzeRecording().
//
// Contract
//   DOCTOR_DEFAULTS: thresholds (below). Any of them can be overridden through the opts of
//     analyzeRecording / doctorItems.
//   timingCheck(rec, opts?) -> TimingReport | null (null when rec.t has < 3 numeric stamps)
//     { periodMs (median forward step), effectiveHz, headerHz (rec.meta.rate_hz or null),
//       jitterMs (robust sd of the forward steps), jitter: bool,
//       gaps: [{ at (index of the sample after the gap), ms, missing (≈ samples lost) }],
//       resets: [{ at, from: 'clock'|'marker' }], slow: bool }
//   floatingCheck(data: number[][], rateHz, opts?) -> [{ channel, flagged, at, windows }]
//   humCheck(data, rateHz, opts?) -> { checked: bool, reason?, channels: [{ channel, hz, amp, ratio, flagged }] }
//   crosstalkCheck(data, quiet: Uint8Array|null, rateHz, opts?) -> [{ channel, from, r, n, flagged }]
//     quiet[i] = 1 where no channel is bursting (crosstalk is judged on rest noise only).
//   doctorItems(rec, { channels: ChannelReport[], names, rateHz, opts }) -> Item[]
//     New codes: board_reset, slow_link, gap, jitter (timing, channel null), floating, hum
//     (per channel), and green information items crosstalk ("possible"), boot_junk, hum_unchecked.
//   fixFor(code, name) -> the Doctor's one-line fix ("A3 looks unconnected: ..."), '' for none.
//   doctorScorecard({ generate, toLines, parse, analyze, seeds=10, channels=6 }) -> scorecard
//     Injected twin/parse/analyze so this module never imports the simulator it is scored on.
//   DOCTOR_EXPECTED: fault type -> codes that count as catching it; HARDWARE_CODES: the codes
//     that are a false alarm on a clean session.
// Units: ADC counts, ms, Hz. Indices are sample indices into rec.data / rec.t.
// Failure behaviour: missing t, too few channels or a low rate skip the check (hum says so in an
// item); nothing here throws on short, empty or NaN-filled input.

import { DRIFT_FIX } from './drift.js';

export const DOCTOR_DEFAULTS = {
  jitterFrac: 0.2,        // step spread above 20% of the period ...
  jitterMinMs: 2,         // ... and above 2 ms (millis() ticks are 1 ms, so +-1 ms is normal)
  gapPeriods: 1.5,        // a step is a gap when > period * (1 + gapPeriods) + max(period, 6 jitter sd)
  slowFrac: 0.8,          // stamps arrive at < 80% of the header's rate_hz -> slow link
  floatWinSec: 1,
  floatMinStep: 5,        // median |step| in counts at 100 Hz (scaled by sqrt(rate/100))
  floatSignFlips: 0.35,   // a random walk turns back about half the time; a grip rises or falls
  floatMaxCorr: 0.3,      // a real muscle signal moves with the other channels
  floatMinWindows: 2,
  floatClip: 1015,        // = quality.js DEFAULTS.saturation
  floatWander: 3,         // level sd >= 3x step sd inside the window: wandering, not noise
  humMinRateHz: 500,      // 50/60 Hz alias to a constant below this
  humMinAmp: 4,           // counts
  humRatio: 6,            // hum bin vs nearby bins
  xtalkMinChannels: 3,    // need other channels to remove the shared grip signal
  xtalkCorr: 0.12,        // partial correlation of rest noise with the neighbour
  xtalkMinSamples: 200,
  xtalkLagSec: 0.02,
};

const FIX = {
  ...DRIFT_FIX,
  dropout: (n) => `${n} keeps dropping to 0: push the plug and wire in firmly and make sure the sensor touches the skin.`,
  spike: (n) => `${n} jumps then slowly settles: a wire or electrode is loose; reseat it and tape the lead down.`,
  saturation: (n) => `${n} hits the top of the range: loosen the band a little or turn the gain down.`,
  noisy_rest: (n) => `${n} is noisy at rest: check the ground wire and that the sensor sits flat on the skin.`,
  fade: (n) => `${n} gets weaker each repeat: let the arm rest a minute; if it keeps fading, check the band has not slipped.`,
  band_shift: (n) => `${n} moved since calibration: put the band back where it was (or re-tighten it) and re-calibrate.`,
  no_bursts: (n) => `${n} shows no clear squeezes: check it is plugged in and placed over the muscle.`,
  no_data: (n) => `${n} has no data: check the channel is wired and the sketch prints it.`,
  position: (n) => `${n} reacts to arm movement: move the sensor nearer the wrist or train the model with arm positions.`,
  floating: (n) => `${n} looks unconnected: check the wire or the sensor.`,
  hum: (n) => `${n} picks up mains hum: keep the cable away from chargers and power leads, run on battery, and check the ground.`,
  crosstalk: (n, from) => `${n} may be picking up ${from || 'its neighbour'}: separate the two wires and check for a shorted or shared pin.`,
  board_reset: () => 'The board restarted mid-recording: check the USB cable and power; record again if the gap matters.',
  slow_link: () => 'The link is too slow for this rate: raise the baud rate in the sketch (e.g. 115200) or lower rate_hz.',
  gap: () => 'Samples went missing: use a shorter or better USB cable and close other programs using the port.',
  jitter: () => 'Sample timing is uneven: time samples with micros() in the sketch and avoid delay() in loop().',
  boot_junk: () => 'Normal for an Uno: the board resets when the port opens. Nothing to fix.',
  hum_unchecked: () => 'To check for mains hum, record at 500 Hz or more.',
  no_rate: () => 'Use the OpenGrip sketch (it sends a header with rate_hz and time stamps).',
  no_labels: () => 'Record with the Studio so each part of the session gets a label.',
};

export function fixFor(code, name = 'This channel', extra) {
  const f = FIX[code];
  return f ? f(name, extra) : '';
}

const median = (a) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

export function timingCheck(rec, opts = {}) {
  const o = { ...DOCTOR_DEFAULTS, ...opts };
  const t = rec.t || [];
  const idx = [];
  for (let i = 0; i < t.length; i++) if (Number.isFinite(t[i])) idx.push(i);
  if (idx.length < 3) return null;
  const fwd = [];
  const resets = [];
  for (let k = 1; k < idx.length; k++) {
    const d = t[idx[k]] - t[idx[k - 1]];
    if (d > 0) fwd.push(d);
  }
  const P = median(fwd);
  if (!(P > 0)) return null;
  // Robust spread: MAD of the forward steps, so a few gaps do not count as jitter.
  const jitterMs = 1.4826 * median(fwd.map((d) => Math.abs(d - P)));
  const gapLim = P * (1 + o.gapPeriods) + Math.max(P, 6 * jitterMs);
  const gaps = [];
  for (let k = 1; k < idx.length; k++) {
    const i = idx[k];
    const d = t[i] - t[idx[k - 1]];
    // A monotonic clock never goes back: the board restarted (brown-out, replug, reset button).
    if (d < -Math.max(2 * P, 20)) resets.push({ at: i, from: 'clock' });
    else if (d > gapLim) gaps.push({ at: i, ms: Math.round(d), missing: Math.max(1, Math.round(d / P) - 1) });
  }
  // Session files keep a monotonic clock across a reset and leave a 'board reset' marker instead.
  for (const m of rec.markers || []) {
    if (!/reset/i.test(m.note || '')) continue;
    const at = Number.isInteger(m.index) ? m.index : firstAtOrAfter(t, m.t);
    if (!resets.some((r) => Math.abs(r.at - at) <= 2)) resets.push({ at, from: 'marker' });
  }
  resets.sort((a, b) => a.at - b.at);
  const headerHz = Number(rec.meta && rec.meta.rate_hz) || null;
  const effectiveHz = 1000 / P;
  return {
    periodMs: Math.round(P * 100) / 100, effectiveHz: Math.round(effectiveHz * 10) / 10, headerHz,
    jitterMs: Math.round(jitterMs * 100) / 100, jitter: jitterMs > Math.max(o.jitterFrac * P, o.jitterMinMs),
    gaps, resets, slow: headerHz != null && effectiveHz < o.slowFrac * headerHz,
  };
}

function firstAtOrAfter(t, x) {
  for (let i = 0; i < t.length; i++) if (t[i] >= x) return i;
  return t.length - 1;
}

function corr(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

function sd(a) {
  let m = 0;
  for (const x of a) m += x;
  m /= a.length || 1;
  let s = 0;
  for (const x of a) s += (x - m) ** 2;
  return Math.sqrt(s / (a.length || 1));
}
const spread = (v, a, n) => sd(v.slice(a, a + n + 1));

// Floating pin: an unconnected analog input random-walks. Its steps are big, turn back about
// half the time (a grip rises or falls for many samples), and do not move with the other
// channels (a real squeeze shows on several sensors at once).
export function floatingCheck(data, rateHz, opts = {}) {
  const o = { ...DOCTOR_DEFAULTS, ...opts };
  const rate = rateHz || 100;
  const win = Math.max(10, Math.round(o.floatWinSec * rate));
  const hop = Math.max(1, Math.floor(win / 2));
  const minStep = o.floatMinStep / Math.sqrt(rate / 100);
  const C = data.length;
  const n = C ? Math.min(...data.map((v) => v.length)) : 0;
  const d = data.map((v) => { const out = new Float64Array(Math.max(0, n - 1)); for (let i = 1; i < n; i++) out[i - 1] = (v[i] - v[i - 1]) || 0; return out; });
  return data.map((_, c) => {
    let run = 0, best = 0, at = null, runStart = null;
    for (let a = 0; a + win <= n - 1; a += hop) {
      const w = d[c].subarray(a, a + win);
      // A clipped window (pinned at 0 or the top) says nothing about wandering.
      let clipped = false;
      for (let i = a; i <= a + win; i++) if (!(data[c][i] > 0 && data[c][i] < o.floatClip)) { clipped = true; break; }
      if (clipped) { run = 0; continue; }
      const mag = median(Array.from(w, Math.abs));
      let flips = 0, pairs = 0, prev = 0;
      for (const x of w) { if (!x) continue; if (prev) { pairs++; if (Math.sign(x) !== Math.sign(prev)) flips++; } prev = x; }
      // A walk drifts: its level spread is many steps wide. Amplified sensor noise (a gain
      // pot turned right up) has big, sign-flipping steps too, but stays put (spread ~1.3 steps).
      let hit = mag >= minStep && pairs > win / 4 && flips / pairs >= o.floatSignFlips && spread(data[c], a, win) >= o.floatWander * sd(w);
      if (hit && C > 1) {
        const others = new Float64Array(win);
        for (let k = 0; k < C; k++) if (k !== c) for (let i = 0; i < win; i++) others[i] += d[k][a + i];
        hit = Math.abs(corr(w, others)) < o.floatMaxCorr;
      }
      if (hit) { if (!run) runStart = a; run++; if (run > best) { best = run; at = runStart; } } else run = 0;
    }
    return { channel: c, flagged: best >= o.floatMinWindows, at: best >= o.floatMinWindows ? at : null, windows: best };
  });
}

// Goertzel amplitude (counts) of one frequency over a block.
function toneAmp(v, a, N, hz, rate) {
  const w = (2 * Math.PI * hz) / rate;
  const cw = 2 * Math.cos(w);
  let mean = 0;
  for (let i = 0; i < N; i++) mean += v[a + i];
  mean /= N;
  let s1 = 0, s2 = 0;
  for (let i = 0; i < N; i++) { const s0 = v[a + i] - mean + cw * s1 - s2; s2 = s1; s1 = s0; }
  return (2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - cw * s1 * s2))) / N;
}

export function humCheck(data, rateHz, opts = {}) {
  const o = { ...DOCTOR_DEFAULTS, ...opts };
  if (!rateHz || rateHz < o.humMinRateHz) return { checked: false, reason: rateHz ? `rate ${Math.round(rateHz)} Hz` : 'unknown rate', channels: [] };
  const N = Math.round(rateHz); // 1 s blocks: 50 and 60 Hz fall on exact bins
  const channels = data.map((v, c) => {
    let best = { channel: c, hz: null, amp: 0, ratio: 0, flagged: false };
    for (const hz of [50, 60]) {
      const amps = [], refs = [];
      for (let a = 0; a + N <= v.length; a += N) {
        amps.push(toneAmp(v, a, N, hz, rateHz));
        refs.push(median([-15, -10, -5, 5, 10, 15].map((dz) => toneAmp(v, a, N, hz + dz, rateHz))));
      }
      if (!amps.length) continue;
      const amp = median(amps), ref = median(refs);
      const ratio = amp / Math.max(ref, 0.25);
      if (amp > best.amp) best = { channel: c, hz, amp: Math.round(amp * 10) / 10, ratio: Math.round(ratio * 10) / 10, flagged: amp >= o.humMinAmp && ratio >= o.humRatio };
    }
    return best;
  });
  return { checked: true, channels };
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
    [M[i], M[p]] = [M[p], M[i]];
    const d = M[i][i];
    if (Math.abs(d) < 1e-9) continue;
    for (let k = i + 1; k < n; k++) { const f = M[k][i] / d; for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = Math.abs(M[i][i]) < 1e-9 ? 0 : s / M[i][i];
  }
  return x;
}

// y minus its least-squares fit on the columns X (plus a constant).
function residual(y, X) {
  const cols = [y.map(() => 1), ...X];
  const A = cols.map((a) => cols.map((b) => a.reduce((s, x, i) => s + x * b[i], 0)));
  const beta = solve(A, cols.map((a) => a.reduce((s, x, i) => s + x * y[i], 0)));
  return y.map((v, i) => v - cols.reduce((s, col, j) => s + beta[j] * col[i], 0));
}

// Crosstalk: a channel that carries part of its neighbour's signal. During a grip every channel
// moves together, so only rest noise is used, and the part shared with the other channels is
// regressed out first (partial correlation). What is left is each sensor's own noise, which
// should be independent of the next one unless the wires leak into each other.
export function crosstalkCheck(data, quiet, rateHz, opts = {}) {
  const o = { ...DOCTOR_DEFAULTS, ...opts };
  const C = data.length;
  if (C < o.xtalkMinChannels) return [];
  const n = Math.min(...data.map((v) => v.length));
  const L = Math.max(1, Math.round(o.xtalkLagSec * (rateHz || 100)));
  const idx = [];
  for (let i = L; i < n; i++) if ((!quiet || (quiet[i] && quiet[i - L])) && data.every((v) => Number.isFinite(v[i]) && Number.isFinite(v[i - L]))) idx.push(i);
  if (idx.length < o.xtalkMinSamples) return [];
  const d = data.map((v) => idx.map((i) => v[i] - v[i - L]));
  const out = [];
  for (let c = 1; c < C; c++) {
    const others = d.filter((_, j) => j !== c && j !== c - 1);
    const r = corr(residual(d[c], others), residual(d[c - 1], others));
    out.push({ channel: c, from: c - 1, r: Math.round(r * 100) / 100, n: idx.length, flagged: r >= o.xtalkCorr });
  }
  return out;
}

// Samples where no channel is in (or within 0.5 s of) a burst.
function quietMask(channels, n, rate) {
  const q = new Uint8Array(n).fill(1);
  const pad = Math.round(0.5 * rate);
  for (const ch of channels || []) for (const b of ch.bursts || []) q.fill(0, Math.max(0, b.start - pad), Math.min(n, b.end + pad + 1));
  return q;
}

export function doctorItems(rec, { channels = [], names, rateHz = null, opts = {} } = {}) {
  const o = { ...DOCTOR_DEFAULTS, ...opts };
  const data = rec.data || [];
  const nm = (c) => (names && names[c]) || `ch${c + 1}`;
  const items = [];
  const add = (level, channel, code, message, at = null, extra) => items.push({ level, channel, code, message, at, fix: fixFor(code, channel == null ? undefined : nm(channel), extra) });

  const tm = timingCheck(rec, o);
  if (tm) {
    if (tm.resets.length) add('red', null, 'board_reset', `The board restarted ${tm.resets.length} time(s) during the recording (its clock jumped back).`, tm.resets[0].at);
    if (tm.slow) add('red', null, 'slow_link', `Samples arrive at about ${Math.round(tm.effectiveHz)} Hz, but the board says rate_hz=${tm.headerHz}. The serial link cannot carry this many lines per second.`, 0);
    if (tm.gaps.length) {
      const lost = tm.gaps.reduce((s, g) => s + g.missing, 0);
      add('amber', null, 'gap', `${tm.gaps.length} gap(s) in the time stamps (about ${lost} sample(s) missing, longest ${Math.max(...tm.gaps.map((g) => g.ms))} ms).`, tm.gaps[0].at);
    }
    if (tm.jitter) add('amber', null, 'jitter', `Sample timing is uneven: steps vary by about ±${tm.jitterMs.toFixed(1)} ms around ${tm.periodMs} ms.`);
  }
  const rate = rateHz || (tm && tm.effectiveHz) || 100;
  for (const f of floatingCheck(data, rate, o)) {
    if (f.flagged) add('red', f.channel, 'floating', `${nm(f.channel)}: wanders randomly for about ${((f.windows + 1) * o.floatWinSec / 2).toFixed(1)} s and does not follow the other channels, like a pin with nothing connected.`, f.at);
  }
  const hum = humCheck(data, rateHz, o);
  if (!hum.checked) add('green', null, 'hum_unchecked', `Mains hum (50/60 Hz) cannot be checked at this rate (${hum.reason}); it needs ${o.humMinRateHz} Hz or more.`);
  for (const h of hum.channels) if (h.flagged) add('amber', h.channel, 'hum', `${nm(h.channel)}: ${h.hz} Hz mains hum of about ±${Math.round(h.amp)} counts.`);
  const n = data.length ? Math.min(...data.map((v) => v.length)) : 0;
  for (const x of crosstalkCheck(data, quietMask(channels, n, rate), rate, o)) {
    // Information, not an alarm: on the twin this catches about 7 in 10 at no false alarms, short
    // of the 8 in 10 an alarm needs (docs/reference/doctor-scorecard.md).
    if (x.flagged) add('green', x.channel, 'crosstalk', `${nm(x.channel)}: possible crosstalk, its rest noise follows ${nm(x.from)} (partial correlation ${x.r}).`, null, nm(x.from));
  }
  const junk = rec.stats && rec.stats.garbageLines;
  if (junk) add('green', null, 'boot_junk', `${junk} line(s) had start-up junk before the numbers; it was removed.`, 0);
  return items;
}

export const DOCTOR_EXPECTED = {
  dropout: ['dropout', 'spike'], loose: ['dropout', 'spike', 'noisy_rest'], saturation: ['saturation'],
  floating: ['floating'], shift: ['band_shift'], hum: ['hum'], jitter: ['jitter'], missing: ['gap'],
  boot: ['boot_junk'], slowlink: ['slow_link'], brownout: ['board_reset'], crosstalk: ['crosstalk'],
  creep: ['hold_creep'], // from drift.js, added to the report by quality.js
};
// Codes that mean "something is wrong with the hardware" (an alarm when not green). fade and position describe the signal
// itself (the twin injects real fatigue and an elbow distractor), so they are not counted here.
export const HARDWARE_CODES = [...new Set(Object.values(DOCTOR_EXPECTED).flat())];

export function doctorScorecard({ generate, toLines, parse, analyze, seeds = 10, channels = 6, types = Object.keys(DOCTOR_EXPECTED) } = {}) {
  const run = (o) => { const S = generate({ channels, ...o }); return { S, rep: analyze(parse(toLines(S, 'nxt').join('\n'))) }; };
  const card = { sessions: seeds, clean: { sessions: seeds, withAlarm: 0, alarms: {}, info: {} }, types: {} };
  for (let s = 1; s <= seeds; s++) {
    const { rep } = run({ seed: 1000 + s });
    const bad = rep.items.filter((it) => HARDWARE_CODES.includes(it.code) && it.level !== 'green');
    if (bad.length) card.clean.withAlarm++;
    // Green "possible" findings (crosstalk) on a clean session: not alarms, but still wrong.
    for (const it of rep.items) if (HARDWARE_CODES.includes(it.code) && it.level === 'green' && it.code !== 'boot_junk') card.clean.info[it.code] = (card.clean.info[it.code] || 0) + 1;
    for (const it of bad) card.clean.alarms[it.code] = (card.clean.alarms[it.code] || 0) + 1;
  }
  for (const type of types) {
    const exp = DOCTOR_EXPECTED[type];
    const row = { expected: exp, hits: 0, misses: 0, skipped: 0, otherAlarms: {} };
    for (let s = 1; s <= seeds; s++) {
      const { S, rep } = run({ seed: s, faults: [type], rateHz: type === 'hum' ? 500 : 100 });
      const f = S.truth.faults.find((x) => x.type === type);
      if (!f) { row.skipped++; continue; }
      const hit = rep.items.some((it) => exp.includes(it.code) && (f.channel == null || it.channel == null || it.channel === f.channel));
      if (hit) row.hits++; else row.misses++;
      // Any other hardware code, or the right code on a channel the twin did not touch.
      for (const it of rep.items) {
        if (!HARDWARE_CODES.includes(it.code) || it.level === 'green') continue;
        if (exp.includes(it.code) && (f.channel == null || it.channel == null || it.channel === f.channel)) continue;
        const key = f.channel != null && it.channel === f.channel ? `${it.code}(same channel)` : it.code;
        row.otherAlarms[key] = (row.otherAlarms[key] || 0) + 1;
      }
    }
    card.types[type] = row;
  }
  return card;
}
