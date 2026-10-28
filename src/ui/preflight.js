// ui/preflight.js: Preflight screen (spec §7). Arduino: 8 rows filled in live top to bottom;
// Demo: 3 rows that pass on their own, then wait for "Next: Fit the band" or "Skip to record".
// Simple mode (simplify N5, default): Speed / Format / Sensors / Rate fold into one "Signal
// readable" row (their numbers in its Why?), the raw-lines panel hides, and the demo never leaves
// Connect by itself. Advanced shows every row and keeps "close Fit after the ticks -> Record".
//
// Contract
//   mountPreflight(root, { mode: 'serial'|'demo', straight? }, app) -> { keys, unmount }
//   Each row is <div class="row" data-row="<id>"> with a status element
//   <span class="st" data-status="ok|check|fix|wait|busy"> holding an icon AND the status word.
//   Start session hands Record ctx.handoff:
//     { kind: 'serial'|'twin', source, ingest, format, baud|null, rate: { hz, approx },
//       names: string[], buffer: { t, hostMs, rows } (last ≤ 30 s),
//       count() -> samples since Preflight began, onSample(fn) replaces the sample sink,
//       onStatus(fn) replaces the source-status sink, stop() stops the source }
//   The source keeps running across the hand-off (no gap, no second port open).
//   Failures never blank the screen: a failing row turns red with a Fix line; the rows above
//   stay as they were. Port busy (RISKS B8) shows the error's own words in the Port row.

import { SerialSource, TwinSource } from '../sources.js';
import { Ingest } from '../pipeline.js';
import { formatName, rateLabel, bandwidthCheck, makeRowParser } from '../detect.js';
import { movementCheck } from '../quality.js';
import { PREFLIGHT as W, STATUS, SHELL, FIT } from './words.js';
import { openFit, placesLine } from './fit.js';
import { statusIcon } from './icons.js';
import { esc, whyHTML } from './dom.js';

const SAFETY_KEY = 'opengrip.safetyAck';
const BUFFER_SAMPLES = 30 * 1000; // 30 s at up to 1 kHz
const RATE_AFTER_MS = 2000;       // spec: Rate needs ~2 s of data
const FLEX_MIN_MS = 4000;         // two squeezes take at least this long
const FLEX_GIVE_UP_MS = 12000;    // then decide amber / red
const SLOW_HZ = 80;
const SPEED_CHECK_FRACTION = 0.9; // under 90 % readable: garbled lines, check the cable
// The rows Simple's "Signal readable" row stands for (see deriveSignal).
const SIGNAL_PARTS = ['speed', 'format', 'channels', 'rate'];
const advanced = () => document.body.dataset.mode === 'advanced';
// A row the current mode does not show is never "current" nor counted in "n of m working".
const hiddenRow = (id) => (advanced() ? id === 'signal' : SIGNAL_PARTS.includes(id));

export function mountPreflight(root, ctx, app) {
  return ctx.mode === 'demo' ? demoPreflight(root, ctx, app) : serialPreflight(root, ctx, app);
}

// ---------- shared view ----------
function view(root, app, rowIds, { demo = false } = {}) {
  root.innerHTML = `<section class="screen pf">
    <div>
      <div class="pf-head"><h1>${esc(W.title)}</h1><span id="pf-count" class="small num"></span></div>
      <div class="rows" id="pf-rows">${rowIds.map((id) => `<div class="row${id === 'signal' ? ' pf-simple' : SIGNAL_PARTS.includes(id) ? ' pf-adv' : ''}" data-row="${id}">
        <span class="st" data-status="wait"></span><span class="nm">${esc(W.rows[id])}</span><div class="dt"></div></div>`).join('')}</div>
      <p class="small">${whyHTML(W.whyRows, W.why)}</p>
      <div class="pf-foot"><button class="btn" type="button" id="pf-back">${esc(W.back)}</button>
        ${demo ? `<button class="btn primary" type="button" id="pf-fit" disabled>${esc(W.nextFit)}</button>
        <button class="btn" type="button" id="pf-skip" disabled>${esc(W.skipRecord)}</button>`
    : `<button class="btn primary" type="button" id="pf-start" disabled>${esc(W.start)} <span aria-hidden="true">⏎</span></button>`}</div>
    </div>
    <aside aria-label="${esc(demo ? W.peekTitleDemo : W.peekTitle)}">
      <h2 class="pf-adv">${esc(demo ? W.peekTitleDemo : W.peekTitle)}</h2>
      <div class="peek pf-adv" id="pf-peek" aria-hidden="true"></div>
      <div id="pf-copy-wrap" class="pf-adv" hidden><button class="btn" type="button" id="pf-copy">${esc(W.copy)}</button></div>
      <h2 class="lanes-h"><span class="pf-adv">${esc(W.lanesTitle)}</span><span class="pf-simple">${esc(W.lanesTitleSimple)}</span></h2>
      <div class="lanes" id="pf-lanes"></div>
      <div id="doctor"></div>
    </aside></section>`;

  const rows = Object.fromEntries(rowIds.map((id) => [id, { id, status: 'wait', detail: '', line: null, actions: [] }]));
  const el = (id) => root.querySelector(`[data-row="${id}"]`);

  function paint(id) {
    const r = rows[id];
    const e = el(id);
    const st = e.querySelector('.st');
    st.dataset.status = r.status;
    st.innerHTML = `${statusIcon(r.status)}<span>${esc(STATUS[r.status])}</span>`;
    if (r.custom) r.custom(e.querySelector('.dt'));
    else {
      const acts = r.actions.map((a, i) => `<button class="btn" type="button" data-act="${i}">${esc(a.label)}${a.enter ? ' <span aria-hidden="true">⏎</span>' : ''}</button>`).join('');
      const line = r.line ? `<div class="fixline"><b class="${r.line.kind}">${esc(r.line.kind === 'fix' ? W.fixPrefix : W.tipPrefix)}</b> ${esc(r.line.text)}</div>` : '';
      e.querySelector('.dt').innerHTML = `<span>${esc(r.detail)}</span>${r.why ? ` ${whyHTML(r.why, W.why)}` : ''}${line}${acts ? `<span class="acts">${acts}</span>` : ''}`;
      e.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => r.actions[Number(b.dataset.act)].fn(); });
    }
  }

  function current() {
    return rowIds.find((id) => ['wait', 'busy', 'fix'].includes(rows[id].status) && !rows[id].passive && !hiddenRow(id)) || null;
  }

  function refresh() {
    const cur = current();
    for (const id of rowIds) el(id).classList.toggle('current', id === cur);
    // The optional Sensor places row is not counted: it never blocks (body-view-spec §6.1).
    const counted = rowIds.filter((id) => id !== 'places' && !hiddenRow(id));
    const ok = counted.filter((id) => rows[id].status === 'ok').length;
    root.querySelector('#pf-count').textContent = W.okCount(ok, counted.length);
  }

  // set(id, status, detail, { line, actions, passive, quiet }): one row changes; others stay.
  function set(id, status, detail, opts = {}) {
    const r = rows[id];
    const changed = r.status !== status || r.detail !== detail;
    Object.assign(r, { status, detail, line: opts.line || null, actions: opts.actions || [], passive: !!opts.passive, why: opts.why || '' });
    paint(id);
    if (rows.signal && SIGNAL_PARTS.includes(id)) deriveSignal();
    refresh();
    // Only rows this mode shows are spoken: Simple hears "Signal readable", not "115200 baud".
    if (changed && !opts.quiet && !hiddenRow(id) && ['ok', 'check', 'fix'].includes(status)) app.say(W.sayRow(W.rows[id], STATUS[status], detail));
  }

  // Simple's "Signal readable" row is the worst of its parts (Fix, then one still being checked,
  // then Check) and borrows that part's fix line and buttons, so a red line still says what to press.
  function deriveSignal() {
    const parts = SIGNAL_PARTS.filter((p) => rows[p]);
    const worst = parts.find((p) => rows[p].status === 'fix') || parts.find((p) => ['wait', 'busy'].includes(rows[p].status))
      || parts.find((p) => rows[p].status === 'check') || null;
    const st = worst ? rows[worst].status : 'ok';
    const detail = { ok: W.signalOk, check: W.signalCheck, fix: W.signalFix }[st] || W.signalWait;
    const r = rows.signal;
    const was = r.status;
    Object.assign(r, { status: st, detail, why: W.signalWhy(parts.map((p) => [W.rows[p], rows[p].detail])),
      line: worst ? rows[worst].line : null, actions: worst ? rows[worst].actions : [], passive: false });
    paint('signal');
    if (was !== st && !advanced() && ['ok', 'check', 'fix'].includes(st)) app.say(W.sayRow(W.rows.signal, STATUS[st], detail));
  }

  const peekLines = [];
  let peekMax = 8;
  let isJunk = () => false;
  const peekEl = root.querySelector('#pf-peek');
  let peekDirty = false;
  function peek(line) {
    peekLines.push(line);
    if (peekLines.length > 20) peekLines.shift();
    peekDirty = true;
  }
  function paintPeek() {
    if (!peekDirty) return;
    peekDirty = false;
    peekEl.innerHTML = peekLines.slice(-peekMax).map((l) => (isJunk(l)
      ? `<span class="junk">${esc(l)}  [${esc(W.skipped)}]</span>`
      : esc(l))).join('\n');
  }
  function showSeen() {
    peekMax = 20;
    peekEl.classList.add('big');
    root.querySelector('#pf-copy-wrap').hidden = false;
    peekDirty = true;
    paintPeek();
  }
  root.querySelector('#pf-copy').onclick = () => {
    navigator.clipboard?.writeText(peekLines.join('\n')).then(() => app.say(W.copied), () => {});
  };

  // Mini lanes: one 24 px sparkline per channel, last 5 s, auto-scaled.
  let lanes = [];
  function setupLanes(names) {
    const box = root.querySelector('#pf-lanes');
    box.innerHTML = names.slice(0, 8).map((n, i) => `<div class="lane" data-lane="${i}"><span class="mono">${esc(n)}</span><canvas width="240" height="24" aria-hidden="true"></canvas><span class="lw"></span></div>`).join('');
    lanes = [...box.querySelectorAll('.lane')].map((e) => ({ canvas: e.querySelector('canvas'), word: e.querySelector('.lw'), moved: null }));
  }
  function paintLanes(buf, keep, moved) {
    const css = getComputedStyle(document.documentElement);
    const trace = css.getPropertyValue('--trace').trim() || '#cbd5e1';
    const tw = Number(css.getPropertyValue('--tw')) || 1;
    const n = buf.rows.length;
    const from = Math.max(0, n - keep);
    lanes.forEach((ln, c) => {
      const g = ln.canvas.getContext('2d');
      const { width: wd, height: ht } = ln.canvas;
      g.clearRect(0, 0, wd, ht);
      if (n - from < 2) return;
      let lo = Infinity, hi = -Infinity;
      for (let i = from; i < n; i++) { const v = buf.rows[i][c]; if (v < lo) lo = v; if (v > hi) hi = v; }
      const span = hi - lo || 1;
      g.strokeStyle = trace;
      g.lineWidth = 1.2 * tw;
      g.beginPath();
      for (let i = from; i < n; i++) {
        const x = ((i - from) / (n - from - 1)) * wd;
        const y = ht - 2 - ((buf.rows[i][c] - lo) / span) * (ht - 4);
        if (i === from) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      const m = moved ? moved.has(c) : null;
      if (m !== ln.moved) {
        ln.moved = m;
        ln.word.innerHTML = m == null ? '' : `${statusIcon(m ? 'ok' : 'wait')} ${esc(m ? W.moved : W.flat)}`;
        ln.word.style.color = m ? 'var(--good)' : 'var(--muted)';
      }
    });
  }

  return { rows, set, paint, refresh, current, peek, paintPeek, showSeen, setupLanes, paintLanes, setJunk: (fn) => { isJunk = fn; } };
}

// The optional "Sensor places" row (body-view-spec §6.1): opens the Fit sheet, never blocks.
// get() -> { channels, names, rateHz, demo }; the sheet sees live samples through sink.setNext
// until Record takes the sink over. placement() is what Start hands to Record.
// onNext(): the Fit page's "Next: Record" (after it saved and closed); no onNext, no button.
function placesRow(v, app, sink, get, onOpen = () => {}, onClose = () => {}, onNext = null) {
  let placement = null;
  let fit = null;
  let lastDiff = [];
  function paint(diff = []) {
    v.set('places', placement ? 'ok' : 'opt', placesLine(placement, diff), { passive: true, quiet: !placement,
      actions: [{ label: placement ? FIT.rowEdit : FIT.rowButton, fn: open }] });
  }
  function open() {
    if (fit) return;
    const g = get();
    onOpen();
    fit = openFit(document.body, { channels: g.channels, names: g.names, rateHz: g.rateHz, demo: g.demo, placement,
      scale: app.env.fit?.scale, say: (t) => app.say(t), more: app.advanced, onNext,
      onSave: (p, { diff }) => { placement = p; lastDiff = diff; paint(diff); },
      onClose: () => { if (!fit) return; fit = null; sink.setNext(null); paint(lastDiff); document.querySelector('[data-row="places"] [data-act]')?.focus(); onClose(); } });
    sink.setNext((s) => fit?.feed(s.values));
  }
  paint();
  return { placement: () => placement, open, fit: () => fit, close: () => { const f = fit; fit = null; f?.close(); } }; // no repaint: the screen is leaving
}

// Samples since Preflight began; the last 30 s kept for the lanes, the flex check and Record.
function sampleSink() {
  const buf = { t: [], hostMs: [], rows: [] };
  let count = 0;
  let next = null;
  return {
    buf,
    count: () => count,
    push(s) {
      count++;
      buf.t.push(s.t != null ? s.t : s.hostMs);
      buf.hostMs.push(s.hostMs);
      buf.rows.push(s.values);
      if (buf.rows.length > BUFFER_SAMPLES) { buf.t.shift(); buf.hostMs.shift(); buf.rows.shift(); }
      next?.(s);
    },
    setNext(fn) { next = fn; },
  };
}

function windowRec(buf, names, rateHz, seconds) {
  const keep = Math.max(2, Math.round(seconds * (rateHz || 100)));
  const rows = buf.rows.slice(-keep);
  return { data: names.map((_, c) => rows.map((r) => r[c])), t: buf.t.slice(-keep), rateHz };
}

function browserName() {
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) || [];
  if (brands.some((b) => /Edge/i.test(b)) || /Edg\//.test(navigator.userAgent)) return 'Edge';
  if (brands.some((b) => /Opera/i.test(b))) return 'Opera';
  return 'Chrome';
}

function handoff(kind, source, ingest, sink, extra) {
  let statusSink = null;
  return {
    kind, source, ingest, format: ingest.format, names: ingest.format?.names || [], buffer: sink.buf,
    rate: ingest.rate(), count: sink.count,
    onSample: (fn) => sink.setNext(fn),
    onStatus: (fn) => { statusSink = fn; },
    _status: (s, d) => statusSink?.(s, d),
    stop: () => source.stop().catch(() => {}),
    ...extra,
  };
}

// ---------- Arduino ----------
function serialPreflight(root, ctx, app) {
  const ids = ['browser', 'port', 'signal', 'speed', 'format', 'channels', 'places', 'rate', 'flex', 'safety'];
  const v = view(root, app, ids);
  const env = app.env;
  const src = new SerialSource({ serial: env.serial, storage: env.storage, ...env.serialOpts });
  const sink = sampleSink();
  const startBtn = root.querySelector('#pf-start');
  let alive = true;
  let handed = false;
  let ingest = null;
  let speedText = '';
  let flexFrom = null;
  let flexMoved = new Set();
  let flexDone = false;
  let rate = null;
  let ho = null;
  const timers = [];
  app.setChip(SHELL.arduinoDetecting);
  const places = placesRow(v, app, sink, () => ({ channels: ingest?.format?.names?.length || 6, names: ingest?.format?.names, rateHz: rate?.hz || 100, demo: false }),
    () => {}, () => {}, () => { if (startBtn.disabled) startBtn.focus({ preventScroll: true }); else startSession(); });

  // Rows that don't block: the person still decides (spec: amber rows don't block).
  const blocking = ['browser', 'port', 'speed', 'format', 'channels', 'rate', 'safety'];
  function updateStart() {
    const r = v.rows;
    const anyFix = ids.some((id) => r[id].status === 'fix');
    const allDone = blocking.every((id) => ['ok', 'check'].includes(r[id].status));
    startBtn.disabled = anyFix || !allDone;
    const anyCheck = ids.some((id) => r[id].status === 'check');
    startBtn.firstChild.textContent = `${anyCheck ? W.startAnyway : W.start} `;
  }
  const set = (...a) => { if (!alive) return; v.set(...a); updateStart(); };

  // Browser
  if (!SerialSource.supported(env.serial)) {
    set('browser', 'fix', W.browserFix, { line: { kind: 'fix', text: W.browserFixLine }, actions: [{ label: W.useDemo, fn: () => app.go('preflight', { mode: 'demo' }) }] });
    v.set('safety', 'wait', '', { passive: true, quiet: true });
    return { keys: { Escape: () => app.go('start'), Enter: () => app.go('preflight', { mode: 'demo' }) }, unmount() { alive = false; } };
  }
  set('browser', 'ok', W.browserOk(browserName()));

  // Safety: one-time per browser (remembered with the date). The comfort line (RISKS B19)
  // is always shown, ticked or not.
  let acked = false;
  try { acked = !!env.storage?.getItem(SAFETY_KEY); } catch { /* private mode */ }
  function paintSafety(box) {
    box.innerHTML = acked
      ? `<span>${esc(W.safetyRemembered)}</span><div class="comfort">${esc(W.safetyComfort)}</div>`
      : `<span>${esc(W.safetyText)}</span><div class="comfort">${esc(W.safetyComfort)}</div>
         <label><input type="checkbox" id="pf-safety"> ${esc(W.safetyBox)} <span class="key" aria-hidden="true">X</span></label>`;
    const cb = box.querySelector('#pf-safety');
    if (cb) cb.onchange = () => tickSafety(cb.checked);
  }
  function tickSafety(on) {
    try { if (on) env.storage?.setItem(SAFETY_KEY, new Date().toISOString().slice(0, 10)); else env.storage?.removeItem(SAFETY_KEY); } catch { /* private mode */ }
    const cb = root.querySelector('#pf-safety');
    if (cb) cb.checked = on;
    set('safety', on ? 'ok' : 'wait', on ? W.safetyOk : '', { passive: !on });
  }
  v.rows.safety.custom = paintSafety;
  // Safety stays "passive" while unticked so the current-row bar follows the machine checks.
  set('safety', acked ? 'ok' : 'wait', acked ? W.safetyRemembered : '', { passive: true, quiet: true });

  // Port
  const portWait = () => set('port', 'wait', W.portWait, { actions: [{ label: W.choosePort, enter: true, fn: choose }] });
  portWait();
  async function choose() {
    try {
      await src.choosePort();
    } catch (e) {
      // NotFoundError = the person closed the browser's list without choosing.
      set('port', 'fix', W.portFix, { line: { kind: 'fix', text: W.portFixLine }, actions: [{ label: W.choosePort, enter: true, fn: choose }] });
      return;
    }
    const info = src.port?.getInfo?.() || {};
    set('port', 'ok', W.portOk(info.usbVendorId, info.usbProductId));
    probe();
  }

  async function probe() {
    const remembered = src.rememberedBaud();
    const n = remembered && !src.bauds.includes(remembered) ? src.bauds.length + 1 : src.bauds.length;
    let i = 0;
    set('speed', 'busy', W.speedTrying(remembered || src.bauds[0], 1, n), { quiet: true });
    let r;
    try {
      r = await src.detectBaud((s, d) => { if (s === 'detecting') set('speed', 'busy', W.speedTrying(d.baud, ++i, n), { quiet: true }); });
    } catch (e) { return openFailed(e); }
    if (!alive) return;
    if (!r.baud) {
      set('speed', 'fix', W.speedFix, { line: { kind: 'fix', text: `${W.speedFixLine} ${r.message || ''}`.trim() }, actions: [{ label: W.tryAgain, enter: true, fn: probe }] });
      return;
    }
    const pct = Math.round((r.fraction ?? 1) * 100);
    speedText = r.fraction < SPEED_CHECK_FRACTION ? W.speedCheck(r.baud, pct) : W.speedOk(r.baud, pct, remembered === r.baud);
    set('speed', r.fraction < SPEED_CHECK_FRACTION ? 'check' : 'ok', speedText);
    set('format', 'busy', W.formatWait, { quiet: true });
    ingest = new Ingest({ onSample: (s) => sink.push(s), onFormat });
    try {
      await src.start({
        onLine: (line, t) => { v.peek(line); ingest.push(line, t); },
        onStatus: (s, d) => {
          if (ho) { ho._status(s, d); return; }
          if (s === 'disconnected') set('port', 'fix', d.message || W.portFix, { line: { kind: 'fix', text: W.portFixLine } });
          if (s === 'connected' && v.rows.port.status === 'fix') set('port', 'ok', W.portOk(src.port?.getInfo?.().usbVendorId, src.port?.getInfo?.().usbProductId));
        },
      });
    } catch (e) { return openFailed(e); }
    if (!alive) { src.stop().catch(() => {}); return; }
    timers.push(setInterval(tick, 500));
  }

  function openFailed(e) {
    if (!alive) return;
    if (e?.code === 'port_busy') {
      // RISKS B8: the port row says what to close; Speed waits for it.
      set('port', 'fix', e.message, { actions: [{ label: W.tryAgain, enter: true, fn: probe }] });
      set('speed', 'wait', '', { quiet: true });
      return;
    }
    set('speed', 'fix', W.speedFix, { line: { kind: 'fix', text: e?.message || W.speedFixLine }, actions: [{ label: W.tryAgain, enter: true, fn: probe }] });
  }

  function onFormat(f) {
    if (!alive) return;
    if (!f.ok) {
      set('format', 'fix', f.reason, { actions: [{ label: W.showSeen, fn: v.showSeen }] });
      set('channels', 'fix', W.channelsFix);
      return;
    }
    const parse = makeRowParser(f);
    v.setJunk((l) => !l.startsWith('#') && !parse(l));
    const skippedPct = Math.round((1 - f.parsedFraction) * 100);
    const name = formatName(f, ingest.meta);
    if (skippedPct >= 5) set('format', 'check', name, { line: { kind: 'tip', text: W.formatCheck(skippedPct) } });
    else set('format', 'ok', name);
    if (!f.names.length) set('channels', 'fix', W.channelsFix);
    else if (f.names.length > 8) set('channels', 'check', W.channelsCheck(f.names.length));
    else set('channels', 'ok', W.channelsOk(f.names));
    set('rate', 'busy', W.rateWait, { quiet: true });
    v.setupLanes(f.names);
  }

  function tick() {
    if (!alive) return;
    v.paintPeek();
    const f = ingest?.format;
    if (!f?.ok) return;
    const b = sink.buf;
    if (!rate && b.hostMs.length > 1 && b.hostMs[b.hostMs.length - 1] - b.hostMs[0] >= RATE_AFTER_MS) {
      rate = ingest.rate();
      const label = rateLabel(rate);
      if (!rate.hz) set('rate', 'check', W.rateUnknown);
      else if (rate.hz < SLOW_HZ) set('rate', 'check', W.rateSlow(label));
      else set('rate', 'ok', label);
      app.setChip(SHELL.arduinoChip(src.baud, f.names.length, rate.hz ? label : '?'));
      bandwidth(f);
      flexFrom = Date.now();
      set('flex', 'wait', W.flexWait, { actions: [{ label: W.skipCheck, fn: skipFlex }] });
    }
    if (rate && !flexDone) flex(f);
    v.paintLanes(b, Math.round(5 * (rate?.hz || 100)), rate ? flexMoved : null);
  }

  // RISKS B1: is the link fast enough for this many channels at this rate? Uses the real
  // average line length so a sketch printing long numbers is judged fairly.
  function bandwidth(f) {
    const lineChars = avgLineChars();
    const bw = bandwidthCheck({ baud: src.baud, channels: f.names.length, rateHz: rate.hz, hasTime: f.hasTime, lineChars });
    if (!bw.ok) set('speed', 'check', speedText, { line: { kind: 'tip', text: bw.message } });
  }
  const lineLens = [];
  function avgLineChars() {
    if (!lineLens.length) return null;
    return Math.round(lineLens.reduce((a, x) => a + x, 0) / lineLens.length) + 2; // + CR LF
  }
  const origPeek = v.peek;
  v.peek = (line) => { if (lineLens.length < 200 && /\d/.test(line) && !line.startsWith('#')) lineLens.push(line.length); origPeek(line); };

  function flex(f) {
    const names = f.names;
    const res = movementCheck(windowRec(sink.buf, names, rate.hz, 5), { windowSec: 5 });
    for (const m of res) if (m.moved) flexMoved.add(m.channel);
    const dt = Date.now() - flexFrom;
    const moved = names.filter((_, c) => flexMoved.has(c));
    const flat = names.filter((_, c) => !flexMoved.has(c));
    if (dt >= FLEX_MIN_MS && !flat.length) { flexDone = true; set('flex', 'ok', W.flexOk(moved)); return; }
    if (dt < FLEX_GIVE_UP_MS) return;
    flexDone = true;
    if (moved.length) set('flex', 'check', W.flexCheck(moved, flat));
    else set('flex', 'fix', W.flexFix, { line: { kind: 'fix', text: W.flexFixLine }, actions: [{ label: W.tryAgain, enter: true, fn: retryFlex }, { label: W.skipCheck, fn: skipFlex }] });
  }
  function retryFlex() { flexMoved = new Set(); flexFrom = Date.now(); flexDone = false; set('flex', 'wait', W.flexWait, { actions: [{ label: W.skipCheck, fn: skipFlex }] }); }
  function skipFlex() { flexDone = true; set('flex', 'check', W.flexSkipped); }

  function startSession() {
    if (startBtn.disabled) return;
    handed = true;
    places.close();
    ho = handoff('serial', src, ingest, sink, { baud: src.baud, placement: places.placement() });
    app.go('record', { handoff: ho });
  }
  startBtn.onclick = startSession;
  root.querySelector('#pf-back').onclick = () => app.go('start');

  return {
    keys: {
      Enter: (ev) => {
        if (ev.target?.tagName === 'BUTTON' && ev.target.id !== 'pf-start') return false; // let the focused button act
        const cur = v.current();
        const act = cur && v.rows[cur].actions.find((a) => a.enter);
        if (act) act.fn(); else startSession();
      },
      k: () => { if (v.current() === 'flex' || v.rows.flex.status === 'fix') skipFlex(); else return false; },
      x: () => { if (!acked) tickSafety(!root.querySelector('#pf-safety')?.checked); else return false; },
      Escape: () => app.go('start'),
    },
    unmount() {
      alive = false;
      places.close();
      timers.forEach(clearInterval);
      if (!handed) src.stop().catch(() => {});
    },
  };
}

// ---------- Demo ----------
function demoPreflight(root, ctx, app) {
  const ids = ['browser', 'source', 'places', 'flex'];
  const v = view(root, app, ids, { demo: true });
  const twin = new TwinSource({ channels: 6, rateHz: 100, seed: 1 + Math.floor(Math.random() * 1000), ...app.env.twinOpts });
  const sink = sampleSink();
  const ingest = new Ingest({ onSample: (s) => sink.push(s) });
  let alive = true;
  let handed = false;
  let ho = null;
  const timers = [];
  app.setChip(SHELL.demoChip, { demo: true, short: SHELL.demoChipShort });
  v.set('browser', 'ok', W.demoBrowser);
  // Simple: plain words, the channels and Hz in the Why? (simplify-spec §10 check 5).
  if (app.advanced) v.set('source', 'ok', W.demoSource(twin.channels, twin.rateHz));
  else v.set('source', 'ok', W.demoSourceSimple(twin.channels), { why: W.demoSourceWhy(twin.channels, twin.rateHz) });
  v.set('flex', 'busy', W.flexDemo, { quiet: true });
  v.setupLanes(Array.from({ length: twin.channels }, (_, i) => (app.advanced ? `ch${i + 1}` : W.laneName(i + 1))));
  // The demo waits for "Next: fit the band" or "Skip to record" (simplify N2: the audit found the
  // auto-jump left no time to read Connect). Closing the Fit sheet counts as the choice: once the
  // ticks are in, it goes on to Record. ?demo (ctx.straight) still opens Record at once.
  // Simple (simplify N5, check 7): the demo never leaves Connect by itself. Closing Fit comes back
  // here; only "Next: Record" on the Fit page or "Skip to record" go on. Read at the moment, so the
  // More menu's Advanced switch counts from the next close.
  let ready = false;
  let fitted = false;
  const places = placesRow(v, app, sink, () => ({ channels: twin.channels, rateHz: twin.rateHz, demo: true }),
    () => {}, () => { if (!app.advanced) return; fitted = true; if (ready) timers.push(setTimeout(go, 300)); },
    () => { ready = true; go(); });
  const fitBtn = root.querySelector('#pf-fit');
  const skipBtn = root.querySelector('#pf-skip');
  fitBtn.onclick = () => places.open();
  skipBtn.onclick = () => { ready = true; go(); };

  const go = () => {
    if (!alive || handed) return;
    ready = true;
    if (places.fit()) return;
    handed = true;
    places.close();
    ho = handoff('twin', twin, ingest, sink, { baud: null, synthetic: true, placement: places.placement() });
    app.go('record', { handoff: ho });
  };
  twin.start({
    onLine: (line, t) => { v.peek(line); ingest.push(line, t); },
    onStatus: (s, d) => ho?._status(s, d),
  });
  timers.push(setInterval(() => { v.paintPeek(); v.paintLanes(sink.buf, 500, null); }, 250));
  root.querySelector('#pf-back').onclick = () => app.go('start');
  if (ctx.straight) {
    queueMicrotask(go);
  } else {
    // Spec: flex auto-passes after 2 s (the demo flexes by itself), 1 s pause so it is seen.
    timers.push(setTimeout(() => {
      if (!alive) return;
      v.set('flex', 'ok', W.flexDemo);
      ready = true;
      if (fitted) { timers.push(setTimeout(go, 1000)); return; }
      fitBtn.disabled = false;
      skipBtn.disabled = false;
      app.say(W.sayDemoGo);
      fitBtn.focus({ preventScroll: true });
    }, 2000));
  }
  return {
    keys: { Escape: () => app.go('start') },
    unmount() {
      alive = false;
      timers.forEach((x) => { clearInterval(x); clearTimeout(x); });
      places.close();
      if (!handed) twin.stop().catch(() => {});
    },
  };
}
