// export/common.js: shared prep for the dataset exports (segments, class maps, safe metadata). Pure.
//
// Contract
//   ExportError (extends Error; .problems: string[] in plain words)
//   prepare(recordings, opts) -> Prepared
//     recordings: a recording ({ t, data, labels, channelNames?, rateHz?, meta?, synthetic? }) or
//       { recording, meta } (meta overrides recording.meta), or an array of either.
//     opts: { includeCalibration = false }   cal_rest / cal_squeeze are fitting steps, not classes.
//     Prepared = { items: Item[], labels: string[] (first-appearance order), synthetic: bool }
//     Item = { rec, meta (safe), pid, run (1.. per person), rateHz, synthetic, names: string[],
//              segments: [{ label, start, end (exclusive), rep (1.. per person+label) }] }
//     Item.meta.placement_map: the placement object (placement.js) when the recording has one.
//     opts.align = false: true runs relabel.js on recordings that carry no aligned labels.
//     Item.aligned = null (prompt timing only) | { source: 'recording' | 'relabel', labels: string[]
//       per sample, steps: relabel() steps | null, segments: like Item.segments (same rep numbers)
//       but on the movement-aligned labels }. A recording carries its own as rec.alignedLabels
//       (string[], same length as labels); a wrong length is ignored (prompt timing is used).
//   movementSegments(item) -> item.aligned ? item.aligned.segments : item.segments
//     what LibEMG / Edge Impulse cut files on; stimulus columns and BIDS onsets stay on prompts.
//   labelTiming(item) -> 'movement-aligned (relabel)' | 'movement-aligned (recording)' | 'prompt'
//   isRest(label) -> true for 'rest' and 'rest@<position>'
//   safeMeta(meta) -> copy without name-like keys (name, first_name, volunteer, ...)
//   relTimes(rec, start, end, rateHz) -> ms[] from 0 for one segment (device clock if it runs
//     forwards inside the segment, else index / rate: the twin and real boards both reset)
//   fileSafe(s) -> s with anything but [A-Za-z0-9_-] turned into '_' ('grip@elbow90' -> 'grip_elbow90')
// Failure behaviour: throws ExportError when there is no recording, a person ID is missing or
//   looks like a name (csv.js validateMeta rules), or no labelled samples are left.
// Why one prep step: every format must agree on class numbers and repetition numbers, so a
// LibEMG rep 3 is the same movement as Ninapro repetition 3 and Edge Impulse grip.3.

import { validateMeta, APP_VERSION } from '../csv.js';
import { splitLabel } from '../protocol.js';
import { decodePlacementMap } from '../placement.js';
import { relabel } from '../relabel.js';

export { APP_VERSION };

export class ExportError extends Error {
  constructor(problems) {
    super(problems.join(' '));
    this.name = 'ExportError';
    this.problems = problems;
  }
}

export const isRest = (label) => splitLabel(label).gesture === 'rest';
const isCal = (label) => /^cal_/.test(String(label || ''));
export const fileSafe = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, '_');

// Keys that could carry a real name. The person is an ID only (privacy rule in README).
const NAME_KEY = /(^|_)(name|names|first|last|surname|full_?name|volunteer|participant_name|person_name|email|phone)$/i;
export function safeMeta(meta = {}) {
  const out = {};
  for (const [k, v] of Object.entries(meta)) if (!NAME_KEY.test(k) && v !== '' && v != null) out[k] = v;
  return out;
}

const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';
const isSynthetic = (rec, meta) => truthy(rec.synthetic) || truthy(rec.truth?.synthetic) || truthy(meta.synthetic) || meta.source === 'twin';

function rateOf(rec, meta) {
  const r = Number(rec.rateHz || meta.rate_hz);
  if (r > 0) return r;
  const dts = [];
  for (let i = 1; i < Math.min(rec.t.length, 2000); i++) { const d = rec.t[i] - rec.t[i - 1]; if (d > 0) dts.push(d); }
  dts.sort((a, b) => a - b);
  return dts.length ? Math.round(1000 / dts[dts.length >> 1]) : 100;
}

export function relTimes(rec, start, end, rateHz) {
  const t = rec.t;
  let forwards = true;
  for (let i = start + 1; i < end; i++) if (!(t[i] > t[i - 1])) { forwards = false; break; }
  const out = [];
  for (let i = start; i < end; i++) out.push(forwards ? Math.round((t[i] - t[start]) * 10) / 10 : Math.round(((i - start) * 1000 / rateHz) * 10) / 10);
  return out;
}

// Label runs -> segments; rep k = the k-th run of that label for this person (shared `reps` map).
function segmentsOf(L, n, { includeCalibration, pid, reps, labels }) {
  const segments = [];
  for (let i = 0; i < n;) {
    const lab = L[i];
    let j = i + 1;
    while (j < n && L[j] === lab) j++;
    if (lab && (includeCalibration || !isCal(lab))) {
      if (labels && !labels.includes(lab)) labels.push(lab);
      const key = `${pid}\u0000${lab}`;
      const rep = (reps.get(key) || 0) + 1;
      reps.set(key, rep);
      segments.push({ label: lab, start: i, end: j, rep });
    }
    i = j;
  }
  return segments;
}

export const movementSegments = (it) => (it.aligned ? it.aligned.segments : it.segments);
export const labelTiming = (it) => (it.aligned ? `movement-aligned (${it.aligned.source})` : 'prompt');

export function prepare(recordings, { includeCalibration = false, align = false } = {}) {
  const list = (Array.isArray(recordings) ? recordings : [recordings]).filter(Boolean);
  if (!list.length) throw new ExportError(['Nothing to export: open or record a session first.']);
  const problems = [];
  const labels = [];
  const runs = new Map();
  const reps = new Map();
  const alignedReps = new Map();
  const items = list.map((x, k) => {
    const rec = x.recording || x;
    const meta = { ...(rec.meta || {}), ...(x.recording ? x.meta || {} : {}) };
    const errs = validateMeta(meta);
    if (errs.length) problems.push(`Recording ${k + 1}: ${errs.join(' ')}`);
    const pid = String(meta.person_id ?? '').trim();
    const run = (runs.get(pid) || 0) + 1;
    runs.set(pid, run);
    const synthetic = isSynthetic(rec, meta);
    const m = safeMeta({ ...meta, app_version: APP_VERSION });
    // Every format's metadata carries the placement as an object, whichever form it arrived in.
    if (m.placement_map != null) { const pm = decodePlacementMap(m.placement_map); if (pm) m.placement_map = pm; else delete m.placement_map; }
    if (synthetic) { m.synthetic = true; m.source = m.source || 'twin'; }
    const n = rec.t.length;
    const segments = segmentsOf(rec.labels || [], n, { includeCalibration, pid, reps, labels });
    // Aligned segments count reps on their own map: relabel only moves boundaries, so the k-th
    // grip is the same movement in both and LibEMG R_3 still matches Ninapro repetition 3.
    let aligned = null;
    const own = Array.isArray(rec.alignedLabels) && rec.alignedLabels.length === n ? rec.alignedLabels : null;
    const R = !own && align && (rec.labels || []).length === n ? relabel(rec) : null;
    if (own || R) {
      const AL = own || R.labels;
      aligned = { source: own ? 'recording' : 'relabel', labels: AL, steps: R ? R.steps : null,
        segments: segmentsOf(AL, n, { includeCalibration, pid, reps: alignedReps, labels: null }) };
    }
    const names = (rec.channelNames || rec.data.map((_, c) => `ch${c + 1}`)).map((n, c) => (/^[A-Za-z_]\w*$/.test(n || '') ? n : `ch${c + 1}`));
    return { rec, meta: m, pid, run, rateHz: rateOf(rec, meta), synthetic, names, segments, aligned };
  });
  if (problems.length) throw new ExportError(problems);
  if (!labels.length) throw new ExportError(['No labelled samples to export: record a guided session first.']);
  return { items, labels, synthetic: items.some((it) => it.synthetic) };
}

// Ninapro convention: 0 = rest, movements 1..K in first-appearance order. Rest positions share 0.
export function stimulusMap(labels) {
  const map = {};
  let k = 0;
  for (const l of labels) map[l] = isRest(l) ? 0 : ++k;
  return map;
}

export const metaFile = (dir, P, extra = {}) => ({
  path: `${dir}/metadata.json`,
  text: JSON.stringify({ app_version: APP_VERSION, synthetic: P.synthetic, ...extra, recordings: P.items.map((it) => ({ person_id: it.pid, run: it.run, rate_hz: it.rateHz, channels: it.names, label_timing: labelTiming(it), meta: it.meta })) }, null, 2) + '\n',
});
