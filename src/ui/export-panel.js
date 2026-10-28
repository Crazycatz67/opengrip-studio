// ui/export-panel.js: the "Export dataset" panel (LibEMG, Edge Impulse, BIDS-like, Ninapro as one ZIP).
//
// Contract
//   mountExportPanel(box, { recordings, download, say }) -> { update(recordings), destroy() }
//     box: an element; the panel replaces its contents.
//     recordings: array (or a function returning one) of recordings / { recording, meta }, as
//       src/export/common.js prepare() takes. A function is read at click time, so it stays current.
//     download(name, bytes: Uint8Array, mime = 'application/zip'): saves the file (app.download).
//     say(text, isError = false): the app's status line.
//   The button is disabled while there is nothing to export. Errors (person ID missing or a
//   name, no labels) go to say(..., true) in plain words; nothing is downloaded then.
//   DOM: .export-panel > details.xp-more (formats + #xp-calib), .xp-synth, #xp-go.
// Words: EXPORT in words.js.

import { esc } from './dom.js';
import { EXPORT as W, REVIEW } from './words.js';
import { FORMATS, exportZip, ExportError } from '../export/index.js';

// Card N7: every format is ticked by default, so the choice of formats and the calibration option
// fold under "More details" (open in Advanced); the button and the demo-data label stay in view.

export function mountExportPanel(box, { recordings, download, say = () => {} } = {}) {
  let recs = recordings;
  const current = () => { const r = typeof recs === 'function' ? recs() : recs; return (Array.isArray(r) ? r : r ? [r] : []).filter(Boolean); };
  box.innerHTML = `
    <section class="export-panel" aria-labelledby="xp-title">
      <h3 id="xp-title">${esc(W.title)}</h3>
      <p class="xp-hint">${esc(W.hint)}</p>
      <details class="more-details xp-more"${document.body.dataset.mode === 'advanced' ? ' open' : ''}><summary>${esc(REVIEW.moreDetails)}</summary>
      <fieldset class="xp-formats"><legend>${esc(W.formats)}</legend>
        ${FORMATS.map((f) => `<label><input type="checkbox" name="xp-format" value="${esc(f.id)}" checked> ${esc(f.title)}</label>`).join('')}
      </fieldset>
      <label class="xp-calib"><input type="checkbox" id="xp-calib"> ${esc(W.calib)}</label></details>
      <p class="xp-synth" hidden>${esc(W.synthetic)}</p>
      <button type="button" id="xp-go" class="btn">${esc(W.button)}</button>
    </section>`;
  const $ = (s) => box.querySelector(s);
  const go = $('#xp-go');
  const refresh = () => {
    const list = current();
    go.disabled = !list.length;
    const synth = list.some((x) => { const r = x.recording || x; const m = { ...(r.meta || {}), ...(x.recording ? x.meta || {} : {}) }; return r.synthetic === true || m.synthetic === true || m.synthetic === 'true' || m.source === 'twin'; });
    $('.xp-synth').hidden = !synth;
  };
  const onClick = () => {
    const list = current();
    if (!list.length) { say(W.empty, true); return; }
    const formats = [...box.querySelectorAll('input[name="xp-format"]:checked')].map((i) => i.value);
    if (!formats.length) { say(W.none, true); return; }
    try {
      const { name, bytes, files } = exportZip(list, { formats, includeCalibration: $('#xp-calib').checked });
      download(name, bytes, 'application/zip');
      say(W.done(name, files.length));
    } catch (e) {
      if (e instanceof ExportError) say(e.problems.join(' '), true);
      else throw e;
    }
  };
  go.addEventListener('click', onClick);
  refresh();
  return {
    update(r) { recs = r; refresh(); },
    destroy() { go.removeEventListener('click', onClick); box.innerHTML = ''; },
  };
}
