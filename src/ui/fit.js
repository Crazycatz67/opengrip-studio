// ui/fit.js: the Fit page, step 2 (body-view-spec §6.1, §16): where each sensor sits, typed in by the
// person (quick ring setup + fine-tune), fit memory per person ID + arm, and the 4-step placement
// check whose result glows on the drawing, then a live re-check while a sensor is adjusted.
//
// Contract
//   openFit(host, opts) -> api   (one at a time; the host is usually document.body)
//   Fit is step 2's page (simplify N5b), not a dialog: a labelled region over the screen area
//     (style.css .fit sits below the shell), focus starts on its heading (#fit-h), and while it is
//     open #app (the screen underneath, if there is one) is inert, so Tab and screen readers stay
//     on the page. close() is the page's Back: #app comes back first, then focus returns.
//   opts: { channels: n (sensors on the device), names?: string[], placement?: Placement (start
//     from it), personId?, demo?: bool (the check is played by the twin: generate({ gesture:
//     'check', placement })), rateHz?, scale?: 1 (step-length factor, the walks use ~0.05),
//     say?(text), onSave(placement), onClose(), more?: bool (false folds the detail under
//     "More fitting options"; default open), onNext?() (adds "Next: Record": save, close, onNext) }
//   api: { root, feed(values) (one live sample, raw counts; levels + check recording),
//     state() -> { placement, picked, diff, prev, checks, phase: 'idle'|'check'|'live',
//       misplace, saved, step }, nudge(ch, dDeg, dCm), pick(ch), quick(partial form),
//     useLast(), save(), runCheck() -> Promise<ChannelCheck[]>, setLive(on), setMisplace(on),
//     close() }
//   close() sends document 'opengrip:fit' { open: false, saved, fit: { checks: ChannelCheck[] | null,
//     skipped: bool (no check was run), at: ISO time } } (card A1: app.js carries it to Save).
//   Placement is placement.js's model (ringPreset). Saved fits: localStorage 'opengrip.fits' =
//     { "<person>|<arm>": [Placement newest first, max 10] } (IDs only, local only); the last
//     person ID used is 'opengrip.fitPerson'. Storage failing (private mode) only means nothing
//     is remembered: the sheet still works and save() still hands the placement on.
// Failure behaviour: no samples during a real check -> every sensor 'bad' with the Doctor's
//   no_data fix (checkPlacement's own rule); never throws on missing storage.
// Wording rule (spec §16): "works here", never "correct position"; places stay "entered by you".

import { createBodyView } from './body-draw.js';
import { ringPreset, diffPlacement, placementSummary, checkPlacement, liveCheck, checkSummary, siteName, sideOf, ringXY, OCTANTS, normDeg } from '../placement.js';
import { generate } from '../sim/twin.js';
import { FIT as W } from './words.js';
import { esc } from './dom.js';

const FITS_KEY = 'opengrip.fits';
const PID_KEY = 'opengrip.fitPerson';
const KEEP = 10;
// relax 5 s, then each movement 3 s after a short relax (spec §16: ~20 s in all).
export const CHECK_PLAN = [['relax', 5], ['fist', 3], ['relax', 2], ['wrist_back', 3], ['relax', 2], ['elbow_bend', 3]];
const LIVE_STEPS = ['fist', 'wrist_back', 'elbow_bend'];
const LIVE_S = 4;          // the re-check judges the last 4 s
const MISPLACED_CH = 3;    // demo fault: sensor 3 really sits on the other side

const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
const key = (pid, arm) => `${pid}|${arm}`;
export function lastFit(pid, arm) { return pid ? (read(FITS_KEY, {})[key(pid, arm)] || [])[0] || null : null; }
export function saveFit(p) {
  if (!p.person_id) return false;
  const all = read(FITS_KEY, {});
  const k = key(p.person_id, p.arm);
  all[k] = [p, ...(all[k] || [])].slice(0, KEEP);
  return write(FITS_KEY, all);
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const armWord = (a) => (a === 'L' ? W.armL : W.armR);

export function openFit(host, opts = {}) {
  const n = Math.max(1, Math.min(16, opts.channels || 6));
  const scale = opts.scale ?? 1;
  const say = opts.say || (() => {});
  const back = document.activeElement;
  const root = document.createElement('section');
  // Fit is step 2's page (simplify N5). opts.more === false (Simple) starts with the detail folded
  // under "More fitting options"; anything else (Advanced, the body page) keeps it all open.
  // opts.onNext() adds "Next: Record": save, close, then the caller goes on.
  root.className = opts.more === false ? 'fit fit-less' : 'fit';
  root.setAttribute('aria-labelledby', 'fit-h');
  // The page replaces aria-modal: the screen underneath (Connect, or Record when opened from its
  // rail) is inert while Fit is up. A host inside #app (none today) would be inert too, so skip.
  const under = document.getElementById('app');
  const hide = !!under && !under.contains(host);
  const form = { pid: opts.personId ?? read(PID_KEY, ''), arm: 'R', count: n, cm: 8, startDeg: 0, dir: 1, band: '', landmark: '', flex: false, ext: false };
  const over = new Map(); // ch -> { ringAngleDeg, cmFromElbowCrease }: fine-tuned sensors keep their place
  let picked = 1;
  let checks = null;
  let phase = 'idle';
  let misplace = false;
  let saved = false;
  let step = null;
  let timers = [];
  let view = null;
  let ghost = null;
  const lo = []; const hi = []; let last = null;
  let rec = null; // { data: [][], labels: [] } while a real check or live re-check records

  if (opts.placement) fromPlacement(opts.placement);

  root.innerHTML = `<div class="fit-in">
    <form class="fit-form" onsubmit="return false">
      <h2 id="fit-h" tabindex="-1">${esc(W.title)}</h2>
      <p class="fit-tag">${esc(W.entered)}</p>
      <label class="fit-f">${esc(W.person)} <input id="fit-pid" maxlength="24" autocomplete="off" spellcheck="false"></label>
      <p class="small">${esc(W.personHint)}</p>
      <fieldset><legend>1 · ${esc(W.arm)}</legend><span class="seg" id="fit-arm">
        <button type="button" data-arm="L">${esc(W.armL)}</button><button type="button" data-arm="R">${esc(W.armR)}</button></span></fieldset>
      <fieldset><legend>2 · ${esc(W.quick)}</legend>
        <label class="fit-f">${esc(document.body.dataset.mode === 'advanced' ? W.count : W.countSimple)} <input id="fit-n" type="number" min="1" max="16" step="1"></label>
        <label class="fit-f fit-adv">${esc(W.cm)} <input id="fit-cm" type="range" min="2" max="20" step="0.5"> <output id="fit-cmv" class="num"></output></label>
        <label class="fit-f fit-adv">${esc(W.start)} <select id="fit-start">${OCTANTS.map((o) => `<option value="${o.deg}">${esc(o.name)}</option>`).join('')}</select></label>
        <label class="fit-f fit-adv">${esc(W.dir)} <select id="fit-dir"><option value="1">${esc(W.dirs.thumb)}</option><option value="-1">${esc(W.dirs.little)}</option></select></label>
        <label class="fit-f fit-adv">${esc(W.band)} <input id="fit-band" type="number" min="10" max="60" step="0.5"> <span id="fit-gap" class="small num"></span></label>
        <details class="fit-how fit-adv"><summary>${esc(W.howTitle)}</summary><p>${W.how}</p></details>
        <label class="fit-f fit-adv">${esc(W.landmark)} <input id="fit-land" maxlength="80"></label></fieldset>
      <button class="btn fit-more" type="button" id="fit-more" aria-expanded="${opts.more !== false}">${esc(W.more)} <span aria-hidden="true">▸</span></button>
      <fieldset class="fit-adv"><legend>3 · ${esc(W.emg)}</legend>
        <label><input type="checkbox" id="fit-flex"> ${esc(W.emgFlex)}</label><br><label><input type="checkbox" id="fit-ext"> ${esc(W.emgExt)}</label>
        <p class="small">${esc(W.emgRef)}</p></fieldset>
      <fieldset class="fit-adv"><legend>4 · ${esc(W.fine)}</legend><div class="fit-chips" id="fit-chips" role="toolbar" aria-label="${esc(W.fine)}"></div>
        <p class="small">${esc(W.fineHint)}</p></fieldset>
      <div class="fit-acts"><button class="btn primary" type="button" id="fit-save">${esc(W.save)}</button>
        <button class="btn" type="button" id="fit-last">${esc(W.useLast)}</button><button class="btn" type="button" id="fit-skip">${esc(W.skip)}</button>
        ${opts.onNext ? `<button class="btn primary" type="button" id="fit-next">${esc(W.next)}</button>` : ''}</div>
      <p id="fit-saved" class="fit-ok" role="status"></p>
    </form>
    <div class="fit-draw">
      <div class="fit-view" id="fit-view"></div>
      <p class="small">${esc(W.pressHint)}</p>
      <section class="fit-check fit-adv" aria-labelledby="fit-ch-h"><h3 id="fit-ch-h">${esc(W.checkTitle)}</h3>
        <p class="small">${esc(opts.demo ? W.demoNote : W.checkIntro)}</p>
        <div class="fit-acts"><button class="btn" type="button" id="fit-run">${esc(W.check)}</button>
          <button class="btn" type="button" id="fit-live" disabled>${esc(W.live)}</button>
          ${opts.demo ? `<label class="fit-syn"><input type="checkbox" id="fit-mis"> ${esc(W.misplace)} <b>${esc(W.synthetic)}</b></label>` : ''}</div>
        <div class="fit-step" id="fit-step" aria-live="assertive" hidden><b id="fit-step-w"></b><span id="fit-step-s"></span><span id="fit-step-n" class="num"></span></div>
        <p id="fit-sum" role="status"></p><ul class="fit-res" id="fit-res"></ul></section>
      <section class="fit-cmp fit-adv" aria-labelledby="fit-cmp-h"><h3 id="fit-cmp-h">${esc(W.compare)}</h3><ul id="fit-diff"></ul>
        <div class="fit-ghost" id="fit-ghost" hidden><p class="small">${esc(W.ghost)}</p><div id="fit-ghost-v"></div></div></section>
    </div></div>`;
  host.append(root);
  if (hide) under.inert = true;
  document.dispatchEvent(new CustomEvent('opengrip:fit', { detail: { open: true } }));
  const $ = (id) => root.querySelector(`#${id}`);

  function fromPlacement(p) {
    const r = p.ring || {};
    Object.assign(form, { arm: p.arm || 'R', count: r.count || p.channels.filter((c) => c.sensor !== 'EMG').length || n, cm: r.cmFromElbowCrease ?? 8,
      startDeg: r.startDeg ?? 0, dir: r.dir ?? 1, band: r.circumferenceCm ?? '', landmark: p.landmark || '',
      flex: p.channels.some((c) => c.site === 'Flexors'), ext: p.channels.some((c) => c.site === 'Extensors') });
    over.clear();
    for (const c of p.channels) over.set(c.ch, { ringAngleDeg: c.ringAngleDeg, cmFromElbowCrease: c.cmFromElbowCrease });
  }
  function build() {
    const emg = [form.flex && { muscle: 'flexors' }, form.ext && { muscle: 'extensors' }].filter(Boolean);
    const p = ringPreset({ count: form.count, cmFromElbowCrease: form.cm, startDeg: form.startDeg, dir: form.dir, arm: form.arm,
      circumferenceCm: form.band === '' ? null : form.band, emg, landmark: form.landmark, person_id: form.pid || undefined });
    for (const c of p.channels) {
      const o = over.get(c.ch);
      if (!o) continue;
      if (o.ringAngleDeg != null) { c.ringAngleDeg = o.ringAngleDeg; c.side = sideOf(o.ringAngleDeg); if (c.sensor !== 'EMG') c.site = siteName(o.ringAngleDeg); }
      if (o.cmFromElbowCrease != null) c.cmFromElbowCrease = o.cmFromElbowCrease;
    }
    return p;
  }
  let placement = build();
  let prev = null;

  function paintForm() {
    $('fit-pid').value = form.pid;
    root.querySelectorAll('[data-arm]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.arm === form.arm)));
    $('fit-n').value = form.count; $('fit-cm').value = form.cm; $('fit-cmv').textContent = `${Number(form.cm).toFixed(1)} cm`;
    $('fit-start').value = String(normDeg(form.startDeg) - (normDeg(form.startDeg) % 45)); $('fit-dir').value = String(form.dir);
    $('fit-band').value = form.band; $('fit-land').value = form.landmark; $('fit-flex').checked = form.flex; $('fit-ext').checked = form.ext;
    $('fit-gap').textContent = form.band ? W.spacing((form.band / form.count).toFixed(1)) : '';
  }
  function paintChips() {
    $('fit-chips').innerHTML = placement.channels.map((c) => `<button type="button" data-chip="${c.ch}" aria-pressed="${c.ch === picked}" tabindex="${c.ch === picked ? 0 : -1}">${c.ch}</button>`).join('');
  }
  // Review-2 M6 / spec §6.1: at >= 1280 px the sheet shows Ring and Arm side by side, each filling
  // its pane, instead of one ~260 px lens. Below that, one view with the lens tabs as before.
  // `view` fans out to every shown view so feed()/showChecks() stay one call.
  const pairMq = host.ownerDocument.defaultView.matchMedia('(min-width: 1280px)');
  let views = [], lens1 = 'ring';
  function draw({ focus = false } = {}) {
    const vhost = $('fit-view');
    if (views.length === 1) lens1 = views[0].root.querySelector('.bd-lens [aria-pressed="true"]')?.dataset?.lens || lens1;
    for (const v of views) v.destroy();
    vhost.replaceChildren();
    const pair = pairMq.matches;
    vhost.classList.toggle('fit-pair', pair);
    views = pair ? ['ring', 'arm'].map((l) => {
      const pane = host.ownerDocument.createElement('div');
      pane.className = 'fit-pane'; pane.dataset.lens = l; vhost.append(pane);
      // Both lenses are on screen, so no per-pane Ring/Arm/Table tabs (review-2 leftover: two sets).
      return createBodyView(pane, { placement, names: opts.names, lens: l, fill: true, lensTabs: false });
    }) : [createBodyView(vhost, { placement, names: opts.names, lens: lens1 })];
    view = { root: vhost, update: (x) => views.forEach((v) => v.update(x)), setChecks: (x) => views.forEach((v) => v.setChecks(x)), destroy: () => views.forEach((v) => v.destroy()) };
    if (checks) view.setChecks(byCh(checks));
    vhost.querySelectorAll('[data-ch]').forEach((g) => g.classList.toggle('fit-picked', +g.dataset.ch === picked));
    if (focus) vhost.querySelector(`[data-ch="${picked}"]`)?.focus();
    paintChips();
  }
  const onPairMq = () => draw();
  pairMq.addEventListener('change', onPairMq);
  function paintDiff() {
    prev = lastFit(form.pid, form.arm);
    const other = !prev && form.pid ? lastFit(form.pid, form.arm === 'L' ? 'R' : 'L') : null;
    const items = prev ? diffPlacement(prev, placement) : [];
    const lines = [];
    if (!form.pid) lines.push(['', W.noPerson]);
    else if (other) lines.push(['', W.otherArm(armWord(other.arm))]);
    else if (!prev) lines.push(['', W.first(form.pid, armWord(form.arm))]);
    else {
      for (const d of items) lines.push(['check', d.text]);
      const moved = new Set(items.flatMap((d) => d.chs || [d.ch]));
      const rest = placement.channels.filter((c) => !moved.has(c.ch)).length;
      if (rest) lines.push(['ok', items.length ? W.others(rest) : W.same(rest)]);
    }
    $('fit-diff').innerHTML = lines.map(([k, t]) => `<li class="${k}">${k ? `<b>${esc(k === 'ok' ? W.okTag : W.checkTag)}</b> ` : ''}${esc(t)}</li>`).join('');
    const g = $('fit-ghost');
    g.hidden = !prev;
    ghost?.destroy(); ghost = null;
    // body-draw has no ghost layer: last time's fit is drawn as a second, dimmed view beside it.
    if (prev) ghost = createBodyView($('fit-ghost-v'), { placement: prev, lens: 'ring', calm: true });
    return items;
  }
  let diff = [];
  function changed({ focus = false } = {}) {
    placement = build();
    saved = false; $('fit-saved').textContent = '';
    draw({ focus });
    diff = paintDiff();
  }

  // ---------- form ----------
  const num = (v, d) => (v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
  $('fit-pid').addEventListener('input', (e) => { form.pid = e.target.value.trim(); changed(); });
  root.querySelectorAll('[data-arm]').forEach((b) => b.addEventListener('click', () => api.quick({ arm: b.dataset.arm })));
  $('fit-n').addEventListener('change', (e) => api.quick({ count: Math.max(1, Math.min(16, Math.round(num(e.target.value, n)))) }));
  $('fit-cm').addEventListener('input', (e) => api.quick({ cm: num(e.target.value, 8) }));
  $('fit-start').addEventListener('change', (e) => api.quick({ startDeg: num(e.target.value, 0) }));
  $('fit-dir').addEventListener('change', (e) => api.quick({ dir: num(e.target.value, 1) }));
  $('fit-band').addEventListener('change', (e) => api.quick({ band: e.target.value === '' ? '' : num(e.target.value, '') }));
  $('fit-land').addEventListener('change', (e) => api.quick({ landmark: e.target.value }));
  $('fit-flex').addEventListener('change', (e) => api.quick({ flex: e.target.checked }));
  $('fit-ext').addEventListener('change', (e) => api.quick({ ext: e.target.checked }));
  $('fit-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-chip]'); if (b) api.pick(+b.dataset.chip, true); });
  $('fit-view').addEventListener('click', (e) => { const g = e.target.closest('[data-ch]'); if (g) api.pick(+g.dataset.ch); });
  $('fit-save').addEventListener('click', () => api.save());
  $('fit-last').addEventListener('click', () => api.useLast());
  $('fit-skip').addEventListener('click', () => api.close());
  $('fit-next')?.addEventListener('click', () => { if (!saved) api.save(); api.close(); opts.onNext(); });
  $('fit-more').addEventListener('click', () => {
    const open = root.classList.toggle('fit-less') === false;
    $('fit-more').setAttribute('aria-expanded', String(open));
  });
  $('fit-run').addEventListener('click', () => api.runCheck());
  $('fit-live').addEventListener('click', () => api.setLive(phase !== 'live'));
  $('fit-mis')?.addEventListener('change', (e) => api.setMisplace(e.target.checked));

  // Keys never reach the screen underneath (A, R, Space would act on Record).
  root.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); api.close(); return; }
    const onSensor = e.target.closest?.('[data-chip], .fit-view [data-ch]');
    if (!onSensor) return;
    const big = e.shiftKey;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); api.nudge(picked, leftStep(e.key === 'ArrowLeft') * (big ? 15 : 5), 0, true); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); api.nudge(picked, 0, (e.key === 'ArrowUp' ? 1 : -1) * (big ? 1.5 : 0.5), true); }
    else if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset.ch) { e.preventDefault(); api.pick(+e.target.dataset.ch); }
  });
  // "← always moves the drawing's dot left" (spec §6.1): pick the angle direction that lowers x.
  function leftStep(left) {
    const c = placement.channels.find((x) => x.ch === picked);
    const a = c?.ringAngleDeg ?? 0;
    const dx = ringXY(a + 5, placement.arm).x - ringXY(a - 5, placement.arm).x;
    const plusGoesLeft = dx < 0 || (dx === 0 && placement.arm === 'R');
    return left === plusGoesLeft ? 1 : -1;
  }

  // ---------- live levels (press test) ----------
  function feed(values) {
    last = values;
    for (let i = 0; i < values.length; i++) {
      const x = values[i];
      if (!Number.isFinite(x)) continue;
      if (!(x >= lo[i])) lo[i] = x;
      if (!(x <= hi[i])) hi[i] = x;
    }
    if (rec) { values.forEach((x, i) => { (rec.data[i] ||= []).push(x); }); rec.labels.push(step || 'none'); }
  }
  const lvTimer = setInterval(() => {
    if (!view || !last) return;
    view.update(last.map((x, i) => (Number.isFinite(x) && hi[i] > lo[i] ? (x - lo[i]) / (hi[i] - lo[i]) : null)));
  }, 100);

  // ---------- placement check ----------
  const byCh = (rs) => Object.fromEntries(rs.map((r) => [r.ch, r]));
  const wait = (ms) => new Promise((r) => { timers.push(setTimeout(r, ms)); });
  function showStep(s, secs) {
    step = s;
    $('fit-step').hidden = !s;
    if (!s) return;
    $('fit-step-w').textContent = W.steps[s][0]; $('fit-step-s').textContent = W.steps[s][1]; $('fit-step-n').textContent = secs ? W.secs(secs) : '';
    root.querySelector('.fit-check').dataset.step = s;
  }
  // Demo: the twin plays the check with the places as entered; the misplace toggle puts sensor 3
  // on the other side of the arm from its entry (the twin's 'misplace' fault, 0-based channel).
  function twinRun(seed, extra = {}) {
    const ch = Math.min(n, 8);
    const faults = misplace && ch >= MISPLACED_CH ? [{ type: 'misplace', channel: MISPLACED_CH - 1 }] : [];
    return generate({ gesture: 'check', placement, channels: ch, rateHz: opts.rateHz || 100, seed, faults, ...extra });
  }
  function showChecks(rs) {
    checks = rs;
    view?.setChecks(byCh(rs));
    const s = checkSummary(rs);
    $('fit-sum').textContent = s.text;
    $('fit-res').innerHTML = resultsHtml(rs);
    $('fit-live').disabled = false;
  }
  let seed = 11;
  async function runCheck() {
    if (phase === 'check') return checks;
    api.setLive(false);
    phase = 'check';
    $('fit-run').disabled = true;
    say(W.sayCheck);
    rec = opts.demo ? null : { data: [], labels: [] };
    for (const [s, secs] of CHECK_PLAN) {
      for (let k = secs; k > 0 && phase === 'check'; k--) { showStep(s, k); await wait(1000 * scale); }
      if (phase !== 'check') return checks;
    }
    showStep(null);
    const r = opts.demo ? twinRun(seed++) : { ...rec, rateHz: opts.rateHz || 100 };
    rec = null;
    phase = 'idle';
    $('fit-run').disabled = false;
    const rs = checkPlacement(r, placement);
    showChecks(rs);
    say(checkSummary(rs).text);
    return rs;
  }
  // Live re-check: prompt one movement at a time and judge the last few seconds with liveCheck.
  function setLive(on) {
    if (on && (!checks || phase === 'check')) return;
    if (!on) {
      if (phase === 'live') { phase = 'idle'; timers.forEach(clearTimeout); timers = []; rec = null; showStep(null); }
      $('fit-live').textContent = W.live; $('fit-live').setAttribute('aria-pressed', 'false');
      return;
    }
    phase = 'live';
    $('fit-live').textContent = W.liveStop; $('fit-live').setAttribute('aria-pressed', 'true');
    say(W.liveOn);
    rec = opts.demo ? null : { data: [], labels: [] };
    let i = 0;
    const tick = () => {
      if (phase !== 'live') return;
      const s = LIVE_STEPS[i++ % LIVE_STEPS.length];
      showStep(s, 0);
      timers.push(setTimeout(() => {
        if (phase !== 'live') return;
        let w;
        if (opts.demo) w = twinRun(seed++, { reps: 1, holdS: 1.5 });
        else {
          const keep = Math.round(LIVE_S * (opts.rateHz || 100));
          w = { data: rec.data.map((d) => d.slice(-keep)), labels: rec.labels.slice(-keep), rateHz: opts.rateHz || 100 };
        }
        showChecks(liveCheck(w, placement, { prev: checks, step: opts.demo ? null : s }));
        api.liveTicks++;
        tick();
      }, LIVE_S * 1000 * scale));
    };
    tick();
  }

  function close() {
    phase = 'closed';
    timers.forEach(clearTimeout); clearInterval(lvTimer);
    pairMq.removeEventListener('change', onPairMq); view?.destroy(); ghost?.destroy(); root.remove();
    if (hide) under.inert = false; // before any focus: an inert node cannot take it
    if (back?.isConnected) back.focus();
    opts.onClose?.();
    // The shell's step bar follows the page (shell-nav.js): Fit is step 2 while it is open.
    // Card A1: the result travels with the close so app.js can carry it through Record to Save
    // (the report's fit section). Closed with no check run (Skip, Back, Esc) = skipped.
    const fit = { checks: checks ? clone(checks) : null, skipped: !checks, at: new Date().toISOString() };
    document.dispatchEvent(new CustomEvent('opengrip:fit', { detail: { open: false, saved: !!saved, fit } }));
  }

  const api = {
    root, feed, liveTicks: 0,
    state: () => ({ placement, picked, diff, prev, checks, phase, misplace, saved, step }),
    quick(part) { Object.assign(form, part); paintForm(); changed(); },
    pick(ch, fromChip = false) {
      picked = ch;
      draw({ focus: !fromChip });
      if (fromChip) root.querySelector(`[data-chip="${ch}"]`)?.focus();
    },
    nudge(ch, dDeg = 0, dCm = 0, fromKey = false) {
      const c = placement.channels.find((x) => x.ch === ch);
      if (!c) return;
      const a = normDeg((c.ringAngleDeg ?? 0) + dDeg);
      const cm = Math.min(30, Math.max(0, Math.round(((c.cmFromElbowCrease ?? form.cm) + dCm) * 2) / 2));
      over.set(ch, { ringAngleDeg: a, cmFromElbowCrease: cm });
      const onChip = fromKey && document.activeElement?.dataset?.chip;
      changed({ focus: fromKey && !onChip });
      if (onChip) root.querySelector(`[data-chip="${ch}"]`)?.focus();
      say(W.sayMoved(ch, siteName(a), a, cm));
    },
    useLast() { const p = lastFit(form.pid, form.arm); if (!p) return; fromPlacement(p); paintForm(); changed(); },
    save() {
      const p = clone({ ...placement, saved_at: new Date().toISOString() });
      if (form.pid) { p.person_id = form.pid; write(PID_KEY, form.pid); }
      const kept = saveFit(p);
      // The diff keeps comparing with the fit before this save.
      saved = true;
      $('fit-saved').textContent = form.pid && kept ? W.saved(form.pid, armWord(p.arm)) : W.savedNoPid;
      say($('fit-saved').textContent);
      opts.onSave?.(p, { diff, prev });
      return p;
    },
    runCheck, setLive,
    setMisplace(on) { misplace = !!on; const b = $('fit-mis'); if (b) b.checked = misplace; },
    close,
  };
  root.fitApi = api; // for the ui walk (test/browser/ui.js walkFit)
  paintForm();
  changed();
  // A new page: focus its heading (like a screen change), not the first field.
  $('fit-h').focus({ preventScroll: true });
  return api;
}

// The Preflight row's words for a placement (spec §6.1).
// Review-2 M3: the list reads worst first (bad, then weak) so a ✕ is never below the fold, and
// every good sensor folds into one line with its reasons in a <details>. Only the status word is
// coloured (.st); the reason stays in the body colour and loses its repeated "Sensor N works
// here:" lead, which the row already says.
const RANK = { bad: 0, weak: 1, good: 2 };
function plainReason(r) {
  const t = String(r.reason || '').replace(new RegExp(`^${W.sensor(r.ch)}(?:(?: works here| does not work here yet)?:)?\\s*`), '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
export function resultsHtml(rs) {
  const sorted = [...rs].sort((a, b) => (RANK[a.state] ?? 3) - (RANK[b.state] ?? 3) || a.ch - b.ch);
  const goods = sorted.filter((r) => r.state === 'good');
  const line = (r) => `<li class="${r.state}" data-ch="${r.ch}"><b>${esc(W.sensor(r.ch))}</b> · <span class="st">${esc(W.state[r.state])}</span> ${esc(plainReason(r))}${r.fix ? ` <span class="small">${esc(W.fixPrefix)}${esc(r.fix)}</span>` : ''}</li>`;
  const fold = goods.length ? `<li class="good fit-goods" data-chs="${goods.map((r) => r.ch).join(',')}"><details><summary><span class="st">${esc(W.state.good)}</span> · ${esc(W.goodCount(goods.map((r) => r.ch)))}</summary>
    <ul>${goods.map((r) => `<li data-ch="${r.ch}"><b>${esc(W.sensor(r.ch))}</b> ${esc(plainReason(r))}</li>`).join('')}</ul></details></li>` : '';
  return sorted.filter((r) => r.state !== 'good').map(line).join('') + fold;
}

export function placesLine(p, diff = []) {
  if (!p) return W.rowOptional;
  const moved = new Set(diff.map((d) => d.ch)).size;
  return moved ? W.rowMoved(moved) : W.rowSaved(placementSummary(p));
}
// Session meta for entered places (csv.js writes both lines; the exports read placement_map).
export function placementMeta(p) {
  return p ? { placement: placementSummary(p), placement_map: clone(p), ...(p.person_id ? { person_id: p.person_id } : {}) } : {};
}
