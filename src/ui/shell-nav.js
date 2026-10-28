// ui/shell-nav.js: the fixed shell (simplify-spec §3.1–3.5, build card N1): Home, Back, the 4-step
// bar, More (an empty menu shell; N3 fills it) and the "What do I do now?" guide line.
//
// Contract
//   mountShell(app) -> shell     once, from boot; fills #shell-nav, #steps, #more and #guide (index.html)
//                                and adds app.setStep / app.setGuide.
//   shell.update(name, ctx)      app.go calls it after each mount: Home/Back slots, step states and
//                                the guide line from SCREEN_NAV and NAV.guide.
//   app.setStep(n, state)        n 1..4; state 'upcoming' | 'current' | 'done' | 'skipped' | 'check' | 'fix'.
//   app.setGuide(text)           one sentence; **word** shows bold. Text never changes the line's height.
//   A screen view may add nav: { back?(), home?(), step?(n) }; each returns true when it handled
//   the move itself (Record stops through its own dialog, Fit closes its sheet). Otherwise:
//   Home -> app.go('start'); Back -> the screen's `back` below; a done step n -> STEP_GO[n].
//   The Fit page (fit.js, step 2) is opened by Connect (or Record's rail) and keeps their live
//   source, so it is not an app.go screen: it sends document 'opengrip:fit' { open, saved } and the
//   shell treats it as screen 'fit' (step 2 current, its guide line) while open, then done (saved)
//   or skipped. Back and Home close it first; closing returns to the screen that opened it
//   (Connect -> Back goes to Connect, spec §3.3), "Next: Record" goes on to Record.
//   N2 adds the Stop/Save guards. History (R3c): the page keeps two entries, the plain URL (base)
//   and one above it whose hash names the screen (#connect #fit #record #save #files #watch
//   #compare; Home has none). Browser Back pops to the base, the shell runs goBack() (same guards
//   as the Back button) and pushes the entry again, so Back never leaves the app mid-session; a
//   browser Back on Home leaves. The entry above the base is always the newest, so there is never
//   a forward entry: Forward is greyed out (Chrome) and cannot change the screen (a screen needs
//   its live source, P1). A reload on any hash boots Home
//   (app.js boot ignores the hash), never mid-recording; ?demo stays in the base URL.
//   Back from a More page returns to the screen it was opened from (app.goBackTo(ctx.from)).
//   shell.tour                   the tour (tour.js, N8): Show me and More → What do I do now? open the
//                                help tip for this screen; More → Take the tour again restarts it; the
//                                first app.go starts it once per browser (never in test walks unless asked).

import { NAV } from './words.js';
import { esc } from './dom.js';
import { mountTour } from './tour.js';

// step: the current step (0 = none: Home and the More pages). back: where Back goes.
const SCREEN_NAV = {
  start: { step: 0, back: null },
  preflight: { step: 1, back: 'start' },
  fit: { step: 2, back: 'preflight' }, // Back closes the page (closeFit), see the contract
  record: { step: 3, back: 'start' },
  review: { step: 4, back: 'start' },
  files: { step: 0, back: 'start' },
  scorecard: { step: 0, back: 'start' },
  glassbox: { step: 0, back: 'start' },
};
const STATES = ['upcoming', 'current', 'done', 'skipped', 'check', 'fix'];
const MARK = { done: '✓', skipped: '–', check: '▲', fix: '✕' };

const bold = (text) => esc(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
const plain = (text) => String(text).replace(/\*\*/g, '');

export function mountShell(app) {
  const $ = (id) => document.getElementById(id);
  const homeBtn = $('nav-home');
  const backBtn = $('nav-back');
  const stepsOl = $('steps').querySelector('ol');
  const moreBtn = $('more-btn');
  const menu = $('more-menu');
  const guideText = $('guide-text');
  const showMe = $('guide-show');
  let screen = 'start';
  let curCtx = {};
  let fitOpen = false;
  let fitSaved = false;
  const states = [null, 'upcoming', 'upcoming', 'upcoming', 'upcoming'];

  stepsOl.innerHTML = NAV.steps.map(([full, short], i) => `<li><button class="step" type="button" data-step="${i + 1}">`
    + `<span class="num" aria-hidden="true">${i + 1}</span><span class="lbl full">${esc(full)}</span>`
    + `<span class="lbl short" aria-hidden="true">${esc(short)}</span></button></li>`).join('');
  const stepBtns = [...stepsOl.querySelectorAll('.step')];

  function paintStep(n) {
    const st = states[n];
    const b = stepBtns[n - 1];
    const name = NAV.steps[n - 1][0];
    b.dataset.state = st;
    b.querySelector('.num').textContent = MARK[st] || String(n);
    b.setAttribute('aria-label', NAV.stepAria(n, name, NAV.stateWord[st]));
    if (st === 'current') b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    // Upcoming steps are locked; the title says what comes first. Current is a no-op, not disabled,
    // so it stays focusable (the tour returns focus to it, spec §10 check 8).
    b.disabled = st === 'upcoming';
    b.title = st === 'upcoming' ? NAV.lockedWhy(NAV.steps[Math.max(0, n - 2)][0]) : '';
    b.parentElement.classList.toggle('after-done', n > 1 && ['done', 'skipped'].includes(states[n - 1]));
  }

  app.setStep = (n, state) => {
    if (!(n >= 1 && n <= 4) || !STATES.includes(state)) throw new Error(`setStep(${n}, ${state})`);
    states[n] = state;
    paintStep(n);
  };
  app.setGuide = (text) => {
    guideText.innerHTML = bold(text);
    // The line clips to one line (two below 600 px); the title and Show me keep the full sentence.
    guideText.title = plain(text);
  };

  function defaults() {
    const here = fitOpen ? 'fit' : screen;
    const cur = SCREEN_NAV[here]?.step || 0;
    const fitState = fitSaved ? 'done' : 'skipped';
    for (let n = 1; n <= 4; n++) {
      let st = 'upcoming';
      if (cur && n === cur) st = 'current';
      else if (cur && n < cur) st = n === 2 ? fitState : 'done';
      states[n] = st;
      paintStep(n);
    }
    app.setGuide(NAV.guide[here] || '');
    // Back always works on the Fit page (it closes it), even over a screen without a Back.
    backBtn.classList.toggle('slot', !SCREEN_NAV[here]?.back);
    backBtn.disabled = !SCREEN_NAV[here]?.back;
  }

  const view = () => app._view?.nav || {};
  const closeFit = () => {
    const f = document.querySelector('.fit');
    if (!f?.fitApi) return false;
    f.fitApi.close();
    return true;
  };
  function goHome() {
    closeMenu();
    app._newTake = false;
    if (screen === 'start') return;
    closeFit();
    if (view().home?.()) return;
    app.go('start');
  }
  function goBack() {
    closeMenu();
    if (closeFit()) return;
    // Save -> Back is a new take (spec §3.3): app.go turns review's Connect hop into Record.
    app._newTake = screen === 'review';
    if (view().back?.()) return;
    if (screen === 'files' && curCtx.from) { app.goBackTo(curCtx.from); return; }
    const to = SCREEN_NAV[screen]?.back;
    if (to) app.go(to);
  }
  // A finished step: Connect again (and so a new take) goes through Preflight with the last source.
  function goStep(n) {
    const st = states[n];
    if (st === 'upcoming' || st === 'current') return;
    app._newTake = false;
    if (view().step?.(n)) return;
    app.go('preflight', { mode: app.lastMode || 'demo' });
  }

  homeBtn.addEventListener('click', goHome);
  backBtn.addEventListener('click', goBack);
  stepBtns.forEach((b) => b.addEventListener('click', () => goStep(Number(b.dataset.step))));
  const tour = mountTour(app);
  showMe.addEventListener('click', () => tour.help(showMe));
  // The two Help items sit above Keyboard shortcuts (spec §4.1); index.html stays the N3 markup.
  const keysItem = $('keys-btn');
  for (const [id, label, act] of [['m-whatnow', 'What do I do now?', () => tour.help(moreBtn)], ['m-tour', 'Take the tour again', () => tour.start()]]) {
    const b = document.createElement('button');
    Object.assign(b, { id, type: 'button', textContent: label });
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', act);
    keysItem.before(b);
  }
  let firstUpdate = true;

  // More: menu-button pattern; app.js wires the items (N3). Switches (menuitemcheckbox) keep it open. Keys stays reachable from here.
  function closeMenu(focus = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
    if (focus) moreBtn.focus();
  }
  function openMenu() {
    menu.hidden = false;
    moreBtn.setAttribute('aria-expanded', 'true');
    menu.querySelector('[role="menuitem"]')?.focus();
  }
  moreBtn.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('[role^="menuitem"]')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  });
  menu.addEventListener('click', (e) => { if (e.target.closest('[role="menuitem"]')) closeMenu(); });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !e.target.closest('#more')) closeMenu(); });

  document.addEventListener('opengrip:fit', (e) => {
    fitOpen = !!e.detail?.open;
    if (e.detail?.saved) fitSaved = true;
    defaults();
    syncHistory();
  });

  // Browser history (contract above). The page owns at most two entries: the boot entry (base)
  // and one "up" entry above it ({ og, up: 1 }) that is always the newest, so the browser never
  // has a forward entry to offer (P1: a stale one made Forward bounce through a dead screen).
  // A browser Back that lands on the base is answered by pushing the up entry again, which also
  // drops anything forward of it; Home just rewrites the up entry (og 0, no hash).
  const HASH = { preflight: 'connect', fit: 'fit', record: 'record', review: 'save', files: 'files', glassbox: 'watch', scorecard: 'compare' };
  const base = () => location.pathname + location.search;
  let onUp = false;
  history.replaceState({ og: 0 }, '', base());
  // force: push the up entry even for Home (after a browser Back, to clear the forward entry).
  function syncHistory(force = false) {
    const tag = HASH[fitOpen ? 'fit' : screen];
    const state = { og: tag ? 1 : 0, up: 1 };
    const url = tag ? `${base()}#${tag}` : base();
    if (!onUp) {
      // Home on the boot entry is already the newest entry: nothing to add.
      if (!tag && !force) return;
      history.pushState(state, '', url); onUp = true;
    } else if (location.hash !== (tag ? `#${tag}` : '') || history.state?.og !== state.og) history.replaceState(state, '', url);
  }
  window.addEventListener('popstate', (e) => {
    onUp = !!e.state?.up;
    // Forward onto the up entry (only reachable after a Back that left the page did nothing):
    // never re-enter a screen, just restamp the entry with where the user is.
    if (onUp) { syncHistory(); return; }
    // Browser Back on Home leaves the page, as it would without the up entry.
    if (screen === 'start' && !fitOpen) { history.back(); return; }
    // Browser Back from a screen: the app's own Back, guards included. Whatever it settles on
    // (a guard keeping the user here, or Home) gets the up entry again, forward cleared.
    goBack();
    syncHistory(true);
  });

  // Below 600 px the source chip moves to the start of the guide line so the bar fits 375 px and
  // DEMO stays visible (spec §3.1).
  const narrow = window.matchMedia('(max-width: 599px)');
  const placeChip = () => {
    const chip = $('source-chip'); const g = $('guide');
    if (narrow.matches && g.parentElement !== document.querySelector('.topbar')) g.insertBefore(chip, guideText);
    else document.querySelector('.topbar').insertBefore(chip, $('autosave'));
  };
  narrow.addEventListener('change', placeChip);
  return {
    update(name, ctx = {}) {
      screen = name;
      curCtx = ctx;
      if (name === 'start') fitSaved = false; // a new session starts its Fit step over
      fitOpen = !!document.querySelector('.fit');
      // Record keeps the §3.1 shell like every other screen (review-3 #1/#4): folding the guide into
      // the bar overlapped Show me, DEMO and autosave at 600–1023 px; the plot row gives up the 36 px.
      const home = name === 'start';
      homeBtn.toggleAttribute('aria-current', home);
      if (home) homeBtn.setAttribute('aria-current', 'page');
      // Back is not drawn on Home, but its slot is kept so nothing shifts (spec §3.3): defaults()
      // sets it from SCREEN_NAV.
      placeChip();
      // A file opened for review is not part of a session: only Save is lit.
      defaults();
      if (name === 'review' && ctx.file) for (const n of [1, 2, 3]) app.setStep(n, 'upcoming');
      // A screen change ends any tip: its target may be gone. The first screen starts the tour once.
      if (tour.isOpen()) tour.close(false);
      if (firstUpdate) { firstUpdate = false; requestAnimationFrame(() => tour.auto()); }
      syncHistory();
    },
    goHome, goBack, tour,
  };
}
