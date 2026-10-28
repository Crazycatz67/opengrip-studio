// export/bids.js: a BIDS-EMG-like folder (draft spec: BEP042 was still in review, 2025-26). Pure.
//
// Contract
//   toBIDS(prepared, { date }) -> [{ path, text }]
//     bids/dataset_description.json, bids/participants.tsv, bids/README
//     bids/sub-<id>/emg/sub-<id>_task-<task>_run-<n>_emg.tsv     samples x channels, no header
//     ..._channels.tsv  name type units sampling_frequency description placement placement_side
//                       placement_angle_deg placement_cm_from_elbow_crease   ('n/a' when not placed;
//                       our own columns: the draft has no official placement column we could check)
//     ..._events.tsv    onset duration trial_type value repetition   (seconds; value = Ninapro int)
//                       + movement_onset movement_duration lag_ms alignment_confidence when the
//                       item is movement-aligned (seconds from the recording start; 'n/a' if unknown)
//     ..._emg.json      SamplingFrequency, EMGChannelCount, RecordingDuration, TaskName, ...
//   <id> = person_id with anything but letters/digits removed (BIDS labels are alphanumeric).
//   type: EMG channels 'EMG'; FMG / unknown 'MISC' (BIDS has no FMG type) with the sensor in description.
// Not a validated BIDS dataset: the emg datatype is draft, so everything is marked
// "BIDS-EMG-like (draft spec)" and the bids-validator is not expected to accept it.

import { stimulusMap, isRest, APP_VERSION } from './common.js';
import { placementSummary } from '../placement.js';

const LABEL = 'BIDS-EMG-like (draft spec)';
const alnum = (s) => String(s).replace(/[^A-Za-z0-9]/g, '');
const tsv = (rows) => rows.map((r) => r.join('\t')).join('\n') + '\n';

export function toBIDS(P) {
  const map = stimulusMap(P.labels);
  const files = [];
  const subs = new Set();
  for (const it of P.items) {
    const sub = alnum(it.pid);
    subs.add(sub);
    const task = alnum(it.meta.protocol || 'guided') || 'guided';
    const base = `bids/sub-${sub}/emg/sub-${sub}_task-${task}_run-${it.run}`;
    const n = it.rec.t.length;
    const rows = [];
    for (let i = 0; i < n; i++) rows.push(it.rec.data.map((ch) => ch[i]));
    files.push({ path: `${base}_emg.tsv`, text: tsv(rows) });
    const sensors = String(it.meta.sensors || '').split(',').map((s) => s.trim());
    files.push({
      path: `${base}_channels.tsv`,
      text: tsv([['name', 'type', 'units', 'sampling_frequency', 'description', 'placement', 'placement_side', 'placement_angle_deg', 'placement_cm_from_elbow_crease'],
        ...it.names.map((nm, c) => {
          const s = sensors[c] || 'unknown';
          const pc = (it.meta.placement_map?.channels || []).find((x) => x.ch === c + 1) || {};
          const na = (v) => (v == null || v === '' ? 'n/a' : v);
          return [nm, s === 'EMG' ? 'EMG' : 'MISC', 'n/a', it.rateHz, `${s} (raw ADC counts 0-1023)`, na(pc.site), na(pc.side), na(pc.ringAngleDeg), na(pc.cmFromElbowCrease)];
        })]),
    });
    const A = it.aligned;
    const ev = [['onset', 'duration', 'trial_type', 'value', 'repetition', ...(A ? ['movement_onset', 'movement_duration', 'lag_ms', 'alignment_confidence'] : [])]];
    const am = new Map((A?.segments || []).map((g) => [`${g.label}\u0000${g.rep}`, g]));
    const conf = new Map((A?.steps || []).map((x) => [x.promptStart, x.confidence]));
    for (const s of it.segments) {
      const row = [(s.start / it.rateHz).toFixed(3), ((s.end - s.start) / it.rateHz).toFixed(3), s.label, map[s.label], isRest(s.label) ? 0 : s.rep];
      if (A) {
        const g = am.get(`${s.label}\u0000${s.rep}`);
        row.push(...(g ? [(g.start / it.rateHz).toFixed(3), ((g.end - g.start) / it.rateHz).toFixed(3), Math.round(((g.start - s.start) * 1000) / it.rateHz)] : ['n/a', 'n/a', 'n/a']), conf.get(s.start) ?? 'n/a');
      }
      ev.push(row);
    }
    files.push({ path: `${base}_events.tsv`, text: tsv(ev) });
    files.push({
      path: `${base}_emg.json`,
      text: JSON.stringify({
        TaskName: task, SamplingFrequency: it.rateHz, EMGChannelCount: sensors.filter((s) => s === 'EMG').length,
        MiscChannelCount: it.names.length - sensors.filter((s) => s === 'EMG').length,
        RecordingDuration: Math.round((n / it.rateHz) * 1000) / 1000, RecordingType: 'continuous',
        EMGPlacementScheme: 'Other', EMGPlacementSchemeDescription: it.meta.placement || placementSummary(it.meta.placement_map) || 'n/a',
        Manufacturer: 'OpenGrip club rig (Arduino)', SoftwareVersions: `OpenGrip Studio ${APP_VERSION}`,
        Synthetic: it.synthetic, SpecStatus: LABEL, OpenGripMeta: it.meta,
      }, null, 2) + '\n',
    });
  }
  files.push({
    path: 'bids/dataset_description.json',
    text: JSON.stringify({ Name: `OpenGrip Studio export (${LABEL})`, BIDSVersion: '1.10.0', DatasetType: 'raw', GeneratedBy: [{ Name: 'OpenGrip Studio', Version: APP_VERSION }], Synthetic: P.synthetic, SpecStatus: LABEL }, null, 2) + '\n',
  });
  files.push({ path: 'bids/participants.tsv', text: tsv([['participant_id'], ...[...subs].map((s) => [`sub-${s}`])]) });
  files.push({ path: 'bids/README', text: `${LABEL}. The EMG datatype (BEP042) is a draft, so this folder follows its layout but is not validated BIDS.${P.synthetic ? '\nsynthetic=true: made by the digital twin, for testing and demos only.' : ''}\nPeople are IDs only; no names.\n` });
  return files;
}
