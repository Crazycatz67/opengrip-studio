// export/index.js: one entry point for the dataset exports, bundled as a ZIP. Pure.
//
// Contract
//   FORMATS: [{ id, title }]  ids 'libemg' | 'edge-impulse' | 'bids' | 'ninapro'
//   exportFiles(recordings, { formats = all ids, includeCalibration = false, align = false }) -> [{ path, text }]
//     align: true re-times labels to the movement (relabel.js) for recordings without their own
//     alignedLabels (see common.js prepare); manifest.label_timing lists what each recording used.
//     always adds manifest.json ({ app_version, synthetic, formats, files, label_map }) and README.txt
//   exportZip(recordings, opts & { date }) -> { name, bytes: Uint8Array, files }
//     name: 'opengrip-<person or club>-dataset[-synthetic].zip'
//   recordings: see common.js prepare(). Throws ExportError (plain-word .problems) on bad input
//   (missing / name-like person ID, no labelled samples); unknown format id throws Error.

import { prepare, stimulusMap, labelTiming, APP_VERSION, ExportError } from './common.js';
import { toLibEMG } from './libemg.js';
import { toEdgeImpulse } from './edge-impulse.js';
import { toBIDS } from './bids.js';
import { toNinapro } from './ninapro.js';
import { zipStore } from './zip.js';

export { ExportError };

export const FORMATS = [
  { id: 'libemg', title: 'LibEMG folder', make: toLibEMG },
  { id: 'edge-impulse', title: 'Edge Impulse CSV', make: toEdgeImpulse },
  { id: 'bids', title: 'BIDS-EMG-like (draft spec)', make: toBIDS },
  { id: 'ninapro', title: 'Ninapro-style arrays', make: toNinapro },
];

export function exportFiles(recordings, { formats = FORMATS.map((f) => f.id), includeCalibration = false, align = false } = {}) {
  const P = prepare(recordings, { includeCalibration, align });
  const files = [];
  for (const id of formats) {
    const f = FORMATS.find((x) => x.id === id);
    if (!f) throw new Error(`unknown export format "${id}"`);
    files.push(...f.make(P));
  }
  const manifest = { app_version: APP_VERSION, synthetic: P.synthetic, formats, label_map: stimulusMap(P.labels), people: [...new Set(P.items.map((it) => it.pid))], label_timing: P.items.map(labelTiming), files: files.map((f) => f.path) };
  files.push({ path: 'manifest.json', text: JSON.stringify(manifest, null, 2) + '\n' });
  files.push({ path: 'README.txt', text: `OpenGrip Studio dataset export (v${APP_VERSION}).\nFolders: ${formats.join(', ')}. Each has a metadata.json or README.\n${P.synthetic ? 'synthetic=true: this data came from the digital twin. For testing and demos, never evidence of accuracy.\n' : ''}People are IDs only; no names.\n${P.items.some((it) => it.meta.placement_map) ? 'Sensor places (entered by the user, not measured) are in each folder\'s metadata.json under meta.placement_map; BIDS also has placement columns in _channels.tsv. LibEMG, Edge Impulse and Ninapro carry it in metadata only.\n' : ''}` });
  return files;
}

export function exportZip(recordings, opts = {}) {
  const files = exportFiles(recordings, opts);
  const list = Array.isArray(recordings) ? recordings : [recordings];
  const pids = [...new Set(list.map((x) => String(((x.recording ? { ...x.recording.meta, ...x.meta } : x.meta) || {}).person_id || '')))];
  const synth = files.some((f) => f.path === 'manifest.json' && /"synthetic": true/.test(f.text));
  const name = `opengrip-${pids.length === 1 && pids[0] ? pids[0] : 'club'}-dataset${synth ? '-synthetic' : ''}.zip`;
  return { name, bytes: zipStore(files, opts.date ? { date: opts.date } : {}), files };
}
