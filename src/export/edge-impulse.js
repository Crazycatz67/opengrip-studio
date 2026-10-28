// export/edge-impulse.js: Edge Impulse CSV files, one per labelled segment. Pure.
//
// Contract (files are cut on movement-aligned segments when the item has them: common.js
//   movementSegments; metadata.json says which, per recording, in label_timing)
//   toEdgeImpulse(prepared) -> [{ path, text }]
//     edge-impulse/<label>.<N>.csv   header "timestamp,<ch...>", timestamp in ms from 0 per file
//     edge-impulse/labels.json       file label -> original label; edge-impulse/metadata.json
//   <label> is fileSafe ('grip@elbow90' -> 'grip_elbow90'); N counts from 1 per file label.
// Assumptions (their CSV wizard page, checked 2026-10-20, shows a "timestamp" column and lets you
// pick the timestamp column and its frequency): the uploader takes the label from the file name
// up to the first '.', so labels must not contain '.'; '@' is replaced to keep names portable.
// No label column: one file is one sample of one class, which is what the uploader expects.

import { fileSafe, relTimes, metaFile, movementSegments } from './common.js';

export function toEdgeImpulse(P) {
  const files = [];
  const count = new Map();
  const labels = {};
  for (const it of P.items) {
    for (const s of movementSegments(it)) {
      const name = fileSafe(s.label);
      labels[name] = s.label;
      const n = (count.get(name) || 0) + 1;
      count.set(name, n);
      const ts = relTimes(it.rec, s.start, s.end, it.rateHz);
      const rows = [['timestamp', ...it.names].join(',')];
      for (let i = s.start; i < s.end; i++) rows.push([ts[i - s.start], ...it.rec.data.map((ch) => ch[i])].join(','));
      files.push({ path: `edge-impulse/${name}.${n}.csv`, text: rows.join('\n') + '\n' });
    }
  }
  files.push({ path: 'edge-impulse/labels.json', text: JSON.stringify({ synthetic: P.synthetic, labels }, null, 2) + '\n' });
  files.push(metaFile('edge-impulse', P, { format: 'edge-impulse' }));
  return files;
}
