// ui/review.js: Review and save (spec §10.1-10.3) plus the two pieces Files reuses: the
// whole-recording overview plot and the plain-words quality report with the Doctor's fix lines.
//
// Contract
//   reportHTML(report, names, sensors?) -> string   analyzeRecording() result as HTML:
//     header "✕ n to fix · ▲ n to check · ✓ n OK", the assumed-rate line, then "Whole recording"
//     (channel null) and one group per channel ("ch1 · FMG"), red → amber → green. Follow-ons
//     (green items with causedBy) sit under their root item, not as separate findings. Every
//     non-green item shows its Doctor `fix` line. DOM: .rpt[data-fix][data-check][data-ok],
//     .rgroup[data-channel], .ritem[data-code][data-level][data-channel], .fixline, .follow li[data-code].
//   doctorHTML(report, extra = '') -> string   the "Hardware Doctor" card (#doctor): one row per
//     red/amber item with its fix; extra is HTML appended inside the card (Files: the #ab-hook).
//   drawOverview(box, rec) -> { redraw(), destroy() }   static plot of the whole recording, one lane
//     per channel (≤ 8), min/max per pixel column, grey bands where a gesture label is active.
//   mountReview(root, ctx, app)   ctx: { session, handoff, saver } from Record, or
//     { recovered, recoveredId } from the Start banner, or { file: { rec, name }, back } from Files.
//     Export now (primary) validates the form with validateMeta, then app.download()s
//     opengrip_<id>_<yyyymmdd-hhmm>.csv (toCSV) and .report.json (sidecarJSON) and marks the stored
//     session complete. Delete… asks in the page (#rv-confirm) and deletes the stored session.
//     Add to comparison (#rv-compare) puts this recording in app.compare; B opens the Scorecard
//     once two are in, Esc there comes back here. #rv-xp holds the Export for ML tools panel.
//     Form order (card N7): volunteer code, how the band felt, notes, Save to this computer, then
//     details#rv-more "More details" (sensor per channel, placement, setup name, Delete…), folded in
//     Simple and open in Advanced. After a save #rv-finish holds #rv-again (primary, focused; keeps
//     the code via app.lastPerson), #rv-next (clears it) and #rv-home; a Files review gets only
//     #rv-home. The step bar marks Save done and the guide line says what's next.
//     DOM kept for older walks: #rv-count[data-n], #rv-recovered.
//     #rv-bodyhost (above #doctor) holds the Body card (fingerprint-view.js: pins + fingerprints).
//     #rv-fit (after #rv-report) says the Fit check's result or that Fit was skipped, from
//     handoff.fit (card A1); absent when there is no fit data. The report gets it as meta.fit.

import { analyzeRecording } from '../quality.js';
import { compareDrift } from '../drift.js';
import { checkSummary } from '../placement.js';
import { toCSV, sidecarJSON, validateMeta, SENSOR_TYPES } from '../csv.js';
import { deleteSession } from '../store.js';
import { REVIEW as W, STATUS, SHELL, RECOVER, COMPARE, QUALITY, PLAIN, REPORT, sensorName } from './words.js';
import { sessionReportHTML } from '../report.js';
import { statusIcon } from './icons.js';
import { labelKind, MAX_LANES } from './plot.js';
import { esc, whyHTML } from './dom.js';
import { mountExportPanel } from './export-panel.js';
import { mountBodyCard } from './fingerprint-view.js';

const STATUS_OF = { red: 'fix', amber: 'check', green: 'ok' };
const RANK = { red: 0, amber: 1, green: 2 };

// { startRest: 8, endRest: 60, holds: [..] } -> "startRest 8, endRest 60, holds 2". Plain numbers only.
function numbersText(why) {
  if (!why || typeof why !== 'object') return '';
  return Object.entries(why).filter(([, v]) => v != null).map(([k, v]) => `${k} ${Array.isArray(v) ? v.length : typeof v === 'object' ? '…' : v}`).join(', ');
}

function itemHTML(it, follows, name) {
  const st = STATUS_OF[it.level];
  // Simple: the Doctor's fix line names the sensor in plain words, and codes whose fix uses
  // jargon get a plain fix from PLAIN; Advanced keeps the Doctor's own line.
  const simpleMode = document.body.dataset.mode !== 'advanced';
  const pFix = PLAIN[it.code]?.fix;
  const fixText = !it.fix || !simpleMode ? it.fix
    : pFix ? pFix(sensorName(name))
    : name ? it.fix.replace(new RegExp(`\\b${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), sensorName(name)) : it.fix;
  const fix = it.level !== 'green' && fixText ? `<p class="fixline"><b>${esc(W.fixPrefix)}</b> ${esc(fixText)}</p>` : '';
  const fl = follows.length ? `<div class="follow"><span class="muted">${esc(W.followTitle)}</span><ul>${follows.map((f) => `<li data-code="${esc(f.code)}">${esc(QUALITY.followOn(f.code))} ${whyHTML(f.message, QUALITY.why)}</li>`).join('')}</ul></div>` : '';
  const show = it.at != null && it.level !== 'green' ? ` <span class="muted mono">${esc(W.atSample(it.at))}</span>` : '';
  const p = PLAIN[it.code];
  // Findings with no plain sentence (per-sensor burst stats, mains-hum notes) are for Advanced only.
  const adv = p?.adv ? ' adv' : '';
  const plain = p?.say ? p.say(sensorName(name)) : it.message;
  // it.why (drift items): the numbers behind the finding, appended so "Why?" shows them too.
  const nums = numbersText(it.why);
  const why = p?.say || nums ? whyHTML([p?.say && p.why, p?.say && it.message, nums].filter(Boolean).join(' · '), QUALITY.why) : '';
  return `<li class="ritem${adv}" data-code="${esc(it.code)}" data-level="${it.level}" data-channel="${it.channel ?? ''}">
    <span class="st" data-status="${st}">${statusIcon(st)} ${esc(STATUS[st])}</span> <span class="msg">${esc(plain)}</span>${why}${show}${fix}${fl}</li>`;
}

export function reportHTML(report, names, sensors = []) {
  const items = report.items;
  // Follow-ons are not findings of their own: shown under the root, never counted.
  const isFollow = (it) => it.causedBy && it.level === 'green';
  const main = items.filter((it) => !isFollow(it));
  const n = (l) => main.filter((it) => it.level === l).length;
  const groups = [null, ...names.map((_, c) => c)].map((c) => {
    const list = main.filter((it) => it.channel === c).sort((a, b) => RANK[a.level] - RANK[b.level]);
    if (!list.length) return '';
    // Simple heads say "Sensor 1" with no FMG / EMG (simplify-spec §6); Advanced keeps the file's name and kind.
    const adv = document.body.dataset.mode === 'advanced';
    const head = c == null ? W.whole : adv ? `${names[c]}${sensors[c] && sensors[c] !== 'unknown' ? ` · ${sensors[c]}` : ''}` : sensorName(names[c]);
    const body = list.map((it) => itemHTML(it, items.filter((f) => isFollow(f) && f.channel === c && f.causedBy === it.code), c == null ? '' : names[c])).join('');
    return `<section class="rgroup" data-channel="${c ?? ''}"><h3>${esc(head)}</h3><ul>${body}</ul></section>`;
  }).join('');
  const clean = !n('red') && !n('amber');
  return `<div class="rpt" data-fix="${n('red')}" data-check="${n('amber')}" data-ok="${n('green')}">
    <p class="rhead">${clean ? `<span class="st" data-status="ok">${statusIcon('ok')} ${esc(W.clean)}</span>` : esc(W.header(n('red'), n('amber'), n('green')))}</p>
    ${report.assumedRate ? `<p class="muted">${esc(W.assumed(report.assumedRate))}</p>` : ''}${groups}</div>`;
}

export function doctorHTML(report, extra = '') {
  const rows = report.items.filter((it) => it.level !== 'green' && it.fix);
  const body = rows.length
    ? `<ul>${rows.map((it) => { const st = STATUS_OF[it.level]; return `<li data-code="${esc(it.code)}"><span class="st" data-status="${st}">${statusIcon(st)} ${esc(STATUS[st])}</span> ${esc(it.fix)}</li>`; }).join('')}</ul>`
    : `<p class="muted">${esc(W.doctorNone)}</p>`;
  return `<section class="card" id="doctor" aria-labelledby="doctor-h"><h2 id="doctor-h">${esc(W.doctorTitle)}</h2>${body}${extra}</section>`;
}

export function drawOverview(box, rec) {
  const cv = document.createElement('canvas');
  box.replaceChildren(cv);
  const lanes = Math.min(rec.data.length, MAX_LANES);
  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(200, box.clientWidth);
    const laneH = 40;
    const h = Math.max(1, lanes) * laneH;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(box);
    const col = (v, d) => css.getPropertyValue(v).trim() || d;
    g.clearRect(0, 0, w, h);
    const n = rec.t.length;
    if (!n) return;
    const xOf = (i) => (i / Math.max(1, n - 1)) * w;
    // Label bands first so the trace stays on top.
    g.fillStyle = col('--band', 'rgba(148,163,184,.1)');
    let s = null;
    for (let i = 0; i <= n; i++) {
      const on = i < n && labelKind(rec.labels?.[i]) === 'active';
      if (on && s == null) s = i;
      if (!on && s != null) { g.fillRect(xOf(s), 0, Math.max(1, xOf(i) - xOf(s)), h); s = null; }
    }
    g.strokeStyle = col('--trace', '#cbd5e1');
    g.lineWidth = 1;
    for (let c = 0; c < lanes; c++) {
      const v = rec.data[c];
      let lo = Infinity, hi = -Infinity;
      for (const x of v) { if (x < lo) lo = x; if (x > hi) hi = x; }
      const span = Math.max(40, hi - lo);
      const y0 = c * laneH + 3, yh = laneH - 6;
      const yOf = (x) => y0 + yh - ((x - lo) / span) * yh;
      g.beginPath();
      for (let px = 0; px < w; px++) {
        const a = Math.floor((px / w) * n), b = Math.max(a + 1, Math.floor(((px + 1) / w) * n));
        let mn = Infinity, mx = -Infinity;
        for (let i = a; i < b && i < n; i++) { if (v[i] < mn) mn = v[i]; if (v[i] > mx) mx = v[i]; }
        if (mn === Infinity) continue;
        g.moveTo(px + 0.5, yOf(mx)); g.lineTo(px + 0.5, yOf(mn) + 0.5);
      }
      g.stroke();
      g.fillStyle = col('--muted', '#94a3b8');
      g.font = '11px ui-monospace, monospace';
      g.fillText(rec.channelNames?.[c] || `ch${c + 1}`, 4, y0 + 10);
      g.fillStyle = col('--band', 'rgba(148,163,184,.1)');
    }
  };
  const ro = new ResizeObserver(draw);
  ro.observe(box);
  draw();
  return { redraw: draw, destroy() { ro.disconnect(); } };
}

const pad2 = (x) => String(x).padStart(2, '0');
function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

// Card L1b: the live strip and this report use the same drift measure, but the report sees the
// whole session (the end window moves on), so say so only where the two differ.
// Card A1: the Fit page's result, carried on the handoff (app.js). Nothing for a file from Files
// or a session that never opened Fit (fit is undefined): the old screen stays as it was.
// Wording lives here until words.js (another card's file) takes it.
function fitLineHTML(fit) {
  if (!fit) return '';
  const t = fit.checks?.length ? `Fit check: ${checkSummary(fit.checks).text}` : fit.skipped ? 'Fit was skipped: no placement check before this recording.' : '';
  return t ? `<p class="muted" id="rv-fit" data-skipped="${fit.checks?.length ? 'false' : 'true'}">${esc(t)}</p>` : '';
}
function driftDiffHTML(live, items, names) {
  if (!Array.isArray(live) || !live.length) return '';
  const diff = compareDrift(live, items);
  if (!diff.length) return '';
  return `<p class="small muted" id="rv-drift-diff">${diff.map((d) => esc(`${names[d.channel] || `ch${d.channel + 1}`}: drift ${d.note}.`)).join(' ')}</p>`;
}

export function mountReview(root, ctx, a) {
  const h = ctx.handoff;
  const rec = ctx.file?.rec || ctx.recovered || ctx.session?.recording();
  const names = rec.channelNames || rec.data.map((_, i) => `ch${i + 1}`);
  const m0 = rec.meta || {};
  const sens0 = String(m0.sensors || '').split(',').map((s) => s.trim());
  const sensors = names.map((_, i) => (SENSOR_TYPES.includes(sens0[i]) ? sens0[i] : 'unknown'));
  const report = analyzeRecording(rec);
  const n = rec.t.length;
  const durS = n > 1 && rec.t[n - 1] != null ? Math.round((rec.t[n - 1] - rec.t[0]) / 1000) : null;
  const stored = !ctx.file && (ctx.saver || ctx.recoveredId);
  const tight = ['loose', 'snug', 'tight', ''];
  // Simple folds the details a lab fills in later; Advanced opens them (simplify-spec §4).
  const advanced = document.body.dataset.mode === 'advanced';
  // A new take of the same person ("Record again") keeps the code; "Next volunteer" clears it.
  const pid0 = m0.person_id || (ctx.session && a.lastPerson) || '';

  root.innerHTML = `<section class="screen review" aria-labelledby="rv-h">
    <div class="rv-main">
      <h1 id="rv-h">${esc(ctx.file ? W.fileTitle(ctx.file.name) : SHELL.screens.review)}${ctx.recovered ? ` <span class="chip" id="rv-recovered">${esc(RECOVER.recovered)}</span>` : ''}</h1>
      <p class="muted"><span id="rv-count" class="num" data-n="${n}">${esc(W.summary(n, names.length, durS))}</span> ${whyHTML(W.summaryWhy(n, names.length, durS, rec.markers?.length || 0), QUALITY.why)}</p>
      <div class="overview" id="rv-plot" role="img" aria-label="${esc(W.plotLabel(names.length))}"></div>
      <div id="rv-report">${reportHTML(report, names, sensors)}${driftDiffHTML(ctx.liveDrift, report.items, names)}</div>${fitLineHTML(h?.fit)}
      <p class="row-btns"><button class="btn" type="button" id="rv-back">${esc(ctx.back ? W.backFiles : W.backStart)}</button>
        <button class="btn adv" type="button" id="rv-compare">${esc(W.addCompare)}</button></p>
      <div class="card" id="rv-confirm" role="alertdialog" aria-labelledby="rv-confirm-h" hidden>
        <h2 id="rv-confirm-h">${esc(W.delTitle)}</h2><p>${esc(W.delBody(n))}</p>
        <p class="dlg-row"><button class="btn" type="button" id="rv-keep">${esc(W.keep)}</button>
        <button class="btn danger" type="button" id="rv-del-yes">${esc(W.delYes)}</button></p></div>
      <dialog id="rv-guard" aria-labelledby="rv-guard-h" aria-describedby="rv-guard-p"><h2 id="rv-guard-h">${esc(W.guardTitle)}</h2><p id="rv-guard-p"></p>
        <form method="dialog" class="dlg-row"><button class="btn primary" value="save" id="rv-g-save">${esc(W.guardSave)}</button>
        <button class="btn" value="leave" id="rv-g-leave">${esc(W.guardLeave)}</button>
        <button class="btn" value="stay" id="rv-g-stay">${esc(W.guardStay)} <span class="key">Esc</span></button></form></dialog>
    </div>
    <aside class="rv-side">
      <form class="card rv-form" id="rv-form" novalidate>
        <h2>${esc(W.saveTitle)}</h2>
        <label for="rv-pid">${esc(W.pid)} *</label>
        <input id="rv-pid" name="person_id" autocomplete="off" spellcheck="false" maxlength="24" value="${esc(pid0)}" aria-describedby="rv-pid-hint rv-pid-err">
        <p class="hint" id="rv-pid-hint">${esc(W.pidHint)}</p>
        <p class="err" id="rv-pid-err" hidden></p>
        <fieldset><legend>${esc(W.tightness)}</legend>${tight.map((v) => `<label><input type="radio" name="tight" value="${v}"${(m0.tightness || '') === v ? ' checked' : ''}> ${esc(W.tight[v || 'none'])}</label>`).join(' ')}</fieldset>
        <label for="rv-notes">${esc(W.notes)}</label>
        <textarea id="rv-notes" rows="3">${esc(m0.notes || '')}</textarea>
        <div id="rv-saved-area"><button class="btn primary big" type="submit" id="rv-export">${esc(W.exportNow)}</button>
          <p class="hint">${esc(W.exportHint)}</p></div>
        <details class="more-details" id="rv-more"${advanced ? ' open' : ''}><summary>${esc(W.moreDetails)}</summary>
          <fieldset><legend>${esc(W.sensors)}</legend>
          <p class="row-btns">${esc(W.setAll)} <button class="btn" type="button" data-all="FMG">FMG</button> <button class="btn" type="button" data-all="EMG">EMG</button></p>
          <div class="sens">${names.map((nm, i) => `<label>${esc(nm)} <select data-ch="${i}">${SENSOR_TYPES.map((s) => `<option${s === sensors[i] ? ' selected' : ''}>${s}</option>`).join('')}</select></label>`).join('')}</div>
          </fieldset>
          <label for="rv-place">${esc(W.placement)}</label>
          <input id="rv-place" maxlength="200" placeholder="${esc(W.placementPh)}" value="${esc(m0.placement || '')}">
          <label for="rv-setup">${esc(W.setup)}</label>
          <input id="rv-setup" maxlength="40" value="${esc(m0.setup || '')}"><p class="hint">${esc(W.setupHint)}</p>
          ${stored ? `<p class="row-btns"><button class="btn danger" type="button" id="rv-del">${esc(W.del)}</button></p>` : ''}
        </details>
      </form>
      <div id="rv-bodyhost" class="adv"></div>
      ${doctorHTML(report)}
      <div class="card adv" id="rv-xp"></div>
    </aside></section>`;

  const $ = (s) => root.querySelector(s);
  const plot = drawOverview($('#rv-plot'), rec);
  // Body card (card B5): above the Doctor card; the handoff's places win over the file's.
  const bodyCard = mountBodyCard($('#rv-bodyhost'), rec, { report, placement: h?.placement || undefined, synthetic: h?.synthetic });
  const meta = () => ({
    person_id: $('#rv-pid').value.trim(),
    sensors: [...root.querySelectorAll('select[data-ch]')].map((s) => s.value).join(','),
    placement: $('#rv-place').value.trim(),
    tightness: root.querySelector('input[name="tight"]:checked')?.value || '',
    setup: $('#rv-setup').value.trim(),
    notes: $('#rv-notes').value.trim(),
  });
  const check = () => {
    const errs = validateMeta(meta());
    const el = $('#rv-pid-err');
    el.hidden = !errs.length;
    el.innerHTML = errs.length ? `${statusIcon('fix')} ${esc(errs.join(' '))}` : '';
    $('#rv-pid').setAttribute('aria-invalid', errs.length ? 'true' : 'false');
    return errs;
  };
  $('#rv-pid').addEventListener('blur', check);
  root.querySelectorAll('[data-all]').forEach((b) => { b.onclick = () => root.querySelectorAll('select[data-ch]').forEach((s) => { s.value = b.dataset.all; }); });

  // ctx.saved survives the Scorecard round trip (it remounts Review with the same ctx).
  let saved = !!ctx.saved;
  const markDone = async () => {
    try {
      if (ctx.saver) await ctx.saver.finish();
      else if (ctx.recoveredId) {
        const be = await a.store();
        const s = be && await be.get('sessions', ctx.recoveredId);
        if (s) await be.put('sessions', ctx.recoveredId, { ...s, complete: true });
      }
    } catch (e) { console.warn('mark complete failed', e); }
  };
  $('#rv-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const errs = check();
    if (errs.length) { $('#rv-pid').focus(); a.say(W.cantSave, true); return; }
    const m = meta();
    const base = `opengrip_${m.person_id}_${stamp(Date.parse(m0.started_at) || Date.now())}`;
    try {
      a.download(`${base}.csv`, toCSV(rec, m));
      a.download(`${base}.report.json`, sidecarJSON(report, { ...m0, ...m }));
    } catch (e) { a.say(W.blocked, true); return; }
    saved = true;
    ctx.saved = true;
    markDone();
    // Finish actions (simplify-spec §8 "Saved"): the next thing to do replaces the Save button.
    // Files reviews have no session to continue, so they only get Go home.
    const more = ctx.file ? '' : `<button class="btn primary" type="button" id="rv-again">${esc(W.again)}</button>
      <button class="btn" type="button" id="rv-next">${esc(W.next)}</button>`;
    $('#rv-saved-area').innerHTML = `<p class="good" id="rv-saved" role="status">${statusIcon('ok')} ${esc(W.saved(base))}</p>
      <p class="row-btns" id="rv-finish">${more}<button class="btn${ctx.file ? ' primary' : ''}" type="button" id="rv-home">${esc(W.home)}</button>
        <button class="btn" type="button" id="rv-report-dl">${esc(REPORT.button)}</button></p>`;
    // Card R7: the one-page report reads the same report and form values that were just saved.
    $('#rv-report-dl').onclick = () => {
      const nm = `${base}.report.html`;
      const html = sessionReportHTML(rec, report, { ...m0, ...m, mode: document.body.dataset.mode, synthetic: h?.synthetic ?? m0.synthetic, placement_map: h?.placement || m0.placement_map, liveDrift: ctx.liveDrift, fitChecks: ctx.fitChecks || h?.fitChecks, fit: h?.fit });
      try { a.download(nm, html, 'text/html'); } catch (e) { a.say(W.blocked, true); return; }
      a.say(REPORT.saved(nm));
    };
    const take = (person) => { a.lastPerson = person; a.go('preflight', { mode: a.lastMode || 'demo' }); };
    if (!ctx.file) {
      $('#rv-again').onclick = () => take(m.person_id);
      $('#rv-next').onclick = () => take('');
    }
    $('#rv-home').onclick = () => a.go('start');
    (ctx.file ? $('#rv-home') : $('#rv-again')).focus({ preventScroll: true });
    a.setStep?.(4, 'done');
    a.setGuide?.(W.finishGuide);
    a.say(W.saved(base));
  });

  const xp = mountExportPanel($('#rv-xp'), { recordings: () => [{ recording: rec, meta: { ...m0, ...meta() } }], download: (nm, b, t) => a.download(nm, b, t), say: (t, u) => a.say(t, u) });
  const compareName = () => $('#rv-setup').value.trim() || ctx.file?.name || $('#rv-pid').value.trim() || `Recording ${a.compare.length + 1}`;
  $('#rv-compare').onclick = () => a.addToCompare(rec, compareName());
  // Esc on the Scorecard remounts this Review with the same ctx.
  const scorecard = () => (a.compare.length < 2 ? a.say(COMPARE.needTwo) : a.openScorecard(a.compare[0], a.compare[1], () => a.go('review', ctx)));

  // Save guard (simplify-spec §3.4): leaving a recording that isn't in a file yet asks first, in
  // page (never window.confirm). "Leave, keep it for later" keeps the autosave, so Home shows it
  // as not saved yet. A file opened from Files is already on disk: no guard.
  const guard = $('#rv-guard');
  const lenText = (sec) => (sec == null ? '' : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);
  let pending = null;
  const leave = (fn) => {
    if (saved || ctx.file) { fn(); return true; }
    if (guard.open) return true;
    pending = fn;
    $('#rv-guard-p').textContent = W.guardBody(lenText(durS), $('#rv-pid').value.trim());
    guard.returnValue = ''; // Esc closes without a value: Stay here
    guard.showModal();
    $('#rv-g-save').focus();
    return true;
  };
  guard.addEventListener('close', () => {
    const fn = pending;
    pending = null;
    if (guard.returnValue === 'save') { $('#rv-form').requestSubmit(); if (saved) fn?.(); }
    else if (guard.returnValue === 'leave') fn?.();
    else $('#rv-export').focus({ preventScroll: true });
  });
  const back = () => leave(() => (ctx.back ? ctx.back() : a.go('start')));
  $('#rv-back').onclick = back;
  // Shell Back is a new take (spec §3.3: Save -> Record) unless Review came from Files or Home.
  const backStep = () => leave(() => (ctx.back ? ctx.back() : ctx.recovered ? a.go('start') : a.go('preflight', { mode: a.lastMode || 'demo' })));
  const nav = { home: () => leave(() => a.go('start')), back: backStep, step: () => leave(() => a.go('preflight', { mode: a.lastMode || 'demo' })) };
  const conf = $('#rv-confirm');
  if ($('#rv-del')) {
    $('#rv-del').onclick = () => { conf.hidden = false; $('#rv-keep').focus(); };
    $('#rv-keep').onclick = () => { conf.hidden = true; $('#rv-del').focus(); };
    $('#rv-del-yes').onclick = async () => {
      const id = ctx.saver?.id || ctx.recoveredId;
      try { const be = await a.store(); if (be && id) await deleteSession(be, id); } catch (e) { console.warn('delete failed', e); }
      a.say(W.deleted);
      a.go('start');
    };
  }
  $('#rv-export').focus({ preventScroll: true });
  return {
    keys: { Escape: () => { if (guard.open) return false; if (!conf.hidden) { conf.hidden = true; return; } back(); }, b: scorecard },
    nav,
    get saved() { return saved; },
    unmount() { plot.destroy(); bodyCard.destroy(); xp.destroy(); h?.onSample(null); h?.stop(); },
  };
}
