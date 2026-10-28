// sim/twin.js: the "digital twin" of the club's FMG/EMG Arduino. A seeded synthetic sensor that
// looks like the club's logs, faults included, and records exactly what it injected. Pure ES
// module: runs in Node and the browser; no fs, no DOM.
//
// SYNTHETIC DATA IS FOR TESTING AND DEMOS, NEVER AS EVIDENCE OF ACCURACY. The shape parameters
// come from six 1-channel unlabelled club logs (twin-model.json); the multi-channel gesture and
// arm-position patterns below are assumptions until the club records labelled multi-channel
// data. A detector or model that does well on twin data has only shown it handles the twin.
//
// Contract
//   rng(seed) -> { next() 0..1, normal(mu=0, sd=1), int(lo, hi) inclusive, pick(arr) }
//   generate(opts) -> Session
//     opts: { seed=1, rateHz=100, channels=6 (1..8), gesture='grip'
//             ('grip'|'squeeze'|'open'|'finger'|'rest'|'elbow'|'check'), positions=['down']
//             (cycled over reps; 'down'|'elbow90'|'raised'), reps=model n_bursts (min 3),
//             calibration=true (cal_rest + 2x cal_squeeze first), distractors=channels>1?1:0
//             (elbow_bend bursts), faults=[] (see FAULT_TYPES; 'name', 'name:count' or
//             { type, channel?, start?, ...params }), holdS=null (override hold length),
//             model=TWIN_MODEL, baud=9600 (slowlink), humHz=50,
//             placement=null (placement.js Placement or its channels[]; ch is 1-based),
//             gapS=null (override the burst period: hold + rest, e.g. 7 for the 3 s + 4 s protocol),
//             reactionMs=0 (ms or [lo, hi]: the body starts each step this late after its prompt;
//             then truth.reactions = [{ label, index (prompt start), onset, lagMs }] per step change) }
//     gesture 'check': the placement check, labelled with placement.js CHECK_STEPS ('relax' 3 s,
//       then reps (default 2) x fist / wrist_back / elbow_bend held holdS (default 2 s), each after
//       a relax); defaults calibration=false, distractors=0. checkPlacement(session, placement)
//       reads the steps from the labels.
//     placement: a channel with an entry responds by its site (siteWeights): palm side / flexor
//       EMG to the fist, back side / extensor EMG to wrist back, the elbow bend by distance from
//       the crease. Channels without an entry (and placement=null) keep the PATTERNS table, so
//       sessions without a placement are sample-for-sample unchanged.
//     Placement faults (PLACEMENT_FAULTS, not in FAULT_TYPES: the Doctor cannot see them):
//       'misplace' { channel? } the sensor really sits on the opposite side from its entry
//       (truth start 0, end n). 'loose' also multiplies the channel's elbow pickup x2.5 while loose.
//   siteWeights(entry, { misplaced=false }) -> { grip, open, arm } | null (no usable site)
//     Session: { synthetic: true, rateHz, channels, channelNames, n,
//                t: ms[] (device clock, with jitter / resets), hostMs: ms[] (arrival at the PC),
//                data: number[][] per channel (integers 0..1023), labels: string[],
//                events: [{ index, kind: 'junk'|'header', text? }] (extra lines before sample index),
//                truth: { synthetic: true, seed, opts, faults: Truth[], skipped: [{ type, reason }],
//                         bursts: [{ label, start, end, channelPeak: number[] }] } }
//     Truth = { type, channel (null = whole device), start, end (output sample indices, end
//               exclusive), ...params }. Indices are into the Session arrays (after missing
//               samples are removed), so a detector's sample index can be compared directly.
//   toLines(session, format='nxt', { header=true, channel=0, labels=true }) -> string[]
//     formats: 'nxt' (# nxt_logger header + t_ms,ch..,label), 'timed' (t,v..), 'delimited'
//     (v,v..), 'tsv', 'space', 'single' (one channel, club style), 'plotter' (ch1:v ch2:v).
//     Every format starts with "# synthetic=true ..." unless header=false.
//   new TwinSource({ channels=6, rateHz=100, seed=1, labelProvider=null, speed=1, now, faults=[],
//                    gesture='grip' }): same interface as FakeSource (header(), nextLine(),
//                    generateLines(seconds), start(handlers), stop()); kind = 'twin'.
//   summarize(values) -> stats used by the realism score (see STAT_KEYS).
//   realismScore(realByTask: { task: number[][] }, { seeds=[1..5] }) -> { tasks, within, total, score }
//   detectorScorecard({ parse, analyze, seeds=10, types=FAULT_TYPES }) -> scorecard
//     parse = parse.js parseText, analyze = quality.js analyzeRecording (injected, so this module
//     stays independent of the code it scores).
// Failure behaviour: unknown gesture -> 'grip'; unknown fault type -> throws Error('unknown fault');
// a fault that cannot apply (hum below 500 Hz, crosstalk on 1 channel, slowlink with enough
// baud) is listed in truth.skipped with a reason, never silently dropped.

import { mulberry32, bootJunk } from './uart.js';

// Mirrors src/sim/twin-model.json (a test checks they stay equal). Embedded so the browser
// needs no JSON import. Units: ADC counts and samples at the club logs' ~100 Hz.
// Public export: stand-in values (1 significant figure), not the parameters fitted on the club logs.
export const TWIN_MODEL = {"tasks":{"grip":{"rest_level":10,"rest_noise":1,"peak_mean":200,"peak_sd":90,"rise":20,"decay":40,"width":50,"gap":200,"fade_per_rep":0.9,"n_bursts":5},"squeeze":{"rest_level":4,"rest_noise":0.7,"peak_mean":90,"peak_sd":30,"rise":20,"decay":60,"width":4,"gap":80,"fade_per_rep":0.9,"n_bursts":10,"reps":5,"hold_len":200,"rep_gap":300,"sag_per_s":0.3,"wobble":0.3,"wobble_s":0.3},"finger":{"rest_level":5,"rest_noise":0.6,"peak_mean":40,"peak_sd":20,"rise":20,"decay":40,"width":20,"gap":300,"fade_per_rep":1,"n_bursts":4},"elbow":{"rest_level":30,"rest_noise":6,"peak_mean":200,"peak_sd":40,"rise":20,"decay":30,"width":30,"gap":100,"fade_per_rep":1,"n_bursts":10}},"shape":{"settle":0.5,"settle_s":8,"release_tail":0.1,"fast_x":0.65,"tail_x":2,"sag_per_s":0,"wobble":0.035,"wobble_s":0.1},"faults":{"dropout_len_median":30,"dropouts_per_1000":2,"spike_after_dropout_peak":1000,"spike_decay":30}};

export const SYNTHETIC_NOTE = 'synthetic data is for testing and demos, never evidence of accuracy';
export const FAULT_TYPES = ['dropout', 'loose', 'saturation', 'floating', 'shift', 'hum', 'jitter', 'missing', 'boot', 'slowlink', 'brownout', 'crosstalk', 'creep'];
// Squeeze-type steps a person holds at steady pressure (= drift.js HOLD_RE): where FSR creep shows.
const HOLD_RE = /^(cal_)?(squeeze|grip|pinch|fist)/i;
// Faults of the fit, not the hardware: the Doctor cannot see them (no line noise), only the
// placement check can, so they stay out of FAULT_TYPES (the Doctor scorecard iterates that).
export const PLACEMENT_FAULTS = ['misplace'];
export const GESTURES = ['rest', 'grip', 'squeeze', 'open', 'finger', 'elbow', 'check'];
export const POSITIONS = ['down', 'elbow90', 'raised'];
const MODEL_RATE = 100;
// Burst-shape constants shared by all tasks (model.shape; per-task keys override sag/wobble).
// v2 values were settle 0.5 / 8 s, tail 0.3 at x3 (fast x0.65), no sag, wobble 0.035 / 0.1 s.
const SHAPE_DEFAULTS = { settle: 0.5, settle_s: 8, release_tail: 0.3, fast_x: 0.65, tail_x: 3, sag_per_s: 0, wobble: 0.035, wobble_s: 0.1 };
const shapeOf = (model) => ({ ...SHAPE_DEFAULTS, ...(model && model.shape) });
// Reps a task's protocol has: `reps` when the learned n_bursts counts ripples, not reps (squeeze).
const repsOf = (m) => m.reps ?? m.n_bursts;

// Per-channel weights for an 8-band layout (ASSUMED, see header): flexors for grip, extensors
// for open, one strong band for a finger. Channel 1 is always the club's sensor spot, so a
// 1-channel twin uses weight 1 for every gesture (that is what the club logs measured).
const PATTERNS = {
  grip: [1.0, 0.85, 0.7, 0.9, 0.6, 0.5, 0.75, 0.4],
  open: [0.2, 0.3, 0.95, 0.25, 1.0, 0.8, 0.2, 0.65],
  finger: [0.15, 1.0, 0.25, 0.2, 0.1, 0.35, 0.6, 0.1],
  arm: [0.9, 0.4, 1.0, 0.3, 0.7, 0.5, 0.8, 0.6],
};
// Site-aware patterns (opts.placement; ASSUMED until the club records labelled multi-channel
// data). With a placement a sensor responds to where it sits, not to its channel number. The
// fist loads the palm-side flexors, the wrist going back loads the back-side extensors, and the
// thumb / little-finger edges get some of both: weight = floor + (1 - floor) * palm-ness, with
// palm-ness = (1 + cos angle) / 2 on the anatomical angle (0 palm middle, 180 back middle). The
// elbow bend works the muscles near the crease and pulls the band, so its pickup falls off with
// distance from the crease: ~0.16 of a grip at 8 cm, ~0.3 at 5 cm, about a full grip at 1 cm.
// The club's one-sensor elbow log (peaks ~160 counts) is the evidence that some spots react hard.
// A loose sensor rocks when the arm moves: its elbow pickup is multiplied while it is loose.
export const SITE_RESPONSE = { floor: 0.12, elbowFloor: 0.1, elbowNear: 1.5, elbowCm: 2.5, elbowUnknown: 0.3, looseElbow: 2.5 };

const placementEntry = (placement, c) => (Array.isArray(placement) ? placement : placement?.channels || []).find((x) => x && x.ch === c + 1) || null;

// Anatomical angle of a channel's site: EMG by muscle (placement.js emgSite angles), else the
// ring angle, else the side's middle. null = nothing usable was entered.
function siteAngle(entry) {
  const site = String(entry.site || '').toLowerCase();
  if (entry.sensor === 'EMG' || entry.sensor === 'both') {
    if (/flex/.test(site)) return 20;
    if (/exten/.test(site)) return 200;
  }
  if (Number.isFinite(entry.ringAngleDeg)) return entry.ringAngleDeg;
  return entry.side === 'palm' ? 0 : entry.side === 'back' ? 180 : null;
}

// siteWeights(entry, { misplaced }) -> { grip, open, arm } | null. misplaced: the sensor really
// sits on the opposite side of the arm from the entry (band turned half a turn, or mis-entered).
export function siteWeights(entry, { misplaced = false } = {}) {
  if (!entry) return null;
  const a0 = siteAngle(entry);
  if (a0 == null) return null;
  const R = SITE_RESPONSE;
  const a = ((a0 + (misplaced ? 180 : 0)) * Math.PI) / 180;
  const palm = (1 + Math.cos(a)) / 2;
  const cm = Number.isFinite(entry.cmFromElbowCrease) ? entry.cmFromElbowCrease : null;
  const arm = cm == null ? R.elbowUnknown : R.elbowFloor + R.elbowNear * Math.exp(-cm / R.elbowCm);
  return { grip: R.floor + (1 - R.floor) * palm, open: R.floor + (1 - R.floor) * (1 - palm), arm };
}

// Arm pose changes band pressure even at rest (FMG): counts added per channel, ASSUMED.
const POSITION_OFFSET = {
  down: [0, 0, 0, 0, 0, 0, 0, 0],
  elbow90: [18, 30, 8, 22, 12, 26, 10, 16],
  raised: [35, 20, 40, 15, 30, 10, 25, 20],
};
// Which learned task drives each burst kind; scale for kinds the club never logged.
const KINDS = {
  grip: { task: 'grip', scale: 1, pattern: 'grip' },
  squeeze: { task: 'squeeze', scale: 1, pattern: 'grip' },
  cal_squeeze: { task: 'grip', scale: 1.05, pattern: 'grip', noFade: true },
  open: { task: 'grip', scale: 0.7, pattern: 'open' },
  // The check's wrist-back is a deliberate 2 s hold, as hard as the fist; scale 1 keeps the
  // back side's rise comparable to the palm side's, so an edge sensor reads "both", not "wrong".
  wrist_back: { task: 'grip', scale: 1, pattern: 'open' },
  finger: { task: 'finger', scale: 1, pattern: 'finger' },
  elbow: { task: 'elbow', scale: 1, pattern: 'arm' },
};

export function rng(seed = 1) {
  const next = mulberry32(seed);
  let spare = null;
  return {
    next,
    normal(mu = 0, sd = 1) {
      if (spare != null) { const z = spare; spare = null; return mu + sd * z; }
      const u = Math.max(1e-12, next());
      const v = next();
      const r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v);
      return mu + sd * r * Math.cos(2 * Math.PI * v);
    },
    int(lo, hi) { return lo + Math.floor(next() * (hi - lo + 1)); },
    pick(a) { return a[Math.floor(next() * a.length)]; },
  };
}

const FLOOR_KNEE = 4; // counts: below this the soft floor bends the signal towards 2
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const smooth = (x) => x * x * (3 - 2 * x); // smoothstep: rounded start and top, like real rises

function kindOf(label) {
  const g = String(label || '').split('@')[0].toLowerCase();
  if (g === 'cal_squeeze') return 'cal_squeeze';
  if (/elbow|bend/.test(g)) return 'elbow';
  if (/squeeze/.test(g)) return 'squeeze';
  if (/grip|fist/.test(g)) return 'grip';
  if (/wrist/.test(g)) return 'wrist_back';
  if (/open/.test(g)) return 'open';
  if (/finger|flex|pinch|point/.test(g)) return 'finger';
  return null;
}

function positionOf(label) {
  const at = String(label || '').indexOf('@');
  const p = at < 0 ? null : label.slice(at + 1);
  return POSITION_OFFSET[p] ? p : null;
}

// Clean signal: wandering baseline + noise + smooth bursts + arm-position offsets. One sample per
// step(label); a burst starts when the label turns into a gesture and decays when it ends.
class Body {
  constructor(o, r, plan = []) {
    this.o = o;
    this.r = r;
    this.k = o.rateHz / MODEL_RATE;
    const m = o.model.tasks[o.restTask] || o.model.tasks.grip;
    const C = o.channels;
    this.rest = Array.from({ length: C }, (_, c) => m.rest_level * (c === 0 ? 1 : 0.7 + 0.6 * ((c * 0.618) % 1)));
    // Real noise is smooth (the sensor and ADC low-pass it); white noise made v2 bursts chatter
    // across the threshold and split. AR(1) with phi 0.7, sized so the diff std = rest_noise.
    this.phi = 0.7;
    this.sd = Math.max(0.4, m.rest_noise / Math.sqrt(2 * (1 - this.phi)));
    this.nz = new Array(C).fill(0);
    // Baseline wander (Ornstein-Uhlenbeck, ~4 s memory) plus a settle: the club logs' rest level
    // sinks to about half over the first ~10 s as the band beds in (elbow 28 -> 4..16, grip 14 -> 3..5).
    this.wSd = 0.5 * this.sd + 0.2 * m.rest_level;
    this.wTau = 4 * o.rateHz;
    const sh = shapeOf(o.model);
    this.sh = sh;
    this.settle = sh.settle;
    this.settleTau = sh.settle_s * o.rateHz;
    this.w = new Array(C).fill(0);
    this.pos = new Array(C).fill(0);
    this.posName = 'down';
    this.reps = {};
    this.g = null; // gesture burst
    this.a = null; // arm (elbow_bend) burst
    this.last = undefined;
    this.bursts = [];
    // Per-channel weights per pattern. No placement: the channel-number PATTERNS (1 channel = the
    // club spot, weight 1). A misplaced channel without a site swaps its fist / wrist-back rows.
    const mis = new Set(plan.filter((e) => e.type === 'misplace').map((e) => e.channel));
    this.loose = plan.filter((e) => e.type === 'loose');
    this.wt = {};
    for (const k of Object.keys(PATTERNS)) this.wt[k] = Array.from({ length: C }, (_, c) => (C === 1 ? 1 : PATTERNS[k][c]));
    for (let c = 0; c < C; c++) {
      const sw = o.placement ? siteWeights(placementEntry(o.placement, c), { misplaced: mis.has(c) }) : null;
      if (sw) { this.wt.grip[c] = sw.grip; this.wt.open[c] = sw.open; this.wt.arm[c] = sw.arm; }
      else if (mis.has(c)) [this.wt.grip[c], this.wt.open[c]] = [this.wt.open[c], this.wt.grip[c]];
    }
  }

  weight(pattern, c) { return this.wt[pattern][c]; }

  armWeight(c, i) {
    let w = this.wt.arm[c];
    for (const e of this.loose) if (e.channel === c && i >= e.start && i < e.end) w *= SITE_RESPONSE.looseElbow;
    return w;
  }

  newBurst(kind, i, label) {
    const K = KINDS[kind];
    const m = this.o.model.tasks[K.task];
    const rep = K.noFade ? 0 : (this.reps[kind] = (this.reps[kind] ?? -1) + 1);
    const mean = m.peak_mean * K.scale * Math.pow(m.fade_per_rep, rep);
    const b = {
      kind, label, start: i, pattern: K.pattern, t: 0, active: true, act: 0, from: 0, wob: 0,
      amp: Math.max(5, this.r.normal(mean, m.peak_sd * 0.35)),
      rise: Math.max(2, m.rise * this.k * (0.8 + 0.4 * this.r.next())),
      tau: Math.max(2, m.decay * this.k * (0.8 + 0.4 * this.r.next())),
      bumps: [],
      // Holds sag (the hand tires within one squeeze) and wobble slowly; the squeeze log's long
      // holds lose ~40% over 1.5 s and ripple +-15% (v3). Per task, falling back to the shared shape.
      sag: (m.sag_per_s ?? this.sh.sag_per_s) / this.o.rateHz,
      wobSd: m.wobble ?? this.sh.wobble,
      wobTw: Math.max(1, (m.wobble_s ?? this.sh.wobble_s) * this.o.rateHz),
    };
    // Secondary bumps on the hold: real grips re-squeeze a little.
    const nb = this.r.int(0, 2);
    for (let j = 0; j < nb; j++) b.bumps.push({ at: b.rise + this.r.next() * 40 * this.k, w: (3 + 5 * this.r.next()) * this.k, h: 0.05 + 0.1 * this.r.next() });
    this.bursts.push(b);
    return b;
  }

  advance(b) {
    if (!b) return 0;
    if (b.active) {
      b.t++;
      if (b.t < b.rise) b.act = b.from + (1 - b.from) * smooth(b.t / b.rise);
      else {
        const tw = b.wobTw;
        b.wob += -b.wob / tw + this.r.normal(0, b.wobSd * Math.sqrt(2 / tw));
        let bump = 0;
        for (const p of b.bumps) bump += p.h * Math.exp(-(((b.t - p.at) / p.w) ** 2));
        b.act = (1 + b.wob + bump) * Math.exp(-b.sag * (b.t - b.rise));
      }
    } else {
      // Release: a fast drop plus a small slow tail. v2 used a 30% tail at tau x3, read off the
      // squeeze log, but that log's "tail" is the next hold sagging; real grips and elbow bends
      // fall back to rest between reps (v3: grip p10/p50 and the elbow gap were off because of it).
      const tail = this.sh.release_tail;
      if (b.fast == null) { b.fast = (1 - tail) * b.act; b.slow = tail * b.act; }
      b.fast *= Math.exp(-1 / (this.sh.fast_x * b.tau));
      b.slow *= Math.exp(-1 / (this.sh.tail_x * b.tau));
      b.act = b.fast + b.slow;
    }
    return b.act;
  }

  step(label, i) {
    if (label !== this.last) {
      const kind = kindOf(label);
      const arm = kind === 'elbow';
      if (this.g) this.g.active = false; // any label change ends the hold; the burst decays
      if (this.a && !arm) this.a.active = false;
      if (kind && !arm) { const from = this.g ? this.g.act : 0; this.g = this.newBurst(kind, i, label); this.g.from = clamp(from, 0, 1); }
      if (arm) { this.a = this.newBurst('elbow', i, label); }
      const p = positionOf(label);
      if (p || !kind) this.posName = p || 'down';
      this.last = label;
    }
    const ga = this.advance(this.g);
    const aa = this.advance(this.a);
    const k = 1 - Math.exp(-1 / (0.4 * this.o.rateHz));
    const out = new Array(this.o.channels);
    for (let c = 0; c < this.o.channels; c++) {
      this.w[c] += -this.w[c] / this.wTau + this.r.normal(0, this.wSd * Math.sqrt(2 / this.wTau));
      this.pos[c] += (POSITION_OFFSET[this.posName][c] - this.pos[c]) * k;
      this.nz[c] = this.phi * this.nz[c] + this.r.normal(0, this.sd * Math.sqrt(1 - this.phi * this.phi));
      const settle = 1 - this.settle * (1 - Math.exp(-i / this.settleTau));
      let v = this.rest[c] * settle + this.w[c] + this.pos[c] + this.nz[c];
      if (this.g) v += this.g.amp * ga * this.weight(this.g.pattern, c);
      if (this.a) v += this.a.amp * aa * this.armWeight(c, i);
      // A healthy sensor never reads exactly 0 for long; without a floor the settle + wander
      // clipped quiet channels to 0 and the clean twin raised dropout alarms (2 of 10 sessions).
      // The floor is soft (a divider's offset plus its noise, about 2-4 counts): a hard clamp at 1
      // left quiet channels flat, with no noise for a neighbour to leak into (crosstalk invisible).
      out[c] = v > FLOOR_KNEE ? v : 2 + (FLOOR_KNEE - 2) * Math.exp((v - FLOOR_KNEE) / (FLOOR_KNEE - 2));
    }
    return out;
  }
}

function parseFaultSpec(f) {
  if (typeof f === 'object' && f) return { count: 1, ...f };
  const [type, n] = String(f).split(':');
  return { type: type.trim(), count: n ? Number(n) : 1 };
}

const lineBytes = (C) => 6 + 5 * C + 2; // "12345,1023,...\r\n" worst case at 4 digits

// Decide where and how each fault happens (device sample indices). Pure given the RNG.
export function planFaults(specs, { n, channels, rateHz, safeStart = 0, baud = 9600, humHz = 50, model = TWIN_MODEL }, r) {
  const plan = [];
  const skipped = [];
  const k = rateHz / MODEL_RATE;
  const s = (sec) => Math.round(sec * rateHz);
  const lo = Math.min(safeStart, n - 1);
  const at = (len) => r.int(lo, Math.max(lo, n - len - s(0.5)));
  const ch = (spec) => (spec.channel != null ? spec.channel : r.int(0, channels - 1));
  for (const raw of specs.map(parseFaultSpec)) {
    if (!FAULT_TYPES.includes(raw.type) && !PLACEMENT_FAULTS.includes(raw.type)) throw new Error(`unknown fault: ${raw.type}`);
    for (let j = 0; j < (raw.count || 1); j++) {
      const { type } = raw;
      const e = { type, channel: null };
      if (type === 'misplace') {
        // Whole session: the sensor's real site is opposite its entry, so it answers the other
        // movement (a palm entry rises on wrist back). The line itself is clean.
        Object.assign(e, { channel: ch(raw), start: 0, end: n });
      } else if (type === 'dropout') {
        const len = Math.max(5, Math.round(r.normal(model.faults.dropout_len_median, 5) * k));
        Object.assign(e, { channel: ch(raw), start: raw.start ?? at(len + s(1)), len, spikePeak: Math.round(model.faults.spike_after_dropout_peak * (0.85 + 0.15 * r.next())), spikeTau: model.faults.spike_decay * k });
        e.end = e.start + len;
      } else if (type === 'loose') {
        const len = s(4);
        Object.assign(e, { channel: ch(raw), start: raw.start ?? at(len), events: [] });
        e.end = e.start + len;
        for (let t = e.start + s(0.1); t < e.end - s(0.2); t += s(0.25 + 0.55 * r.next())) {
          e.events.push({ at: t, len: Math.max(1, Math.round((2 + 10 * r.next()) * k)), kick: Math.round(80 + 320 * r.next()) });
        }
      } else if (type === 'saturation') {
        const len = raw.len ?? Math.round((n - lo) * 0.6);
        Object.assign(e, { channel: ch(raw), start: raw.start ?? at(len), gain: raw.gain ?? 8 + 4 * r.next() }); // over-tight band / gain pot: every grip pins at 1023
        e.end = Math.min(n, e.start + len);
      } else if (type === 'floating') {
        const len = s(3 + 3 * r.next());
        Object.assign(e, { channel: ch(raw), start: raw.start ?? at(len), stepSd: 12 / Math.sqrt(k), centre: 300 + 300 * r.next() });
        e.end = e.start + len;
      } else if (type === 'shift') {
        // Band slides or loosens after calibration: offset up, gain down, ramped then held.
        Object.assign(e, { channel: ch(raw), start: raw.start ?? lo + s(1), end: n, offset: Math.round(raw.offset ?? 60 + 80 * r.next()), gain: raw.gain ?? 0.5 + 0.2 * r.next() });
        e.ramp = Math.max(1, Math.round((e.end - e.start) * 0.3));
      } else if (type === 'hum') {
        // At 100 Hz a 50 Hz hum aliases to a constant; it is only visible at >= 500 Hz.
        if (rateHz < 500) { skipped.push({ type, reason: `mains hum needs rate >= 500 Hz (got ${rateHz})` }); continue; }
        Object.assign(e, { channel: ch(raw), start: raw.start ?? lo, end: n, amp: raw.amp ?? 15 + 25 * r.next(), hz: humHz, phase: r.next() * 2 * Math.PI });
      } else if (type === 'jitter') {
        Object.assign(e, { start: 0, end: n, sdMs: raw.sdMs ?? 0.35 * (1000 / rateHz) });
      } else if (type === 'missing') {
        const len = raw.len ?? Math.round((3 + 22 * r.next()) * k);
        Object.assign(e, { start: raw.start ?? at(len), len });
        e.end = e.start + len;
      } else if (type === 'boot') {
        Object.assign(e, { start: 0, end: 1 });
      } else if (type === 'slowlink') {
        const b = raw.baud ?? baud;
        const bytes = lineBytes(channels);
        const capacityHz = b / 10 / bytes;
        if (capacityHz >= rateHz) { skipped.push({ type, reason: `${b} baud carries ${capacityHz.toFixed(0)} lines/s >= ${rateHz} Hz` }); continue; }
        Object.assign(e, { start: 0, end: n, baud: b, bytesPerLine: bytes, capacityHz: Math.round(capacityHz * 10) / 10, requestedHz: rateHz });
      } else if (type === 'brownout') {
        const gap = raw.gap ?? s(0.3 + 0.5 * r.next());
        Object.assign(e, { start: raw.start ?? at(gap + s(1)), gap, bootMs: r.int(0, 5) });
        e.end = e.start + gap;
      } else if (type === 'creep') {
        // FSR creep: under a steady squeeze the resistance keeps falling, so the reading keeps
        // rising. Only steps held >= 1 s count (short grips are taps). `holds` fills in as the
        // session is generated (needs the step context; the live TwinSource passes it too, card L1b).
        // From sample 0: creep is the sensor, not an event, so the calibration squeezes show it too.
        Object.assign(e, { channel: ch(raw), start: raw.start ?? 0, end: n, gain: raw.gain ?? 0.4 + 0.3 * r.next(), minLen: s(1), holds: [] });
      } else if (type === 'crosstalk') {
        if (channels < 2) { skipped.push({ type, reason: 'crosstalk needs 2+ channels' }); continue; }
        Object.assign(e, { channel: raw.channel ?? r.int(1, channels - 1), start: 0, end: n, leak: raw.leak ?? 0.08 + 0.12 * r.next() });
        e.from = e.channel - 1;
      }
      plan.push(e);
    }
  }
  return { plan, skipped };
}

// Applies the plan sample by sample. Keeps the per-fault state (random walk, timing credit).
class FaultLine {
  constructor(plan, o, r) {
    this.plan = plan;
    this.o = o;
    this.r = r;
    this.walk = new Map();
    this.credit = 0;
    // Live TwinSource repeats the plan each minute (i wraps); after the first lap the lasting
    // faults (shift, creep) stay on, so a slid band does not jump back. generate() never sets it.
    this.lap = 0;
    this.lastT = -Infinity;
    this.tShift = 0;
    this.slow = plan.find((e) => e.type === 'slowlink');
    this.jit = plan.find((e) => e.type === 'jitter');
  }

  // ctx (optional) = { label, j, len }: the prompted step and the position in it (creep needs it).
  values(i, v, ctx = null) {
    const out = v.slice();
    const prev = this.prevIn ?? v;
    this.prevIn = v;
    for (const e of this.plan) {
      const c = e.channel;
      // ADC settling error: the sample-and-hold still carries part of the previous channel's
      // voltage, so channel c reads leak * (neighbour - itself) too much; visible when the
      // neighbour is high and this channel is not.
      if (e.type === 'crosstalk') out[c] += e.leak * (v[e.from] - v[c]);
      else if (e.type === 'shift' && (i >= e.start || this.lap)) {
        const f = this.lap ? 1 : Math.min(1, (i - e.start) / e.ramp);
        out[c] = out[c] * (1 + (e.gain - 1) * f) + e.offset * f;
      } else if (e.type === 'creep' && (i >= e.start || this.lap) && ctx && ctx.len >= e.minLen && HOLD_RE.test(ctx.label)) {
        // The rise above the level just before the squeeze grows linearly to (1 + gain) by the end.
        if (ctx.j === 0 || !this.walk.has(e)) { this.walk.set(e, prev[c]); e.holds.push({ label: ctx.label, start: i, end: i - ctx.j + ctx.len }); }
        out[c] += e.gain * (ctx.j / ctx.len) * Math.max(0, out[c] - this.walk.get(e));
      } else if (e.type === 'saturation' && i >= e.start && i < e.end) out[c] *= e.gain;
      else if (e.type === 'hum' && i >= e.start) out[c] += e.amp * Math.sin(2 * Math.PI * e.hz * (i / this.o.rateHz) + e.phase);
    }
    for (const e of this.plan) {
      const c = e.channel;
      if (e.type === 'floating' && i >= e.start && i < e.end) {
        let w = this.walk.get(e) ?? out[c];
        w += (e.centre - w) * 0.002 + this.r.normal(0, e.stepSd);
        w = clamp(w, 0, 1023);
        this.walk.set(e, w);
        out[c] = w;
      } else if (e.type === 'dropout') {
        if (i >= e.start && i < e.end) out[c] = 0;
        else if (i >= e.end && i < e.end + 5 * e.spikeTau) out[c] += e.spikePeak * Math.exp(-(i - e.end) / e.spikeTau);
      } else if (e.type === 'loose' && i >= e.start && i < e.end + 40) {
        for (const ev of e.events) {
          if (i >= ev.at && i < ev.at + ev.len) out[c] = 0;
          else if (i >= ev.at + ev.len && i < ev.at + ev.len + 30) out[c] += ev.kick * Math.exp(-(i - ev.at - ev.len) / 6);
        }
      }
    }
    return out.map((x) => clamp(Math.round(x), 0, 1023));
  }

  // Device timestamp and whether the sample reaches the PC; pre = extra lines first.
  timing(i) {
    const rate = this.o.rateHz;
    let t = (i * 1000) / rate;
    const pre = [];
    let skip = false;
    for (const e of this.plan) {
      if (e.type === 'missing' && i >= e.start && i < e.end) skip = true;
      if (e.type === 'brownout') {
        if (i >= e.start && i < e.end) skip = true;
        if (i === e.end) { pre.push({ kind: 'junk' }, { kind: 'header' }); this.tShift = (i * 1000) / rate - e.bootMs; this.lastT = -Infinity; }
      }
      if (e.type === 'boot' && i === 0) pre.push({ kind: 'boot' });
    }
    if (this.slow) {
      // The sketch blocks in Serial.print once the 64-byte TX buffer is full, so only
      // capacityHz lines per second leave the board; the rest are never sampled/sent.
      this.credit += this.slow.capacityHz / rate;
      if (this.credit >= 1) this.credit -= 1;
      else skip = true;
    }
    t -= this.tShift;
    if (this.jit) t += this.r.normal(0, this.jit.sdMs);
    t = Math.max(Math.round(t), this.lastT === -Infinity ? 0 : this.lastT);
    if (!skip) this.lastT = t;
    return { t, skip, pre };
  }
}

function buildPlan(o) {
  const out = [];
  const k = o.rateHz / MODEL_RATE;
  const s = (sec) => Math.round(sec * o.rateHz);
  const push = (label, len) => out.push({ label, len: Math.max(1, Math.round(len)) });
  if (o.gesture === 'check') return checkPlan(o, s, push, out);
  const mainKind = o.gesture === 'rest' ? null : (o.gesture === 'elbow' ? 'elbow' : o.gesture);
  const m = o.model.tasks[mainKind ? KINDS[mainKind].task : 'grip'];
  const rv = o._r;
  push('rest', s(1));
  let calEnd = 0;
  if (o.calibration) {
    push('cal_rest', s(3)); push('rest', s(1));
    push('cal_squeeze', s(1.5)); push('rest', s(1.5));
    push('cal_squeeze', s(1.5)); push('rest', s(1.5));
    calEnd = out.reduce((a, b) => a + b.len, 0);
  }
  // Hold = rise + the part of the learned 50%-width that is not rise or decay.
  // hold_len / rep_gap (samples at 100 Hz) when the task's learned width/gap describe ripples
  // inside long holds rather than separate reps (the squeeze log, v3).
  const hold = o.holdS != null ? s(o.holdS) : m.hold_len != null ? m.hold_len * k : (m.rise + Math.max(4, m.width - m.rise / 2 - 0.69 * m.decay)) * k;
  const gap = o.gapS != null ? s(o.gapS) : (m.rep_gap ?? m.gap) * k; // gapS: a prompted protocol's hold + rest
  const distractAt = new Set();
  for (let d = 0; d < o.distractors; d++) distractAt.add(Math.floor(((d + 1) * o.reps) / (o.distractors + 1)));
  for (let rep = 0; rep < o.reps; rep++) {
    const pos = o.positions[rep % o.positions.length];
    const suffix = pos === 'down' ? '' : `@${pos}`;
    const restLabel = `rest${suffix}`;
    const lead = gap * (rep === 0 ? 0.6 : 1) - hold + rv.normal(0, gap * 0.1);
    push(restLabel, Math.max(s(0.3), lead));
    push(mainKind ? (o.gesture === 'elbow' ? 'elbow_bend' : `${o.gesture}${suffix}`) : restLabel, hold);
    if (distractAt.has(rep)) {
      const em = o.model.tasks.elbow;
      push(restLabel, gap * 0.5);
      push('elbow_bend', (em.rise + 6) * k);
    }
  }
  push('rest', Math.max(s(1.5), gap));
  return { segs: out, calEnd };
}

// The placement check (placement.js CHECK_STEPS), labelled with the step ids so checkPlacement
// reads the steps straight from the labels. Relax is 3 s: the slow release tail (~30% of a
// burst, tau ~1.3 s) would otherwise lift the relax baseline the check measures from.
function checkPlan(o, s, push, out) {
  push('relax', s(1));
  let calEnd = 0;
  if (o.calibration) {
    push('cal_rest', s(3)); push('relax', s(1.5));
    push('cal_squeeze', s(1.5)); push('relax', s(3));
    calEnd = out.reduce((a, b) => a + b.len, 0);
  }
  const hold = s(o.holdS ?? 2);
  for (let rep = 0; rep < o.reps; rep++) {
    for (const step of ['fist', 'wrist_back', 'elbow_bend']) { push('relax', s(3)); push(step, hold); }
  }
  push('relax', s(3));
  return { segs: out, calEnd };
}

function normOpts(opts = {}) {
  const o = {
    seed: 1, rateHz: 100, channels: 6, gesture: 'grip', positions: ['down'], reps: null, calibration: true,
    distractors: null, faults: [], holdS: null, model: TWIN_MODEL, baud: 9600, humHz: 50, ...opts,
  };
  o.channels = clamp(Math.round(o.channels), 1, 8);
  if (!GESTURES.includes(o.gesture)) o.gesture = 'grip';
  if (typeof o.positions === 'string') o.positions = [o.positions];
  o.positions = o.positions.filter((p) => POSITIONS.includes(p));
  if (!o.positions.length) o.positions = ['down'];
  const task = o.gesture === 'rest' || o.gesture === 'open' || o.gesture === 'check' ? 'grip' : o.gesture;
  o.restTask = task;
  if (o.gesture === 'check') {
    // A check is short and comes before calibration; its elbow step replaces the distractor.
    if (opts.calibration == null) o.calibration = false;
    if (o.reps == null) o.reps = 2;
    o.distractors = 0;
  }
  if (o.reps == null) o.reps = Math.max(3, repsOf(o.model.tasks[task]));
  if (o.distractors == null) o.distractors = o.channels > 1 && o.gesture !== 'elbow' ? 1 : 0;
  return o;
}

export function generate(opts = {}) {
  const o = normOpts(opts);
  const r = rng(o.seed);
  o._r = r;
  const { segs, calEnd } = buildPlan(o);
  delete o._r;
  const n = segs.reduce((a, b) => a + b.len, 0);
  const { plan, skipped } = planFaults(o.faults, { n, channels: o.channels, rateHz: o.rateHz, safeStart: calEnd, baud: o.baud, humHz: o.humHz, model: o.model }, rng(o.seed * 7919 + 13));
  const body = new Body(o, r, plan);
  const fl = new FaultLine(plan, o, rng(o.seed * 104729 + 7));
  const S = { synthetic: true, rateHz: o.rateHz, channels: o.channels, channelNames: Array.from({ length: o.channels }, (_, c) => `ch${c + 1}`), n: 0, t: [], hostMs: [], data: Array.from({ length: o.channels }, () => []), labels: [], events: [] };
  const outIdx = new Int32Array(n + 1);
  const dev = [];
  // Reaction lag (opt-in): the body keeps doing the previous step for a while after each prompt,
  // as people do. Its own rng, so sessions without reactionMs are sample-for-sample unchanged.
  const lags = reactionLags(opts.reactionMs, segs, o);
  const reactions = [];
  let i = 0;
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    const lag = lags ? lags[s] : 0;
    if (lags && s > 0) reactions.push({ label: seg.label, index: i, onset: i + lag, lagMs: Math.round((lag * 1000) / o.rateHz) });
    for (let j = 0; j < seg.len; j++, i++) {
      outIdx[i] = S.t.length;
      const vals = fl.values(i, body.step(j < lag ? segs[s - 1].label : seg.label, i), { label: seg.label, j, len: seg.len });
      const tm = fl.timing(i);
      if (tm.skip) continue;
      for (const p of tm.pre) S.events.push({ index: S.t.length, kind: p.kind === 'boot' ? 'junk' : p.kind, text: p.kind === 'header' ? null : junkText(r, p.kind === 'boot') });
      S.t.push(tm.t);
      dev.push(i);
      for (let c = 0; c < o.channels; c++) S.data[c].push(vals[c]);
      S.labels.push(seg.label);
    }
  }
  outIdx[n] = S.t.length;
  S.n = S.t.length;
  S.hostMs = arrivals(dev, o.rateHz, plan.find((e) => e.type === 'slowlink'));
  const map = (x) => outIdx[clamp(x, 0, n)];
  const faults = plan.map((e) => {
    const f = { ...e, start: map(e.start), end: map(e.end) };
    if (e.events) f.events = e.events.map((ev) => ({ ...ev, at: map(ev.at) }));
    if (e.holds) { f.holds = e.holds.map((h) => ({ ...h, start: map(h.start), end: map(h.end) })); if (f.holds.length) f.start = f.holds[0].start; }
    if (e.type === 'missing' || e.type === 'brownout') { f.deviceStart = e.start; f.end = f.start; }
    if (e.type === 'slowlink') f.dropped = n - S.n;
    return f;
  });
  const bursts = body.bursts.map((b) => ({ label: b.label, start: map(b.start), amp: Math.round(b.amp * 10) / 10 }));
  const pub = { ...o };
  delete pub.model;
  S.truth = { synthetic: true, note: SYNTHETIC_NOTE, seed: o.seed, opts: pub, faults, skipped, bursts };
  if (lags) S.truth.reactions = reactions.map((x) => ({ ...x, index: map(x.index), onset: map(x.onset) }));
  return S;
}

// Per-step reaction lag in samples (null when off). reactionMs: ms or [lo, hi] (uniform per step).
// The first step has no prompt change before it; a lag never eats a whole step (len - 1 at most).
function reactionLags(reactionMs, segs, o) {
  if (reactionMs == null || reactionMs === 0) return null;
  const [lo, hi] = Array.isArray(reactionMs) ? reactionMs : [reactionMs, reactionMs];
  const r = rng(o.seed * 15485863 + 101);
  return segs.map((seg, s) => (s === 0 ? 0 : Math.min(seg.len - 1, Math.max(0, Math.round(((lo + (hi - lo) * r.next()) * o.rateHz) / 1000)))));
}

// The Uno's reset/bootloader noise; the boot form ends in a printable letter like the club logs ("  f14").
function junkText(r, boot) {
  const b = bootJunk(r.next);
  let s = String.fromCharCode(...b);
  if (boot) s += r.pick(['f', 'x', '~', '']);
  return s;
}

// Host arrival times: USB-serial bridges flush about every 16 ms, so lines come in bunches; on a
// slow link each line also waits for the bytes before it to leave at the baud rate.
function arrivals(dev, rateHz, slow) {
  const out = new Array(dev.length);
  let wire = 0;
  for (let i = 0; i < dev.length; i++) {
    // Host time follows the real clock (device sample index), not the device's millis(),
    // which restarts after a brown-out.
    let done = (dev[i] * 1000) / rateHz;
    if (slow) { wire = Math.max(wire, done) + (slow.bytesPerLine * 10 * 1000) / slow.baud; done = wire; }
    out[i] = Math.ceil(done / 16) * 16 + 2;
  }
  return out;
}

function headerLines(S, format) {
  const o = S.truth?.opts || {};
  const faults = (S.truth?.faults || []).map((f) => f.type).join('+') || 'none';
  const lines = [`# synthetic=true source=twin model=twin-model.json seed=${o.seed ?? ''} gesture=${o.gesture ?? ''} faults=${faults} note=testing-and-demos-only-never-evidence-of-accuracy`];
  if (format === 'nxt') lines.push(...deviceHeader(S));
  return lines;
}

const deviceHeader = (S) => [`# nxt_logger v1 channels=${S.channels} rate_hz=${S.rateHz} source=twin synthetic=true`, ['t_ms', ...S.channelNames, 'label'].join(',')];

export function toLines(S, format = 'nxt', opts = {}) {
  const { header = true, channel = 0, labels = true } = opts;
  const delim = { tsv: '\t', space: ' ' }[format] || ',';
  const row = (i) => {
    const v = S.data.map((ch) => ch[i]);
    switch (format) {
      case 'nxt': return [S.t[i], ...v, ...(labels ? [S.labels[i] || 'rest'] : [])].join(',');
      case 'timed': return [S.t[i], ...v].join(',');
      case 'delimited': case 'tsv': case 'space': return v.join(delim);
      case 'single': return String(v[channel] ?? v[0]);
      case 'plotter': return S.channelNames.map((nm, c) => `${nm}:${v[c]}`).join(' ');
      default: throw new Error(`unknown format: ${format}`);
    }
  };
  const out = header ? headerLines(S, format) : [];
  const ev = new Map();
  for (const e of S.events) (ev.get(e.index) || ev.set(e.index, []).get(e.index)).push(e);
  for (let i = 0; i < S.n; i++) {
    let glue = '';
    for (const e of ev.get(i) || []) {
      if (e.kind === 'header') { if (format === 'nxt') out.push(...deviceHeader(S)); }
      else if (i === 0) glue += e.text; // boot junk sticks to the first print, as in the club logs
      else out.push(e.text);
    }
    out.push(glue + row(i));
  }
  return out;
}

// ---------- live source ----------

// Streams the twin like FakeSource. With a labelProvider the label drives the bursts live; without
// one a built-in 60 s demo schedule plays. Faults are planned per 60 s and repeat each minute.
export class TwinSource {
  constructor(opts = {}) {
    this.channels = clamp(opts.channels ?? 6, 1, 8);
    this.rateHz = opts.rateHz ?? 100;
    this.seed = opts.seed ?? 1;
    this.labelProvider = opts.labelProvider ?? null;
    this.speed = opts.speed ?? 1;
    this.faults = opts.faults ?? [];
    this.gesture = opts.gesture ?? 'grip';
    this.now = opts.now ?? (() => (globalThis.performance ? performance.now() : Date.now()));
    this.kind = 'twin';
    this._reset();
  }

  _reset() {
    const o = normOpts({ seed: this.seed, rateHz: this.rateHz, channels: this.channels, gesture: this.gesture, calibration: false, faults: [] });
    this.o = o;
    this.period = 60 * this.rateHz;
    this.r = rng(this.seed);
    o._r = this.r;
    this.schedule = buildPlan({ ...o, reps: 20 }).segs; // demo loop when no labelProvider
    delete o._r;
    const { plan } = planFaults(this.faults, { n: this.period, channels: this.channels, rateHz: this.rateHz, safeStart: this.rateHz * 2 }, rng(this.seed * 7919 + 13));
    this.plan = plan;
    this.body = new Body(o, this.r);
    this.fl = new FaultLine(plan, o, rng(this.seed * 104729 + 7));
    this.i = 0;
    this.seg = 0;
    this.segLeft = this.schedule[0].len;
    this.queue = [];
    this.stepLabel = null;
    this.stepJ = 0;
  }

  header() { return `# nxt_logger v1 channels=${this.channels} rate_hz=${this.rateHz} source=twin synthetic=true`; }

  _label() {
    if (this.labelProvider) return String(this.labelProvider() || 'rest');
    while (this.segLeft <= 0) { this.seg = (this.seg + 1) % this.schedule.length; this.segLeft = this.schedule[this.seg].len; }
    this.segLeft--;
    return this.schedule[this.seg].label;
  }

  // Next line (may be a junk or header line after a simulated reset). Missing / slow-link
  // samples are consumed silently, so the device clock keeps running.
  nextLine() {
    while (!this.queue.length) {
      const label = this._label();
      // Step info for the creep fault: position in the current label run; the length is the
      // schedule's, or (labelProvider: the prompt's length is unknown here) at least 2 s, the
      // protocol's default hold, growing if the step runs on.
      if (label !== this.stepLabel) { this.stepLabel = label; this.stepJ = 0; }
      const len = this.labelProvider ? Math.max(this.stepJ + 1, 2 * this.rateHz) : this.schedule[this.seg].len;
      this.fl.lap = this.i >= this.period ? 1 : 0;
      const vals = this.fl.values(this.i % this.period, this.body.step(label, this.i), { label, j: this.stepJ++, len });
      const tm = this.fl.timing(this.i % this.period);
      // Each minute repeats the fault plan; the clock must still move forward.
      const t = tm.t + Math.floor(this.i / this.period) * 60000;
      this.i++;
      if (tm.skip) continue;
      for (const p of tm.pre) this.queue.push(p.kind === 'header' ? this.header() : junkText(this.r, false));
      this.queue.push(`${t},${vals.join(',')}`);
    }
    return this.queue.shift();
  }

  generateLines(seconds) {
    this._reset();
    const out = [this.header()];
    const target = Math.round(seconds * this.rateHz);
    while (this.i < target) out.push(this.nextLine());
    return out;
  }

  async start(handlers) {
    this.handlers = handlers;
    this._reset();
    handlers.onStatus?.('connected', { baud: null, fake: true, twin: true });
    handlers.onLine(this.header(), this.now());
    const t0 = this.now();
    this.timer = setInterval(() => {
      const due = Math.floor(((this.now() - t0) / 1000) * this.rateHz * this.speed);
      const t = this.now();
      while (this.i < due) handlers.onLine(this.nextLine(), t);
    }, 20);
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.handlers?.onStatus?.('stopped', {});
  }
}

// ---------- realism score ----------

export const STAT_KEYS = ['p10', 'p50', 'p90', 'p99', 'restLevel', 'restNoise', 'burstHeight', 'width', 'rise', 'decay', 'gap', 'fade', 'dropoutsPer1000'];

const pctl = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] : NaN);
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };

// Same measures the prototype learned the model with (synth_prototype.py), applied identically
// to real and twin data. Dropout zeros and the 60 samples after them are cut before shape stats.
export function summarize(values) {
  const x = values.filter(Number.isFinite);
  let zeroRuns = 0;
  const bad = new Uint8Array(x.length);
  for (let i = 0; i < x.length;) {
    if (x[i] !== 0) { i++; continue; }
    let j = i;
    while (j < x.length && x[j] === 0) j++;
    if (j - i >= 3) { zeroRuns++; bad.fill(1, i, Math.min(x.length, j + 60)); }
    i = j;
  }
  const clean = x.filter((_, i) => !bad[i]);
  const sorted = clean.slice().sort((a, b) => a - b);
  const head = clean.slice(0, Math.max(20, Math.floor(clean.length / 20)));
  const base = med(head);
  const p95 = pctl(sorted, 0.95);
  const thr = base + 0.5 * (p95 - base);
  const bs = [];
  for (let i = 1; i < clean.length; i++) {
    if (clean[i - 1] <= thr && clean[i] > thr) {
      let e = i;
      while (e < clean.length && clean[e] > thr) e++;
      if (e < clean.length) bs.push([i, e]);
    }
  }
  const peaks = []; const rises = []; const falls = []; const widths = [];
  for (const [s, e] of bs) {
    const seg = clean.slice(Math.max(0, s - 40), Math.min(clean.length, e + 80));
    let p = 0;
    for (let j = 1; j < seg.length; j++) if (seg[j] > seg[p]) p = j;
    const pk = seg[p] - base;
    peaks.push(pk);
    let r = -1;
    for (let j = 0; j < p; j++) if (seg[j] < base + 0.1 * pk) r = j;
    rises.push(p - (r < 0 ? 0 : r));
    let f = -1;
    for (let j = p; j < seg.length; j++) if (seg[j] < base + 0.37 * pk) { f = j - p; break; }
    falls.push(f < 0 ? 40 : f);
    widths.push(e - s);
  }
  const starts = bs.map((b) => b[0]);
  const gaps = starts.slice(1).map((s, j) => s - starts[j]);
  const rest = clean.filter((v) => v < base + 0.1 * (p95 - base));
  const d = rest.slice(1).map((v, j) => v - rest[j]);
  const dm = d.reduce((a, b) => a + b, 0) / (d.length || 1);
  return {
    p10: pctl(sorted, 0.1), p50: pctl(sorted, 0.5), p90: pctl(sorted, 0.9), p99: pctl(sorted, 0.99),
    restLevel: med(rest), restNoise: Math.sqrt(d.reduce((a, b) => a + (b - dm) ** 2, 0) / (d.length || 1)),
    burstHeight: med(peaks), width: med(widths), rise: med(rises), decay: med(falls),
    gap: gaps.length ? med(gaps) : NaN,
    fade: peaks.length > 1 ? Math.pow(peaks[peaks.length - 1] / peaks[0], 1 / (peaks.length - 1)) : NaN,
    dropoutsPer1000: (1000 * zeroRuns) / (x.length || 1), bursts: bs.length,
  };
}

// Allowed band around the real values: relative tolerance plus an absolute floor (ADC counts or
// samples), because one or two club logs per task cannot give a real spread.
const TOL = { p10: [0.35, 3], p50: [0.35, 3], p90: [0.35, 5], p99: [0.35, 10], restLevel: [0.3, 2], restNoise: [0.5, 0.5], burstHeight: [0.35, 5], width: [0.5, 4], rise: [0.4, 4], decay: [0.4, 6], gap: [0.25, 10], fade: [0.12, 0.05], dropoutsPer1000: [0.5, 0.6] };

export function realismScore(realByTask, { seeds = [1, 2, 3, 4, 5], model = TWIN_MODEL } = {}) {
  const tasks = {};
  let within = 0;
  let total = 0;
  for (const [task, logs] of Object.entries(realByTask)) {
    const real = logs.map(summarize);
    const twin = seeds.map((seed) => {
      const m = model.tasks[task];
      const n = logs[0].length;
      const faults = task === 'elbow' ? [`dropout:${Math.max(1, Math.round((model.faults.dropouts_per_1000 * n) / 1000))}`] : [];
      const S = generate({ seed, gesture: task, channels: 1, calibration: false, distractors: 0, reps: repsOf(m), faults, model });
      return summarize(S.data[0]);
    });
    const stats = {};
    for (const key of STAT_KEYS) {
      const rv = real.map((s) => s[key]).filter(Number.isFinite);
      const tv = med(twin.map((s) => s[key]).filter(Number.isFinite));
      if (!rv.length) continue;
      const [rel, abs] = TOL[key];
      const lo = Math.min(...rv) * (1 - rel) - abs;
      const hi = Math.max(...rv) * (1 + rel) + abs;
      const ok = Number.isFinite(tv) && tv >= lo && tv <= hi;
      stats[key] = { real: rv.map((v) => +v.toFixed(2)), twin: Number.isFinite(tv) ? +tv.toFixed(2) : null, range: [+lo.toFixed(2), +hi.toFixed(2)], within: ok };
      total++;
      if (ok) within++;
    }
    tasks[task] = stats;
  }
  return { tasks, within, total, score: total ? within / total : 0, note: SYNTHETIC_NOTE };
}

// ---------- detector scorecard ----------

// Which quality.js codes would count as "noticed" for each fault (null = no check exists).
export const EXPECTED_CODES = {
  dropout: ['dropout', 'spike'], loose: ['dropout', 'spike', 'noisy_rest'], saturation: ['saturation'],
  floating: ['noisy_rest'], shift: ['band_shift'], hum: ['noisy_rest'], jitter: null, missing: null,
  boot: null, slowlink: null, brownout: null, crosstalk: null,
};
const INFO_CODES = new Set(['ok', 'bursts', 'no_rate', 'no_labels']);

export function detectorScorecard({ parse, analyze, seeds = 10, types = FAULT_TYPES, channels = 6 } = {}) {
  const run = (opts) => {
    const S = generate({ channels, ...opts });
    const rec = parse(toLines(S, 'nxt').join('\n'));
    return { S, rec, rep: analyze(rec) };
  };
  const card = { note: SYNTHETIC_NOTE, sessions: seeds, types: {}, clean: { sessions: seeds, falseAlarms: {} } };
  for (let s = 1; s <= seeds; s++) {
    const { rep } = run({ seed: 1000 + s });
    for (const it of rep.items) if (!INFO_CODES.has(it.code) && it.level !== 'green') card.clean.falseAlarms[it.code] = (card.clean.falseAlarms[it.code] || 0) + 1;
  }
  for (const type of types) {
    const row = { expected: EXPECTED_CODES[type], hits: 0, misses: 0, skipped: 0, falseAlarms: 0, parseGarbage: 0, rateSeen: [] };
    for (let s = 1; s <= seeds; s++) {
      const { S, rec, rep } = run({ seed: s, faults: [type], rateHz: type === 'hum' ? 500 : 100 });
      const f = S.truth.faults.find((x) => x.type === type);
      if (!f) { row.skipped++; continue; }
      if (rec.stats?.garbageLines) row.parseGarbage++;
      if (rec.rateHz) row.rateSeen.push(Math.round(rec.rateHz));
      const exp = EXPECTED_CODES[type] || [];
      const hit = rep.items.some((it) => exp.includes(it.code) && (f.channel == null || it.channel == null || it.channel === f.channel));
      if (hit) row.hits++; else row.misses++;
      // A fault code on a channel the twin did not touch is a false alarm.
      row.falseAlarms += rep.items.filter((it) => !INFO_CODES.has(it.code) && it.level !== 'green' && f.channel != null && it.channel != null && it.channel !== f.channel && ['dropout', 'spike', 'saturation', 'noisy_rest', 'band_shift'].includes(it.code)).length;
    }
    row.rateSeen = row.rateSeen.length ? [Math.min(...row.rateSeen), Math.max(...row.rateSeen)] : null;
    card.types[type] = row;
  }
  return card;
}
