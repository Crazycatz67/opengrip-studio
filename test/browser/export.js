// Browser export test: a twin session through the real Export panel, then the ZIP bytes checked.
// Result: document.title 'PASS'|'FAIL' and window.__gate = { done, pass, results }.
import { generate } from '../../src/sim/twin.js';
import { mountExportPanel } from '../../src/ui/export-panel.js';
import { readZip } from '../../src/export/zip.js';

const logEl = document.getElementById('log');
const results = [];
window.__gate = { done: false, pass: false, results };
const log = (s) => { logEl.textContent += `${s}\n`; };
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`);
}

function scenarioTwinExport() {
  const S = generate({ seed: 3, channels: 3, positions: ['down', 'elbow90'], reps: 4 });
  const got = [];
  const said = [];
  const box = document.getElementById('panel');
  let recs = [];
  const panel = mountExportPanel(box, { recordings: () => recs, download: (name, bytes, mime) => got.push({ name, bytes, mime }), say: (t, err) => said.push({ t, err: !!err }) });
  const go = box.querySelector('#xp-go');
  check('button disabled with nothing to export', go.disabled);
  recs = [{ recording: S, meta: { person_id: 'P03', sensors: 'FMG,FMG,EMG', name: 'Alice Smith' } }];
  panel.update(() => recs);
  check('button enabled once there is a session', !go.disabled);
  check('synthetic note shown for twin data', !box.querySelector('.xp-synth').hidden);
  go.click();
  check('one ZIP downloaded', got.length === 1 && got[0].mime === 'application/zip', got.map((g) => g.name).join());
  const { name, bytes } = got[0] || {};
  check('file name marks person and synthetic', name === 'opengrip-P03-dataset-synthetic.zip', name);
  check('ZIP starts with a local header (PK 3 4)', bytes && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4);
  const z = readZip(bytes);
  check('every entry CRC matches', z.length > 20 && z.every((e) => e.crcOk), `${z.length} entries, ${bytes.length} bytes`);
  const paths = z.map((e) => e.path);
  for (const p of ['manifest.json', 'libemg/classes.json', 'libemg/README.md', 'edge-impulse/grip.1.csv', 'bids/dataset_description.json', 'bids/sub-P03/emg/sub-P03_task-guided_run-1_emg.json', 'ninapro/P03_run-1.json']) check(`has ${p}`, paths.includes(p));
  const dec = new TextDecoder();
  const text = (p) => dec.decode(z.find((e) => e.path === p).bytes);
  const man = JSON.parse(text('manifest.json'));
  check('manifest synthetic=true and lists every file', man.synthetic === true && man.files.length === z.length - 2, man.files.length);
  const classes = JSON.parse(text('libemg/classes.json')).classes;
  const gripIdx = Object.keys(classes).find((k) => classes[k] === 'grip');
  const gripRuns = S.labels.filter((l, i) => l === 'grip' && S.labels[i - 1] !== 'grip').length;
  const gripFiles = paths.filter((p) => new RegExp(`^libemg/P03/R_\\d+_C_${gripIdx}_EMG\\.csv$`).test(p));
  check('LibEMG grip reps = twin grip reps', gripFiles.length === gripRuns && gripRuns > 0, `${gripFiles.length}/${gripRuns}`);
  const nina = JSON.parse(text('ninapro/P03_run-1.json'));
  check('Ninapro rest = 0', nina.label_map.rest === 0 && nina.label_map['rest@elbow90'] === 0);
  check('BIDS sampling rate', JSON.parse(text('bids/sub-P03/emg/sub-P03_task-guided_run-1_emg.json')).SamplingFrequency === S.rateHz);
  check('no name anywhere in the ZIP', !z.some((e) => /Alice/.test(dec.decode(e.bytes))));
  check('status line says saved', said.length === 1 && !said[0].err && /Saved/.test(said[0].t), said[0]?.t);
  // A real name as the person ID is refused in plain words, and nothing downloads.
  recs = [{ recording: S, meta: { person_id: 'Alice Smith' } }];
  go.click();
  check('name as person ID refused', got.length === 1 && said[1]?.err && /not a name/.test(said[1].t), said[1]?.t);
  panel.destroy();
  check('destroy empties the box', box.innerHTML === '');
}

(async () => {
  const t0 = performance.now();
  for (const sc of [scenarioTwinExport]) {
    log(`-- ${sc.name}`);
    try { await sc(); } catch (e) { check(`${sc.name} threw`, false, e?.stack || e); }
  }
  const pass = results.length > 0 && results.every((r) => r.ok);
  const s = document.getElementById('summary');
  s.textContent = `${pass ? 'PASS' : 'FAIL'}: ${results.filter((r) => r.ok).length}/${results.length} checks in ${Math.round((performance.now() - t0) / 1000)} s`;
  s.className = pass ? 'pass' : 'fail';
  Object.assign(window.__gate, { done: true, pass });
  document.title = pass ? 'PASS' : 'FAIL';
})();
