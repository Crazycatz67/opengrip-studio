// placement.js: where each sensor sits on the arm (the Body view's data model), fit-to-fit diffs
// in plain words, and the 4-step placement check ("does this spot work?"). Pure; Node + browser.
// Spec: docs/design/body-view-spec.md §7 (data model) and §16 (placement check).
//
// Contract
//   Angles: ringAngleDeg 0-359 integer, ANATOMICAL: 0 palm middle, 90 thumb side, 180 back middle,
//     270 little-finger side, so the same number is the same spot on either arm. Only the drawing
//     mirrors (ringXY). Distances: cm from the elbow crease, 0-30, step 0.5. Channels: `ch` is
//     1-based (ch 1 = recording data[0]).
//   OCTANTS: [{ deg, name }] x8; siteName(deg) -> nearest octant name | null; sideOf(deg) ->
//     'back' if 90 <= a < 270, else 'palm'; null for null. normDeg(a) -> 0..359 integer.
//   ringXY(deg, arm, rx=1, ry=1) -> { x, y }  spec §5.1: thumbX = arm==='R' ? -1 : 1,
//     x = thumbX*sin(a)*rx, y = cos(a)*ry (y+ = palm side, drawn at the bottom).
//   ringPreset({ count=8, cmFromElbowCrease=8, startDeg=0, dir=1, arm='R', circumferenceCm=null,
//     sensors=[] (per ring channel, default 'FMG'), emg=[] ({ ch?, muscle: 'flexors'|'extensors',
//     cmFromElbowCrease? }), person_id, landmark, entered_by='user', saved_at }) -> Placement
//     Ring sensors get ch 1..count; EMG sites follow (ch count+1.. unless given).
//   emgSite(muscle, opts) -> channel entry (flexors 20°, extensors 200°: over the muscle bellies).
//   mirrorPlacement(p) -> copy on the other arm (angles unchanged, by the convention above).
//   diffPlacement(prev, next, { cm=DIFF_CM, deg=DIFF_DEG }) -> [{ ch, kind, delta, text }]
//     kind 'arm' | 'along' | 'around' | 'added' | 'removed' | 'sensor'; text is one plain sentence
//     ("Sensor 3 (thumb edge) is 1.5 cm further from the elbow than last time (8.0 → 9.5 cm).").
//     [] = same fit. Spec §12.5 / review-2 M2: one slider move = one line, so >= 3 sensors moved
//     from the same depth to the same depth become ONE 'along' item { ch: null, chs: [..] }
//     ("All 6 sensors are …" or "Sensors 1, 2 and 4 are …"). A turn names its direction and,
//     when next.ring.circumferenceCm is known, the distance round the arm.
//   placementSummary(p) -> the human `# placement=` line ("right arm; 8 FMG evenly spaced ring ...").
//   encodePlacementMap(p) -> one-line JSON with every '=' written = (so a CSV header split
//     on '=' can never break, whatever the landmark says); decodePlacementMap(s|obj) -> obj | null.
//   CHECK_STEPS: ['relax', 'fist', 'wrist_back', 'elbow_bend']; CHECK (thresholds, below).
//   checkPlacement(rec, placement, steps?, opts?) -> ChannelCheck[] (one per rec.data channel)
//     rec: column rec { data: number[][], labels?, rateHz?, channelNames? } (quality.js shape).
//     steps: [{ step, start, end (exclusive) }] sample indices; omitted -> runs of rec.labels whose
//       label is a step id (aliases: rest->relax, grip->fist, open/wrist_ext->wrist_back,
//       elbow->elbow_bend). A missing step is not judged (and says so in `missing`).
//     ChannelCheck = { ch, state: 'good'|'weak'|'bad', reason, fix, expected: step|null,
//       code, stats: { baseline, noise, resp: { fist, wrist_back, elbow_bend } (counts above rest
//       or null), }, missing: step[] }
//     opts: CHECK overrides, plus { doctor: false } to skip the whole-recording Doctor checks
//       (liveCheck does), { rest: [{ baseline, noise }] } to judge without a relax step.
//   liveCheck(window, placement, { prev, step, ...opts }) -> ChannelCheck[]
//     The re-check while the user adjusts: window = the last few seconds (column rec). Steps come
//     from its labels, or the whole window is `step`. Rest level comes from the window's relax
//     part, else from prev (an earlier result). Responses the window does not contain are taken
//     from prev, so the glow only changes for what the user is redoing now.
//   checkSummary(results) -> { good, weak, bad, text }
// Wording rule (spec §16): the check says "works here", never "correct position".
// Failure behaviour: never throws on empty / short / NaN input; a channel with no samples is 'bad'
//   with the Doctor's no_data fix. Unknown placement (no side) -> judged on "reacts at all, quiet
//   at rest, not the elbow" only, and the reason says no place was entered.

import { analyzeRecording } from './quality.js';
import { fixFor } from './doctor.js';

export const OCTANTS = [
  { deg: 0, name: 'Palm middle' }, { deg: 45, name: 'Palm, thumb side' },
  { deg: 90, name: 'Thumb edge' }, { deg: 135, name: 'Back, thumb side' },
  { deg: 180, name: 'Back middle' }, { deg: 225, name: 'Back, little-finger side' },
  { deg: 270, name: 'Little-finger edge' }, { deg: 315, name: 'Palm, little-finger side' },
];
// Thresholds for "the fit changed" (first guess: a band slipping 1 cm or turning one sensor
// gap on an 8-ring changes FMG patterns; to be tuned on real club fits).
export const DIFF_CM = 1;
export const DIFF_DEG = 20;
const EMG_ANGLE = { flexors: 20, extensors: 200 };

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
export const normDeg = (a) => { const n = num(a); return n == null ? null : ((Math.round(n) % 360) + 360) % 360; };
const roundHalf = (v) => Math.round(v * 2) / 2;
const clampCm = (v) => { const n = num(v); return n == null ? null : Math.min(30, Math.max(0, roundHalf(n))); };

export function siteName(deg) {
  const a = normDeg(deg);
  if (a == null) return null;
  return OCTANTS[Math.round(a / 45) % 8].name;
}

export function sideOf(deg) {
  const a = normDeg(deg);
  if (a == null) return null;
  return a >= 90 && a < 270 ? 'back' : 'palm';
}

export function ringXY(deg, arm, rx = 1, ry = 1) {
  const a = ((normDeg(deg) ?? 0) * Math.PI) / 180;
  const thumbX = arm === 'R' ? -1 : 1;
  return { x: thumbX * Math.sin(a) * rx, y: Math.cos(a) * ry };
}

export function emgSite(muscle, { ch = null, cmFromElbowCrease = 5, arm = 'R' } = {}) {
  const m = muscle === 'extensors' ? 'extensors' : 'flexors';
  const a = EMG_ANGLE[m];
  return { ch, sensor: 'EMG', site: m === 'flexors' ? 'Flexors' : 'Extensors', ringAngleDeg: a, cmFromElbowCrease: clampCm(cmFromElbowCrease), side: sideOf(a), arm };
}

export function ringPreset({ count = 8, cmFromElbowCrease = 8, startDeg = 0, dir = 1, arm = 'R', circumferenceCm = null, sensors = [], emg = [], person_id, landmark = '', entered_by = 'user', saved_at = null } = {}) {
  const n = Math.max(1, Math.min(16, Math.round(count)));
  const d = dir < 0 ? -1 : 1;
  const cm = clampCm(cmFromElbowCrease);
  const channels = [];
  for (let i = 0; i < n; i++) {
    const a = normDeg((num(startDeg) ?? 0) + (d * i * 360) / n);
    channels.push({ ch: i + 1, sensor: sensors[i] || 'FMG', site: siteName(a), ringAngleDeg: a, cmFromElbowCrease: cm, side: sideOf(a), arm });
  }
  let next = n + 1;
  for (const e of emg) {
    const c = emgSite(e.muscle, { ch: e.ch ?? next, cmFromElbowCrease: e.cmFromElbowCrease ?? 5, arm });
    next = Math.max(next, c.ch) + 1;
    channels.push(c);
  }
  const p = { v: 1, arm, entered_by, method: 'ring', saved_at, ring: { count: n, cmFromElbowCrease: cm, startDeg: normDeg(startDeg) ?? 0, dir: d, circumferenceCm: num(circumferenceCm) }, landmark, channels };
  if (person_id != null) p.person_id = person_id;
  return p;
}

export function mirrorPlacement(p) {
  const arm = p.arm === 'L' ? 'R' : 'L';
  return { ...p, arm, channels: (p.channels || []).map((c) => ({ ...c, arm })) };
}

const armWord = (a) => (a === 'L' ? 'left' : a === 'R' ? 'right' : 'unknown');
const fmtCm = (v) => String(Math.round(v * 10) / 10);
const cm1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const listChs = (chs) => (chs.length < 2 ? String(chs[0]) : `${chs.slice(0, -1).join(', ')} and ${chs[chs.length - 1]}`);
// Which way a sensor turned, in arm words: compare how much it gained toward the thumb (sin) with
// how much toward the palm (cos), anatomical angles (0 palm middle, 90 thumb side).
function turnWay(a, b) {
  const ds = Math.sin(b * Math.PI / 180) - Math.sin(a * Math.PI / 180);
  const dc = Math.cos(b * Math.PI / 180) - Math.cos(a * Math.PI / 180);
  if (Math.abs(ds) >= Math.abs(dc)) return ds > 0 ? 'toward the thumb' : 'toward the little finger';
  return dc > 0 ? 'toward the palm' : 'toward the back of the arm';
}

export function diffPlacement(prev, next, { cm = DIFF_CM, deg = DIFF_DEG } = {}) {
  const out = [];
  if (!prev || !next) return out;
  if (prev.arm && next.arm && prev.arm !== next.arm) {
    out.push({ ch: null, kind: 'arm', delta: null, text: `Last time was the ${armWord(prev.arm)} arm; this is the ${armWord(next.arm)} arm.` });
  }
  const byCh = (p) => new Map((p.channels || []).filter((c) => c.ringAngleDeg != null || c.cmFromElbowCrease != null).map((c) => [c.ch, c]));
  const A = byCh(prev);
  const B = byCh(next);
  for (const [ch, b] of B) {
    const a = A.get(ch);
    if (!a) { out.push({ ch, kind: 'added', delta: null, text: `Sensor ${ch} is placed this time but was not last time.` }); continue; }
    if (a.sensor && b.sensor && a.sensor !== b.sensor) out.push({ ch, kind: 'sensor', delta: null, text: `Sensor ${ch} is ${b.sensor} now; last time it was ${a.sensor}.` });
    const dc = num(b.cmFromElbowCrease) != null && num(a.cmFromElbowCrease) != null ? b.cmFromElbowCrease - a.cmFromElbowCrease : null;
    const pa = normDeg(a.ringAngleDeg);
    const pb = normDeg(b.ringAngleDeg);
    const who = `Sensor ${ch}${pb != null ? ` (${siteName(pb).toLowerCase()})` : ''}`;
    if (dc != null && Math.abs(dc) >= cm) {
      const range = `(${cm1(a.cmFromElbowCrease)} → ${cm1(b.cmFromElbowCrease)} cm)`;
      out.push({ ch, kind: 'along', delta: dc, range, text: `${who} is ${cm1(Math.abs(dc))} cm ${dc > 0 ? 'further from' : 'closer to'} the elbow than last time ${range}.` });
    }
    if (pa != null && pb != null) {
      const dd = ((pb - pa + 540) % 360) - 180; // shortest way round, -180..179
      const circ = num(next.ring?.circumferenceCm);
      const round = circ ? ` (about ${cm1(Math.abs(dd) / 360 * circ)} cm round the arm)` : '';
      if (Math.abs(dd) >= deg) out.push({ ch, kind: 'around', delta: dd, text: `${who} has turned ${Math.abs(dd)}° ${turnWay(pa, pb)}${round}.` });
    }
  }
  for (const ch of A.keys()) if (!B.has(ch)) out.push({ ch, kind: 'removed', delta: null, text: `Sensor ${ch} was placed last time but not this time.` });
  return mergeAlong(out, B.size);
}

// Same from -> to depth on >= 3 sensors is one slider move: one line, at the first one's place.
function mergeAlong(items, placedCount) {
  const groups = new Map();
  for (const d of items) if (d.kind === 'along') groups.set(d.range, [...(groups.get(d.range) || []), d]);
  const out = [];
  for (const d of items) {
    const g = d.kind === 'along' ? groups.get(d.range) : null;
    if (!g || g.length < 3) { out.push(d); continue; }
    if (g[0] !== d) continue;
    const chs = g.map((x) => x.ch);
    const who = chs.length === placedCount ? `All ${chs.length} sensors` : `Sensors ${listChs(chs)}`;
    out.push({ ch: null, chs, kind: 'along', delta: d.delta, range: d.range, text: `${who} are ${cm1(Math.abs(d.delta))} cm ${d.delta > 0 ? 'further from' : 'closer to'} the elbow than last time ${d.range}.` });
  }
  return out;
}

export function placementSummary(p) {
  if (!p) return '';
  const parts = [`${armWord(p.arm)} arm`];
  const chans = p.channels || [];
  const ringN = p.ring ? chans.filter((c) => c.ch <= p.ring.count) : [];
  if (p.ring) {
    const types = [...new Set(ringN.map((c) => c.sensor))];
    parts.push(`${p.ring.count} ${types.length === 1 ? types[0] : 'sensor'} evenly spaced ring ${fmtCm(p.ring.cmFromElbowCrease)} cm below elbow crease`);
  }
  const rest = chans.filter((c) => !ringN.includes(c) && c.site);
  const emg = rest.filter((c) => c.sensor === 'EMG');
  if (emg.length) parts.push(`EMG ${emg.map((c) => `${c.ch} ${c.site.toLowerCase()}`).join(', ')}`);
  const other = rest.filter((c) => c.sensor !== 'EMG');
  if (other.length) parts.push(other.map((c) => `${c.sensor} ${c.ch} ${c.site.toLowerCase()}`).join(', '));
  const unplaced = chans.filter((c) => !c.site && c.ringAngleDeg == null);
  if (unplaced.length) parts.push(`not placed: ${unplaced.map((c) => c.ch).join(', ')}`);
  // No '=' in the human line: parse.js splits a '# key=value' header that contains ' k=v'.
  if (p.landmark) parts.push(String(p.landmark).replace(/[\r\n]+/g, ' ').replace(/=/g, ':').trim());
  parts.push(`entered by ${p.entered_by || 'user'}`);
  return parts.join('; ');
}

export function encodePlacementMap(p) {
  // '=' only ever appears inside JSON strings, where = is the same character.
  return JSON.stringify(p).replace(/=/g, '\\u003d');
}

export function decodePlacementMap(s) {
  if (s && typeof s === 'object') return s;
  if (typeof s !== 'string' || !s.trim()) return null;
  try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

// ---------------------------------------------------------------- placement check (spec §16)

export const CHECK_STEPS = ['relax', 'fist', 'wrist_back', 'elbow_bend'];
const STEP_ALIAS = { relax: 'relax', rest: 'relax', fist: 'fist', grip: 'fist', wrist_back: 'wrist_back', wrist_ext: 'wrist_back', open: 'wrist_back', elbow_bend: 'elbow_bend', elbow: 'elbow_bend' };
const STEP_WORD = { fist: 'the fist', wrist_back: 'the wrist going back', elbow_bend: 'the elbow bend' };

// All FIRST GUESSES, to be tuned on real club data (the twin's numbers are assumptions too).
// Counts are raw ADC counts above the relax level; noise is the robust sd at rest.
export const CHECK = {
  goodCounts: 40,      // a good spot rises at least this much on its movement ...
  goodSnr: 8,          // ... and at least 8x its rest noise
  weakCounts: 15,      // below this (or 4x noise) it barely reacts: 'bad'
  weakSnr: 4,
  wrongRatio: 1.25,    // the other movement beats the expected one by 25%: wrong side of the arm
  bothRatio: 0.8,      // the other movement is >= 80% of the expected one: 'weak' (not selective)
  elbowBad: 0.6,       // elbow bend gives >= 60% of the expected response: picks up the arm
  elbowWeak: 0.35,
  flatCounts: 3,       // the whole check moves less than this: dead or not touching
  respQuantile: 0.9,   // response = this quantile of a step minus the rest level (ignores spikes)
};
// Doctor findings that mean "this channel can't be judged / is broken": first match wins.
const FAULT_CODES = ['no_data', 'dropout', 'floating', 'saturation', 'hum', 'spike', 'noisy_rest'];

const finite = (a) => a.filter(Number.isFinite);
function quantile(a, q) {
  const s = finite(a).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
}
const median = (a) => quantile(a, 0.5);
const robustSd = (a) => { const m = median(a); return 1.4826 * median(a.map((x) => Math.abs(x - m))); };

function stepsFromLabels(labels = []) {
  const out = [];
  let cur = null;
  for (let i = 0; i <= labels.length; i++) {
    const s = i < labels.length ? STEP_ALIAS[String(labels[i] || '').split('@')[0]] || null : null;
    if (cur && cur.step === s) continue;
    if (cur) { cur.end = i; out.push(cur); }
    cur = s ? { step: s, start: i, end: i } : null;
  }
  return out;
}

const chEntry = (placement, c) => (placement?.channels || []).find((x) => x.ch === c + 1) || null;

// Which movement should move this spot: flexors / palm side -> fist; extensors / back -> wrist back.
function expectedStep(entry) {
  if (!entry) return null;
  const site = String(entry.site || '').toLowerCase();
  if (entry.sensor === 'EMG' || entry.sensor === 'both') {
    if (/flex/.test(site)) return 'fist';
    if (/exten/.test(site)) return 'wrist_back';
  }
  const side = entry.side || sideOf(entry.ringAngleDeg);
  return side === 'palm' ? 'fist' : side === 'back' ? 'wrist_back' : null;
}

function doctorFaults(rec, names, opts) {
  if (!rec.data.length || !rec.data[0]?.length) return new Map();
  let report;
  try { report = analyzeRecording({ ...rec, channelNames: names }, { skipPosition: true, doctor: opts.doctor }); } catch { return new Map(); }
  const out = new Map();
  for (const code of FAULT_CODES) {
    for (const it of report.items) {
      if (it.code !== code || it.channel == null || it.level === 'green' || out.has(it.channel)) continue;
      out.set(it.channel, it);
    }
  }
  return out;
}

function judge(c, entry, stats, fault, o, missing) {
  const name = `Sensor ${c + 1}`;
  const base = { ch: c + 1, expected: expectedStep(entry), stats, missing };
  if (fault) return { ...base, state: 'bad', code: fault.code, reason: `${name} does not work here yet: ${fault.message.replace(/^[^:]*:\s*/, '')}`, fix: fault.fix || fixFor(fault.code, name) };
  if (!stats.n) return { ...base, state: 'bad', code: 'no_data', reason: `${name} sent no data during the check.`, fix: fixFor('no_data', name) };
  const r = stats.resp;
  if (stats.span < o.flatCounts) return { ...base, state: 'bad', code: 'flat', reason: `${name} stays flat through the whole check: it is not touching or not connected.`, fix: fixFor('no_bursts', name) };
  const strong = (v) => v != null && v >= Math.max(o.goodCounts, o.goodSnr * stats.noise);
  const some = (v) => v != null && v >= Math.max(o.weakCounts, o.weakSnr * stats.noise);
  const exp = base.expected;
  if (!exp) {
    // No place entered: judge only "reacts at all, and not mainly to the elbow".
    const best = Math.max(r.fist ?? 0, r.wrist_back ?? 0);
    if (r.elbow_bend != null && some(r.elbow_bend) && r.elbow_bend >= o.elbowBad * best) return { ...base, state: 'bad', code: 'elbow', reason: `${name} reacts to the elbow bend about as much as to the hand (no place entered for it).`, fix: fixFor('position', name) };
    if (strong(best)) return { ...base, state: 'good', code: 'ok', reason: `${name} works here (no place entered, so only "it reacts" was checked).`, fix: '' };
    if (some(best)) return { ...base, state: 'weak', code: 'faint', reason: `${name} reacts only faintly (no place entered for it).`, fix: 'Tighten the band a little or press the sensor flatter on the skin, then try again.' };
    return { ...base, state: 'bad', code: 'no_response', reason: `${name} barely reacts to the fist or the wrist going back.`, fix: fixFor('no_bursts', name) };
  }
  const other = exp === 'fist' ? 'wrist_back' : 'fist';
  const e = r[exp];
  if (e == null) return { ...base, state: 'weak', code: 'not_checked', reason: `${name}: ${STEP_WORD[exp]} step was not done, so this spot is not checked yet.`, fix: `Do ${STEP_WORD[exp]} step of the check.` };
  const ov = r[other];
  const side = exp === 'fist' ? 'palm side' : 'back of the arm';
  if (ov != null && some(ov) && ov >= o.wrongRatio * Math.max(e, 1)) {
    return { ...base, state: 'bad', code: 'wrong_movement', reason: `${name} reacts to the wrong movement: more to ${STEP_WORD[other]} than to ${STEP_WORD[exp]}. It was entered on the ${side}.`, fix: `Check the band is not turned: ${name} should sit on the ${side}. Turn the band or correct the place you entered, then re-check.` };
  }
  if (!some(e)) return { ...base, state: 'bad', code: 'no_response', reason: `${name} barely reacts to ${STEP_WORD[exp]}.`, fix: fixFor('no_bursts', name) };
  if (r.elbow_bend != null && some(r.elbow_bend) && r.elbow_bend >= o.elbowBad * e) {
    return { ...base, state: 'bad', code: 'elbow', reason: `${name} reacts to the elbow bend almost as much as to ${STEP_WORD[exp]}.`, fix: fixFor('position', name) };
  }
  const weakWhy = [];
  if (!strong(e)) weakWhy.push(`reacts only faintly to ${STEP_WORD[exp]}`);
  if (ov != null && some(ov) && ov >= o.bothRatio * e) weakWhy.push(`reacts about as much to ${STEP_WORD[other]}`);
  if (r.elbow_bend != null && some(r.elbow_bend) && r.elbow_bend >= o.elbowWeak * e) weakWhy.push('picks up some of the elbow bend');
  if (weakWhy.length) return { ...base, state: 'weak', code: 'weak', reason: `${name} works here but ${weakWhy.join(' and ')}.`, fix: !strong(e) ? 'Tighten the band a little or press the sensor flatter on the skin, then try again.' : `Nudge ${name} a little further onto the ${side}.` };
  return { ...base, state: 'good', code: 'ok', reason: `${name} works here: it reacts to ${STEP_WORD[exp]} and stays quiet otherwise.`, fix: '' };
}

function channelStats(values, steps, o, restIn) {
  const pick = (name) => { const v = []; for (const s of steps.filter((x) => x.step === name)) for (let i = s.start; i < s.end; i++) v.push(values[i]); return v; };
  const all = finite(values || []);
  const relax = finite(pick('relax'));
  let baseline = relax.length ? median(relax) : num(restIn?.baseline);
  let noise = relax.length ? robustSd(relax) : num(restIn?.noise);
  if (baseline == null || !Number.isFinite(baseline)) baseline = all.length ? quantile(all, 0.1) : NaN;
  if (noise == null || !Number.isFinite(noise)) noise = 0;
  const resp = {};
  for (const k of ['fist', 'wrist_back', 'elbow_bend']) {
    const v = finite(pick(k));
    resp[k] = v.length ? Math.max(0, quantile(v, o.respQuantile) - baseline) : null;
  }
  const span = all.length ? quantile(all, 0.99) - quantile(all, 0.01) : 0;
  return { n: all.length, baseline, noise, resp, span };
}

export function checkPlacement(rec, placement, steps = null, opts = {}) {
  const o = { ...CHECK, ...opts };
  const data = rec?.data || [];
  const st = (steps && steps.length ? steps : stepsFromLabels(rec?.labels || []))
    .map((s) => ({ ...s, step: STEP_ALIAS[s.step] || s.step }))
    .filter((s) => CHECK_STEPS.includes(s.step));
  const missing = CHECK_STEPS.filter((k) => !st.some((s) => s.step === k));
  const names = data.map((_, c) => `Sensor ${c + 1}`);
  const faults = doctorFaults({ ...rec, data }, names, o);
  return data.map((values, c) => judge(c, chEntry(placement, c), channelStats(values, st, o, o.rest?.[c]), faults.get(c), o, missing));
}

export function liveCheck(window, placement, { prev = null, step = null, ...opts } = {}) {
  const n = window?.data?.[0]?.length || 0;
  const steps = step ? [{ step, start: 0, end: n }] : null;
  const rest = (prev || []).map((p) => p?.stats ? { baseline: p.stats.baseline, noise: p.stats.noise } : null);
  // The live window is short, so the whole-recording Doctor checks (hum, timing) are left out.
  const now = checkPlacement(window, placement, steps, { doctor: false, rest, ...opts });
  if (!prev) return now;
  // Keep earlier responses for the steps this window does not contain, then judge again.
  const o = { ...CHECK, ...opts };
  return now.map((r, c) => {
    const p = prev[c];
    // A fault seen in this window wins: the sensor is broken now, whatever it did before.
    if (!p?.stats || FAULT_CODES.includes(r.code)) return r;
    const resp = { ...r.stats.resp };
    for (const k of Object.keys(resp)) if (resp[k] == null) resp[k] = p.stats.resp?.[k] ?? null;
    const stats = { ...r.stats, resp, span: Math.max(r.stats.span, p.stats.span || 0) };
    const missing = CHECK_STEPS.filter((k) => k === 'relax' ? r.missing.includes('relax') && p.missing?.includes('relax') : resp[k] == null);
    return judge(c, chEntry(placement, c), stats, null, o, missing);
  });
}

export function checkSummary(results = []) {
  const n = { good: 0, weak: 0, bad: 0 };
  for (const r of results) n[r.state] = (n[r.state] || 0) + 1;
  const parts = [];
  if (n.good) parts.push(`${n.good} work${n.good === 1 ? 's' : ''} here`);
  if (n.weak) parts.push(`${n.weak} weak`);
  if (n.bad) parts.push(`${n.bad} not working here`);
  return { ...n, text: parts.length ? `${parts.join(', ')}.` : 'Nothing checked yet.' };
}
