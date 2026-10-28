// ui/fingerprint-view.js: the Review "Body" card (spec docs/design/body-view-spec.md §6.3 + §5.5).
// A ring with the Doctor's pins and each sensor's mean level during the gesture steps, then the
// gesture fingerprints: a grid of small rings (gesture rows x arm-position columns), one line per
// pair that looks alike, and the same numbers as a table. Logic lives in src/fingerprint.js.
//
// Contract
//   mountBodyCard(host, rec, { report?, placement?, synthetic? }) -> { fp, root, destroy() }
//     rec: the column recording (data, labels, meta). report: analyzeRecording(rec) (computed when
//     omitted); its items become pins. placement: placement.js model (default rec.placement, then
//     rec.meta.placement_map); none -> an evenly spaced ring in channel order, and the card says so.
//     synthetic: label the card as demo data (default rec.synthetic || rec.meta.synthetic).
//   DOM: section.card.fp-card#rv-body[data-cells][data-lookalike]; .fp-main (pinned ring);
//     .fp-grid > .fp-cell[data-key] (a text-free mini ring, svg aria-hidden; the cell is role=img with the numbers in aria-label) or .fp-cell.fp-none ("not recorded");
//     .fp-alike > li.fp-line[data-a][data-b] (look-alike) or li.fp-ok; details.fp-table >
//     table > tbody > tr[data-key] (one per recorded cell); .fp-synth when synthetic.
//   Words: FP_WORDS in words.js (re-exported here). Styles: the .fp- rules in style.css.
//   Card N7: .fp-grid and details.fp-table sit inside details.fp-more ("More details"), after
//   .fp-alike; open when body[data-mode="advanced"] at mount.
// Failure behaviour: no gesture steps -> the pinned ring plus "No gesture steps" line, no grid.

import { createBodyView, liveColour } from './body-draw.js';
import { fingerprints, FP_POSITIONS } from '../fingerprint.js';
import { analyzeRecording } from '../quality.js';
import { ringPreset, decodePlacementMap, ringXY } from '../placement.js';
import { esc } from './dom.js';
import { REVIEW, FP_WORDS } from './words.js';

// FP_WORDS moved to words.js (review-2 m7); re-exported so existing imports keep working.
export { FP_WORDS };
const W = FP_WORDS;
// Card N7: the look-alike lines are the answer, so they stay in view; the grid of small rings and
// the numbers table are the evidence, folded in Simple and open in Advanced.
const gestureName = (g) => String(g).replace(/_/g, ' ').toUpperCase();

// Review-2 M4: a cell is a bare ring (skin + one dot per placed sensor, coloured like the Body
// view), with no text at all: a full Body view shrunk to ~110 px drew 5-6 px labels that overlapped
// at 375. The cell's aria-label carries the numbers and the table below repeats them.
function miniRing(placement, mean) {
  const R = 40, r = 9;
  const dots = (placement.channels || []).filter((c) => Number.isFinite(c.ringAngleDeg)).map((c) => {
    const { x, y } = ringXY(c.ringAngleDeg, placement.arm, R, R);
    const m = mean[c.ch - 1];
    const lv = Number.isFinite(m);
    return `<circle class="fp-dot${lv ? '' : ' fp-nolevel'}" cx="${(50 + x).toFixed(1)}" cy="${(50 + y).toFixed(1)}" r="${r}"${lv ? ` fill="${liveColour(m)}"` : ''}/>`;
  }).join('');
  return `<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false"><ellipse class="fp-skin" cx="50" cy="50" rx="${R}" ry="${R}"/>${dots}</svg>`;
}

export function mountBodyCard(host, rec, opts = {}) {
  const doc = host.ownerDocument;
  const given = opts.placement || rec.placement || decodePlacementMap(rec.meta?.placement_map);
  const nCh = rec.data.length;
  const placed = !!given?.channels?.some((c) => Number.isFinite(c.ringAngleDeg));
  // No places: the same stand-in ring Record uses, so the spokes at least come in channel order.
  const placement = placed ? given : ringPreset({ count: Math.max(1, Math.min(16, nCh)) });
  const report = opts.report || analyzeRecording(rec);
  const synthetic = opts.synthetic ?? !!(rec.synthetic || rec.meta?.synthetic === true || rec.meta?.synthetic === 'true');
  const fp = fingerprints(rec, { placement: given || null });
  const views = [];

  const root = doc.createElement('section');
  root.className = 'card fp-card'; root.id = 'rv-body';
  root.dataset.cells = String(fp.cells.length);
  root.dataset.lookalike = String(fp.lookAlike.length);
  root.setAttribute('aria-labelledby', 'fp-h');
  const posHead = FP_POSITIONS.map((p) => `<div class="fp-colh">${esc(W.positions[p])}</div>`).join('');
  const rows = fp.gestures.map((g) => `<div class="fp-rowh">${esc(gestureName(g.gesture))}${g.distractor ? `<small>${esc(W.distractor)}</small>` : ''}</div>`
    + FP_POSITIONS.map((p) => {
      const c = fp.cells.find((x) => x.gesture === g.gesture && x.position === p);
      return c ? `<div class="fp-cell" data-key="${esc(c.key)}" role="img" aria-label="${esc(`${gestureName(c.gesture)}, ${W.positions[p]}: ${c.mean.map((m, i) => `sensor ${i + 1} ${m == null ? '-' : m.toFixed(2)}`).join(', ')}`)}"></div>`
        : `<div class="fp-cell fp-none">${esc(W.notRecorded)}</div>`;
    }).join('')).join('');
  const lines = !fp.cells.length ? `<li class="fp-ok">${esc(fp.summary)}</li>`
    : fp.lookAlike.length ? fp.lookAlike.map((p) => `<li class="fp-line" data-a="${esc(p.a)}" data-b="${esc(p.b)}"><b>${esc(W.check)}</b> ${esc(p.text)}</li>`).join('')
      : `<li class="fp-ok"><b>${esc(W.ok)}</b> ${esc(W.okLine)}</li>`;
  const chHead = fp.channels.map((c) => `<th scope="col">${c.ch} ${esc(c.sensor)}</th>`).join('');
  const trs = fp.cells.map((c) => `<tr data-key="${esc(c.key)}"><td>${esc(gestureName(c.gesture))}</td><td>${esc(W.positions[c.position])}</td><td>${c.steps}</td>${c.mean.map((m, i) => `<td title="spread ${c.spread[i] == null ? '-' : c.spread[i].toFixed(2)}">${m == null ? '-' : m.toFixed(2)}</td>`).join('')}</tr>`).join('');
  root.innerHTML = `<h2 id="fp-h">${esc(W.title)}${synthetic ? ` <span class="fp-synth">${esc(W.synthetic)}</span>` : ''}</h2>
    <div class="fp-main"></div>
    <p class="fp-note">${esc(W.mainNote)}${placed ? '' : ` ${esc(W.placesNotSet)}`}</p>
    <h3>${esc(W.fpTitle)}</h3>
    <p class="fp-note">${esc(W.fpIntro)} ${esc(W.basis[fp.basis])}</p>
    <ul class="fp-alike">${lines}</ul>
    ${fp.cells.length ? `<details class="more-details fp-more"${document.body.dataset.mode === 'advanced' ? ' open' : ''}><summary>${esc(REVIEW.moreDetails)}</summary>
    <div class="fp-grid"><div></div>${posHead}${rows}</div>
    <details class="fp-table"><summary>${esc(W.table)}</summary><div class="fp-scroll"><table>
      <thead><tr><th scope="col">${esc(W.tableHead.gesture)}</th><th scope="col">${esc(W.tableHead.position)}</th><th scope="col">${esc(W.tableHead.steps)}</th>${chHead}</tr></thead>
      <tbody>${trs}</tbody></table></div></details></details>` : ''}`;
  host.appendChild(root);

  // The big ring: mean level over the real gestures (distractors left out: they are not the
  // gestures the recording is for), pinned with the Doctor's red/amber findings.
  const real = fp.cells.filter((c) => !c.distractor);
  const active = fp.channels.map((_, i) => {
    const xs = real.map((c) => c.mean[i]).filter(Number.isFinite);
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  });
  const main = createBodyView(root.querySelector('.fp-main'), { placement, lens: 'ring', calm: true, smoothMs: 0, names: rec.channelNames });
  main.setPins(report.items || []);
  main.update(active);
  views.push(main);
  for (const el of root.querySelectorAll('.fp-cell[data-key]')) {
    const c = fp.cells.find((x) => x.key === el.dataset.key);
    el.innerHTML = miniRing(placement, c.mean);
  }
  return { fp, root, destroy() { for (const v of views) v.destroy(); root.remove(); } };
}
