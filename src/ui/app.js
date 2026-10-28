// ui/app.js: Recorder shell (spec §5) + Start screen (§6). Preflight lives in preflight.js;
// Record lives in record.js (+ plot.js); Review & Save in review.js; Files in files.js.
//
// Contract (for the screens built next)
//   app.go(name, ctx)        unmounts the current screen, mounts `name` with ctx. Names:
//                            'start' | 'preflight' | 'record' | 'review' | 'files' | 'scorecard'.
//   A screen is mount(root, ctx, app) -> { keys?: { [key]: fn(ev) }, unmount?() }.
//     keys use KeyboardEvent.key, letters lower-case ('k', 'x'), plus 'Enter', 'Escape',
//     'ArrowLeft'... A screen key wins over the shell keys; return false from fn to let the
//     shell handle it too. Keys are ignored while typing in a text field (except Escape).
//   app.say(text, urgent=false)  #say-polite / #say-alert; the same text within 5 s is dropped.
//   app.setChip(text|null, { demo, short })   source chip in the top bar; short = narrow-width words.
//   app.download(name, data, type = 'text/csv')   saves a string or bytes (env.download in tests).
//   app.compare / addToCompare(rec, name) / openScorecard(a, b, back)   the A/B tray (≤ 2) and the
//             'scorecard' screen (ctx { a, b: { rec, name } or an array of them to pool, back });
//             Esc returns to back().
//   app.env   { serial, serialOpts, twinOpts, storage, record, wakeLock }: navigator.serial and SerialSource /
//             TwinSource options, overridable by a same-origin test page (see testEnv below).
//   app.store() -> Promise<Backend|null>   the IndexedDB store (env.dbName, default 'opengrip'),
//             opened once and cached; null when this browser has none (autosave then says failed).
//   app.persistOnce() -> Promise   asks navigator.storage.persist() (or env.persist) once per page.
//   Start shows the recovery banner (spec §9.2) for the newest unfinished session with samples;
//   Review receives ctx.recovered (a loadSession recording) when opened from it.
//   Record receives ctx.handoff from Preflight (see the contract at the top of preflight.js);
//     go('record') adds handoff.fit = { checks, skipped, at } (and handoff.fitChecks) from the last
//     Fit close since Start (card A1), which Record passes on to Review untouched.
//   app.setStep(n, state) / app.setGuide(text) and each screen's `nav` hooks: see shell-nav.js.
//   URL ?demo skips Start and opens the Demo signal straight into Record (portfolio link).
//   URL ?showcase opens the guided portfolio walkthrough instead of Start (showcase.js).

import { SerialSource } from '../sources.js';
import { idbBackend, listSessions, loadSession, deleteSession } from '../store.js';
import { toCSV } from '../csv.js';
import { SHELL, START, KEYS, RECOVER, COMPARE, MORE } from './words.js';
import { brand, tile, statusIcon } from './icons.js';
const statusIconLevel = (l) => statusIcon(l, 18);
import { mountPreflight } from './preflight.js';
import { mountRecord } from './record.js';
import { mountReview } from './review.js';
import { mountFiles } from './files.js';
import { mountScorecard } from './scorecard.js';
import { esc } from './dom.js';
import { mountShell } from './shell-nav.js';
import { mountGlassBox } from './glassbox-view.js';
import { mountShowcase } from './showcase.js';

const HC_KEY = 'opengrip.hc';
// Simple (default for everyone) or Advanced, remembered per browser (owner choice, simplify N3).
const MODE_KEY = 'og.mode';
// Keys whose controls Simple hides: they do nothing there and say once where the tool lives (spec §4).
const ADV_KEYS = { record: new Set(['m', 'n', 'c', 'a', '[', ']', ...'123456789']), review: new Set(['b']) };
const $ = (id) => document.getElementById(id);

// A test page that embeds index.html in an iframe can hand the app a mock serial and short
// probe times. Same-origin only; any other embedder throws on parent access and gets {}.
function testEnv() {
  try {
    const hook = window.parent !== window && window.parent.__opengripTest;
    return typeof hook === 'function' ? hook(window) || {} : {};
  } catch { return {}; }
}

function storageOrNull() { try { return window.localStorage; } catch { return null; } }

const t = testEnv();
export const app = {
  screen: null,
  env: {
    serial: 'serial' in t ? t.serial : (navigator.serial ?? null),
    serialOpts: t.serialOpts || {},
    twinOpts: t.twinOpts || {},
    storage: 'storage' in t ? t.storage : storageOrNull(),
    record: t.record || {},
    fit: t.fit || {},
    dbName: t.dbName || 'opengrip',
    persist: t.persist || null,
    download: t.download || null,
    // Screen Wake Lock override for the ui walk; null means navigator.wakeLock (record.js).
    wakeLock: t.wakeLock || null,
  },
  _store: null,
  _persisted: null,

  store() {
    if (!this._store) {
      this._store = Promise.resolve().then(() => (typeof indexedDB === 'undefined' ? null : idbBackend(this.env.dbName))).catch((e) => { console.warn('IndexedDB unavailable', e); return null; });
    }
    return this._store;
  },

  persistOnce() {
    if (!this._persisted) {
      const fn = this.env.persist || (navigator.storage?.persist ? () => navigator.storage.persist() : null);
      this._persisted = Promise.resolve().then(() => fn?.()).catch(() => false);
    }
    return this._persisted;
  },

  // data: a string or bytes (Uint8Array for the export ZIP); type: the file's MIME type.
  download(name, data, type = 'text/csv') {
    if (this.env.download) { this.env.download(name, data, type); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type }));
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  _view: null,
  _gen: 0,
  _said: new Map(),
  _fit: null,

  go(name, ctx = {}) {
    // Save -> Back (shell-nav sets _newTake) is a new take, spec §3.3: the demo goes straight on to
    // Record. A serial port was closed by Save's unmount, so it reopens through Connect's checks.
    if (this._newTake && this.screen === 'review' && name === 'preflight') ctx = { ...ctx, straight: ctx.mode === 'demo' };
    this._newTake = false;
    // Card A1: a fit result belongs to this session's setup; Start begins a new one. Record gets
    // it on the handoff (handoff.fit + handoff.fitChecks) unless Preflight already set one.
    if (name === 'start') this._fit = null;
    if (name === 'record' && ctx.handoff && this._fit && ctx.handoff.fit == null) {
      ctx.handoff.fit = this._fit;
      if (this._fit.checks && ctx.handoff.fitChecks == null) ctx.handoff.fitChecks = this._fit.checks;
    }
    // A screen that re-opens itself (Files' own sub-views) keeps the page it was opened from.
    if (name === this.screen && ctx.from == null && this._ctx?.from != null) ctx = { ...ctx, from: this._ctx.from };
    this._ctx = ctx;
    try { this._view?.unmount?.(); } catch (e) { console.warn('unmount failed', e); }
    this._view = null;
    const root = $('app');
    root.replaceChildren();
    this.screen = name;
    document.body.dataset.screen = name;
    if (name === 'preflight' && ctx.mode) this.lastMode = ctx.mode;
    if (name === 'start') this.setChip(null);
    // Autosave status only means something while there is a recording on screen.
    $('autosave').hidden = !(name === 'record' || name === 'review');
    const mount = SCREENS[name];
    const gen = ++this._gen;
    const v = mount(root, ctx, this) || {};
    // A screen may hand on during its own mount (?demo); the newer screen's view wins.
    if (gen === this._gen) { this._view = v; this.shell?.update(name, ctx); } else v.unmount?.();
    // The old screen's focused node is gone; keep keyboard users inside the new screen.
    if (!root.contains(document.activeElement)) root.focus({ preventScroll: true });
  },

  // Where a More page was opened from: { name, ctx } for goBackTo().
  opener() { return { name: this.screen, ctx: this._ctx || {} }; },

  // Back from a More page (R3c). Record and Connect hold a live source that leaving stopped, so
  // they come back through Connect (the demo straight on to Record); other screens re-mount with
  // their old ctx. from may also be a bare screen name.
  goBackTo(from) {
    const f = typeof from === 'string' ? { name: from, ctx: {} } : from || { name: 'start' };
    if (f.name === 'record' || f.name === 'preflight') {
      const mode = this.lastMode || 'demo';
      this.go('preflight', { mode, straight: f.name === 'record' && mode === 'demo' });
    } else this.go(SCREENS[f.name] ? f.name : 'start', f.ctx || {});
  },

  say(text, urgent = false) {
    const now = Date.now();
    const last = this._said.get(text);
    if (last != null && now - last < 5000) return;
    this._said.set(text, now);
    const el = $(urgent ? 'say-alert' : 'say-polite');
    // Clear then set on the next frame, so a screen reader hears a changed node.
    el.textContent = '';
    requestAnimationFrame(() => { el.textContent = text; });
  },

  // short: the words shown at narrow widths (375 px); the full text stays the accessible name.
  setChip(text, { demo = false, short = null } = {}) {
    const chip = $('source-chip');
    chip.hidden = !text;
    chip.classList.toggle('demo', !!demo);
    // At narrow widths the CSS shows .chip-short and keeps .chip-full for screen readers only.
    if (short && text) chip.innerHTML = `<span class="chip-full">${esc(text)}</span><span class="chip-short" aria-hidden="true">${esc(short)}</span>`;
    else chip.textContent = text || '';
  },

  // A/B comparison tray: up to two { rec, name }; adding a third drops the oldest.
  compare: [],
  addToCompare(rec, name) {
    this.compare = [...this.compare.filter((x) => x.rec !== rec), { rec, name }].slice(-2);
    this.say(COMPARE.added(name, this.compare.length));
    return this.compare.length;
  },
  // Opens the Scorecard screen; back() is where Esc returns (default Start). a and b are each
  // { rec, name } or an array of them (pooled per side, from Files); a recording on both sides
  // is refused because pooling would compare it with itself.
  openScorecard(a, b, back = null) {
    const as = [].concat(a || []), bs = [].concat(b || []);
    if (!as.length || !bs.length) { this.say(COMPARE.needTwo); return false; }
    if (as.some((x) => bs.some((y) => y.rec === x.rec))) { this.say(COMPARE.sameTwice); return false; }
    this.go('scorecard', { a, b, back });
    return true;
  },

  get advanced() { return document.body.dataset.mode === 'advanced'; },
  setMode(advanced, announce = false) {
    document.body.dataset.mode = advanced ? 'advanced' : 'simple';
    try { this.env.storage?.setItem(MODE_KEY, advanced ? 'advanced' : 'simple'); } catch { /* private mode */ }
    $('m-advanced').setAttribute('aria-checked', String(!!advanced));
    $('mode-tag').hidden = !advanced;
    if (announce) this.say(advanced ? MORE.advancedOn : MORE.advancedOff);
  },

  setContrast(high, announce = false) {
    document.documentElement.dataset.contrast = high ? 'high' : 'normal';
    try { this.env.storage?.setItem(HC_KEY, high ? '1' : '0'); } catch { /* private mode */ }
    $('m-contrast')?.setAttribute('aria-checked', String(!!high));
    if (announce) this.say(high ? SHELL.hcOn : SHELL.hcOff);
    this.record?.plot?.refreshColours(); // the canvas caches its colours
  },
};

// The ui walk reads app.record (session, plot) through this; only when a test page embeds us.
if (Object.keys(t).length) window.__opengripApp = app;

// ---------- keys ----------
function typing(el) {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'file'].includes(el.type);
}

let advKeyNoted = false;
function onKey(ev) {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if ($('keys-dialog').open) return; // the dialog handles its own Esc
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  if (typing(ev.target) && key !== 'Escape') return;
  if (!app.advanced && ADV_KEYS[app.screen]?.has(key)) {
    ev.preventDefault();
    if (!advKeyNoted) { advKeyNoted = true; app.say(MORE.advancedKey); }
    return;
  }
  const fn = app._view?.keys?.[key];
  if (fn) {
    if (fn(ev) !== false) { ev.preventDefault(); return; }
  }
  if (key === '?') { ev.preventDefault(); openKeys(); return; }
  if (key === 'h') { ev.preventDefault(); app.setContrast(document.documentElement.dataset.contrast !== 'high', true); }
}

function openKeys() {
  const d = $('keys-dialog');
  const rows = [...(KEYS[app.screen] || []), ...KEYS.global];
  d.innerHTML = `<h2 id="keys-title">${esc(SHELL.keysTitle)}</h2><table>${rows.map(([k, w]) => `<tr><td><span class="key">${esc(k)}</span></td><td>${esc(w)}</td></tr>`).join('')}</table>
    <button class="btn" type="button" id="keys-close">${esc(SHELL.close)}</button>`;
  const opener = document.activeElement;
  d.querySelector('#keys-close').onclick = () => d.close();
  d.addEventListener('close', () => opener?.focus?.(), { once: true });
  d.showModal();
}

// ---------- Start ----------
function mountStart(root, ctx, a) {
  const canSerial = SerialSource.supported(a.env.serial);
  root.innerHTML = `<section class="screen" aria-labelledby="start-h">
    <h1 id="start-h" class="vh">${esc(SHELL.screens.start)}</h1>
    <div id="recover" class="recover" role="region" aria-labelledby="recover-h" hidden></div>
    <div class="lead"><p>${esc(START.lead1)}</p><p>${esc(START.lead2)}</p></div>
    <div class="tiles" role="group" aria-label="${esc(SHELL.screens.start)}">
      <button class="tile" type="button" id="tile-connect" ${canSerial ? '' : 'aria-disabled="true"'}>
        ${tile.connect}<span class="t">${esc(START.connectTitle)}</span>
        <span class="b">${esc(canSerial ? START.connectBody : START.connectDisabled)}</span><span class="key" aria-hidden="true">1</span></button>
      <button class="tile" type="button" id="tile-demo">${tile.demo}<span class="t">${esc(START.demoTitle)}</span>
        <span class="b">${esc(START.demoBody)}</span><span class="key" aria-hidden="true">2</span></button>
      <button class="tile" type="button" id="tile-file">${tile.file}<span class="t">${esc(START.fileTitle)}</span>
        <span class="b">${esc(START.fileBody)}</span><span class="key" aria-hidden="true">3</span></button>
    </div>
    <div class="foot small"><p>${esc(START.privacy)}</p><p>${esc(START.notMedical)}</p></div>
  </section>`;
  const tiles = [...root.querySelectorAll('.tile')];
  const connect = () => {
    if (!canSerial) { a.say(START.connectDisabled); return; }
    a.go('preflight', { mode: 'serial' });
  };
  const demo = () => a.go('preflight', { mode: 'demo' });
  const file = () => $('file-input').click();
  tiles[0].onclick = connect;
  tiles[1].onclick = demo;
  tiles[2].onclick = file;
  const input = $('file-input');
  input.value = '';
  input.onchange = () => { if (input.files.length) a.go('files', { files: [...input.files] }); };
  (canSerial ? tiles[0] : tiles[1]).focus();
  const move = (d) => {
    const i = tiles.indexOf(document.activeElement);
    tiles[(Math.max(0, i) + d + tiles.length) % tiles.length].focus();
  };
  let alive = true;
  const dlg = { open: false };
  showRecovery(root, a, () => alive, dlg);
  const k = (fn) => (ev) => (dlg.open ? false : fn(ev));
  return {
    keys: { 1: k(connect), 2: k(demo), 3: k(file), ArrowRight: k(() => move(1)), ArrowLeft: k(() => move(-1)) },
    unmount() { alive = false; },
  };
}

function fmtLen(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

// Recovery (spec §9.2): the newest unfinished session that holds samples. The list resolves
// after Start may already have gone; isAlive() keeps a late answer off the next screen.
async function showRecovery(root, a, isAlive, dlg) {
  const backend = await a.store();
  if (!backend || !isAlive()) return;
  let list;
  try { list = (await listSessions(backend)).filter((s) => !s.complete && s.samples > 0); } catch (e) { console.warn('listSessions failed', e); return; }
  if (!list.length || !isAlive()) return;
  const s = list[0];
  const box = root.querySelector('#recover');
  const lenMs = s.updatedAt ? Date.parse(s.updatedAt) - Date.parse(s.startedAt) : 0;
  const len = fmtLen(lenMs);
  const who = s.meta?.person_id || s.meta?.personId || RECOVER.noPerson;
  const when = new Date(s.startedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  box.innerHTML = `<h2 id="recover-h">${statusIconLevel('check')} ${esc(RECOVER.title)}</h2>
    <p class="num" id="recover-line" data-samples="${s.samples}" data-channels="${s.channels}" data-id="${esc(s.id)}">${esc(RECOVER.line(who, when, len))}</p>
    ${list.length > 1 ? `<p class="small">${esc(RECOVER.more(list.length - 1))}</p>` : ''}
    <div class="row-btns"><button class="btn primary" type="button" id="rc-review">${esc(RECOVER.review)}</button>
      <button class="btn" type="button" id="rc-export">${esc(RECOVER.export)}</button>
      <button class="btn" type="button" id="rc-discard">${esc(RECOVER.discard)}</button></div>
    <p class="small" id="rc-msg" role="status"></p>
    <dialog id="rc-dlg" aria-labelledby="rc-dlg-h"><h2 id="rc-dlg-h">${esc(RECOVER.discardTitle)}</h2><p>${esc(RECOVER.discardBody(len))}</p>
      <form method="dialog" class="dlg-row"><button class="btn" value="keep" id="rc-keep" autofocus>${esc(RECOVER.keep)} <span class="key">Esc</span></button>
      <button class="btn danger" value="delete" id="rc-delete">${esc(RECOVER.del)}</button></form></dialog>`;
  box.hidden = false;
  const msg = box.querySelector('#rc-msg');
  const load = async () => {
    msg.textContent = RECOVER.loading(s.samples);
    try { return await loadSession(backend, s.id); } catch (e) { msg.textContent = RECOVER.loadError(e?.message || e); return null; }
  };
  box.querySelector('#rc-review').onclick = async () => {
    const rec = await load();
    if (rec && isAlive()) a.go('review', { recovered: rec, recoveredId: s.id });
  };
  box.querySelector('#rc-export').onclick = async () => {
    const rec = await load();
    if (!rec) return;
    const name = `opengrip-recovered-${s.startedAt.slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    a.download(name, toCSV(rec));
    msg.textContent = RECOVER.exported(name);
    a.say(RECOVER.exported(name));
  };
  const d = box.querySelector('#rc-dlg');
  const opener = box.querySelector('#rc-discard');
  opener.onclick = () => {
    dlg.open = true;
    d.showModal();
    // Keep is the safe default: Enter or a stray click must not delete data.
    d.querySelector('#rc-keep').focus();
  };
  d.addEventListener('close', async () => {
    dlg.open = false;
    if (d.returnValue !== 'delete') { opener.focus(); return; }
    try { await deleteSession(backend, s.id); } catch (e) { msg.textContent = String(e?.message || e); return; }
    box.hidden = true;
    box.innerHTML = '';
    a.say(RECOVER.discarded);
    root.querySelector('.tile:not([aria-disabled])')?.focus();
  });
}

// Scorecard (A vs B): ctx { a, b: { rec, name } or an array of them, back }. Esc returns to
// back() or Start. One recording per side passes the bare rec (the unpooled card, as before);
// several pass an array, which ui/scorecard.js pools, named after the first plus a count.
function mountScorecardScreen(root, ctx, a) {
  const back = () => (ctx.back ? ctx.back() : a.go('start'));
  const side = (x) => {
    const list = [].concat(x);
    return list.length === 1 ? { rec: list[0].rec, name: list[0].name } : { rec: list.map((r) => r.rec), name: `${list[0].name} + ${list.length - 1} more` };
  };
  let sc = null;
  try {
    const sa = side(ctx.a), sb = side(ctx.b);
    sc = mountScorecard(root, { a: sa.rec, b: sb.rec, names: [sa.name, sb.name], say: (t, u) => a.say(t, u), download: (n, d, t) => a.download(n, d, t) });
  } catch (e) {
    console.warn('scorecard failed', e);
    root.innerHTML = `<section class="screen"><p class="err" role="alert">${esc(COMPARE.failed(e?.message || e))}</p></section>`;
  }
  // Shell Back goes where the Scorecard was opened from (Review or Files), like Esc (simplify N2).
  return { keys: { Escape: back }, nav: { back: () => { back(); return true; } }, unmount() { sc?.destroy(); } };
}

// Glass Box ("Watch it decide", from More): glassbox-view.js on the demo twin until real recordings
// are handed in. Back and Esc return to the screen it was opened from (app.goBackTo); leaving
// destroys the view (stops its replay timer and plot).
function mountGlassBoxScreen(root, ctx, a) {
  const back = () => (ctx.from ? a.goBackTo(ctx.from) : a.go('start'));
  root.innerHTML = '<section class="screen" id="gb-screen"></section>';
  const gb = mountGlassBox(root.firstElementChild, { recordings: ctx.recordings || [], say: (t, u) => a.say(t, u), simple: !a.advanced, demo: true });
  a.glassbox = gb;
  return { keys: { Escape: back }, nav: { back: () => { back(); return true; } }, unmount() { gb.destroy(); a.glassbox = null; } };
}

// More menu items (spec §4.1). Leaving a screen goes through its own guard first: a view whose
// nav.home() handled the move (stop / save-first dialog) keeps the user there.
function wireMore() {
  const leave = (to, ctx) => { if (app._view?.nav?.home?.()) return; app.go(to, ctx); };
  const reveal = (sel) => { const el = $('app').querySelector(sel); if (!el) return null; el.classList.add('shown'); el.scrollIntoView?.({ block: 'nearest' }); return el; };
  const can = {
    'm-export': () => !!$('app').querySelector('#rv-xp'),
    'm-body': () => app.screen === 'record' || app.screen === 'review',
  };
  const why = { 'm-export': MORE.needRecording, 'm-body': MORE.bodyWhere };
  $('more-btn').addEventListener('click', () => {
    for (const [id, ok] of Object.entries(can)) {
      const off = !ok();
      $(id).setAttribute('aria-disabled', String(off));
      $(id).title = off ? why[id] : '';
    }
  });
  $('m-files').onclick = () => leave('files', { from: app.opener() });
  $('m-glassbox').onclick = () => leave('glassbox', { from: app.opener() });
  $('m-compare').onclick = () => {
    if (app.screen === 'review') $('app').querySelector('#rv-compare')?.click();
    if (app.compare.length >= 2) app.openScorecard(app.compare[0], app.compare[1]);
    else app.say(COMPARE.needTwo);
  };
  $('m-export').onclick = () => {
    if (!can['m-export']()) { app.say(MORE.needRecording); return; }
    reveal('#rv-xp')?.querySelector('button, a, input')?.focus();
  };
  $('m-body').onclick = () => {
    if (app.screen === 'record') { $('app').querySelector('#b-body')?.click(); return; }
    if (app.screen !== 'review') { app.say(MORE.bodyWhere); return; }
    const host = $('app').querySelector('#rv-bodyhost');
    const on = !host?.classList.contains('shown');
    for (const el of $('app').querySelectorAll('#rv-bodyhost, #doctor')) el.classList.toggle('shown', on);
    if (on) host?.scrollIntoView?.({ block: 'nearest' });
  };
  $('m-contrast').onclick = () => app.setContrast(document.documentElement.dataset.contrast !== 'high', true);
  $('m-advanced').onclick = () => app.setMode(!app.advanced, true);
}

const SCREENS = { glassbox: mountGlassBoxScreen, start: mountStart, preflight: mountPreflight, record: mountRecord, review: mountReview, files: mountFiles, scorecard: mountScorecardScreen };

// ---------- boot ----------
function boot() {
  $('brand-mark').innerHTML = brand;
  app.shell = mountShell(app);
  // Owner choice: high contrast is a toggle (H), off until someone turns it on; remembered.
  let hc = null;
  try { hc = app.env.storage?.getItem(HC_KEY); } catch { /* private mode */ }
  app.setContrast(hc === '1');
  let mode = null;
  try { mode = app.env.storage?.getItem(MODE_KEY); } catch { /* private mode */ }
  app.setMode(mode === 'advanced');
  wireMore();
  $('keys-btn').onclick = openKeys;
  document.addEventListener('keydown', onKey);
  // Card A1: the last Fit close's result ({ checks, skipped, at }, fit.js contract) rides on the
  // next Record handoff so Save's report shows the real check, or that Fit was skipped.
  document.addEventListener('opengrip:fit', (e) => { if (e.detail?.open === false && e.detail.fit) app._fit = e.detail.fit; });
  const params = new URLSearchParams(location.search);
  if (params.has('showcase')) mountShowcase(app);
  else if (params.has('demo')) app.go('preflight', { mode: 'demo', straight: true });
  else app.go('start');
}

boot();
