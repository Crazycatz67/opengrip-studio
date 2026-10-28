// ui/showcase.js: the portfolio walkthrough (build card D5). `?showcase` drives the REAL screens on the
// demo twin (one planted loose sensor, so the Hardware Doctor has something to find) with an anchored
// tip card per step: Connect → Record (volunteer prompt) → live quality strip → the Doctor on Save →
// Save → Glass Box "Watch it decide". About 2 minutes with the short recording timing below.
//
// Contract
//   mountShowcase(app) -> showcase    from app.js boot when the URL has ?showcase (instead of Start).
//     Sets app.showcase = { step(), steps, busy(), next(), back(), exit(), isOpen() } for the ui walk.
//   While open the app runs sandboxed, restored on exit:
//     app.env.twinOpts / app.env.record   the planted fault and the fast protocol (showcase wins over a
//                                         test page's values);
//     app.env.storage                     reads fall through to the browser, writes stay in memory, and
//                                         og.tour reads 'done' so the first-run tour never opens on top;
//     app._store / app._persisted         an in-memory store and no persist() prompt: autosave never
//                                         touches IndexedDB. Only a button the visitor presses downloads.
//   DOM: #showcase > .tour-hole + .tour-tip[role=dialog] (tour.js createTipCard and its styles, non-modal so
//     the visitor can press Save), .sc-chip "Demo: synthetic data" and #sc-exit "Exit demo" in every
//     step, .tour-c "Step n of N", #sc-next, #sc-back. Esc in the card = Exit demo.
//   exit(): closes the card, restores everything above, drops ?showcase from the URL, goes Home.
//     Pressing Home (or any route to Start) mid-walk also ends the showcase the same way.
// Failure behaviour: a screen that does not reach the expected state within its wait leaves the card
//   on the current step with the note "That step did not load. Try Next again, or Exit demo."
//
// Glass Box step: the session the visitor just recorded (caught on Record's route to Review, kept in
//   memory, never stored) is handed to Glass Box and trained on. If it cannot be trained on (too short,
//   one gesture), Glass Box uses its stored demo recordings and the card says so in one line.

import { esc } from './dom.js';
import { createTipCard } from './tour.js';
import { demoRecordings } from './glassbox-view.js';
import { memoryBackend } from '../store.js';

// Fast protocol: the whole recording takes about 20 s instead of several minutes.
const TIMING = { calRest: 2, calSqueezes: 1, restStart: 2, hold: 2, rest: 2, reps: 1, restEnd: 2 };
// One loose sensor (ch3), repeated so the visitor meets it whenever they press Record. Sample
// indices at 100 Hz from the twin's start on Connect; each loose spell lasts about 4 s.
const FAULTS = [8, 18, 28, 38, 48].map((s) => ({ type: 'loose', channel: 2, start: s * 100 }));
const TWIN = { seed: 7, faults: FAULTS };

const COPY = {
  chip: 'Demo: synthetic data',
  exit: 'Exit demo',
  next: 'Next',
  back: 'Back',
  finish: 'Finish',
  wait: 'Loading the next screen…',
  failed: 'That step did not load. Try Next again, or Exit demo.',
  takeName: 'Your take (synthetic twin)',
  tooShort: 'Your take was too short to train on, so this uses the stored demo recordings instead.',
  label: 'Demo walkthrough',
};

const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(80); }
  return !!fn();
}

export function mountShowcase(app) {
  const $ = (id) => document.getElementById(id);
  const screen = () => app.screen;
  const realGo = app.go;
  const saved = { twinOpts: app.env.twinOpts, record: app.env.record, storage: app.env.storage, store: app._store, persisted: app._persisted };
  let index = 0;
  let busy = false;
  let open = true;
  let gen = 0; // bumps on exit so a step still waiting on a screen gives up
  let take = null; // the session the visitor just recorded, from Record's route to Review (memory only)
  let gbNote = ''; // why Glass Box fell back to the demo recordings, '' when it trained on the take

  // ---------- the sandbox ----------
  const mem = new Map([['og.tour', 'done']]);
  const real = saved.storage;
  app.env.storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : (() => { try { return real?.getItem(k) ?? null; } catch { return null; } })()),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.set(k, null); },
  };
  app.env.twinOpts = { ...saved.twinOpts, ...TWIN };
  app.env.record = { ...saved.record, timing: TIMING, preRollMs: 1500 };
  app._store = Promise.resolve(memoryBackend());
  app._persisted = Promise.resolve(false);
  // Any route Home (the Home button, Glass Box Back) ends the walk cleanly instead of leaving the
  // card over Start with the sandbox still on.
  app.go = function go(name, ctx) {
    // Restore first: Start's recovery banner must read the real store, not the sandbox.
    if (open && name === 'start') exit(false);
    if (open && name === 'review' && ctx?.session) take = ctx.session;
    return realGo.call(this, name, ctx);
  };

  // ---------- step actions (each brings the app from the previous step's screen to this one) ----------
  const click = (sel) => { const b = document.querySelector(sel); if (b && !b.disabled) { b.click(); return true; } return false; };
  async function toRecord(g) {
    if (screen() !== 'preflight') realGo.call(app, 'preflight', { mode: 'demo' });
    if (!await until(() => g !== gen || click('#pf-skip'), 6000) || g !== gen) return false;
    if (!await until(() => screen() === 'record' && $('b-rec'), 4000)) return false;
    if (app.record?.phase?.() === 'ready') click('#b-rec');
    return until(() => ['preroll', 'live'].includes(app.record?.phase?.()), 3000);
  }
  async function toReview() {
    if (screen() !== 'record') return false;
    click('#b-stop');
    await sleep(60);
    if (visible($('rec-stop-yes'))) click('#rec-stop-yes');
    return until(() => screen() === 'review', 4000);
  }
  async function toGlassBox(g) {
    let rec = null;
    try { rec = take?.recording?.() || null; } catch { rec = null; }
    gbNote = '';
    realGo.call(app, 'glassbox', { recordings: rec ? [{ name: COPY.takeName, recording: rec }] : [] });
    if (!await until(() => g !== gen || (screen() === 'glassbox' && app.glassbox), 6000) || g !== gen) return false;
    const gb = app.glassbox;
    // train() answers null (with its own error line) when the take cannot be split into seen and
    // unseen repetitions: fall back to the demo recordings rather than show an empty Watch step.
    if (!rec || !gb.train()) {
      gbNote = COPY.tooShort;
      gb.setRecordings(demoRecordings());
      if (!gb.train()) return false;
    }
    if (!await until(() => g !== gen || visible($('gb-watch')), 4000) || g !== gen) return false;
    click('#gb-watch [data-act="play"]');
    // The step's show() scrolls the hand into view; wait until it has loaded and the plot and bars
    // above it have laid out, or the scroll lands short.
    await until(() => g !== gen || app.glassbox?.hand, 2000);
    await Promise.race([app.glassbox?.hand?.ready, sleep(3000)]);
    await sleep(300);
    return g === gen;
  }
  const doctorOrReport = () => (visible($('doctor')) ? ['doctor'] : ['rv-report']);
  const saveButton = () => {
    const b = $('rv-export') || [...document.querySelectorAll('#app .btn.primary')].find(visible);
    return b ? [b] : ['rv-report'];
  };

  const STEPS = [
    { screen: 'preflight', target: () => ['pf-rows'], title: 'Connect finds the signal by itself.',
      body: 'No settings to pick. The app listened, recognised a 6-sensor band at 100 readings a second and ticked each check. This band is a synthetic twin of a real one, with one fault planted for the app to find.' },
    { screen: 'record', enter: toRecord, target: () => ['rec-prompt'], title: 'The volunteer reads one big word.',
      body: 'Each step shows one word, a pose and a countdown ring, readable from across a table. The twin follows the prompt, so the signal moves when the word says squeeze. (Speeded up for this demo.)' },
    { screen: 'record', target: () => ['rec-quality'], title: 'The live quality strip.',
      body: 'Once a second the strip checks every sensor. The planted fault, a loose sensor 3, shows up here as it happens, so the operator can fix it before the session is wasted.' },
    { screen: 'review', enter: toReview, target: doctorOrReport, title: 'The Hardware Doctor names the fault.',
      body: 'After the recording, the Doctor reads the whole file and says which sensor is at fault and, in one line, how to fix it.' },
    { screen: 'review', target: saveButton, title: 'Save, with the report.',
      body: 'The file saves with its quality report beside it. Nothing is saved in this demo unless you press this button yourself; Next goes on without saving.' },
    { screen: 'glassbox', enter: toGlassBox, target: () => [document.querySelector('.gb-hand') || 'gb-watch'], title: 'Watch it decide.',
      body: () => (gbNote ? 'Glass Box trains a simple classifier on synthetic demo recordings and replays the part it has not seen. The 3D hand shows what it decides, moment by moment, with the honest score below.'
        : 'Glass Box trains a simple classifier on the take you just recorded and replays the repetitions it did not train on. The 3D hand shows what it decides, moment by moment, with the honest score below.'),
      note: () => gbNote, show: () => { document.querySelector('.gb-hand')?.scrollIntoView({ block: 'end' }); card.place(); } },
    { screen: 'glassbox', target: () => ['sc-exit'], title: 'That is the whole loop.',
      body: 'Connect, check, record, save, understand: on real hardware the same screens run on the band over USB. Exit demo returns to the app’s Home.' },
  ];

  // ---------- the card (tour.js's shared tip card, non-modal so the visitor can press Save) ----------
  const card = createTipCard({ id: 'showcase', className: 'tour', modal: false, label: COPY.label, hId: 'sc-h', bId: 'sc-b',
    targets: () => STEPS[index].target(), clamp: true, follow: 400, onEscape: () => exit() });
  function render(note = '') {
    const s = STEPS[index];
    const last = index === STEPS.length - 1;
    const buttons = [{ id: 'sc-next', label: busy ? COPY.wait : last ? COPY.finish : COPY.next, primary: true, disabled: busy, onClick: () => (last ? exit() : next()) }];
    if (index > 0) buttons.push({ id: 'sc-back', label: COPY.back, disabled: busy, onClick: back });
    card.render({
      head: `<div class="sc-top"><span class="chip demo sc-chip">${esc(COPY.chip)}</span><button class="btn" type="button" id="sc-exit">${esc(COPY.exit)}</button></div>`,
      counter: `Step ${index + 1} of ${STEPS.length}`, title: s.title, body: typeof s.body === 'function' ? s.body() : s.body,
      note: note || (s.note?.() ?? ''), buttons, on: { 'sc-exit': () => exit() }, focus: ['sc-next', 'sc-exit'] });
    document.body.dataset.showcase = '';
    if (!busy) s.show?.();
  }

  // Moves to step i. Forward one step runs that step's action; any other jump on a different
  // screen replays the walk from Connect (a recording cannot be un-stopped).
  async function goTo(i) {
    if (busy || !open) return;
    const g = gen;
    const from = index;
    busy = true; index = i; render();
    let ok = true;
    if (i === from + 1) ok = !STEPS[i].enter || await STEPS[i].enter(g);
    else if (STEPS[i].screen !== screen()) {
      realGo.call(app, 'preflight', { mode: 'demo' });
      for (let k = 1; k <= i && ok && g === gen; k++) if (STEPS[k].enter) ok = await STEPS[k].enter(g);
    }
    if (g !== gen) return;
    busy = false;
    if (!ok) index = from;
    render(ok ? '' : COPY.failed);
  }
  const next = () => goTo(Math.min(index + 1, STEPS.length - 1));
  const back = () => goTo(Math.max(index - 1, 0));

  // home=true goes to Start; false when the app is already on its way there.
  function exit(home = true) {
    if (!open) return;
    open = false; gen++; busy = false;
    card.close();
    delete document.body.dataset.showcase;
    app.go = realGo;
    app.env.twinOpts = saved.twinOpts; app.env.record = saved.record; app.env.storage = saved.storage;
    app._store = saved.store; app._persisted = saved.persisted;
    const u = new URL(location.href);
    u.searchParams.delete('showcase');
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    app.setChip(null);
    if (home) realGo.call(app, 'start');
    app.showcase = null;
  }

  realGo.call(app, 'preflight', { mode: 'demo' });
  render();
  const api = { steps: STEPS.length, step: () => index + 1, busy: () => busy, next, back, exit, isOpen: () => open };
  app.showcase = api;
  return api;
}
