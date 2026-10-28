// export/ninapro.js: Ninapro-style arrays (emg, stimulus, restimulus, repetition). Pure.
//
// Contract
//   toNinapro(prepared) -> [{ path, text }]
//     ninapro/<person_id>_run-<n>.json  { emg: number[n][ch], stimulus, restimulus, repetition,
//                                         t_ms, channels, rate_hz, label_map, synthetic, meta }
//     ninapro/<person_id>_run-<n>.csv   t_ms,<ch...>,stimulus,restimulus,repetition
//     ninapro/label_map.json; ninapro/metadata.json
//   label_map: rest (any position) = 0, movements 1..K in first-appearance order (Ninapro DB2).
//   repetition: 1.. per person and movement; 0 on rest samples. Only labelled samples are kept.
// restimulus: the movement-aligned label (relabel.js, or the recording's own alignedLabels) when
// the item has one; otherwise a copy of stimulus, and restimulus_source says which, so a copy is
// never passed off as re-timed. Repetition stays on the prompt (as stimulus).

import { stimulusMap, isRest, metaFile } from './common.js';

export function toNinapro(P) {
  const map = stimulusMap(P.labels);
  const files = [];
  for (const it of P.items) {
    const emg = [], stim = [], restim = [], rep = [], t = [];
    const AL = it.aligned ? it.aligned.labels : null;
    for (const s of it.segments) {
      for (let i = s.start; i < s.end; i++) {
        emg.push(it.rec.data.map((ch) => ch[i]));
        stim.push(map[s.label]);
        restim.push(AL ? map[AL[i]] ?? 0 : map[s.label]);
        rep.push(isRest(s.label) ? 0 : s.rep);
        t.push(Math.round(it.rec.t[i] * 10) / 10);
      }
    }
    const base = `ninapro/${it.pid}_run-${it.run}`;
    files.push({
      path: `${base}.json`,
      text: JSON.stringify({ synthetic: it.synthetic, channels: it.names, rate_hz: it.rateHz, label_map: map, restimulus_source: AL ? `movement-aligned (${it.aligned.source})` : 'copy of stimulus (no movement-aligned labels for this recording)', emg, stimulus: stim, restimulus: restim, repetition: rep, t_ms: t, meta: it.meta }) + '\n',
    });
    const rows = [['t_ms', ...it.names, 'stimulus', 'restimulus', 'repetition'].join(',')];
    for (let k = 0; k < emg.length; k++) rows.push([t[k], ...emg[k], stim[k], restim[k], rep[k]].join(','));
    files.push({ path: `${base}.csv`, text: rows.join('\n') + '\n' });
  }
  files.push({ path: 'ninapro/label_map.json', text: JSON.stringify({ synthetic: P.synthetic, label_map: map }, null, 2) + '\n' });
  files.push(metaFile('ninapro', P, { format: 'ninapro-style', label_map: map }));
  return files;
}
