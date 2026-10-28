// drift.js: FSR drift tracking (RISKS.md B4: creep, drift, hysteresis). Pure; Node and browser.
// Two questions per channel, both answered from the labels the Studio already records:
//   1. Did the rest level move between the start and the end of the session? (band slid or
//      loosened, or the sensor drifted; compares settled rest at the start with settled rest
//      at the end.)
//   2. Does the reading keep rising while the person holds a steady squeeze? (FSR creep: the
//      resistance keeps falling under constant load.)
// Wired in by card D2: quality.js analyzeRecording adds the Check/Fix items after the Doctor's;
// the twin's 'creep' fault exercises hold_creep (DOCTOR_EXPECTED.creep).
//
// Contract
//   DRIFT_DEFAULTS: thresholds (below). Every one is a FIRST GUESS tuned on the twin only; tune
//     them at the real-hardware checkpoint. Override any through opts.
//   driftCheck(rec, opts?) -> DriftReport
//     rec: { data: number[][], labels?: (string|null)[], rateHz?: number|null, channelNames? }
//       (the analyzeRecording input; windowOf() makes one from a Session).
//     { checked: bool, reason?: string, rateHz, assumedRate: bool,
//       channels: [{ channel, status: 'Working'|'Check'|'Fix'|null (null = not checked),
//         startRest, endRest (counts, median of settled rest), span (counts, rest -> squeeze),
//         spanFrom: 'calibration'|'holds'|null, restDrift (fraction of span, signed),
//         restDriftCounts, perMin (counts per minute between the two rest windows),
//         holds: [{ label, start, end, early, late, creep (fraction of hold height, signed) }],
//         creep (median hold creep of the steadiest task, or null; see sessionCreep), reason?: string }],
//       items: Item[] }
//   driftItems(rec, opts?) -> Item[]  (= driftCheck(rec, opts).items)
//   Item = the Doctor/quality item shape plus `status` and `why`:
//     { level: 'green'|'amber'|'red', status: 'Working'|'Check'|'Fix', channel: number|null,
//       code: 'rest_drift'|'hold_creep'|'drift_ok'|'drift_unchecked', message, at, fix,
//       why: { ...the numbers behind "Why?" } }
//     Only Check/Fix items name a channel; one green item says the check ran and passed
//     (drift_ok) or could not run (drift_unchecked, with the reason).
// Units: ADC counts, samples, minutes. Indices are sample indices into rec.data.
// Failure behaviour: no labels, no rest at the start or the end, or no usable span skips the
//   channel (status null, `reason` says why); never throws on empty, short or NaN input.

export const DRIFT_DEFAULTS = {
  assumedRateHz: 100,     // = quality.js DEFAULTS.assumedRateHz (legacy logs have no rate)
  edgeFrac: 0.25,         // "start" = rest in the first 25% of the session, "end" = the last 25%
  settleFrac: 0.5,        // use only the last half of each rest step: FSR and muscle take
                          // ~1 s to relax after a grip (the twin's rest starts high and decays)
  minRestSamples: 20,     // per edge window, after settling
  restCheck: 0.15,        // first guess: rest moved by 15% of the rest -> squeeze span: Check
  restFix: 0.4,           // first guess: 40%: the band is no longer where it was calibrated: Fix
  minHoldMs: 1000,        // a "hold" is a squeeze step of >= 1 s (the twin's 0.3 s grips are taps)
  holdSkipFrac: 0.3,      // skip the rise at the start of a hold ...
  holdTailFrac: 0.1,      // ... and the release at the end
  minHoldAmp: 15,         // counts above start rest; below this creep is just noise
  creepCheck: 0.15,       // first guess: reading rose 15% of the hold height during the hold
  creepBy: 'task',        // 'task': steadiest task's median (card B1); 'all': one median (pre-B1)
  creepTaskHolds: 2,      // first guess: a task's median counts only with >= 2 holds
};

const REST_RE = /^(cal_)?rest(@|$)/i;
// Squeeze-type steps a person holds; open/point/elbow are not steady pressure on the FSR.
const HOLD_RE = /^(cal_)?(squeeze|grip|pinch|fist)/i;
const STATUS = { green: 'Working', amber: 'Check', red: 'Fix' };

// Exported so doctor.js fixFor() knows these codes too (one wording, kept here).
export const DRIFT_FIX = {
  rest_drift: (n) => `${n} does not go back to the same rest level: re-tighten the band where it was, re-calibrate at every fitting and keep sessions short.`,
  hold_creep: (n) => `${n} keeps rising during a steady squeeze (sensor creep): keep holds short (2 to 3 s) and calibrate at every fitting.`,
  drift_ok: () => '',
  drift_unchecked: () => 'Record with the Studio (rest and squeeze steps) so drift can be checked.',
};

const median = (a) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const r0 = (x) => (Number.isFinite(x) ? Math.round(x) : null);
const pct = (x) => `${Math.round(Math.abs(x) * 100)}%`;

function segments(labels) {
  const segs = [];
  for (let i = 0; i < labels.length; i++) {
    const L = labels[i] || '';
    const last = segs[segs.length - 1];
    if (last && last.label === L) { last.end = i + 1; continue; }
    segs.push({ label: L, start: i, end: i + 1 }); // end is exclusive
  }
  return segs;
}

export function driftCheck(rec, opts = {}) {
  const o = { ...DRIFT_DEFAULTS, ...opts };
  const data = Array.isArray(rec && rec.data) ? rec.data : [];
  const labels = Array.isArray(rec && rec.labels) ? rec.labels : null;
  const rateHz = (rec && rec.rateHz) || o.assumedRateHz;
  const assumedRate = !(rec && rec.rateHz);
  const nm = (c) => (rec && rec.channelNames && rec.channelNames[c]) || `ch${c + 1}`;
  const n = data.length ? Math.min(...data.map((v) => (v ? v.length : 0))) : 0;
  const base = { rateHz, assumedRate, channels: [], items: [] };
  const unchecked = (reason) => ({ ...base, checked: false, reason, items: [item('green', null, 'drift_unchecked', `Drift could not be checked: ${reason}.`, null, { reason }, nm)] });
  if (!n) return unchecked('no data');
  if (!labels || !labels.some((l) => l)) return unchecked('the recording has no step labels');

  const segs = segments(labels.slice(0, n));
  const rests = segs.filter((s) => REST_RE.test(s.label)).map((s) => ({ ...s, start: s.start + Math.floor((s.end - s.start) * o.settleFrac) }));
  const edge = Math.floor(n * o.edgeFrac);
  // A rest step counts for an edge when its settled part lies (mostly) inside that edge.
  const startRests = rests.filter((s) => (s.start + s.end) / 2 < edge);
  const endRests = rests.filter((s) => (s.start + s.end) / 2 >= n - edge);
  const minHold = Math.round((o.minHoldMs * rateHz) / 1000);
  const holdSegs = segs.filter((s) => HOLD_RE.test(s.label) && s.end - s.start >= minHold);
  const cal = calibrationSpan(segs, data);
  const items = [];
  const channels = data.map((v, c) => {
    const ch = { channel: c, status: null, startRest: null, endRest: null, span: null, spanFrom: null, restDrift: null, restDriftCounts: null, perMin: null, holds: [], creep: null };
    const pick = (ss) => ss.flatMap((s) => v.slice(s.start, s.end));
    const a = pick(startRests).filter(Number.isFinite);
    const b = pick(endRests).filter(Number.isFinite);
    if (a.length >= o.minRestSamples) ch.startRest = r0(median(a));
    if (b.length >= o.minRestSamples) ch.endRest = r0(median(b));
    ch.holds = holdSegs.map((s) => holdCreep(v, s, ch.startRest, o)).filter(Boolean);
    // Span: the calibrated rest -> squeeze range (as quality.js bandShift uses); without a
    // calibration, the median hold height. A % of the raw rest is meaningless when rest is ~5.
    if (cal && cal.span[c] > 0) { ch.span = r0(cal.span[c]); ch.spanFrom = 'calibration'; }
    else if (ch.holds.length) {
      const h = median(ch.holds.map((x) => x.early - ch.startRest));
      if (h > 0) { ch.span = r0(h); ch.spanFrom = 'holds'; }
    }
    if (ch.startRest == null || ch.endRest == null) ch.reason = 'no settled rest at the start and the end';
    else if (!ch.span) ch.reason = 'no squeeze to compare the rest level with';
    if (ch.reason) return ch;

    ch.restDriftCounts = ch.endRest - ch.startRest;
    ch.restDrift = r2(ch.restDriftCounts / ch.span);
    const mid = (ss) => median(ss.map((s) => (s.start + s.end) / 2));
    const minutes = (mid(endRests) - mid(startRests)) / rateHz / 60;
    ch.perMin = minutes > 0 ? Math.round((ch.restDriftCounts / minutes) * 10) / 10 : null;
    // Only a rising reading under steady pressure is creep: a falling one is far more often the
    // hand easing off or tiring, which the person controls and fatigue checks cover.
    const creeps = ch.holds.map((x) => x.creep).filter(Number.isFinite);
    ch.creep = creeps.length ? r2(sessionCreep(ch.holds, o)) : null;

    const abs = Math.abs(ch.restDrift);
    const restLevel = abs >= o.restFix ? 'red' : abs >= o.restCheck ? 'amber' : 'green';
    const creepLevel = ch.creep != null && ch.creep >= o.creepCheck ? 'amber' : 'green';
    ch.status = STATUS[restLevel === 'red' ? 'red' : restLevel === 'amber' || creepLevel === 'amber' ? 'amber' : 'green'];
    const why = { startRest: ch.startRest, endRest: ch.endRest, span: ch.span, spanFrom: ch.spanFrom, restDrift: ch.restDrift, perMin: ch.perMin, checkAt: o.restCheck, fixAt: o.restFix };
    if (restLevel !== 'green') {
      const at = endRests.length ? endRests[0].start : null;
      items.push(item(restLevel, c, 'rest_drift', `${nm(c)}: the rest level moved from ${ch.startRest} to ${ch.endRest} during the session (${ch.restDriftCounts > 0 ? 'up' : 'down'} ${pct(ch.restDrift)} of the squeeze range${ch.perMin != null ? `, about ${Math.abs(ch.perMin)} counts a minute` : ''}).`, at, why, nm));
    }
    if (creepLevel !== 'green') {
      const worst = ch.holds.reduce((m, x) => (x.creep > m.creep ? x : m));
      items.push(item('amber', c, 'hold_creep', `${nm(c)}: the reading kept rising during steady squeezes (by about ${pct(ch.creep)} of the squeeze height, across ${creeps.length} hold(s)).`, worst.start, { creep: ch.creep, holds: ch.holds.map((x) => ({ label: x.label, early: x.early, late: x.late, creep: x.creep })), checkAt: o.creepCheck }, nm));
    }
    return ch;
  });
  const done = channels.filter((ch) => ch.status);
  if (!done.length) return { ...unchecked(channels[0] && channels[0].reason || 'no rest steps'), channels };
  if (!items.length) items.push(item('green', null, 'drift_ok', `The rest level stayed steady on ${done.length} channel(s) and steady squeezes did not creep.`, null, { channels: done.map((ch) => ({ channel: ch.channel, restDrift: ch.restDrift, creep: ch.creep })) }, nm));
  return { ...base, checked: true, channels, items };
}

export function driftItems(rec, opts = {}) {
  return driftCheck(rec, opts).items;
}

function item(level, channel, code, message, at, why, nm) {
  return { level, status: STATUS[level], channel, code, message, at, fix: DRIFT_FIX[code](channel == null ? 'This channel' : nm(channel)), why };
}

// cal_rest median and median cal_squeeze peak, per channel (the same reading as quality.js
// calibrate(), kept local so this module stays a leaf).
function calibrationSpan(segs, data) {
  const r = segs.filter((s) => s.label === 'cal_rest');
  const q = segs.filter((s) => s.label === 'cal_squeeze');
  if (!r.length || !q.length) return null;
  return {
    span: data.map((v) => {
      const rest = median(r.flatMap((s) => v.slice(s.start, s.end)));
      const sq = median(q.map((s) => Math.max(...v.slice(s.start, s.end).filter(Number.isFinite))));
      return sq - rest;
    }),
  };
}

// Creep inside one hold: median of the first vs the last quarter of the plateau (rise and
// release cut off), as a fraction of the hold height above start rest.
function holdCreep(v, s, rest, o) {
  if (rest == null) return null;
  const len = s.end - s.start;
  const from = s.start + Math.floor(len * o.holdSkipFrac);
  const to = s.end - Math.floor(len * o.holdTailFrac);
  const q = Math.max(1, Math.floor((to - from) / 4));
  const early = median(v.slice(from, from + q));
  const late = median(v.slice(to - q, to));
  if (!Number.isFinite(early) || !Number.isFinite(late) || early - rest < o.minHoldAmp) return null;
  return { label: s.label, start: s.start, end: s.end, early: r0(early), late: r0(late), creep: r2((late - early) / (early - rest)) };
}

// Session creep (card B1): the median hold creep of the STEADIEST task (the label whose holds
// agree most: smallest mean distance from their median), not one median over all holds. Squeeze
// holds sag as the hand tires (twin sag_per_s 0.3, read off the club squeeze log) and wobble, so
// they outvoted the 2 calibration squeezes, which hold steady: gain 0.5 creep was caught 7/40 on
// squeeze sessions vs 28/40 on grip ones. Creep is the sensor, so every task shows it; the
// steadiest one reads it cleanest. (Largest per-task median instead: 30/40 but 1/40 clean false
// alarm, from 5 wobbly squeeze holds.) A task needs >= creepTaskHolds holds, so one hold cannot
// look steady alone; with no such task, the old all-holds median.
function sessionCreep(holds, o) {
  const all = holds.map((x) => x.creep).filter(Number.isFinite);
  if (o.creepBy !== 'task') return median(all);
  const by = new Map();
  for (const x of holds) {
    if (!Number.isFinite(x.creep)) continue;
    const k = x.label.replace(/@.*$/, '').toLowerCase();
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(x.creep);
  }
  let best = null;
  for (const a of by.values()) {
    if (a.length < o.creepTaskHolds) continue;
    const m = median(a);
    const spread = a.reduce((t, x) => t + Math.abs(x - m), 0) / a.length;
    if (!best || spread < best.spread) best = { m, spread };
  }
  return best ? best.m : median(all);
}

// ---------- Live drift (card L1) ----------
// DriftTracker: the same driftCheck, fed one finished step at a time while recording, so the
// live strip and the report after Save use ONE measure. It keeps only the samples driftCheck
// reads (rest, hold and calibration steps) at their session indices, so driftCheck on the
// kept steps equals driftCheck on the recording so far.
//   new DriftTracker({ channels, channelNames?, rateHz?, opts?, confirm = 2, minSec = 20 })
//   push(step, samples) -> Item[]  step = { label, start, end } (session sample indices, end
//     exclusive); samples[c] = channel c's values for that step. Other labels are ignored.
//   items() -> Item[]  live items: at most ONE per channel, never green. Calm rules (spec §8.4,
//     soften don't remove): nothing before minSec of data; a channel's item appears only after
//     `confirm` checks in a row say Check/Fix; once shown it stays (code fixed, so the chip
//     never swaps), and a later clean check softens it to Check with why.settled = true.
//     why.live = true and why.soFarSec say the numbers are "so far"; the report after Save
//     re-measures the whole session (the end window moves), see compareDrift.
//   report() -> the last DriftReport (null before the first check).
// compareDrift(liveItems, finalItems) -> [{ channel, code, live, final, note }]: one line per
//   channel where the live warning and the final report disagree, with the reason in words.
export class DriftTracker {
  constructor({ channels = 0, channelNames, rateHz, opts = {}, confirm = 2, minSec = 20 } = {}) {
    Object.assign(this, { channels, channelNames, rateHz, opts, confirm, minSec });
    this.steps = [];
    this.n = 0;
    this._report = null;
    this._streak = new Map(); // channel -> checks in a row with a Check/Fix finding
    this._shown = new Map();  // channel -> live item
  }

  push(step, samples) {
    if (!step || !(REST_RE.test(step.label || '') || HOLD_RE.test(step.label || ''))) return this.items();
    if (!Array.isArray(samples) || !(step.end > step.start)) return this.items();
    this.channels = Math.max(this.channels, samples.length);
    this.steps.push({ label: step.label, start: step.start, end: step.end, samples });
    this.n = Math.max(this.n, step.end);
    const rate = this.rateHz || (this.opts.assumedRateHz ?? DRIFT_DEFAULTS.assumedRateHz);
    if (this.n < this.minSec * rate) return this.items();
    // Holey arrays: unrecorded indices are skipped by every median (Number.isFinite).
    const data = Array.from({ length: this.channels }, () => new Array(this.n));
    const labels = new Array(this.n).fill(null);
    for (const s of this.steps) {
      for (let i = s.start; i < s.end; i++) labels[i] = s.label;
      for (let c = 0; c < this.channels; c++) {
        const v = s.samples[c] || [];
        for (let k = 0; k < v.length && s.start + k < s.end; k++) data[c][s.start + k] = v[k];
      }
    }
    const rep = driftCheck({ data, labels, rateHz: this.rateHz, channelNames: this.channelNames }, this.opts);
    this._report = rep;
    const soFarSec = Math.round(this.n / rate);
    for (let c = 0; c < this.channels; c++) {
      const found = rep.items.filter((it) => it.channel === c && it.level !== 'green')
        .sort((a, b) => (b.level === 'red') - (a.level === 'red') || (a.code === 'rest_drift' ? -1 : 1));
      const shown = this._shown.get(c);
      if (!found.length) {
        this._streak.set(c, 0);
        if (shown) this._shown.set(c, { ...shown, level: 'amber', status: STATUS.amber, why: { ...shown.why, settled: true, soFarSec } });
        continue;
      }
      this._streak.set(c, (this._streak.get(c) || 0) + 1);
      if (!shown && this._streak.get(c) < this.confirm) continue;
      const same = shown ? found.find((it) => it.code === shown.code) : found[0];
      const base = same || shown;
      const level = found[0].level;
      this._shown.set(c, { ...base, level, status: STATUS[level], at: shown ? shown.at : base.at ?? step.start, why: { ...base.why, live: true, soFarSec, settled: false } });
    }
    return this.items();
  }

  items() { return [...this._shown.values()].map((it) => ({ ...it, why: { ...it.why } })); }
  report() { return this._report; }
}

export function compareDrift(liveItems = [], finalItems = []) {
  const out = [];
  const fin = (finalItems || []).filter((it) => it.channel != null && it.level !== 'green');
  for (const it of liveItems || []) {
    const f = fin.find((x) => x.channel === it.channel && x.code === it.code) || fin.find((x) => x.channel === it.channel);
    if (f && f.level === it.level && f.code === it.code) continue;
    const note = !f ? (it.why && it.why.settled ? 'shown live earlier, but the later rest steps came back to the starting level, so the whole session passes'
      : 'shown live from the steps so far; the whole session, with the last rest steps, passes')
      : f.code !== it.code ? `live showed ${it.code}, the whole session also has ${f.code} (live shows one item per channel)`
      : `live said ${it.status}, the whole session says ${f.status}: the last rest steps moved the measure`;
    out.push({ channel: it.channel, code: it.code, finalCode: f ? f.code : null, live: it.level, final: f ? f.level : 'green', note });
  }
  for (const f of fin) {
    if ((liveItems || []).some((it) => it.channel === f.channel)) continue;
    out.push({ channel: f.channel, code: f.code, live: null, final: f.level, note: 'found only in the whole session (too little data, or not yet confirmed, while recording)' });
  }
  return out;
}
