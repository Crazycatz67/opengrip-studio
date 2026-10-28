// ui/record.js: Record screen core (spec §8.1-8.3, §8.5): the prompt band (fixed height in every
// state), the step strip, the protocol clock (pause, redo, skip, C insert), transport keys and the
// live plot, the live quality strip (quality-strip.js, lane markers in plot.js) and autosave
// (autosave.js, top-bar #autosave), the unplug band (spec §9.1), the screen wake lock and the
// hidden-tab pause (RISKS B9) and the Volunteer view (spec §8.7).
//
// Contract
//   mountRecord(root, { handoff }, app) -> { keys, unmount }
//     handoff: from Preflight (contract at the top of preflight.js). The source keeps running;
//     Record replaces its sample sink. Leaving Record without going to Review stops the source.
//   Phases (section[data-phase]): 'ready' (before R) -> 'preroll' (3 s, app.env.record.preRollMs)
//     -> 'live' (Session recording; the prompt shows Running / Paused / Done from the session).
//   S when the protocol is done (or "Stop and save" in the dialog) -> app.go('review',
//     { handoff, session }) with the session stopped.
//   Demo (handoff.kind 'twin'): the twin's labelProvider reads the session's current label, so the
//     synthetic bursts follow the prompt; the SYNTHETIC chip from Preflight stays.
//   Test hook: app.env.record = { timing?: DEFAULT_TIMING overrides, preRollMs?, reducedMotion? } shortens the
//     protocol; app.record = { session, plot, strip, saver, autosave, phase() } while mounted
//     (read-only, for the ui walk). Review receives ctx.saver (the AutoSaver; its finish() marks
//     the session complete once the CSV is saved).
//   Autosave starts when the pre-roll ends; leaving Record flushes it. Quality updates once a second.
//   section[data-samples] = samples since Preflight began (updated 4x a second).
//   Unplug: source status 'disconnected' -> section[data-link='unplugged'], session.disconnected()
//     (clock paused, reason 'unplugged'), autosave flushed. #rec-unplug covers the prompt band (same
//     box, no layout jump); its Reconnect button calls handoff.source.reconnect(). 'reconnecting' ->
//     data-link 'reconnecting'; a failed reopen ('error' or a rejected reconnect) -> 'failed'.
//     'connected' -> 'back': a 3 s count (app.env.record.backMs), then the current step restarts
//     (redoStep) and resume(); R or P carries on at once. While 'unplugged', R and P do nothing.
//   Hidden tab while live: session.pause('hidden'); the prompt says keep this tab in front; data
//     keeps arriving (labelled 'paused'). Coming back does NOT resume: R or P does (the person decides).
//   Wake lock: navigator.wakeLock (or app.env.wakeLock) held while live, running and not done;
//     released on pause, stop, done and unmount; asked again on visibilitychange. A refusal is silent.
//   Board reset (device clock went backwards): a lasting note in the step strip (#rec-note).
//   Volunteer view: V toggles section[data-vol]; Esc, V or its Back to controls button (#b-volx) leaves.
//     #b-volshow opens it; it shows a whole-minute time left (#rec-vleft) and "Need to stop?" line.
//   Step menu (simplify N6a): #b-stepm (aria-haspopup="menu") opens #rec-stepmenu holding #b-redo and
//     #b-skip (role="menuitem"); ↑/↓ move, Esc or a choice closes it and focus goes back to #b-stepm.
//   app.record also has link(), wake() ('held'|'off'), vol(), source (the handoff's source).
//   Body rail (body-view-spec §6.2, card B4): A or #b-body toggles the rail right of the plot
//     (>= 900 px, section[data-body='on']) or switches the Signal/Body tab (< 900 px,
//     section[data-tab]). Both live inside .plotwrap: the prompt band and plot row never change
//     height. Places: handoff.placement (or app.env.record.placement), the placement.js model;
//     none -> ringPreset(channels), a "Set sensor places" prompt and "default ring, not your
//     places"; the lanes then say "not placed". Default: rail on at >= 1280 px when places exist;
//     the choice and the lens are remembered in localStorage 'opengrip.body' ({ on, lens }).
//     Hidden rail/tab = no drawing work. Levels: 0-1 from calibration, else each channel's seen
//     range (rough); unplugged -> no levels. Pins: the live quality items, once a second.
//     app.record.body() -> { on, tab, visible, isDefault, placement, view }.

import { Session } from '../session.js';
import { defaultProtocol, calibrationSteps, timeline, splitLabel } from '../protocol.js';
import { calibrate, windowOf, LiveQuality } from '../quality.js';
import { createQualityStrip } from './quality-strip.js';
import { startAutosave, paintAutosave } from './autosave.js';
import { createPlot, labelKind, NOW_AT } from './plot.js';
import { createBodyView } from './body-draw.js';
import { ringPreset } from '../placement.js';
import { openFit, placementMeta } from './fit.js';
import { BODY_RAIL, BODY_WORDS, PLACE_SHORT, NOT_PLACED_SHORT, sensorName } from './words.js';
import { RECORD as W, INSTRUCTION_WORDS, PROMPT_WORDS, POSITION_WORDS, STRIP_GROUPS } from './words.js';
// Words for the current mode: Simple names buttons, Advanced keeps today's key instructions.
const WS = () => (document.body.dataset.mode === 'advanced' ? W : { ...W, ...W.simple });
import { pose } from './icons.js';
import { esc } from './dom.js';

const PREROLL_MS = 3000;
const LAST_SECONDS = 3;     // countdown turns accent
const NEXT_WARN_SEC = 2;    // "Next" brightens
const WINDOWS = [5, 10, 20, 30];
const RING_R = 74;
const RING_C = 2 * Math.PI * RING_R;
const BACK_MS = 3000;       // "carrying on in 3…" after a reconnect

export function wordFor(label) {
  const { gesture } = splitLabel(label);
  const w = PROMPT_WORDS[gesture];
  return w ? w[0] : gesture.replace(/_/g, ' ').toUpperCase();
}
function tagFor(label) { return PROMPT_WORDS[splitLabel(label).gesture]?.[1] || ''; }
function positionFor(label) {
  const { gesture, position } = splitLabel(label);
  if (position) return position;
  if (gesture === 'rest' || gesture.startsWith('cal_')) return 'table';
  return gesture === 'elbow_bend' ? 'elbow90' : null;
}
function handFor(label) {
  const g = splitLabel(label).gesture;
  if (/grip|squeeze/.test(g)) return 'fist';
  if (g === 'open') return 'open';
  if (/elbow|bend/.test(g)) return 'bend';
  return 'relaxed';
}
const isCalStep = (s) => s.label.startsWith('cal_');
// Seconds of the calibration block at the start of the protocol ("Calibration first: 26 s").
function calSecs(tl) { let t = 0; for (const s of tl) { if (!isCalStep(s)) break; t += s.seconds; } return t; }
function stripKind(label) {
  if (label.startsWith('cal_')) return 'cal';
  const k = labelKind(label);
  return k === 'none' ? 'rest' : k;
}
// Caption group of a step; a plain rest inherits the group before it (elbow-bend reps rest on the table).
function groupsOf(tl) {
  let prev = '';
  return tl.map((s) => {
    const { gesture, position } = splitLabel(s.label);
    let k = '';
    if (gesture.startsWith('cal_')) k = 'cal';
    else if (position) k = position;
    else if (/elbow|bend/.test(gesture)) k = 'bend';
    else if (gesture === 'rest' && prev === 'bend') k = 'bend';
    prev = k;
    return k;
  });
}
// Part number (1-based) of every step: a new part starts where the caption group changes, so the
// Simple step line counts the 5 strip groups ("Part 1 of 5") instead of 62 steps (simplify-spec §6).
function partsOf(tl) {
  let cur = '', p = 0;
  const at = groupsOf(tl).map((g) => { if (p === 0 || (g && g !== cur)) { p += 1; cur = g || cur; } return p; });
  return { at, n: p };
}

export function mountRecord(root, ctx, app) {
  const h = ctx.handoff;
  const opts = app.env.record || {};
  const timing = opts.timing || {};
  const preRollMs = opts.preRollMs ?? PREROLL_MS;
  const backMs = opts.backMs ?? BACK_MS;
  // Reduced motion (spec §11): the countdown ring moves in whole seconds.
  // Also puts the plot in sweep mode (no scrolling). app.env.record.reducedMotion overrides the
  // media query for the walks, which cannot emulate it from inside a frame.
  const calm = opts.reducedMotion ?? !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  // ?demo hands on before the format is known: then the lanes appear with the first sample.
  let names = h.names?.length ? h.names : [];
  const session = new Session({ channels: names.length, channelNames: names.length ? names : undefined, protocol: defaultProtocol(timing) });

  root.innerHTML = `<section class="rec" data-phase="ready" aria-label="Record">
    <div class="prompt" id="rec-prompt">
      <div class="pw"><div class="wordrow"><span class="word" id="rec-word"></span><span class="pos" id="rec-pos" hidden></span></div>
        <div class="tag" id="rec-tag"></div><div class="sub" id="rec-sub"></div></div>
      <div class="pose" id="rec-pose"></div>
      <div class="ring" id="rec-ring"><svg viewBox="0 0 160 160" aria-hidden="true"><circle class="track" cx="80" cy="80" r="${RING_R}"/>
        <circle class="arc" cx="80" cy="80" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(2)}" transform="rotate(-90 80 80)"/></svg><span class="n num" id="rec-count"></span></div>
      <div class="next" id="rec-next"><span>${esc(W.next)}</span><b id="rec-next-w"></b><span id="rec-next-s" class="num"></span></div>
      <div class="unplug" id="rec-unplug" role="group" aria-label="${esc(W.unplugged)}" hidden>
        <div class="uh" id="rec-uh"></div><div class="usub" id="rec-usub"></div>
        <div class="urow"><span class="num" id="rec-uwait"></span>
          <button class="btn primary" type="button" id="b-reconnect">${esc(W.reconnectBtn)} <span aria-hidden="true">⏎</span></button>
          <button class="btn" type="button" id="b-ustop">${esc(W.stopReviewBtn)} <span class="key">S</span></button></div>
      </div>
      <div class="volfoot" aria-live="off"><span class="vleft num" id="rec-vleft"></span><span class="vstop">${esc(W.volStop)}</span></div>
      <button class="btn volx" type="button" id="b-volx">${esc(W.volExit)}</button>
    </div>
    <div class="strip"><div class="caps" id="rec-caps" aria-hidden="true"></div><div class="segs" id="rec-segs"></div><div class="parts" id="rec-parts" aria-hidden="true"></div>
      <div class="stepline">${h.synthetic ? `<span class="demo-tag">${esc(W.demoTag)}</span> ` : ''}<span id="rec-stepline" class="num"></span><span id="rec-note" class="note"></span><span id="rec-toast" class="toast" role="status"></span></div></div>
    <div class="plotwrap"><div class="rtabs" role="tablist" aria-label="${esc(BODY_RAIL.tabsLabel)}">${['signal', 'body'].map((k) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === 'signal'}">${esc(BODY_RAIL.tabs[k])}</button>`).join('')}</div>
      <div class="gutter" id="rec-gutter"></div><div class="cvbox" id="rec-cv"></div>
      <div class="volcard" id="rec-volcard" role="note" aria-labelledby="rec-volcard-h"><h2 id="rec-volcard-h">${esc(W.volCardTitle)}</h2>
        <ol>${W.volCard.map((t) => `<li>${esc(t)}</li>`).join('')}</ol></div>
      <aside class="bodyrail" id="rec-body" aria-label="${esc(BODY_RAIL.region)}"><div class="br-head"><b>${esc(BODY_RAIL.button)}</b>
        <button class="btn br-x" type="button" id="b-body-x" aria-label="${esc(BODY_RAIL.close)}" title="${esc(BODY_RAIL.close)}">✕</button></div>
        <div class="br-prompt" id="rec-body-prompt" hidden><button class="btn" type="button" id="b-places">${esc(BODY_RAIL.setPlaces)}</button>
          <span class="br-tag">${esc(BODY_RAIL.defaultRing)}</span><p id="rec-places-note" hidden>${esc(BODY_RAIL.setPlacesNote)}</p></div>
        <div id="rec-bodyview"></div><div class="br-foot" id="rec-body-foot"></div></aside></div>
    <div class="qrow" id="rec-quality"></div>
    <div class="transport">
      <div class="trow">
        <button class="btn big" type="button" id="b-rec"><span class="ic" aria-hidden="true">●</span> <span class="w">${esc(WS().buttons.record)}</span> <span class="key">R</span></button>
        <button class="btn big" type="button" id="b-pause"><span class="ic" aria-hidden="true">❚❚</span> <span class="w">${esc(W.buttons.pause)}</span> <span class="key">P</span></button>
        <button class="btn big" type="button" id="b-stop"><span class="ic" aria-hidden="true">■</span> <span class="w">${esc(WS().buttons.stop)}</span> <span class="key">S</span></button>
        <button class="btn big" type="button" id="b-volshow" aria-label="${esc(W.volShow)}"><span class="w">${esc(W.volShow)}</span> <span class="ic" aria-hidden="true">⛶</span> <span class="key">V</span></button>
        <span class="stepm"><button class="btn" type="button" id="b-stepm" aria-haspopup="menu" aria-expanded="false" aria-controls="rec-stepmenu" aria-label="${esc(W.stepMenuLabel)}"><span aria-hidden="true">⋯</span> ${esc(W.stepMenu)}</button>
          <div class="menu" id="rec-stepmenu" role="menu" aria-label="${esc(W.stepMenu)}" hidden>
            <button type="button" role="menuitem" id="b-redo"><span aria-hidden="true">⟲</span> ${esc(W.buttons.redo)} <span class="key m-k">←</span></button>
            <button type="button" role="menuitem" id="b-skip">${esc(W.buttons.skip)} <span class="key m-k">→</span></button></div></span>
        <button class="btn adv" type="button" id="b-body" aria-pressed="false"><span aria-hidden="true">◎</span> ${esc(BODY_RAIL.button)} <span class="key">A</span></button>
        <span class="spacer"></span>
        <span class="adv"><span class="small">${esc(W.viewLabel)}:</span>
        <span class="seg3" role="group" aria-label="${esc(W.viewLabel)}">${Object.entries(W.views).map(([k, w]) => `<button type="button" data-view="${k}" aria-pressed="false">${esc(w)}</button>`).join('')}</span>
        <span class="key">N</span><span class="small num" id="rec-win"></span></span>
      </div>
      <div class="legend small adv">${W.legendProtocol.map(([k, w]) => `<span class="key">${esc(k)}</span> ${esc(w)}`).join(' · ')}</div>
    </div>
    <dialog id="rec-stop" aria-labelledby="rec-stop-h"><h2 id="rec-stop-h">${esc(W.stopTitle)}</h2><p id="rec-stop-p"></p>
      <form method="dialog" class="dlg-row"><button class="btn primary" value="stop" id="rec-stop-yes">${esc(W.stopYes)} <span aria-hidden="true">⏎</span></button>
      <button class="btn" value="keep">${esc(W.stopNo)} <span class="key">Esc</span></button></form></dialog>
  </section>`;
  const $ = (id) => root.querySelector(`#${id}`);
  const sec = root.firstElementChild;
  const el = { word: $('rec-word'), pos: $('rec-pos'), tag: $('rec-tag'), sub: $('rec-sub'), pose: $('rec-pose'), ring: $('rec-ring'),
    count: $('rec-count'), arc: root.querySelector('.arc'), next: $('rec-next'), nextW: $('rec-next-w'), nextS: $('rec-next-s'),
    segs: $('rec-segs'), caps: $('rec-caps'), parts: $('rec-parts'), volcard: $('rec-volcard'), stepline: $('rec-stepline'), toast: $('rec-toast'), win: $('rec-win'), dlg: $('rec-stop'), vleft: $('rec-vleft') };
  const btn = { rec: $('b-rec'), pause: $('b-pause'), stop: $('b-stop'), redo: $('b-redo'), skip: $('b-skip') };

  // ---------- Body rail (body-view-spec §6.2) ----------
  let placeSet = h.placement || opts.placement || null;
  let fit = null; // the Fit sheet, opened from the rail's "Set sensor places"
  const BODY_KEY = 'opengrip.body';
  const pref = (() => { try { return JSON.parse(localStorage.getItem(BODY_KEY)) || {}; } catch { return {}; } })();
  const savePref = () => { try { localStorage.setItem(BODY_KEY, JSON.stringify(pref)); } catch { /* private mode: not remembered */ } };
  const narrowMq = globalThis.matchMedia?.('(max-width: 899px)');
  // Simple keeps the Body view in More (simplify-spec §4), so it starts closed there unless chosen.
  const body = { on: pref.on ?? (document.body.dataset.mode === 'advanced' && !!placeSet && globalThis.innerWidth >= 1280), tab: 'signal', placement: null, isDefault: !placeSet, view: null,
    lo: [], hi: [], last: null, items: [], lastMs: 0, foot: '' };
  const bodyVisible = () => !sec.dataset.vol && (narrowMq?.matches ? body.tab === 'body' : body.on);
  function placeLine(c) {
    if (!c || (c.ringAngleDeg == null && !c.site)) return NOT_PLACED_SHORT;
    const where = c.sensor === 'EMG' && c.site ? c.site : (c.ringAngleDeg != null ? PLACE_SHORT[Math.round(c.ringAngleDeg / 45) % 8] : c.site);
    // Simple names the place only; the sensor kind (FMG / EMG) is Advanced detail (simplify-spec §6).
    return document.body.dataset.mode === 'advanced' ? `${c.sensor || 'FMG'} · ${where}` : where;
  }
  function setupBody(n) {
    body.placement = placeSet || ringPreset({ count: Math.max(1, Math.min(16, n)) });
    $('rec-body-prompt').hidden = !body.isDefault;
    // The default ring is a guess: lanes say "not placed" rather than a place nobody entered.
    plot.setPlaces(names.slice(0, plot.lanes).map((_, i) => (body.isDefault ? NOT_PLACED_SHORT : placeLine(body.placement.channels.find((c) => c.ch === i + 1)))));
    applyBody();
  }
  function applyBody() {
    if (body.on) sec.dataset.body = 'on'; else delete sec.dataset.body;
    sec.dataset.tab = body.tab;
    root.querySelectorAll('.rtabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === body.tab)));
    $('b-body').setAttribute('aria-pressed', String(narrowMq?.matches ? body.tab === 'body' : body.on));
    if (bodyVisible() && body.placement && !body.view) {
      // fill + lensHost (review-2 B1/B2): the ring is sized from the rail's real box, and the lens
      // buttons share the title row, so a 192 px Body tab or a 289 px rail cuts nothing off.
      body.view = createBodyView($('rec-bodyview'), { placement: body.placement, names, lens: pref.lens || 'ring', calm, fill: true, lensHost: root.querySelector('#rec-body .br-head') });
      body.view.setPins(body.items);
    }
    if (bodyVisible()) { body.view?.fit(); body.lastMs = 0; }
  }
  function toggleBody() {
    if (narrowMq?.matches) body.tab = body.tab === 'body' ? 'signal' : 'body';
    else { body.on = !body.on; pref.on = body.on; savePref(); }
    applyBody();
    app.say(bodyVisible() ? BODY_RAIL.shown : BODY_RAIL.hidden);
  }
  // Levels for the drawing: 0-1 from calibration when there is one, else each channel's own seen
  // range (rough, said so in the foot line). Called from the frame loop, at most 30 times a second.
  function bodyFrame(now) {
    if (!body.view || !bodyVisible() || now - body.lastMs < (calm ? 250 : 33)) return;
    body.lastMs = now;
    const v = body.last;
    const off = link !== 'ok' && link !== 'back';
    const lv = (v || []).map((x, i) => {
      if (off || !Number.isFinite(x)) return null;
      if (cal) { const r = cal.rest[i]; const q = cal.squeeze[i]; return Number.isFinite(r) && Number.isFinite(q) && q !== r ? (x - r) / (q - r) : null; }
      return body.hi[i] > body.lo[i] ? (x - body.lo[i]) / (body.hi[i] - body.lo[i]) : 0;
    });
    body.view.update(lv);
    const foot = off ? BODY_RAIL.unplugged : (cal ? BODY_RAIL.calibrated : BODY_RAIL.rough);
    if (foot !== body.foot) { body.foot = foot; $('rec-body-foot').textContent = foot; }
  }
  function bodySample(values) {
    body.last = values;
    fit?.feed(values);
    for (let i = 0; i < values.length; i++) {
      const x = values[i];
      if (!Number.isFinite(x)) continue;
      if (!(x >= body.lo[i])) body.lo[i] = x;
      if (!(x <= body.hi[i])) body.hi[i] = x;
    }
  }
  $('b-body').addEventListener('click', toggleBody);
  $('b-body-x').addEventListener('click', () => { if (narrowMq?.matches) body.tab = 'signal'; else { body.on = false; pref.on = false; savePref(); } applyBody(); });
  root.querySelectorAll('.rtabs button').forEach((b) => b.addEventListener('click', () => { body.tab = b.dataset.tab; applyBody(); }));
  $('b-places').addEventListener('click', openPlaces);
  function openPlaces() {
    if (fit) return;
    fit = openFit(document.body, { channels: names.length || plot?.lanes || 6, names, rateHz: h.rate?.hz || h.source?.rateHz || 100, demo: h.kind === 'twin',
      placement: placeSet, scale: app.env.fit?.scale, say: (t) => app.say(t),
      onSave: (p) => {
        placeSet = p; body.isDefault = false;
        body.view?.destroy(); body.view = null;
        // Places entered mid-session still reach the saved file (meta is read at save time).
        if (session.state !== 'idle') Object.assign(session.meta, placementMeta(p));
        if (names.length) setupBody(names.length);
      },
      onClose: () => { fit = null; } });
  }
  // Remember the lens: body-draw has no lens event, so read the pressed button after a click.
  $('rec-bodyview').addEventListener('click', (ev) => {
    if (!ev.target.closest?.('.bd-lens button')) return;
    const t = $('rec-bodyview').querySelector('.bd-lens button[aria-pressed="true"]')?.textContent.trim();
    const k = Object.keys(BODY_WORDS.lens).find((x) => BODY_WORDS.lens[x] === t);
    if (k) { pref.lens = k; savePref(); }
  });
  narrowMq?.addEventListener?.('change', applyBody);

  let plot = null;
  let windowSec = 10;
  const makePlot = (n) => {
    if (!names.length) names = Array.from({ length: n }, (_, i) => `ch${i + 1}`);
    // Simple lanes say "Sensor 1", not the file's "ch1" (review-3 #5); the data keeps its names.
    const laneNames = document.body.dataset.mode === 'advanced' ? names : names.map(sensorName);
    plot = createPlot({ box: $('rec-cv'), gutter: $('rec-gutter'), names: laneNames, rateHz: h.rate?.hz || h.source?.rateHz || 100, windowSec, sweep: calm });
    plot.canvas.setAttribute('aria-label', W.plotLabel(names.length, plot.windowSec, ''));
    strip = createQualityStrip({ box: $('rec-quality'), names, say: (t2, urgent) => app.say(t2, urgent) });
    setupBody(names.length);
  };
  let strip = null;
  let ctl = null;          // autosave controller, from the end of the pre-roll
  let issues = [];         // lane markers for the plot: [{ lane, level, ms (performance.now clock) }]
  const lq = new LiveQuality();
  const saveEl = document.getElementById('autosave');
  if (names.length) makePlot(names.length);
  let phase = 'ready';
  let prerollEnd = 0;
  let handed = false;
  let alive = true;
  let view = 'fit';
  let viewChosen = false;
  let cal = null;
  let wasCal = false;
  let doneSaid = false;
  const markers = [];
  let markerN = 0;
  let toastTimer = null;
  let offset = null; // host clock -> performance.now(), if a source stamps on another clock

  // Seed the plot with what Preflight saw, so Record never opens on an empty canvas.
  const b = h.buffer;
  if (b?.rows.length && !plot) makePlot(b.rows[0].length);
  if (b) for (let i = Math.max(0, b.rows.length - windowSec * 200); i < b.rows.length; i++) plot.push(b.hostMs[i], b.rows[i], null);
  if (b?.hostMs.length) offset = Math.abs(performance.now() - b.hostMs[b.hostMs.length - 1]) > 2000 ? performance.now() - b.hostMs[b.hostMs.length - 1] : 0;

  h.onSample((s) => {
    if (offset == null) offset = Math.abs(performance.now() - s.hostMs) > 2000 ? performance.now() - s.hostMs : 0;
    const kept = session.push(s);
    if (!plot) makePlot(s.values.length);
    plot.push(s.hostMs + offset, s.values, kept ? session.labels[session.labels.length - 1] : null);
    bodySample(s.values);
  });
  // Demo: the synthetic arm does what the prompt says (spec §6: the Demo follows the protocol).
  if (h.kind === 'twin' && h.source) h.source.labelProvider = () => (session.state === 'recording' ? session.currentLabel() : 'rest');

  // ---------- step strip ----------
  let stripFor = null;
  let tl = [];
  let segEls = [];
  let curIdx = -2;
  let parts = { at: [], n: 0 };
  let partSecs = [], partBefore = [], partEls = [], curPart = -2;
  // i: 1-based step number. Advanced keeps the exact step count; Simple says the part.
  const stepline = (i, left) => WS().stepLine(i, tl.length, left, { at: parts.at[Math.min(i, parts.at.length) - 1] || 1, n: parts.n || 1 });
  function buildStrip() {
    stripFor = session.protocol;
    tl = timeline(session.protocol);
    parts = partsOf(tl);
    el.segs.innerHTML = tl.map((s) => `<span class="seg k-${stripKind(s.label)} fut" style="flex-grow:${s.seconds}" title="${esc(`${wordFor(s.label)} · ${s.seconds} s`)}"></span>`).join('');
    segEls = [...el.segs.children];
    const groups = groupsOf(tl);
    const runs = [];
    groups.forEach((g, i) => { if (runs.length && runs[runs.length - 1].g === g) runs[runs.length - 1].s += tl[i].seconds; else runs.push({ g, s: tl[i].seconds }); });
    el.caps.innerHTML = runs.map((r) => `<span style="flex-grow:${r.s}">${esc(STRIP_GROUPS[r.g] || '')}</span>`).join('');
    // Simple mode's strip (spec N6): one block per part, sized by its seconds and named by its
    // first captioned step. Both strips are always painted, so switching mode mid-session is safe.
    partSecs = Array(parts.n).fill(0);
    partBefore = tl.map((s, i) => { const p = parts.at[i] - 1; const b = partSecs[p]; partSecs[p] += s.seconds; return b; });
    const partName = Array(parts.n).fill('');
    groups.forEach((g, i) => { const p = parts.at[i] - 1; if (g && !partName[p]) partName[p] = STRIP_GROUPS[g] || ''; });
    el.parts.innerHTML = partSecs.map((sec, p) => `<span class="part fut" style="flex-grow:${sec}"><span class="pn">${esc(partName[p])}</span></span>`).join('');
    partEls = [...el.parts.children];
    curPart = -2;
    curIdx = -2;
  }
  buildStrip();
  function paintStrip(idx, frac, paused) {
    if (idx !== curIdx) {
      segEls.forEach((s, i) => { s.classList.toggle('fut', i > idx); s.classList.toggle('cur', i === idx); });
      curIdx = idx;
    }
    const cur = segEls[idx];
    if (cur) { cur.style.setProperty('--p', `${(frac * 100).toFixed(1)}%`); cur.classList.toggle('paused', !!paused); }
    // idx past the end (done) fills every part; idx < 0 (ready) leaves them all to come.
    const p = idx >= tl.length ? parts.n : idx < 0 ? -1 : parts.at[idx] - 1;
    if (p !== curPart) {
      partEls.forEach((s, i) => { s.classList.toggle('fut', i > p); s.classList.toggle('cur', i === p); });
      curPart = p;
    }
    const cp = partEls[p];
    if (cp) {
      const pf = partSecs[p] ? (partBefore[idx] + frac * tl[idx].seconds) / partSecs[p] : 0;
      cp.style.setProperty('--p', `${(Math.min(1, pf) * 100).toFixed(1)}%`); cp.classList.toggle('paused', !!paused);
    }
  }

  // ---------- prompt (writes only what changed) ----------
  const last = {};
  const put = (k, node, text, prop = 'textContent') => { if (last[k] !== text) { last[k] = text; node[prop] = text; } };
  function prompt(m) {
    put('word', el.word, m.word);
    el.word.classList.toggle('long', m.word.length > 10);
    el.word.classList.toggle('dim', !!m.dim);
    put('tag', el.tag, m.tag || '');
    put('sub', el.sub, m.sub || '');
    put('pos', el.pos, m.pos || '');
    el.pos.hidden = !m.pos;
    put('pose', el.pose, m.pose || '', 'innerHTML');
    put('count', el.count, m.count, 'innerHTML');
    el.ring.dataset.tone = m.tone || '';
    el.arc.style.strokeDashoffset = (RING_C * (1 - (m.ring ?? 1))).toFixed(1);
    put('nextW', el.nextW, m.next || '');
    put('nextS', el.nextS, m.nextS || '');
    el.next.classList.toggle('soon', !!m.soon);
    put('stepline', el.stepline, m.stepline || '');
    // Volunteer screen only (CSS hides it elsewhere); whole minutes so it changes rarely.
    put('vleft', el.vleft, m.left == null ? '' : W.volLeft(m.left));
  }

  // ---------- transport ----------
  function setBtn(b2, enabled, reason, primary = false) {
    b2.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    b2.title = enabled ? '' : reason;
    b2.classList.toggle('primary', primary);
  }
  let tKey = '';
  function paintTransport(ps) {
    const live = phase === 'live';
    const paused = live && session.paused;
    const done = live && ps?.done;
    // While unplugged, R and P do nothing (carryOn() owns the restart), so both read and act
    // disabled and Record keeps its label: two enabled "Resume" buttons misled (review-1 #2).
    const off = link !== 'ok';
    const k = `${phase}|${paused}|${done}|${view}|${!!cal}|${windowSec}|${off}`;
    if (k === tKey) return;
    tKey = k;
    sec.dataset.phase = phase;
    sec.dataset.view = view;
    setBtn(btn.rec, !off && (phase === 'ready' || paused), W.needStart, !off && phase === 'ready');
    btn.rec.querySelector('.w').textContent = paused && !off ? WS().buttons.resume : WS().buttons.record;
    setBtn(btn.pause, !off && live && !done, W.needStart);
    btn.pause.querySelector('.w').textContent = paused && !off ? WS().buttons.resume : W.buttons.pause;
    // At Done the only way on is Stop, so it becomes the primary "Review and save" (review-1 #3);
    // the "Next" column has nothing left to say and is hidden.
    setBtn(btn.stop, live, W.needStart, !!done);
    btn.stop.querySelector('.w').textContent = done ? WS().buttons.review : WS().buttons.stop;
    el.next.hidden = !!done;
    setBtn(btn.redo, live && !done, W.needStart);
    setBtn(btn.skip, live && !done, W.needStart);
    root.querySelectorAll('[data-view]').forEach((v) => {
      v.setAttribute('aria-pressed', String(v.dataset.view === view));
      if (v.dataset.view === 'norm') v.setAttribute('aria-disabled', cal ? 'false' : 'true');
    });
    el.win.textContent = W.windowSec(windowSec);
  }

  function toast(text) {
    el.toast.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.textContent = ''; }, 3000);
  }
  const mark = (note) => markers.push({ ms: performance.now(), note });
  const curWord = () => { const ps = session.protocolState(); return ps?.step ? wordFor(ps.step.label) : ''; };

  // ---------- unplug / reconnect (spec §9.1) ----------
  let link = 'ok';          // 'ok' | 'unplugged' | 'reconnecting' | 'failed' | 'back'
  let unplugAt = 0;
  let backEnd = 0;
  const ub = { box: $('rec-unplug'), h: $('rec-uh'), sub: $('rec-usub'), wait: $('rec-uwait'), re: $('b-reconnect'), stop: $('b-ustop') };
  const canReconnect = typeof h.source?.reconnect === 'function';
  ub.re.hidden = !canReconnect;
  h.onStatus?.((st) => {
    if (!alive) return;
    const now = performance.now();
    if (st === 'disconnected') {
      if (link !== 'ok') return;
      link = 'unplugged';
      unplugAt = now;
      // Only a live session has a clock to pause; before R the band alone is enough.
      if (phase === 'live') session.disconnected(now);
      if (phase === 'preroll') phase = 'ready';
      mark('unplugged');
      ctl?.flush().catch((e) => console.warn('autosave flush failed', e));
      app.say(W.sayUnplugged, true);
    } else if (st === 'reconnecting' && link !== 'ok' && link !== 'back') link = 'reconnecting';
    else if (st === 'error' && link !== 'ok') link = 'failed';
    else if (st === 'connected' && link !== 'ok' && link !== 'back') {
      if (phase === 'live') session.reconnected(now);
      mark('reconnected');
      link = 'back';
      backEnd = now + backMs;
    }
  });
  // The count after a reconnect ended (or R/P cut it short): restart the step that was cut.
  function carryOn() {
    link = 'ok';
    if (phase !== 'live') return;
    if (session.pauseReason === 'unplugged') session.resume();
    const w = curWord();
    if (session.redoStep()) curIdx = -2;
    app.say(W.sayReconnected(w));
  }
  function reconnect() {
    if (!canReconnect || link === 'ok' || link === 'back' || link === 'reconnecting') return;
    link = 'reconnecting';
    // A rejected reopen needs a fresh press (and maybe the port picker), so the band says so.
    h.source.reconnect().catch(() => { if (link === 'reconnecting') link = 'failed'; });
  }
  function paintBand(now) {
    const on = link !== 'ok';
    if (ub.box.hidden === on) ub.box.hidden = !on;
    sec.dataset.link = link;
    if (!on) return;
    const back = link === 'back';
    put('uh', ub.h, back ? W.reconnected(Math.max(1, Math.ceil((backEnd - now) / 1000))) : W.unplugged);
    const dataSec = session.t.length ? session.t[session.t.length - 1] / 1000 : 0;
    put('usub', ub.sub, back ? WS().reconnectedSub(curWord()) : link === 'failed' ? W.reconnectFailed : W.unplugSub(W.mmss(dataSec)));
    put('uwait', ub.wait, link === 'reconnecting' ? W.reconnecting : back ? '' : W.unplugWait(W.mmss((now - unplugAt) / 1000)));
    const busy = link === 'reconnecting' || back;
    ub.re.setAttribute('aria-disabled', String(busy));
    ub.box.dataset.state = link;
  }

  // ---------- hidden tab + wake lock (RISKS B9) ----------
  const wl = app.env.wakeLock || globalThis.navigator?.wakeLock;
  let lock = null;
  let lockBusy = false;
  let lockDenied = false;
  const wantLock = () => alive && phase === 'live' && !session.paused && !session.protocolState()?.done;
  function syncLock() {
    const want = wantLock();
    if (want && !lock && !lockBusy && !lockDenied && wl?.request && !document.hidden) {
      lockBusy = true;
      wl.request('screen').then((l) => {
        lockBusy = false;
        if (!wantLock()) { l.release?.().catch?.(() => {}); return; }
        lock = l;
        // The browser drops the lock itself when the tab is hidden; visibilitychange asks again.
        l.addEventListener?.('release', () => { if (lock === l) lock = null; });
      }, () => { lockBusy = false; lockDenied = true; });
    } else if (!want && lock) {
      const l = lock;
      lock = null;
      l.release?.().catch?.(() => {});
    }
  }
  const onVis = () => {
    if (!alive) return;
    if (document.hidden) {
      // rAF stops in a hidden tab, so the prompt can't be seen: stop the clock, keep the data.
      if (phase === 'live' && !session.protocolState()?.done && session.pause('hidden')) mark('paused (hidden)');
    } else lockDenied = false;
    syncLock();
  };
  document.addEventListener('visibilitychange', onVis);

  // ---------- board reset note ----------
  let resetsShown = 0;
  const noteEl = $('rec-note');

  // ---------- Volunteer view (spec §8.7) ----------
  let vol = false;
  function setVol(on) {
    vol = on;
    if (on) sec.dataset.vol = '1'; else delete sec.dataset.vol;
    // The card sits over the plot for the operator but in the prompt for the volunteer, where it is
    // read at full size (review-3 #2). Works at every width now: below 600 px the button is an icon.
    if (on) sec.querySelector('.prompt').insertBefore(el.volcard, sec.querySelector('.volfoot'));
    else sec.querySelector('.plotwrap').insertBefore(el.volcard, $('rec-body'));
    // The volunteer screen hides the shell, so its own Back to controls button takes focus: a
    // keyboard user is never left on a hidden control (simplify-audit: "one-way door").
    if (on) $('b-volx').focus({ preventScroll: true });
    else if (sec.contains(document.activeElement) && document.activeElement.id === 'b-volx') root.closest('main')?.focus({ preventScroll: true });
  }
  $('b-volx').onclick = () => setVol(false);
  $('b-volshow').onclick = () => setVol(true);

  // ---------- Step menu (Redo / Skip; menu-button pattern as shell-nav.js More) ----------
  const stepBtn = $('b-stepm');
  const stepMenu = $('rec-stepmenu');
  function closeStep(focus = false) {
    if (stepMenu.hidden) return;
    stepMenu.hidden = true;
    stepBtn.setAttribute('aria-expanded', 'false');
    if (focus) stepBtn.focus();
  }
  function openStep() {
    stepMenu.hidden = false;
    stepBtn.setAttribute('aria-expanded', 'true');
    stepMenu.querySelector('[role="menuitem"]')?.focus();
  }
  stepBtn.onclick = () => (stepMenu.hidden ? openStep() : closeStep());
  stepMenu.addEventListener('keydown', (e) => {
    const items = [...stepMenu.querySelectorAll('[role="menuitem"]')];
    const i = items.indexOf(document.activeElement);
    // Stop propagation: the page's ← / → / Esc keys must not also redo, skip or leave Record.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeStep(true); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); } else if (e.key === 'Tab') closeStep();
  });
  // Choosing an item closes the menu and puts focus back on ⋯ Step, so focus never sits on a hidden item.
  stepMenu.addEventListener('click', (e) => { if (e.target.closest('[role="menuitem"]')) closeStep(true); });
  const onStepAway = (e) => { if (!stepMenu.hidden && !e.target.closest('.stepm')) closeStep(); };
  document.addEventListener('pointerdown', onStepAway);

  // ---------- actions ----------
  const act = {
    record() {
      if (link === 'back') { carryOn(); return; }
      if (link !== 'ok') { toast(W.plugInFirst); return; }
      // The first Start puts the volunteer card away for good (spec §7); it is an overlay, so
      // hiding it never moves the plot or the prompt.
      if (phase === 'ready') { el.volcard.hidden = true; phase = 'preroll'; prerollEnd = performance.now() + preRollMs; return; }
      if (phase === 'live' && session.paused) act.pause();
    },
    pause() {
      if (link === 'back') { carryOn(); return; }
      if (link !== 'ok') { toast(W.plugInFirst); return; }
      if (phase !== 'live' || session.protocolState()?.done) return;
      if (session.paused) { if (session.resume()) { mark('resumed'); app.say(W.sayStarted); } } else if (session.pause('user')) { mark('paused'); app.say(W.sayPaused); }
    },
    // leaving: Home, Back or a step asked (Stop guard, spec §3.4): same dialog, the leaving words.
    stop(leaving = false) {
      if (phase !== 'live') return;
      if (session.protocolState()?.done) { finish(); return; }
      $('rec-stop-p').textContent = leaving ? W.leaveBody : W.stopBody(W.mmss((performance.now() - session.startHost) / 1000));
      el.dlg.showModal();
      $('rec-stop-yes').focus();
    },
    redo() { const w = curWord(); if (phase === 'live' && session.redoStep()) { mark('redo'); app.say(W.sayRedo(w)); curIdx = -2; } },
    skip() { const w = curWord(); if (phase === 'live' && session.skipStep()) { mark('skip'); app.say(W.saySkip(w)); curIdx = -2; } },
    recal() {
      if (phase !== 'live') return;
      const r = session.insertSteps(calibrationSteps(timing));
      if (r.ok) { mark('calibration added'); toast(W.calAdded); app.say(W.calAdded); }
    },
    marker(note) {
      if (phase !== 'live') return;
      markerN++;
      session.addMarker(note || `M${markerN}`);
      mark(note || `M${markerN}`);
      toast(W.marker(markerN, W.mmss(session.clock())));
    },
    view(v, byHand = true) {
      if (v === 'norm' && !cal) { app.say(W.needCal); toast(W.needCal); return; }
      view = v;
      if (byHand) viewChosen = true;
    },
    cycleView() {
      const order = cal ? ['fit', 'full', 'norm'] : ['fit', 'full'];
      act.view(order[(order.indexOf(view) + 1) % order.length]);
    },
    window(d) {
      const i = WINDOWS.indexOf(windowSec);
      windowSec = WINDOWS[Math.max(0, Math.min(WINDOWS.length - 1, (i < 0 ? 1 : i) + d))];
      if (plot) plot.windowSec = windowSec;
    },
  };
  function finish() {
    if (handed) return;
    session.stop();
    handed = true;
    ctl?.flush().catch((e) => console.warn('autosave flush failed', e));
    app.go('review', { handoff: h, session, saver: ctl?.saver || null, liveDrift: lq.driftItems() });
  }
  el.dlg.addEventListener('close', () => {
    if (el.dlg.returnValue === 'stop') finish();
    else root.closest('main')?.focus({ preventScroll: true });
  });
  // After a click, focus goes back to the Record region so Space/Enter mean the hotkeys again.
  const click = (b2, fn) => { b2.onclick = () => { if (b2.getAttribute('aria-disabled') !== 'true') fn(); if (!el.dlg.open) root.closest('main')?.focus({ preventScroll: true }); }; };
  click(ub.re, reconnect); click(ub.stop, () => act.stop());
  click(btn.rec, act.record); click(btn.pause, act.pause); click(btn.stop, act.stop); click(btn.redo, act.redo); click(btn.skip, act.skip);
  root.querySelectorAll('[data-view]').forEach((v) => click(v, () => act.view(v.dataset.view)));

  // ---------- frame ----------
  let raf = 0;
  let ariaStep = null;
  function frame() {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    if (phase === 'preroll' && now >= prerollEnd) {
      session.start({ source: h.kind, synthetic: !!h.synthetic, ...placementMeta(placeSet) });
      phase = 'live';
      ctl = startAutosave({ backend: app.store(), session, persist: () => app.persistOnce(),
        meta: { source: h.kind, synthetic: !!h.synthetic, rate_hz: h.rate?.hz || h.source?.rateHz || undefined, ...placementMeta(placeSet) } });
      mark('start');
      app.say(W.sayStarted);
    }
    if (link === 'back' && now >= backEnd) carryOn();
    if (stripFor !== session.protocol) buildStrip();
    const ps = phase === 'live' ? session.protocolState(now) : null;
    const n = tl.length;
    const total = tl.length ? tl[tl.length - 1].end : 0;
    let future = [];
    let current = null;
    const span = (windowSec * (1 - NOW_AT)) / NOW_AT + 0.2;
    const ahead = (fromSec, baseMs, idx0) => {
      for (let i = Math.max(0, idx0); i < n && tl[i].start < fromSec + span; i++) {
        const s = tl[i];
        future.push({ startMs: baseMs + (s.start - fromSec) * 1000, endMs: baseMs + (s.end - fromSec) * 1000, label: s.label, word: wordFor(s.label), current: ps && i === ps.index });
      }
    };

    if (phase === 'ready') {
      const first = tl[0];
      // Simple mode: no key as the instruction; the ring shows ▶ (simplify-spec §5).
      const simple = document.body.dataset.mode !== 'advanced';
      prompt({ word: W.ready, sub: vol ? W.volReadySub : WS().readySub(calSecs(tl), n - tl.filter(isCalStep).length, total), count: simple ? '<span aria-hidden="true">▶</span>' : '<span class="key">R</span>',
        ring: 1, next: first ? wordFor(first.label) : '', nextS: first ? W.nextSec(first.seconds) : '', stepline: stepline(1, total), left: total });
      paintStrip(-1, 0, false);
    } else if (phase === 'preroll') {
      const first = tl[0];
      const left = Math.max(0, (prerollEnd - now) / 1000);
      prompt({ word: wordFor(first.label), dim: true, sub: W.startingIn, count: String(Math.max(1, Math.ceil(left))), tone: 'accent',
        ring: left / (preRollMs / 1000 || 1), next: wordFor(first.label), nextS: W.nextSec(first.seconds), stepline: stepline(1, total), left: total });
      ahead(0, prerollEnd, 0);
      paintStrip(-1, 0, false);
    } else if (ps && ps.done) {
      prompt({ word: W.done, sub: WS().doneSub(n), count: '✓', tone: 'good', ring: 1, next: W.nextDone, stepline: stepline(n, 0) });
      paintStrip(n, 0, false);
      if (!doneSaid) { doneSaid = true; app.say(WS().sayDone); }
    } else if (ps) {
      const s = ps.step;
      const nx = tl[ps.index + 1];
      const remain = ps.stepRemaining;
      const word = wordFor(s.label);
      current = s.label;
      prompt({
        word: session.paused ? W.paused : word,
        tag: session.paused ? '' : tagFor(s.label),
        sub: session.paused ? (session.pauseReason === 'hidden' ? WS().hiddenSub(word) : WS().pausedSub(word)) : (INSTRUCTION_WORDS[splitLabel(s.label).gesture] || s.instruction),
        pos: POSITION_WORDS[positionFor(s.label)] || '',
        pose: pose(positionFor(s.label), handFor(s.label)),
        count: String(Math.max(1, Math.ceil(remain - 1e-6))),
        tone: session.paused ? 'muted' : (remain <= LAST_SECONDS ? 'accent' : ''),
        ring: (calm ? Math.ceil(remain - 1e-6) : remain) / s.seconds,
        next: nx ? wordFor(nx.label) : W.nextDone, nextS: nx ? W.nextSec(nx.seconds) : '', soon: remain <= NEXT_WARN_SEC,
        stepline: stepline(ps.index + 1, total - session.clock(now)), left: Math.max(0, total - session.clock(now)),
      });
      paintStrip(ps.index, ps.stepElapsed / s.seconds, session.paused);
      ahead(session.clock(now), now, ps.index);
      // Calibration just ended: compute it once and switch to 0-1 (spec §8.3 Automatic switch).
      const isCal = s.label.startsWith('cal_');
      if (wasCal && !isCal) {
        const c = calibrate(windowOf(session));
        if (c) {
          const first = !cal;
          cal = c;
          if (first && !viewChosen) { view = 'norm'; app.say(W.calAuto); toast(W.calAuto); } else if (first) { app.say(W.calManual); toast(W.calManual); }
        }
      }
      wasCal = isCal;
      if (plot && ariaStep !== s.label) {
        ariaStep = s.label;
        plot.canvas.setAttribute('aria-label', W.plotLabel(names.length, windowSec, `${word.toLowerCase()}${POSITION_WORDS[positionFor(s.label)] ? `, ${POSITION_WORDS[positionFor(s.label)].toLowerCase()}` : ''}`));
      }
    }
    paintTransport(ps);
    paintBand(now);
    syncLock();
    plot?.frame(now, { view, cal, current, future, markers, issues });
    bodyFrame(now);
  }
  raf = requestAnimationFrame(frame);
  const counter = setInterval(() => { sec.dataset.samples = String(h.count()); ctl?.pump(); }, 250);
  sec.dataset.samples = String(h.count());
  // Quality and the autosave line once a second: LiveQuality scans 15 s, too much for every frame.
  const tick = () => {
    if (phase === 'live' && strip && session.t.length) {
      try {
        const r = lq.update(session);
        const tLast = session.t[session.t.length - 1];
        strip.update(r, tLast);
        const now = performance.now();
        issues = strip.lanes().map((l) => ({ lane: l.lane, level: l.level, ms: now - (tLast - l.atMs) }));
        body.items = r.items || [];
        if (body.view && bodyVisible()) body.view.setPins(body.items);
      } catch (e) { console.warn('live quality failed', e); }
    }
    if (session.resets > resetsShown) {
      resetsShown = session.resets;
      const r = session.markers.filter((m) => m.note === 'board reset').pop();
      noteEl.textContent = W.boardReset(W.mmss((r?.t || 0) / 1000));
      mark('board reset');
    }
    paintAutosave(saveEl, ctl ? ctl.state() : null, Date.now(), (t2, urgent) => app.say(t2, urgent));
  };
  const ticker = setInterval(tick, 1000);
  tick();

  app.record = { session, get plot() { return plot; }, get strip() { return strip; }, get saver() { return ctl?.saver || null; }, get autosave() { return ctl; }, phase: () => phase,
    link: () => link, wake: () => (lock ? 'held' : 'off'), vol: () => vol, source: h.source,
    fit: () => fit,
    body: () => ({ on: body.on, tab: body.tab, visible: bodyVisible(), isDefault: body.isDefault, placement: body.placement, view: body.view }) };
  const live = (fn) => (ev) => {
    if (el.dlg.open) return false; // the dialog owns Enter / Esc
    if (ev.repeat) return true;
    fn(ev);
    return true;
  };
  const keys = {
    r: live(act.record), p: live(act.pause), v: live(() => setVol(!vol)), a: live(toggleBody),
    Enter: (ev) => { if (el.dlg.open || link === 'ok' || ev.target?.tagName === 'BUTTON') return false; reconnect(); return true; }, s: live(act.stop), c: live(act.recal), n: live(act.cycleView),
    ArrowLeft: live(act.redo), ArrowRight: live(act.skip), m: live(() => act.marker()),
    '[': live(() => act.window(-1)), ']': live(() => act.window(1)),
    // A focused button keeps Space/Enter (hotkey safety rule 2); otherwise Space does nothing here.
    ' ': (ev) => (ev.target?.tagName === 'BUTTON' ? false : true),
    Escape: (ev) => {
      if (el.dlg.open) return false;
      if (vol) { setVol(false); return true; }
      if (strip?.isOpen()) { strip.close(); return true; }
      if (phase === 'ready') { app.go('start'); return true; }
      return false;
    },
  };
  for (let d = 1; d <= 9; d++) keys[String(d)] = live(() => act.marker(`key ${d}`));
  // Shell Home/Back/steps (shell-nav.js). While recording or paused, leaving goes through the Stop
  // guard (Stop and save -> Review, or Keep recording) so nothing is lost; Back from ready opens Fit.
  const leave = () => {
    if (phase === 'live') { if (!el.dlg.open) act.stop(true); return true; }
    if (phase === 'preroll') phase = 'ready';
    return false;
  };
  const nav = {
    home: leave,
    back: () => leave() || (openPlaces(), true),
    step: (n) => (n === 2 ? (openPlaces(), true) : leave()),
  };
  return {
    keys, nav,
    unmount() {
      alive = false;
      syncLock();
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('pointerdown', onStepAway);
      cancelAnimationFrame(raf);
      clearInterval(counter);
      clearInterval(ticker);
      ctl?.flush().catch((e) => console.warn('autosave flush failed', e));
      strip?.close();
      clearTimeout(toastTimer);
      plot?.destroy();
      body.view?.destroy();
      narrowMq?.removeEventListener?.('change', applyBody);
      if (app.record?.session === session) delete app.record;
      fit?.close();
      if (!handed) { h.onSample(null); h.stop(); }
    },
  };
}
