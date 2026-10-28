// ui/scorecard.js: the Design Scorecard screen (A vs B). Self-contained: it injects its own
// scoped styles (.sc-*) built on the app's tokens from style.css and reads no global state.
//
// Contract
//   mountScorecard(box: HTMLElement, { a, b, names = ['A', 'B'], say = () => {},
//                  download = null, boot = 2000, seed = 1, today }) -> { card, destroy() }
//     a, b: recordings (fromCSV shape, parsed log or twin Session) or scoreRecording() results,
//     or an array of them per side to pool sessions (A1+A2 vs B1+B2). Pooled column headers
//     show "N recordings, M volunteers" (.sc-count); the fairness list names the counts.
//     say(text, urgent?) is the app's screen-reader announcer; download(name, text, type) the app's
//     file saver (falls back to a Blob link). The user can rename A and B on screen; names
//     are part of every sentence and the export. destroy() empties box; the <style> stays
//     (one per document, shared by later mounts).
// Never colour alone: every verdict chip carries a glyph and words, warnings say "Check".

import { compareRecordings, scoreRecording, scorecardJSON, scorecardHTML, intervalSVG, verdictText, formatValue as fmt } from '../scorecard.js';
import { esc } from './dom.js';

const STYLE_ID = 'sc-style';
const CSS = `
.sc { max-width: 1120px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--s4); }
.sc-head { display: flex; flex-wrap: wrap; align-items: end; gap: var(--s3); }
.sc-head label { display: flex; flex-direction: column; gap: var(--s1); font-size: 14px; color: var(--muted); }
.sc-head input, .sc-head select { min-height: 32px; font: inherit; color: var(--fg); background: var(--panel-2); border: 1px solid var(--edge); border-radius: 6px; padding: 0 var(--s2); }
.sc-head .grow { flex: 1; }
.sc-warn { border: 1px solid var(--warn); border-radius: var(--radius); background: var(--panel); padding: var(--s3) var(--s4); }
.sc-warn ul { margin: 0; padding-left: 0; list-style: none; display: flex; flex-direction: column; gap: var(--s2); }
.sc-warn li b { margin-right: var(--s1); }
.sc-warn li.warn b { color: var(--warn); }
.sc-warn li.info b { color: var(--muted); }
.sc-overall { font-size: 18px; border: 2px solid var(--accent); border-radius: var(--radius); background: var(--accent-weak); padding: var(--s3) var(--s4); margin: 0; }
.sc-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); }
.sc-table { border-collapse: collapse; width: 100%; min-width: 760px; }
.sc-table th, .sc-table td { text-align: left; vertical-align: top; padding: var(--s2) var(--s3); border-top: 1px solid var(--line); }
.sc-table thead th { border-top: 0; color: var(--muted); font-weight: 600; font-size: 14px; }
.sc-table td.num { white-space: nowrap; }
.sc-table .sc-ci { color: var(--trace); display: block; }
.sc-chip { display: inline-block; border: 1px solid var(--edge); border-radius: 6px; padding: 2px var(--s2); font-size: 14px; font-weight: 650; white-space: nowrap; }
.sc-chip.win { border-color: var(--accent); color: var(--accent); }
.sc-chip.none { color: var(--muted); }
.sc-chip.na { border-style: dashed; color: var(--muted); }
.sc-sentence { margin: var(--s1) 0 0; font-size: 14px; color: var(--muted); max-width: 44ch; }
.sc-foot { font-size: 14px; color: var(--muted); }
`;

function injectStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  doc.head.appendChild(s);
}

const safeName = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'x';
const unitOf = (r) => (r.unit === '×' ? '' : ` ${r.unit}`);

export function mountScorecard(box, opts = {}) {
  const doc = box.ownerDocument;
  injectStyle(doc);
  const say = opts.say || (() => {});
  const cmp = { boot: opts.boot ?? 2000, seed: opts.seed ?? 1, ...(opts.today ? { today: opts.today } : {}) };
  // Score each recording once; renaming only re-runs the comparison.
  const scoreOne = (x) => (x && x.units ? x : scoreRecording(x || { data: [] }));
  const scoreSide = (x) => (Array.isArray(x) && x.length ? x.map(scoreOne) : scoreOne(Array.isArray(x) ? null : x));
  const sa = scoreSide(opts.a);
  const sb = scoreSide(opts.b);
  const names = [...(opts.names || ['A', 'B'])];
  let card = null;
  let view = 0;

  box.innerHTML = `<section class="sc" aria-labelledby="sc-title">
    <h1 id="sc-title">Design scorecard</h1>
    <div class="sc-head">
      <label>Setup A name <input id="sc-name-a" maxlength="40"></label>
      <label>Setup B name <input id="sc-name-b" maxlength="40"></label>
      <label>Channels <select id="sc-view"></select></label>
      <span class="grow"></span>
      <button type="button" class="btn primary" id="sc-export">Export scorecard (JSON + printable HTML)</button>
    </div>
    <div class="sc-warn" role="region" aria-label="Fairness checks"><ul id="sc-fair"></ul></div>
    <p class="sc-overall" id="sc-overall" aria-live="polite"></p>
    <div class="sc-wrap"><table class="sc-table"><caption class="sc-foot" id="sc-cap"></caption>
      <thead><tr><th scope="col">Metric</th><th scope="col" id="sc-col-a"></th><th scope="col" id="sc-col-b"></th><th scope="col">Difference, 95% interval</th><th scope="col">Verdict</th></tr></thead>
      <tbody id="sc-rows"></tbody></table></div>
    <p class="sc-foot" id="sc-weights"></p>
  </section>`;
  const $ = (id) => box.querySelector(`#${id}`);
  $('sc-name-a').value = names[0];
  $('sc-name-b').value = names[1];

  function compute() {
    card = compareRecordings(sa, sb, { ...cmp, names });
    $('sc-view').innerHTML = card.views.map((v, i) => `<option value="${i}">${esc(v.name)}</option>`).join('');
    view = Math.min(view, card.views.length - 1);
    $('sc-view').value = String(view);
    $('sc-fair').innerHTML = card.fairness.map((f) => `<li class="${f.level}" data-code="${esc(f.code)}"><b>${f.level === 'warn' ? '⚠ Check' : 'ℹ Note'}</b>${esc(f.message)}</li>`).join('');
    $('sc-weights').textContent = `Weights (shown so nothing is hidden): ${card.weights.map((w) => `${w.label} ${w.weight}`).join(', ')}; total ${card.totalWeight}. A row gives its weight to a side only when its 95% interval excludes no difference. Intervals come from ${card.boot} bootstrap resamples of the repetitions, rest periods and 5 s blocks${card.pooled ? ', and of whole recordings in each side' : ''}. They describe ${card.pooled ? `these ${card.a.pool.recordings + card.b.pool.recordings} recordings` : 'these two recordings'}, not every arm or every day.`;
    render();
  }

  function render() {
    const v = card.views[view];
    const [A, B] = card.names.map(esc);
    // Pooled columns carry their counts so a mean of 4 sessions never reads like one session.
    const count = (p) => (card.pooled ? `<div class="sc-foot sc-count">${p.recordings} recording${p.recordings === 1 ? '' : 's'}, ${p.volunteers} volunteer${p.volunteers === 1 ? '' : 's'}${p.unknownPeople ? ` + ${p.unknownPeople} unknown` : ''}</div>` : '');
    $('sc-col-a').innerHTML = `A: ${A}${count(card.a.pool)}`;
    $('sc-col-b').innerHTML = `B: ${B}${count(card.b.pool)}`;
    $('sc-cap').textContent = `${v.name}: ${A === B ? 'same name on both sides; ' : ''}each row compares B with A.`;
    $('sc-overall').textContent = v.overall.sentence;
    $('sc-rows').innerHTML = v.rows.map((r) => {
      const chip = r.verdict === 'A' || r.verdict === 'B' ? 'win' : r.verdict;
      const diff = r.scale === 'ratio' ? `${B} ÷ ${A}` : `${B} − ${A}`;
      return `<tr data-key="${r.key}" data-verdict="${r.verdict}">
        <th scope="row">${esc(r.label)}<div class="sc-foot">${r.direction === 'higher' ? '▲ higher' : '▼ lower'} is better · weight ${r.weight}</div></th>
        <td class="num">${esc(fmt(r.a))}${esc(unitOf(r))}</td>
        <td class="num">${esc(fmt(r.b))}${esc(unitOf(r))}</td>
        <td>${intervalSVG(r)}<span class="sc-foot">${diff}: ${esc(fmt(r.effect))}${r.scale === 'ratio' ? '×' : ''} (${esc(fmt(r.lo))} to ${esc(fmt(r.hi))})</span></td>
        <td><span class="sc-chip ${chip}">${esc(verdictText(r, card.names))}</span><p class="sc-sentence">${esc(r.sentence)}</p></td>
      </tr>`;
    }).join('');
  }

  function save(name, text, type) {
    if (opts.download) { opts.download(name, text, type); return; }
    const a = doc.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const onName = () => {
    names[0] = $('sc-name-a').value.trim() || 'A';
    names[1] = $('sc-name-b').value.trim() || 'B';
    compute();
    say(`Scorecard updated: ${names[0]} vs ${names[1]}.`);
  };
  const onView = () => { view = Number($('sc-view').value) || 0; render(); say(`Showing ${card.views[view].name}. ${card.views[view].overall.sentence}`); };
  const onExport = () => {
    const base = `scorecard_${safeName(card.names[0])}_vs_${safeName(card.names[1])}`;
    save(`${base}.json`, scorecardJSON(card), 'application/json');
    save(`${base}.html`, scorecardHTML(card), 'text/html');
    say(`Saved ${base}.json and ${base}.html to your Downloads folder.`);
  };
  $('sc-name-a').addEventListener('change', onName);
  $('sc-name-b').addEventListener('change', onName);
  $('sc-view').addEventListener('change', onView);
  $('sc-export').addEventListener('click', onExport);
  compute();

  return {
    get card() { return card; },
    destroy() { box.innerHTML = ''; },
  };
}
