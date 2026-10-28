// One-page session report (card R7): a self-contained HTML file the club can print or share.
//
// Contract:
//   sessionReportHTML(rec, report, meta = {}) -> string   a whole HTML document. Pure: no DOM, no clock.
//     rec: a recording { t, data, channelNames?, rateHz?, labels?, meta?, synthetic? }.
//     report: analyzeRecording(rec) (quality.js; its items already include the drift items).
//     meta (all optional; each falls back to rec.meta):
//       mode: 'simple' (default) | 'advanced'. Simple uses PLAIN / sensorName words only;
//         Advanced adds the file's channel names, sensor kinds, Doctor messages and numbers.
//       person_id: printed only when validateMeta (csv.js) accepts it as a code; anything else
//         (a name, empty) prints REPORT.noCode, so a name never reaches the page.
//       started_at (ISO string or ms), setup, sensors ('FMG,EMG,..' or array), tightness,
//       placement (free text), placement_map (placement.js object; Advanced prints its summary),
//       synthetic (bool; also read from rec.synthetic / rec.meta.synthetic / meta.source 'twin'),
//       liveDrift (DriftTracker items seen live; compareDrift notes when they differ),
//       fitChecks (checkPlacement() results, if a fit check was done), fit ({ checks, skipped, at }
//       from the Fit page, card A1: skipped with no checks reads "Fit was skipped"; no fit at all,
//       e.g. a file from Files, keeps "no fit check was done").
//   The output has no <script>, no external URL (no src/href to http, no @import, no url()),
//   only inline CSS with a @media print sheet; every value from the recording goes through esc().
//   Never throws on missing fields; an empty recording gives a valid page with no plots.

import { validateMeta, APP_VERSION } from './csv.js';
import { compareDrift } from './drift.js';
import { placementSummary } from './placement.js';
import { REPORT as W, PLAIN, STATUS, sensorName } from './ui/words.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escHTML = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const STATUS_OF = { red: 'fix', amber: 'check', green: 'ok' };
const RANK = { red: 0, amber: 1, green: 2 };
const DRIFT_CODES = new Set(['rest_drift', 'hold_creep']);
const SENSOR_KINDS = ['FMG', 'EMG', 'both'];
const PLOT_W = 600;
const PLOT_H = 60;
const PLOT_PTS = 300;

export function reportCode(id) {
  const s = String(id ?? '').trim();
  // Only the person-ID rule: sensors are checked elsewhere, and a bad code must never print.
  return s && !validateMeta({ person_id: s }).length ? s : null;
}

function isSynthetic(rec, m) {
  const t = (v) => v === true || v === 'true';
  return t(m.synthetic) || t(rec.synthetic) || t(rec.meta?.synthetic) || m.source === 'twin' || rec.meta?.source === 'twin';
}

// ISO date + minute in UTC, so the same recording prints the same page on any computer.
function dateText(v) {
  const ms = typeof v === 'number' ? v : Date.parse(v || '');
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : W.noDate;
}

// Min/max per bucket keeps spikes and dropouts visible after shrinking thousands of samples to 300 columns.
export function sparkPath(values, w = PLOT_W, h = PLOT_H) {
  const v = (values || []).map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : null));
  const ok = v.filter((x) => x != null);
  if (!ok.length) return '';
  let lo = Infinity; let hi = -Infinity;
  for (const x of ok) { if (x < lo) lo = x; if (x > hi) hi = x; }
  const span = hi - lo || 1;
  const n = v.length;
  const buckets = Math.min(PLOT_PTS, n);
  const y = (x) => (h - 2 - ((x - lo) / span) * (h - 4)).toFixed(1);
  let d = ''; let pen = false;
  for (let b = 0; b < buckets; b++) {
    const a = Math.floor((b * n) / buckets); const e = Math.max(a + 1, Math.floor(((b + 1) * n) / buckets));
    let mn = Infinity; let mx = -Infinity;
    for (let i = a; i < e; i++) if (v[i] != null) { if (v[i] < mn) mn = v[i]; if (v[i] > mx) mx = v[i]; }
    // A bucket with no readings breaks the line, so a gap looks like a gap.
    if (mn === Infinity) { pen = false; continue; }
    const x = ((b + 0.5) * w / buckets).toFixed(1);
    d += `${pen ? 'L' : 'M'}${x} ${y(mx)}L${x} ${y(mn)}`;
    pen = true;
  }
  return d;
}

function plotSVG(values, label) {
  const d = sparkPath(values);
  return `<svg class="plot" viewBox="0 0 ${PLOT_W} ${PLOT_H}" preserveAspectRatio="none" role="img" aria-label="${escHTML(label)}"><rect x="0" y="0" width="${PLOT_W}" height="${PLOT_H}" fill="none" stroke="#bbb"/>${d ? `<path d="${d}" fill="none" stroke="#1d4f91" stroke-width="1" vector-effect="non-scaling-stroke"/>` : ''}</svg>`;
}

const numbersText = (why) => (!why || typeof why !== 'object' ? ''
  : Object.entries(why).filter(([, v]) => v != null).map(([k, v]) => `${k} ${Array.isArray(v) ? v.length : typeof v === 'object' ? '…' : v}`).join(', '));

function itemLine(it, name, adv) {
  const st = STATUS_OF[it.level] || 'check';
  const p = PLAIN[it.code];
  const label = name ? sensorName(name) : '';
  let msg; let fix = it.fix || '';
  if (adv) {
    msg = it.message || '';
    const nums = numbersText(it.why);
    if (nums) msg += ` (${nums})`;
  } else {
    msg = p?.say ? p.say(label || 'This sensor') : it.message || '';
    // Same rule as the Save screen: a plain fix where one exists, else the Doctor's line with the sensor's plain name.
    if (fix && p?.fix) fix = p.fix(label || 'the sensor');
    else if (fix && name) fix = fix.replace(new RegExp(`\\b${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), label);
  }
  const fixHTML = it.level !== 'green' && fix ? `<p class="fix"><b>${escHTML(W.fix)}</b> ${escHTML(fix)}</p>` : '';
  return `<li data-code="${escHTML(it.code)}" data-status="${st}"><span class="st st-${st}">${escHTML(STATUS[st])}</span> ${escHTML(msg)}${fixHTML}</li>`;
}

function groupsHTML(items, names, adv, kinds) {
  return [null, ...names.map((_, c) => c)].map((c) => {
    const list = items.filter((it) => (it.channel ?? null) === c).sort((a, b) => RANK[a.level] - RANK[b.level]);
    if (!list.length) return '';
    const head = c == null ? W.whole : adv ? `${names[c]}${kinds[c] ? ` · ${kinds[c]}` : ''}` : sensorName(names[c]);
    return `<h3>${escHTML(head)}</h3><ul>${list.map((it) => itemLine(it, c == null ? '' : names[c], adv)).join('')}</ul>`;
  }).join('');
}

const CSS = `
*{box-sizing:border-box}body{font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;background:#fff;margin:0}
main{max-width:46rem;margin:0 auto;padding:1.5rem}h1{font-size:1.5rem;margin:0 0 .5rem}h2{font-size:1.1rem;margin:1.2rem 0 .4rem;border-bottom:1px solid #ccc}
h3{font-size:.95rem;margin:.7rem 0 .2rem}ul{margin:.2rem 0;padding-left:1.1rem}li{margin:.15rem 0}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.15rem 1rem;margin:0}dt{font-weight:600}dd{margin:0}
.banner{border:2px solid #8a5a00;background:#fff4d6;color:#4a3000;padding:.5rem .75rem;font-weight:700;margin:.5rem 0}
.st{font-weight:700}.st-fix{color:#a00}.st-check{color:#8a5a00}.st-ok{color:#185e20}.fix{margin:.1rem 0 .3rem}
.muted{color:#555}.plot{display:block;width:100%;height:60px}figure{margin:.3rem 0}figcaption{font-size:.85rem}
@media print{@page{size:A4;margin:12mm}main{max-width:none;padding:0}h2{break-after:avoid}figure,li{break-inside:avoid}.banner{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;

export function sessionReportHTML(rec, report, meta = {}) {
  const r = rec || {};
  const m = { ...(r.meta || {}), ...(meta || {}) };
  const adv = m.mode === 'advanced';
  const data = Array.isArray(r.data) ? r.data : [];
  const names = r.channelNames || data.map((_, i) => `ch${i + 1}`);
  const kinds0 = Array.isArray(m.sensors) ? m.sensors : String(m.sensors || '').split(',').map((s) => s.trim());
  const kinds = names.map((_, i) => (SENSOR_KINDS.includes(kinds0[i]) ? kinds0[i] : ''));
  const t = r.t || [];
  const n = t.length;
  const sec = n > 1 && t[n - 1] != null && t[0] != null ? Math.round((t[n - 1] - t[0]) / 1000) : null;
  const items = report?.items || [];
  // Follow-ons are not findings of their own; Simple hides Advanced-only codes (as on screen).
  const shown = items.filter((it) => !(it.causedBy && it.level === 'green') && (adv || !PLAIN[it.code]?.adv));
  const doctor = shown.filter((it) => !DRIFT_CODES.has(it.code));
  const drift = shown.filter((it) => DRIFT_CODES.has(it.code));
  const cnt = (l) => doctor.filter((it) => it.level === l).length;
  const code = reportCode(m.person_id);

  const row = (k, v) => `<dt>${escHTML(k)}</dt><dd>${escHTML(v)}</dd>`;
  const sensorsVal = adv ? names.map((nm, i) => `${nm}${kinds[i] ? ` (${kinds[i]})` : ''}`).join(', ') : `${W.sensorsVal(names.length)}: ${names.map(sensorName).join(', ')}`;
  const pmap = adv && m.placement_map && typeof m.placement_map === 'object' ? placementSummary(m.placement_map) : '';
  const facts = [
    row(W.code, code || W.noCode),
    row(W.date, dateText(m.started_at)),
    row(W.length, W.lengthVal(sec, n)),
    adv && r.rateHz ? row(W.rate, `${Math.round(r.rateHz)}`) : '',
    m.setup ? row(W.setup, m.setup) : '',
    row(W.sensors, sensorsVal),
    m.tightness ? row(W.band, m.tightness) : '',
    m.placement ? row(W.placement, m.placement) : '',
    pmap ? row(W.placement, pmap) : '',
  ].join('');

  const clean = !cnt('red') && !cnt('amber');
  const doctorBody = `<p>${escHTML(clean ? W.clean : W.counts(cnt('red'), cnt('amber'), cnt('green')))}</p>${groupsHTML(doctor, names, adv, kinds)}`;
  const driftBody = drift.some((it) => it.level !== 'green') ? groupsHTML(drift, names, adv, kinds) : `<p>${escHTML(W.driftNone)}</p>`;
  const diff = Array.isArray(m.liveDrift) && m.liveDrift.length ? compareDrift(m.liveDrift, items) : [];
  const plainCode = (s) => (adv ? s : String(s).replace(/\b(rest_drift|hold_creep)\b/g, (c) => PLAIN[c].short.toLowerCase()));
  const diffBody = diff.length ? `<h3>${escHTML(W.liveNote)}</h3><ul>${diff.map((d) => `<li>${escHTML(`${adv ? names[d.channel] || `ch${d.channel + 1}` : sensorName(names[d.channel] || `ch${d.channel + 1}`)}: ${plainCode(d.note)}.`)}</li>`).join('')}</ul>` : '';
  const fits = Array.isArray(m.fitChecks) && m.fitChecks.length ? m.fitChecks : Array.isArray(m.fit?.checks) ? m.fit.checks : [];
  // words.js is not this card's file: the fallback keeps the wording here until it moves there.
  const fitSkipped = W.fitSkipped || 'Fit was skipped: the placement check was not run before this recording.';
  const fitBody = fits.length
    ? `<ul>${fits.map((f) => `<li data-state="${escHTML(f.state)}"><b>${escHTML(`Sensor ${f.ch ?? ''}`)}</b>: ${escHTML(W.fitState[f.state] || f.state)}${f.reason ? ` · ${escHTML(f.reason)}` : ''}${f.state !== 'good' && f.fix ? `<p class="fix"><b>${escHTML(W.fix)}</b> ${escHTML(f.fix)}</p>` : ''}</li>`).join('')}</ul>`
    : m.fit?.skipped ? `<p class="muted" id="fit-skipped">${escHTML(fitSkipped)}</p>` : `<p class="muted">${escHTML(W.fitNone)}</p>`;
  const plots = data.map((vals, c) => {
    const label = adv ? names[c] : sensorName(names[c]);
    return `<figure>${plotSVG(vals, W.plotLabel(label))}<figcaption>${escHTML(label)}</figcaption></figure>`;
  }).join('');

  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHTML(`${W.title}${code ? ` · ${code}` : ''}`)}</title><style>${CSS}</style></head>
<body><main>
<h1>${escHTML(W.title)}</h1>
${isSynthetic(r, m) ? `<p class="banner" id="synthetic">${escHTML(W.synthetic)}</p>` : ''}
<section id="session"><h2>${escHTML(W.session)}</h2><dl>${facts}</dl></section>
<section id="doctor"><h2>${escHTML(W.doctor)}</h2>${doctorBody}</section>
<section id="drift"><h2>${escHTML(W.drift)}</h2>${driftBody}${diffBody}</section>
<section id="fit"><h2>${escHTML(W.fit)}</h2>${fitBody}</section>
<section id="plots"><h2>${escHTML(W.plots)}</h2>${plots}</section>
<p class="muted">${escHTML(W.footer(APP_VERSION))}</p>
</main></body></html>
`;
}
