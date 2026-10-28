// csv.js: CSV export/import with a '#' metadata header, plus the quality-report sidecar. Pure.
//
// Contract
//   APP_VERSION
//   validateMeta(meta) -> string[]   problems in plain words ([] = fine)
//     person_id must look like an ID (letters+digits, e.g. P03), never a name.
//   toCSV(recording, meta) -> string
//     # opengrip_studio v<APP_VERSION>
//     # key=value            (person_id, sensors, placement, tightness, notes, rate_hz,
//                              app_version, started_at, baud, format, cal_rest, cal_squeeze, ...)
//     # marker t_ms=<ms> note=<text>
//     t_ms,<ch names...>,label
//     <t>,<v1>,...,<label>
//     sensors = per-channel list "FMG,FMG,EMG" (one per channel, FMG|EMG|both|unknown).
//     t is written with at most 1 decimal; values as given (integers from the ADC).
//   fromCSV(text) -> recording { meta, channels, channelNames, t, data, labels, markers, rateHz }
//   sidecarJSON(report, meta) -> string (pretty JSON: { app_version, meta, report })
//     meta.placement_map comes out as an object (decoded if it was given as the header string).
//   placement_map: the Body view's placement (placement.js) as one line of JSON, '=' written
//     \u003d so the "# key=value" header splits cleanly; toCSV takes the object or that string,
//     fromCSV gives back the object (or drops the key with a placement_map_error if it is unreadable).
// Values with newlines are flattened to one line so the header can't break the file.

import { parseText } from './parse.js';
import { encodePlacementMap, decodePlacementMap } from './placement.js';

export const APP_VERSION = '0.1.0';
export const SENSOR_TYPES = ['FMG', 'EMG', 'both', 'unknown'];
const META_ORDER = ['person_id', 'sensors', 'placement', 'placement_map', 'tightness', 'notes', 'rate_hz', 'app_version', 'started_at', 'baud', 'format', 'cal_rest', 'cal_squeeze', 'protocol'];

export function validateMeta(meta = {}) {
  const errs = [];
  const id = String(meta.person_id ?? '').trim();
  if (!id) errs.push('Add a person ID (e.g. P03).');
  else if (!/^[A-Za-z0-9_-]{1,24}$/.test(id) || !/\d/.test(id)) errs.push('Person ID should be a code like P03, not a name (letters and digits, no spaces).');
  if (meta.sensors) {
    const bad = String(meta.sensors).split(',').map((s) => s.trim()).filter((s) => !SENSOR_TYPES.includes(s));
    if (bad.length) errs.push(`Unknown sensor type(s): ${bad.join(', ')}. Use FMG, EMG, both or unknown.`);
  }
  return errs;
}

const flat = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
const fmtT = (t) => (t == null ? '' : String(Math.round(t * 10) / 10));
const safeName = (n, i) => (/^[A-Za-z_][\w]*$/.test(n || '') && !/^t(_ms)?$/i.test(n) ? n : `ch${i + 1}`);

export function toCSV(rec, meta = {}) {
  const m = { ...(rec.meta || {}), ...meta, app_version: APP_VERSION };
  if (rec.rateHz && !m.rate_hz) m.rate_hz = rec.rateHz;
  const out = [`# opengrip_studio v${APP_VERSION}`];
  const keys = [...META_ORDER.filter((k) => k in m), ...Object.keys(m).filter((k) => !META_ORDER.includes(k)).sort()];
  if (m.placement_map != null && m.placement_map !== '') {
    const pm = decodePlacementMap(m.placement_map);
    if (pm) m.placement_map = encodePlacementMap(pm); else delete m.placement_map;
  }
  for (const k of keys) if (/^[A-Za-z_][\w.\-]*$/.test(k) && m[k] !== '' && m[k] != null) out.push(`# ${k}=${flat(m[k])}`);
  for (const mk of rec.markers || []) out.push(`# marker t_ms=${fmtT(mk.t)} note=${flat(mk.note)}`);
  const names = (rec.channelNames || rec.data.map((_, i) => `ch${i + 1}`)).map(safeName);
  out.push(['t_ms', ...names, 'label'].join(','));
  const n = rec.t.length;
  for (let i = 0; i < n; i++) {
    const row = [fmtT(rec.t[i])];
    for (let c = 0; c < rec.data.length; c++) row.push(rec.data[c][i]);
    // Labels are validated by the protocol; strip commas anyway so a hotkey label can't shift columns.
    row.push(flat(rec.labels?.[i]).replace(/,/g, ' '));
    out.push(row.join(','));
  }
  return out.join('\n') + '\n';
}

export function fromCSV(text) {
  const r = parseText(text, { hasTime: true });
  const colLine = String(text).split(/\r?\n/).find((l) => /^t_ms,/.test(l));
  const cols = colLine ? colLine.split(',') : [];
  const channelNames = cols.length ? cols.slice(1, cols[cols.length - 1] === 'label' ? -1 : undefined) : r.data.map((_, i) => `ch${i + 1}`);
  // Markers come before the data rows in the file; place them by time.
  const markers = r.markers.map((m) => ({ t: m.t, note: m.note, index: r.t.findIndex((x) => x >= m.t) }));
  const meta = { ...r.meta };
  if ('placement_map' in meta) {
    const pm = decodePlacementMap(meta.placement_map);
    if (pm) meta.placement_map = pm;
    else { meta.placement_map_error = 'placement_map in this file could not be read'; delete meta.placement_map; }
  }
  return {
    meta, channels: r.channels, channelNames, t: r.t, data: r.data,
    labels: r.labels.map((l) => l || null), markers, rateHz: r.rateHz,
  };
}

export function sidecarJSON(report, meta = {}) {
  const m = { ...meta };
  if (m.placement_map != null) { const pm = decodePlacementMap(m.placement_map); if (pm) m.placement_map = pm; else delete m.placement_map; }
  return JSON.stringify({ app_version: APP_VERSION, meta: m, report }, null, 2);
}
