// Browser test for the 3D hand (src/ui/hand3d.js). No hardware, no sound. Works with or without
// WebGL: the real-model checks run when the browser has WebGL, the words-only fallback is always
// checked (WebGL is switched off for one hand by stubbing getContext).
// Result: document.title 'PASS'|'FAIL' and window.__gate = { done, pass, results }.
// Run: GATE_PAGES=/test/browser/hand3d.html npm run gate:browser, or open /test/browser/hand3d.html.
import { createHand3D, normProbs, H3D_WORDS } from '../../src/ui/hand3d.js';
import rightB64 from '../../assets/hand/right-glb.js';
import leftB64 from '../../assets/hand/left-glb.js';

const logEl = document.getElementById('log');
const box = document.getElementById('box');
const results = [];
window.__gate = { done: false, pass: false, results };
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  logEl.textContent += `${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}\n`;
}
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (v) => (v == null ? 'null' : v.toFixed(2));
const errors = [];
const origErr = console.error;
console.error = (...a) => { errors.push(a.join(' ')); origErr(...a); };
window.addEventListener('error', (e) => errors.push(String(e.message)));
async function settle(hand, ms = 1500) {
  const t0 = performance.now();
  while (hand.state().running && performance.now() - t0 < ms) await frame();
  await frame();
}
async function sha256(b64) {
  const bin = atob(b64); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', u))].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function inside(el, host) {
  const a = el.getBoundingClientRect(), b = host.getBoundingClientRect();
  return a.width > 0 && a.left >= b.left - 1 && a.right <= b.right + 1 && host.scrollWidth <= host.clientWidth + 1;
}

async function run() {
  // Pure helper
  const p = normProbs({ grip: 3, open: 1, junk: 9, rest: -1 });
  check('normProbs folds grip into close, ignores junk and negatives', p.close === 0.75 && p.open === 0.25 && p.rest === 0, JSON.stringify(p));
  check('normProbs of nothing = resting', normProbs({}).rest === 1);

  // Model asset is the upstream bytes
  check('right hand bytes = upstream sha256', (await sha256(rightB64)) === '291790c14f7f88a7f9bd35330c47392ed8e8d395ae6728f4bb7089f1bc1f2b96');
  check('left hand bytes = upstream sha256', (await sha256(leftB64)) === 'bc67783144944ea1cda54d9247885825ea5fb9d4651469fe7d00be517a5c2b87');

  // Words-only fallback, forced: no WebGL for this hand
  const getCtx = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, ...a) { return /webgl/.test(t) ? null : getCtx.call(this, t, ...a); };
  const fb = createHand3D(box, { reducedMotion: true });
  const fbMode = await fb.ready;
  HTMLCanvasElement.prototype.getContext = getCtx;
  const fbEl = fb.root.querySelector('.h3d-fallback');
  check('no WebGL: fallback box, no canvas', fbMode === 'fallback' && fbEl && !fb.root.querySelector('canvas'), fbMode);
  fb.setProbs({ close: 0.8, open: 0.2 });
  check('fallback aria-label follows setProbs', fbEl.getAttribute('aria-label') === H3D_WORDS.label('closed (grip)', 80), fbEl.getAttribute('aria-label'));
  fb.setDecision('rest', { probs: { open: 0.9, rest: 0.1 } });
  check('fallback follows setDecision, not the top chance', fbEl.getAttribute('aria-label') === H3D_WORDS.decision('resting', 10) && fb.state().top === 'rest', fbEl.getAttribute('aria-label'));
  fb.setProbs({ close: 0.8, open: 0.2 });
  check('fallback shows the words', fbEl.textContent.includes('closed (grip), 80% sure'), fbEl.textContent);
  fb.destroy(); fb.destroy();
  check('destroy removes the hand (twice is fine)', !box.querySelector('.h3d'));

  // The real hand
  const glOk = (() => { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); })();
  const hand = createHand3D(box, {});
  const mode = await hand.ready;
  check(`mode matches WebGL (${glOk ? 'available' : 'unavailable'} here)`, mode === (glOk ? 'model' : 'fallback'), mode);
  window.__hand3dMode = mode;
  if (mode === 'model') {
    const cv = hand.canvas;
    check('canvas has role=img and an aria-label', cv && cv.getAttribute('role') === 'img' && /^3D hand: /.test(cv.getAttribute('aria-label')), cv?.getAttribute('aria-label'));
    hand.setPose('open', { blend: false }); await frame();
    const open = hand.tipSpread();
    hand.setPose('close', { blend: false }); await frame();
    const close = hand.tipSpread();
    hand.setPose('rest', { blend: false }); await frame();
    const rest = hand.tipSpread();
    check('open hand: tips at full reach', Math.abs(open - 1) < 0.02, r2(open));
    check('close: fingertips pulled in (< 0.75 of open)', close < 0.75, r2(close));
    check('rest sits between open and close', rest < open && rest > close, r2(rest));
    hand.setProbs({ open: 0.5, close: 0.5 }); await settle(hand);
    const half = hand.tipSpread();
    check('50/50 open/close: a half-closed hand', half < open - 0.05 && half > close + 0.05, r2(half));
    check('aria-label names the top class', cv.getAttribute('aria-label').startsWith('3D hand: open, 50%'), cv.getAttribute('aria-label'));
    hand.setProbs({ grip: 0.9, rest: 0.1 }); await settle(hand);
    check('grip counts as close; label updates', cv.getAttribute('aria-label') === H3D_WORDS.label('closed (grip)', 90) && hand.tipSpread() < 0.8, `${cv.getAttribute('aria-label')} ${r2(hand.tipSpread())}`);

    // Easing: not there in one frame, there after settling, then the loop stops
    hand.setPose('open', { blend: false }); await frame();
    hand.setPose('close'); await frame();
    const mid = hand.tipSpread();
    await settle(hand);
    check('blend eases: one frame in, the hand is still on its way', mid > close + 0.02, `${r2(mid)} vs ${r2(close)}`);
    check('after settling: at the close pose and the loop has stopped', Math.abs(hand.tipSpread() - close) < 0.02 && !hand.state().running, r2(hand.tipSpread()));
    const f0 = hand.stats.frames; await wait(300);
    check('idle: no frames drawn while nothing changes', hand.stats.frames === f0, hand.stats.frames - f0);

    // Decision (the Glass Box vote): pose follows the decided class even when the raw chances disagree;
    // the raw chances only shade it. Eased like setPose.
    hand.setPose('open', { blend: false }); await frame();
    hand.setDecision('close', { probs: { open: 0.6, close: 0.4 } }); await frame();
    const decMid = hand.tipSpread();
    await wait(800);
    const dec = hand.tipSpread(); const ds = hand.state();
    check('setDecision: top = the decision though open had the higher chance', ds.top === 'close' && ds.decision === 'close', JSON.stringify(ds.probs));
    check('setDecision: label names the vote and the window\'s own chance', cv.getAttribute('aria-label') === H3D_WORDS.decision('closed (grip)', 40), cv.getAttribute('aria-label'));
    check('setDecision eases (one frame in, still on its way)', decMid > dec + 0.02, `${r2(decMid)} vs ${r2(dec)}`);
    check('setDecision: shaded by the chances, between close and open, nearer close', dec > close + 0.02 && dec < (open + close) / 2, `${r2(close)} < ${r2(dec)} < ${r2((open + close) / 2)}`);
    hand.setDecision('grip', { blend: false }); await frame();
    check('setDecision without chances: full pose, no percent', Math.abs(hand.tipSpread() - close) < 0.02 && cv.getAttribute('aria-label') === H3D_WORDS.decision('closed (grip)', null), cv.getAttribute('aria-label'));
    hand.setProbs({ open: 1 });
    check('setProbs clears the decision', hand.state().decision === null && cv.getAttribute('aria-label').startsWith('3D hand: open, 100%'), cv.getAttribute('aria-label'));
    await wait(800);

    // Truth ghost
    hand.setTruth('open');
    check('setTruth adds the true gesture to the label', cv.getAttribute('aria-label').endsWith(H3D_WORDS.truth('open')), cv.getAttribute('aria-label'));
    hand.setTruth(null);
    check('setTruth(null) removes it', !/True gesture/.test(cv.getAttribute('aria-label')));

    // Off screen: paused; back: catches up
    box.style.cssText = 'position:fixed;top:-5000px;left:0;width:360px';
    await wait(150); await frame();
    const f1 = hand.stats.frames;
    hand.setPose('open'); await wait(300);
    check('off screen: no frames drawn', hand.stats.frames === f1, hand.stats.frames - f1);
    box.style.cssText = '';
    await wait(150); await settle(hand);
    check('back on screen: catches up to the new pose', hand.stats.frames > f1 && Math.abs(hand.tipSpread() - open) < 0.02, r2(hand.tipSpread()));

    // Speed: a new decision every frame for 2 s (the Watch replay worst case)
    const gaps = []; let last = performance.now(); const tEnd = last + 2000; let i = 0;
    const r0 = hand.stats.frames;
    while (performance.now() < tEnd) {
      hand.setProbs({ open: (Math.sin(i / 10) + 1) / 2, close: (Math.cos(i / 10) + 1) / 2 }); i++;
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now(); gaps.push(now - last); last = now;
    }
    gaps.sort((a, b) => a - b);
    const fps = 1000 / gaps[Math.floor(gaps.length / 2)];
    window.__hand3dPerf = { fps, renderMs: hand.stats.renderMs, frames: hand.stats.frames - r0, p90: gaps[Math.floor(gaps.length * 0.9)] };
    check('one draw per frame while moving', hand.stats.frames - r0 >= gaps.length - 2, `${hand.stats.frames - r0} draws / ${gaps.length} frames`);
    check('render cost under 8 ms a frame (room for 60 fps)', hand.stats.renderMs < 8, `${hand.stats.renderMs.toFixed(2)} ms; median ${fps.toFixed(0)} fps, p90 gap ${window.__hand3dPerf.p90.toFixed(1)} ms`);
    const gl = hand._gl();
    check('no WebGL errors', gl && gl.getError() === gl.NO_ERROR);

    // Widths
    for (const w of [375, 1440]) {
      box.style.width = `${w}px`; await wait(100); hand.resize(); await frame();
      const c = hand.canvas.getBoundingClientRect();
      // Square up to the height cap (70vh / 520 px), so a wide box gives a wide, capped view.
      const capH = Math.min(innerHeight * 0.7, 520);
      check(`width ${w}: canvas inside its box, no sideways scroll`, inside(hand.canvas, box) && (c.width > w * 0.95 || c.height > capH - 2) && c.height > 100,
        `${Math.round(c.width)}x${Math.round(c.height)} in ${box.clientWidth} (cap ${Math.round(capH)})`);
    }
    box.style.width = '';

    // Left arm
    const sm = await hand.setSide('left');
    await wait(100);
    hand.setPose('close', { blend: false }); await frame();
    const ls = hand.tipSpread();
    check('left arm: own model, still closes', sm === 'model' && hand.mode === 'model' && hand.root.dataset.side === 'left' && ls != null && ls < 0.75, `${hand.mode} ${r2(ls)}`);
    check('no WebGL errors after switching arm', hand._gl()?.getError() === 0);
    // Reduced motion snaps
    const rm = createHand3D(box, { reducedMotion: true }); await rm.ready;
    rm.setPose('open'); await frame();
    rm.setPose('close'); await frame();
    check('reduced motion: snaps in one frame', rm.tipSpread() != null && Math.abs(rm.tipSpread() - close) < 0.02, r2(rm.tipSpread()));
    rm.destroy();
  } else {
    hand.setProbs({ open: 1 });
    check('no WebGL here: fallback label follows setProbs', hand.root.querySelector('.h3d-fallback').getAttribute('aria-label') === H3D_WORDS.label('open', 100));
  }
  hand.destroy();

  // Every request this page made was to its own origin
  const res = performance.getEntriesByType('resource');
  const foreign = res.filter((e) => new URL(e.name).origin !== location.origin);
  check('0 requests to other origins', foreign.length === 0, `${res.length} same-origin, ${foreign.length} other${foreign.length ? `: ${foreign[0].name}` : ''}`);
  const warnFree = errors.filter((e) => !/^hand3d: showing the words/.test(e));
  check('0 console errors', warnFree.length === 0, warnFree[0] || '');
}

run().catch((e) => check('test page ran to the end', false, e?.stack || e)).finally(() => {
  const pass = results.length > 0 && results.every((r) => r.ok);
  Object.assign(window.__gate, { done: true, pass });
  document.title = pass ? 'PASS' : 'FAIL';
  const s = document.getElementById('summary');
  s.textContent = `${pass ? 'PASS' : 'FAIL'}: ${results.filter((r) => r.ok).length}/${results.length} checks`;
  s.className = pass ? 'pass' : 'fail';
});
