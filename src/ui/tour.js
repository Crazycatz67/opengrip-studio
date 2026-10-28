// ui/tour.js: the first-run tour and the "Show me" help tip (simplify-spec §3.5, §7; build card N8),
// and the shared tip card they and showcase.js's walkthrough are built on.
//
// Contract
//   mountTour(app) -> tour       once, from mountShell. Builds nothing until a tip opens.
//   tour.start()                 the 4-tip tour from tip 1 (More → Take the tour again).
//   tour.help(opener?)           one "Help" tip: the full guide sentence for this screen, pointing at
//                                the button it names (Show me, More → What do I do now?).
//   tour.auto()                  starts the tour once per browser: only while localStorage og.tour is
//                                not 'done'. Inside a test page (window.parent.__opengripTest) it runs
//                                only when the walk's env says { tour: true }, so other walks never meet it.
//   tour.close(focus = true)     ends whatever is open; the tour marks og.tour = 'done' (Skip, Esc,
//                                Got it). Focus returns to the step bar's current step (tour, §10
//                                check 8) or to the opener (help).
//   tour.isOpen()
//   Never opens over the Volunteer screen (.rec[data-vol]): the shell is hidden there and the
//   volunteer must not see operator help. DOM: #tour > .tour-block, .tour-hole, .tour-tip[role=dialog].
//   Storage failures (private mode) are swallowed: the tour then shows on each visit, which is harmless.
//
//   createTipCard(opts) -> card  the anchored tip card itself (no copy, no storage):
//     opts: { id = 'tour', className, modal = true (a .tour-block scrim that eats presses; Tab kept
//             inside the card), label (aria-label), hId / bId (heading / body element ids),
//             targets() -> (Element | id)[] (the card points at their union box), clamp = false (the
//             tour's placement; true: the box is clamped to the viewport, no target centres the card
//             with data-side 'none', and when neither below nor above fits the card sits over the
//             target's foot, data-side 'inside'), follow = 0 (ms: re-place on a timer), onEscape() }
//     card.render({ head = '' (trusted HTML above the counter), counter, title, body | html (trusted),
//                   note, buttons: [{ id, label, primary, disabled, onClick }], on: { id: onClick },
//                   focus: ids (default: the buttons) }) -> the .tour-tip element
//       builds #<id> on the first call, fills the card, places it, focuses the first enabled id.
//       Every key stops at the card (app shortcuts never act behind it); Esc calls onEscape.
//     card.place(); card.tip; card.isOpen(); card.close() removes the layer, timer and listeners.
//       Focus out is the caller's: the tour and the showcase send it to different places.

import { esc } from './dom.js';

const KEY = 'og.tour';
// Spec §7 copy. target: element ids; the first is where the card points.
const TIPS = [
  { target: ['steps'], title: 'Four steps, left to right.', body: 'Connect, fit the band, record, save. The lit one is where you are; ticked ones are done.' },
  { target: ['guide'], title: 'Not sure what to do?', body: 'This line always says what to do next. Show me points at the button.' },
  { target: ['nav-home', 'nav-back'], title: 'You can always get back.', body: "Home and Back are here on every screen. If a recording isn't saved yet, we ask first." },
  { target: ['more-btn'], title: 'Extra tools are in More.', body: "Saved recordings, comparing, exports, shortcuts and Advanced mode. You don't need them for a first session." },
];

function testEnv() {
  try {
    const hook = window.parent !== window && window.parent.__opengripTest;
    return typeof hook === 'function' ? hook(window) || {} : null;
  } catch { return null; }
}
const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

export function createTipCard({ id = 'tour', className = '', modal = true, label = '', hId = 'tour-h', bId = 'tour-b',
  targets = () => [], clamp = false, follow = 0, onEscape = () => {} } = {}) {
  let layer = null;
  let timer = null;
  const tipEl = () => layer?.querySelector('.tour-tip') || null;

  // The scrim is the hole's huge box-shadow rather than a layer under a lifted target: the target sits
  // inside the sticky shell's stacking context, so z-index on it could never rise above a body scrim.
  function place() {
    if (!layer) return;
    const hole = layer.querySelector('.tour-hole');
    const tip = tipEl();
    const rs = targets().map((t) => (typeof t === 'string' ? document.getElementById(t) : t)).filter(visible)
      .filter((el) => !layer.contains(el)).map((el) => el.getBoundingClientRect());
    const w = tip.offsetWidth; const h = tip.offsetHeight;
    if (!rs.length) {
      hole.hidden = true;
      if (!clamp) { tip.style.top = '80px'; tip.style.left = '12px'; return; }
      tip.dataset.side = 'none';
      tip.style.left = `${Math.max(12, (innerWidth - w) / 2)}px`; tip.style.top = `${Math.max(12, (innerHeight - h) / 2)}px`;
      return;
    }
    const r = { left: Math.min(...rs.map((x) => x.left)), top: Math.min(...rs.map((x) => x.top)),
      right: Math.max(...rs.map((x) => x.right)), bottom: Math.max(...rs.map((x) => x.bottom)) };
    if (clamp) { r.top = Math.max(0, r.top); r.bottom = Math.min(innerHeight, r.bottom); }
    hole.hidden = false;
    Object.assign(hole.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.right - r.left + 6}px`, height: `${r.bottom - r.top + 6}px` });
    const left = Math.max(12, Math.min(r.left, innerWidth - w - 12));
    let side; let top;
    if (!clamp) {
      side = r.bottom + 14 + h <= innerHeight || r.top - 14 - h < 0 ? 'below' : 'above';
      top = side === 'below' ? r.bottom + 14 : r.top - 14 - h;
    } else {
      // A target taller than the room left (the prompt band at 375 px) gets the card over its foot
      // rather than off screen: the card is always fully on screen, its buttons always reachable.
      side = r.bottom + 14 + h <= innerHeight ? 'below' : r.top - 14 - h >= 0 ? 'above' : 'inside';
      top = side === 'below' ? r.bottom + 14 : side === 'above' ? r.top - 14 - h : innerHeight - h - 12;
      top = Math.max(12, Math.min(top, innerHeight - h - 12));
    }
    tip.dataset.side = side;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    // The arrow points at the target's centre, kept inside the card's rounded corners.
    tip.style.setProperty('--arrow-x', `${Math.max(16, Math.min(w - 28, (r.left + r.right) / 2 - left - 6))}px`);
  }

  function onKey(e) {
    // App shortcuts (R, P, S...) must not act on the page behind the card.
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); onEscape(); return; }
    if (modal && e.key === 'Tab') {
      const bs = [...layer.querySelectorAll('.tour-tip button')];
      const at = bs.indexOf(document.activeElement);
      e.preventDefault();
      bs[(at + (e.shiftKey ? -1 : 1) + bs.length) % bs.length]?.focus();
    }
  }

  function render({ head = '', counter = '', title = '', body = '', html = null, note = '', buttons = [], on = {}, focus = null } = {}) {
    if (!layer) {
      layer = document.createElement('div');
      layer.id = id;
      if (className) layer.className = className;
      layer.innerHTML = (modal ? '<div class="tour-block"></div>' : '') + '<div class="tour-hole" aria-hidden="true"></div>'
        + `<div class="tour-tip" role="dialog" aria-modal="${modal}"${label ? ` aria-label="${esc(label)}"` : ''} aria-labelledby="${hId}" aria-describedby="${bId}"></div>`;
      document.body.append(layer);
      layer.addEventListener('keydown', onKey);
      // A press on the scrim does nothing: a modal card ends only through its own buttons or Esc.
      layer.querySelector('.tour-block')?.addEventListener('pointerdown', (e) => e.preventDefault());
      addEventListener('resize', place);
      // Screens grow while they run (a strip fills, Save lays out): keep the card on its target.
      if (follow) timer = setInterval(place, follow);
    }
    const tip = tipEl();
    tip.innerHTML = `${head}<span class="tour-c">${esc(counter)}</span><h2 id="${hId}">${esc(title)}</h2>`
      + `<p id="${bId}">${html ?? esc(body)}</p>${note ? `<p class="sc-note" role="status">${esc(note)}</p>` : ''}<div class="tour-act">`
      + buttons.map((b) => `<button id="${b.id}" class="btn${b.primary ? ' primary' : ''}" type="button"${b.disabled ? ' disabled' : ''}>${esc(b.label)}</button>`).join('')
      + '</div>';
    for (const b of buttons) if (b.onClick) tip.querySelector(`#${b.id}`).onclick = b.onClick;
    for (const [k, fn] of Object.entries(on)) { const el = tip.querySelector(`#${k}`); if (el) el.onclick = fn; }
    place();
    const f = (focus || buttons.map((b) => b.id)).map((k) => tip.querySelector(`#${k}`)).find((el) => el && !el.disabled);
    f?.focus({ preventScroll: true });
    return tip;
  }

  function close() {
    if (!layer) return;
    clearInterval(timer); timer = null;
    removeEventListener('resize', place);
    layer.remove();
    layer = null;
  }

  return { get tip() { return tipEl(); }, isOpen: () => !!layer, place, render, close };
}

export function mountTour(app) {
  const $ = (id) => document.getElementById(id);
  let mode = null; // 'tour' | 'help'
  let index = 0;
  let opener = null;
  let targets = [];
  const card = createTipCard({ targets: () => targets, onEscape: () => close() });

  const storage = () => app.env?.storage ?? null;
  const done = () => { try { return storage()?.getItem(KEY) === 'done'; } catch { return false; } };
  const markDone = () => { try { storage()?.setItem(KEY, 'done'); } catch { /* private mode */ } };
  const onVolunteer = () => !!document.querySelector('.rec[data-vol]');

  function stepFocus() {
    const steps = [...document.querySelectorAll('#steps .step')];
    // Home has no current step and its upcoming steps are disabled: Home (the current page) instead.
    return steps.find((b) => b.getAttribute('aria-current') === 'step') || steps.find((b) => !b.disabled) || $('nav-home');
  }

  function render(t, counter, last) {
    const buttons = [{ id: 'tour-next', label: last ? 'Got it' : 'Next', primary: true, onClick: () => (last ? close() : show(index + 1)) }];
    if (mode === 'tour' && !last) buttons.push({ id: 'tour-skip', label: 'Skip tour', onClick: () => close() });
    card.render({ counter, title: t.title, body: t.body, html: t.html, buttons });
  }

  function show(i) {
    index = i;
    const t = TIPS[i];
    targets = t.target.map($).filter(Boolean);
    render(t, `Tip ${i + 1} of ${TIPS.length}`, i === TIPS.length - 1);
  }

  function close(focus = true) {
    if (!card.isOpen()) return;
    if (mode === 'tour') markDone();
    card.close();
    const back = mode === 'tour' ? stepFocus() : (visible(opener) ? opener : $('more-btn'));
    mode = null; targets = [];
    if (focus) back?.focus({ preventScroll: true });
  }

  function start() {
    if (onVolunteer()) return false;
    close(false);
    mode = 'tour';
    show(0);
    return true;
  }

  // Help: the guide's full sentence (the line itself may be cut to one line, spec §8), pointing at the
  // first visible button whose label holds the sentence's **bold** words, else at the guide line.
  function help(from = null) {
    if (onVolunteer()) return false;
    close(false);
    mode = 'help';
    opener = from;
    const g = $('guide-text');
    const named = g?.querySelector('b')?.textContent.trim().toLowerCase();
    const btn = named && [...document.querySelectorAll('main button, #app button')]
      .find((b) => visible(b) && !b.closest('#tour') && b.textContent.toLowerCase().includes(named));
    targets = btn ? [btn] : [$('guide')];
    render({ title: 'What to do now', html: g?.innerHTML || '' }, 'Help', true);
    return true;
  }

  function auto() {
    if (done() || card.isOpen()) return false;
    const t = testEnv();
    if (t && t.tour !== true) return false;
    return start();
  }

  return { start, help, auto, close, isOpen: () => card.isOpen(), get mode() { return mode; } };
}
