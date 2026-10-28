// export/libemg.js: LibEMG OfflineDataHandler folder. Pure.
//
// Contract (files are cut on movement-aligned segments when the item has them: common.js
//   movementSegments; metadata.json says which, per recording, in label_timing)
//   toLibEMG(prepared) -> [{ path, text }]
//     libemg/<person_id>/R_<rep>_C_<class>_EMG.csv  one file per labelled segment (repetition);
//       rows = samples, columns = channels, no header (LibEMG reads every column as a channel).
//     libemg/classes.json  { classes: { "<index>": label }, channels, reps per class }
//     libemg/README.md     the RegexFilter lines to paste; libemg/metadata.json
//   Class index: 0-based, first-appearance order of the label (rest is a class, as in LibEMG's
//   "no motion"). Rep: 1-based per person and label, counted on across runs, so files never clash.
// Naming follows the LibEMG data docs (checked 2026-10-20: "dataset/train/R_1_C_1_EMG.csv where R
// is the rep and C is the class", RegexFilter(left_bound, right_bound, values, description)).
// RegexFilter gives each file the POSITION of its match in `values`, so the values lists below
// are written in index order: C_0 -> class 0, R_1 -> rep index 0.

import { metaFile, movementSegments } from './common.js';

export function toLibEMG(P) {
  const files = [];
  const classIdx = Object.fromEntries(P.labels.map((l, i) => [l, i]));
  let maxRep = 0;
  for (const it of P.items) {
    for (const s of movementSegments(it)) {
      maxRep = Math.max(maxRep, s.rep);
      const rows = [];
      for (let i = s.start; i < s.end; i++) rows.push(it.rec.data.map((ch) => ch[i]).join(','));
      files.push({ path: `libemg/${it.pid}/R_${s.rep}_C_${classIdx[s.label]}_EMG.csv`, text: rows.join('\n') + '\n' });
    }
  }
  const pids = [...new Set(P.items.map((it) => it.pid))];
  const q = (a) => `[${a.map((x) => JSON.stringify(String(x))).join(', ')}]`;
  const classes = Object.fromEntries(P.labels.map((l, i) => [String(i), l]));
  files.push({ path: 'libemg/classes.json', text: JSON.stringify({ synthetic: P.synthetic, classes, channels: P.items[0].names, max_rep: maxRep }, null, 2) + '\n' });
  files.push({
    path: 'libemg/README.md',
    text: [
      '# LibEMG folder (OpenGrip Studio export)',
      P.synthetic ? '\n**synthetic=true**: made by the digital twin. For testing and demos, never evidence of accuracy.\n' : '',
      'One CSV per repetition: `<person>/R_<rep>_C_<class>_EMG.csv`, one column per channel, no header.',
      `Channels: ${P.items[0].names.join(', ')}. Classes are in classes.json.`,
      'Sensor places (entered by the user, not measured) are in metadata.json under meta.placement_map: per channel the site, side, ring angle (0 palm middle, 90 thumb side) and cm from the elbow crease.',
      '',
      '```python',
      'from libemg.data_handler import OfflineDataHandler, RegexFilter',
      `classes_values = ${q(P.labels.map((_, i) => i))}`,
      `reps_values = ${q(Array.from({ length: maxRep }, (_, i) => i + 1))}`,
      `subjects_values = ${q(pids)}`,
      'regex_filters = [',
      '    RegexFilter(left_bound="libemg/", right_bound="/", values=subjects_values, description="subjects"),',
      '    RegexFilter(left_bound="_C_", right_bound="_EMG.csv", values=classes_values, description="classes"),',
      '    RegexFilter(left_bound="/R_", right_bound="_C_", values=reps_values, description="reps"),',
      ']',
      'odh = OfflineDataHandler()',
      'odh.get_data(folder_location="libemg", regex_filters=regex_filters, delimiter=",")',
      '```',
      '',
      'Unzip so the path contains `libemg/` once. FMG channels are force, not EMG, though LibEMG reads them the same way.',
      '',
    ].join('\n'),
  });
  files.push(metaFile('libemg', P, { format: 'libemg', classes }));
  return files;
}
