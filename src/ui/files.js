// ui/files.js: Files, open old logs (spec §10.4). A drop zone plus a picker for .txt/.csv
// (several at once); each file gets its detected format and rate, the overview plot and the
// quality + Hardware Doctor report, drawn with the same pieces as Review (review.js).
//
// Contract
//   recFromText(text) -> { ok, rec?, format, formatName, rate: { hz, approx }|null, reason? }
//     Pure (no DOM). Our own CSV (t_ms header) goes through fromCSV so its metadata survives;
//     anything else through ingestText. A file has no arrival times, so the rate is the device's
//     timestamps, else the header's rate_hz (approx), else unknown (rate null, rec.rateHz null:
//     the report then says timing checks assume 100 Hz).
//   mountFiles(root, ctx, app)   ctx.files: File-like objects ({ name, size, text() }), or
//     ctx.entries (the list kept when coming back from Review), ctx.from (the opener, app.opener():
//     Back, Esc and #fl-back return there via app.goBackTo; none: Home). DOM for tests:
//     #fl-drop, #fl-input, .fl-row[data-name][data-status][data-fix][data-check],
//     #fl-view[data-name] (.fl-head, .overview, the report, #doctor, #ab-hook), #fl-save, #fl-xp.
//   Compare two (#ab-hook) is enabled once two files read; it shows #fl-ab (selects #fl-a, #fl-b,
//   button #fl-ab-go). B opens the Scorecard with those picks (default: this file vs the next);
//   Esc there comes back to Files with the same list. Pooling: #fl-a-add / #fl-b-add add a
//   further pick to that side (#fl-a2, #fl-a3 ..., each with a [data-drop] Remove button);
//   disabled once every readable file is picked. One pick per side calls
//   app.openScorecard({ rec, name }, { rec, name }, back) exactly as before; more calls it with
//   arrays of them. A file picked twice on one side counts once; on both sides app refuses.

import { ingestText } from '../pipeline.js';
import { fromCSV } from '../csv.js';
import { formatName } from '../detect.js';
import { analyzeRecording } from '../quality.js';
import { FILES as W, STATUS, REPORT } from './words.js';
import { sessionReportHTML } from '../report.js';
import { statusIcon } from './icons.js';
import { reportHTML, doctorHTML, drawOverview } from './review.js';
import { esc } from './dom.js';
import { mountExportPanel } from './export-panel.js';

const BIG = 50 * 1024 * 1024;

export function recFromText(text) {
  const s = String(text);
  if (/^t_ms,/m.test(s) && /^# opengrip_studio/m.test(s)) {
    const rec = fromCSV(s);
    const hz = rec.rateHz || Number(rec.meta.rate_hz) || null;
    rec.rateHz = hz;
    return { ok: rec.t.length > 0, rec, format: null, formatName: 'OpenGrip CSV', rate: hz ? { hz, approx: false } : null, reason: rec.t.length ? null : 'no data rows' };
  }
  const r = ingestText(s);
  const f = r.format;
  if (!f || !f.ok || !r.samples.length) return { ok: false, format: f, formatName: formatName(f), rate: null, reason: f?.reason || 'no data rows' };
  let rate = null;
  if (f.hasTime && r.rate?.hz && !r.rate.approx) rate = r.rate;
  else if (Number(r.meta.rate_hz) > 0) rate = { hz: Number(r.meta.rate_hz), approx: true };
  const ch = r.samples[0].values.length;
  const rows = r.samples.filter((x) => x.values.length === ch);
  const hasT = rows.every((x) => x.t != null);
  const rec = {
    meta: r.meta, channels: ch,
    channelNames: (f.names?.length === ch ? f.names : null) || Array.from({ length: ch }, (_, i) => `ch${i + 1}`),
    t: rows.map((x, i) => (hasT ? x.t : rate ? (i * 1000) / rate.hz : null)),
    data: Array.from({ length: ch }, (_, c) => rows.map((x) => x.values[c])),
    labels: rows.map((x) => x.label || null),
    markers: r.markers.map((m) => ({ t: m.t, note: m.note, index: null })),
    rateHz: rate ? rate.hz : null,
  };
  return { ok: true, rec, format: f, formatName: formatName(f), rate };
}

function worst(report) {
  const items = report.items.filter((it) => !(it.causedBy && it.level === 'green'));
  const fix = items.filter((it) => it.level === 'red').length;
  const check = items.filter((it) => it.level === 'amber').length;
  return { fix, check, status: fix ? 'fix' : check ? 'check' : 'ok' };
}

export function mountFiles(root, ctx, a) {
  const entries = ctx.entries || [];
  let cur = ctx.current ?? 0;
  let plot = null;
  let xp = null;
  let alive = true;
  root.innerHTML = `<section class="screen files" aria-labelledby="fl-h">
    <div class="fl-list">
      <h1 id="fl-h">${esc(W.title)} <span id="fl-n" class="muted"></span></h1>
      <label class="btn" for="fl-input">${esc(W.add)}</label>
      <input type="file" id="fl-input" accept=".txt,.csv,text/plain,text/csv" multiple class="vh">
      <ul id="fl-rows" role="listbox" aria-labelledby="fl-h"></ul>
      <div id="fl-drop" class="drop" tabindex="0">${esc(W.drop)}</div>
      <p class="row-btns"><button class="btn" type="button" id="fl-back">${esc(W.back)}</button></p>
    </div>
    <div class="fl-view" id="fl-view" aria-live="polite"></div></section>`;
  const $ = (s) => root.querySelector(s);

  const rowHTML = (e, i) => {
    const st = e.reading ? 'busy' : e.error ? 'fix' : e.sum.status;
    const cnt = e.reading || e.error ? '' : e.sum.fix ? ` ${e.sum.fix}` : e.sum.check ? ` ${e.sum.check}` : '';
    const word = e.reading ? W.reading : STATUS[st];
    return `<li class="fl-row${i === cur ? ' cur' : ''}" role="option" aria-selected="${i === cur}" tabindex="-1" data-i="${i}" data-name="${esc(e.name)}" data-status="${st}" data-fix="${e.sum?.fix ?? ''}" data-check="${e.sum?.check ?? ''}" title="${esc(e.name)}">
      <span class="name">${esc(e.name)}</span> <span class="st" data-status="${st}">${statusIcon(st)} ${esc(word)}${cnt}</span></li>`;
  };
  const paintList = () => {
    $('#fl-n').textContent = entries.length ? `(${entries.length})` : '';
    $('#fl-rows').innerHTML = entries.map(rowHTML).join('');
    $('#fl-drop').textContent = entries.length ? W.dropMore : W.drop;
  };
  const readable = () => entries.filter((e) => e.res);
  const nameOf = (e) => e.name.replace(/\.(txt|csv)$/i, '');
  // Default picks: the open file as A, the next readable one as B.
  const picks = () => {
    const ok = readable();
    const ea = ok.includes(entries[cur]) ? entries[cur] : ok[0];
    const eb = ok.find((e, i) => e !== ea && i > ok.indexOf(ea)) || ok.find((e) => e !== ea);
    return [ea, eb];
  };
  // The picker's choices: indexes into readable(), per side. Several per side pool those
  // recordings (A1+A2 vs B1+B2, scorecard S1); one each is the plain pair, unchanged.
  const chosen = { a: [], b: [] };
  const syncChosen = () => {
    for (const s of ['a', 'b']) chosen[s] = [...root.querySelectorAll(`#fl-ab .fl-side[data-side="${s}"] select`)].map((el) => Number(el.value));
  };
  const sideOf = (s) => {
    const box = $('#fl-ab');
    if (!box || box.hidden) return null;
    syncChosen();
    const ok = readable();
    return [...new Set(chosen[s])].map((i) => ok[i]).filter(Boolean);
  };
  const item = (e) => ({ rec: e.res.rec, name: nameOf(e) });
  const openScorecard = () => {
    const [ea, eb] = picks();
    const as = sideOf('a') || [ea].filter(Boolean);
    const bs = sideOf('b') || [eb].filter(Boolean);
    if (!as.length || !bs.length) { a.say(W.compareNeeds); return; }
    const back = () => a.go('files', { entries, current: cur, from: ctx.from });
    // One each: the same { rec, name } objects as before pooling existed.
    if (as.length === 1 && bs.length === 1) a.openScorecard(item(as[0]), item(bs[0]), back);
    else a.openScorecard(as.map(item), bs.map(item), back);
  };
  const paintPicker = (focusId) => {
    const ok = readable();
    const box = $('#fl-ab');
    const spare = ok.length > new Set([...chosen.a, ...chosen.b]).size;
    const opts = (d) => ok.map((e, i) => `<option value="${i}"${i === d ? ' selected' : ''}>${esc(e.name)}</option>`).join('');
    const side = (s, label) => `<fieldset class="fl-side row-btns" data-side="${s}"><legend>${esc(W.pool.legend(label))}</legend>${chosen[s].map((d, k) => (k === 0
      ? `<label>${esc(label)} <select id="fl-${s}">${opts(d)}</select></label>`
      : `<span class="fl-pick"><label>${esc(W.pool.nth(label, k + 1))} <select id="fl-${s}${k + 1}">${opts(d)}</select></label> <button class="btn" type="button" data-drop="${s}${k}" aria-label="${esc(W.pool.removeLabel(label, k + 1))}">${esc(W.pool.remove)}</button></span>`)).join(' ')}
      <button class="btn" type="button" id="fl-${s}-add"${spare ? '' : ` disabled aria-disabled="true" title="${esc(W.pool.noSpare)}"`}>${esc(W.pool.add(label))}</button></fieldset>`;
    box.innerHTML = `${side('a', W.pickA)} ${side('b', W.pickB)}
      <button class="btn primary" type="button" id="fl-ab-go">${esc(W.openScorecard)}</button>`;
    box.hidden = false;
    $('#fl-ab-go').onclick = openScorecard;
    for (const s of ['a', 'b']) {
      $(`#fl-${s}-add`).onclick = () => {
        syncChosen();
        const taken = new Set([...chosen.a, ...chosen.b]);
        const next = ok.findIndex((e, i) => !taken.has(i));
        if (next < 0) return;
        chosen[s].push(next);
        paintPicker(`#fl-${s}${chosen[s].length}`);
        a.say(W.pool.added(s === 'a' ? W.pickA : W.pickB, chosen[s].length));
      };
    }
    box.querySelectorAll('[data-drop]').forEach((btn) => {
      btn.onclick = () => {
        syncChosen();
        const s = btn.dataset.drop[0];
        chosen[s].splice(Number(btn.dataset.drop.slice(1)), 1);
        paintPicker(`#fl-${s}-add`);
      };
    });
    $(focusId || '#fl-a')?.focus();
  };
  const showPicker = () => {
    const ok = readable();
    const [ea, eb] = picks();
    chosen.a = [ok.indexOf(ea)];
    chosen.b = [ok.indexOf(eb)];
    paintPicker();
  };
  const paintView = () => {
    plot?.destroy(); plot = null;
    xp?.destroy(); xp = null;
    const v = $('#fl-view');
    const e = entries[cur];
    if (!e) { v.innerHTML = `<p class="muted">${esc(W.empty)}</p>`; v.dataset.name = ''; return; }
    v.dataset.name = e.name;
    if (e.reading) { v.innerHTML = `<p>${esc(W.reading)}${e.size > BIG ? ` ${esc(W.big(e.size))}` : ''}</p>`; return; }
    if (e.error) {
      v.innerHTML = `<h2 class="fl-head">${esc(e.name)}</h2><p class="err">${statusIcon('fix')} ${esc(W.unreadable(e.error))}</p><pre class="mono">${esc(e.head)}</pre>`;
      return;
    }
    const r = e.res;
    const rate = r.rate ? `${r.rate.approx ? '≈ ' : ''}${Math.round(r.rate.hz)} Hz` : W.rateUnknown;
    v.innerHTML = `<h2 class="fl-head">${esc(e.name)} · ${esc(r.formatName)} · ${esc(W.channels(r.rec.channels))} · <span class="fl-rate">${esc(rate)}</span></h2>
      <div class="overview" role="img" aria-label="${esc(W.plotLabel(e.name))}"></div>
      ${reportHTML(e.report, r.rec.channelNames)}
      ${doctorHTML(e.report, `<button class="btn" type="button" id="ab-hook"${readable().length >= 2 ? '' : ` disabled aria-disabled="true" title="${esc(W.compareNeeds)}"`}>${esc(W.compare)}</button><div class="fl-ab row-btns" id="fl-ab" hidden></div>`)}
      <p class="row-btns"><button class="btn primary" type="button" id="fl-save">${esc(W.save)}</button>
        <button class="btn" type="button" id="fl-report">${esc(REPORT.button)}</button></p>
      <div class="card" id="fl-xp"></div>`;
    plot = drawOverview(v.querySelector('.overview'), r.rec);
    $('#ab-hook').onclick = showPicker;
    xp = mountExportPanel($('#fl-xp'), { recordings: () => [{ recording: r.rec, meta: r.rec.meta || {} }], download: (nm, b, t) => a.download(nm, b, t), say: (t, u) => a.say(t, u) });
    // Card R7: an old recording's one-page report; the person code comes from the file's own header.
    $('#fl-report').onclick = () => {
      const nm = `${e.name.replace(/\.[^.]*$/, '')}.report.html`;
      try { a.download(nm, sessionReportHTML(r.rec, e.report, { mode: document.body.dataset.mode }), 'text/html'); } catch (err) { return; }
      a.say(REPORT.saved(nm));
    };
    $('#fl-save').onclick = () => a.go('review', { file: { rec: r.rec, name: e.name }, back: () => a.go('files', { entries, current: cur, from: ctx.from }) });
  };
  const select = (i) => { cur = Math.max(0, Math.min(entries.length - 1, i)); paintList(); paintView(); };

  async function add(files) {
    const start = entries.length;
    for (const f of files) entries.push({ name: f.name, size: f.size || 0, reading: true, file: f });
    if (entries.length) a.setChip(`File · ${entries[0].name}${entries.length > 1 ? ` + ${entries.length - 1} more` : ''}`);
    select(start);
    for (const e of entries.slice(start)) {
      let text = '';
      try { text = await e.file.text(); } catch (err) { e.error = String(err?.message || err); }
      if (!alive) return;
      if (!e.error) {
        const res = recFromText(text);
        if (res.ok) { e.res = res; e.report = analyzeRecording(res.rec); e.sum = worst(e.report); }
        else e.error = res.reason;
      }
      if (e.error) e.head = text.split(/\r?\n/).slice(0, 5).join('\n');
      e.reading = false;
      delete e.file;
      paintList();
      // The open file's Compare button depends on how many files have been read.
      if (entries[cur] === e || readable().length === 2) paintView();
    }
  }

  $('#fl-input').onchange = (ev) => { const fs = [...ev.target.files]; ev.target.value = ''; if (fs.length) add(fs); };
  $('#fl-rows').onclick = (ev) => { const li = ev.target.closest('.fl-row'); if (li) select(Number(li.dataset.i)); };
  const drop = $('#fl-drop');
  root.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('over'); });
  root.addEventListener('dragleave', () => drop.classList.remove('over'));
  root.addEventListener('drop', (ev) => { ev.preventDefault(); drop.classList.remove('over'); const fs = [...(ev.dataTransfer?.files || [])]; if (fs.length) add(fs); });
  // Back and Esc return to the screen Files was opened from (ctx.from, R3c), like the shell's
  // Back; coming back from Save or the Scorecard passes it on so the opener is not lost.
  const leave = () => (ctx.from ? a.goBackTo(ctx.from) : a.go('start'));
  $('#fl-back').onclick = leave;

  paintList(); paintView();
  if (ctx.files?.length) add(ctx.files);
  $('#fl-back').focus({ preventScroll: true });
  return {
    add,
    keys: {
      o: () => $('#fl-input').click(),
      ArrowDown: () => select(cur + 1),
      ArrowUp: () => select(cur - 1),
      Delete: () => { if (!entries.length) return; entries.splice(cur, 1); a.say(W.removed); select(cur); },
      b: openScorecard,
      Escape: () => { if ($('#fl-ab') && !$('#fl-ab').hidden) { $('#fl-ab').hidden = true; $('#ab-hook').focus(); return; } leave(); },
    },
    unmount() { alive = false; plot?.destroy(); xp?.destroy(); },
  };
}
