// ui/hand3d.js: a 3D hand that shows what the Glass Box decided (open, closed, resting), posed by
// the class chances so an unsure decision looks like a half-closed hand. Optional ghost of the
// true gesture. Self-contained like glassbox-view.js: words in H3D_WORDS, styles scoped to .h3d-
// and injected once, so it can be mounted on any screen without touching words.js or style.css.
//
// Contract
//   createHand3D(host, { reducedMotion?, side = 'right' }) -> hand
//     host: an element; the hand fills its width (square, at most 70vh / 520 px tall).
//     reducedMotion: default matchMedia('(prefers-reduced-motion: reduce)'). true = every change
//       snaps to the new pose in one frame (no easing).
//     side: 'right' | 'left', the arm the sensors are on. Each side is its own model (not a
//       flipped copy), shown palm toward the viewer.
//   hand.ready -> Promise<mode>; hand.mode: 'loading' | 'model' | 'fallback'.
//     'fallback' when WebGL is unavailable or three.js / the model cannot load (e.g. the page has
//     no import map for 'three', see vendor/README.md): a text box says the decision in words.
//     Never throws from a call below in any mode.
//   hand.setProbs({ open, close, rest })  class chances (any scale, normalised here; grip / fist /
//     squeeze count as close, other keys are ignored, all zero = rest). The pose is the
//     chance-weighted mix of the three keyframe poses (finger bend angles, not positions).
//   hand.setPose(name, { blend = true })  same as setProbs({ [name]: 1 }); blend false = snap.
//   hand.setDecision(name, { probs, shade = DECISION_SHADE, blend = true })  pose by a decision made
//     elsewhere (the Glass Box vote), so the hand never shows a different class than the word beside
//     it. Pose = (1 - shade) x name + shade x normProbs(probs): with shade < 0.5 the decided class is
//     always the top of the mix, and an unsure window still bends it a little. The label names the
//     decision and, when probs are given, this window's own chance for it (H3D_WORDS.decision).
//     An unknown name falls back to setProbs(probs). setProbs / setPose clear the decision.
//   hand.setTruth(name | null)  ghost (muted wireframe) of the true gesture; null hides it.
//   hand.setSide('left' | 'right') -> Promise<mode>.
//   hand.resize(), hand.destroy() (idempotent; frees WebGL and observers, removes the DOM).
//   hand.label() -> the words on the canvas aria-label, e.g. "3D hand: closed (grip), 80% sure.
//     True gesture: open." Same words on the fallback box.
//   hand.state() -> { mode, side, probs (the posed mix), top, decision (name | null), truth, reducedMotion, running }
//   hand.tipSpread() -> mean fingertip-to-wrist distance / open-hand distance (1 open, ~0.5 fist);
//     null until the model is in. hand.stats = { frames, renderMs } (renderMs: moving average).
//   DOM: div.h3d[data-mode][data-side] > canvas.h3d-canvas[role=img][aria-label] | div.h3d-fallback.
// Render loop: frames are drawn only while the pose is still moving toward its target, and never
//   while the tab is hidden or the hand is scrolled off screen (it catches up when it comes back).
// Network: three.js and the model are same-origin module imports; GLTFLoader only parse()s bytes
//   already in memory, so nothing is fetched at run time.

const CLOSE_RE = /^(close|grip|fist|squeeze)$/;
const CLASSES = ['open', 'close', 'rest'];
const TAU_MS = 90;        // easing time constant: a decision change reads in ~0.3 s, calm, not twitchy
const SETTLE_RAD = 0.002; // below this the pose is "there" and the loop stops
// Share of a decision pose given to the raw chances: enough that a 40%-sure window visibly looks
// less committed, never enough (< 0.5) to tip the hand into another class than the decision.
export const DECISION_SHADE = 0.25;

export const H3D_WORDS = {
  pose: { open: 'open', close: 'closed (grip)', rest: 'resting' },
  label: (pose, pct) => `3D hand: ${pose}, ${pct}% sure.`,
  // pct null = no chances given. "by vote" so the number is not read as the vote's own certainty.
  decision: (pose, pct) => `3D hand: ${pose} (by vote)${pct == null ? '' : `, this window ${pct}% sure`}.`,
  truth: (pose) => ` True gesture: ${pose}.`,
  loading: '3D hand: loading.',
  noGl: 'The 3D hand needs WebGL, which is turned off in this browser. The decision in words:'
};

// Bend added to the model's own (slightly relaxed) pose, radians, per finger bone from the knuckle
// out. Thumb bones are metacarpal, proximal, distal. Hand-tuned by eye on the generic-hand model.
const POSES = {
  open: { thumb: [-0.1, -0.1, -0.05], finger: [-0.12, -0.08, -0.05] },
  close: { thumb: [0.45, 0.55, 0.7], finger: [1.45, 1.6, 1.1] },
  rest: { thumb: [0.12, 0.2, 0.25], finger: [0.35, 0.5, 0.35] }
};
const FINGERS = ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'];
const CHAINS = [
  { key: 'thumb', bones: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'] },
  ...FINGERS.map((f) => ({ key: 'finger', bones: [`${f}-phalanx-proximal`, `${f}-phalanx-intermediate`, `${f}-phalanx-distal`, `${f}-tip`] }))
];
const TIPS = ['thumb-tip', ...FINGERS.map((f) => `${f}-tip`)];

const STYLE = `
.h3d { position: relative; width: 100%; aspect-ratio: 1 / 1; max-height: min(70vh, 520px); margin-inline: auto; overflow: hidden; }
.h3d-canvas { display: block; width: 100%; height: 100%; }
.h3d-fallback { box-sizing: border-box; height: 100%; display: grid; place-content: center; gap: .5rem; padding: 1rem;
  text-align: center; color: var(--muted, #94a3b8); border: 1px dashed var(--line, #334155); border-radius: var(--radius, 10px); overflow-wrap: anywhere; }
.h3d-fallback strong { color: var(--fg, #f8fafc); font-size: 1.25rem; }
`;
function injectStyle() {
  if (document.getElementById('h3d-style')) return;
  const s = document.createElement('style');
  s.id = 'h3d-style';
  s.textContent = STYLE;
  document.head.appendChild(s);
}

// Normalised { open, close, rest }; aliases folded in, junk ignored, nothing at all = resting.
export function normProbs(p) {
  const out = { open: 0, close: 0, rest: 0 };
  for (const [k, v] of Object.entries(p || {})) {
    const key = CLOSE_RE.test(k) ? 'close' : k;
    if (key in out && Number.isFinite(v) && v > 0) out[key] += v;
  }
  const sum = out.open + out.close + out.rest;
  if (!(sum > 0)) return { open: 0, close: 0, rest: 1 };
  for (const k of CLASSES) out[k] /= sum;
  return out;
}
const topOf = (p) => CLASSES.reduce((a, b) => (p[b] > p[a] ? b : a), 'rest');
const poseName = (c) => H3D_WORDS.pose[CLOSE_RE.test(c) ? 'close' : c] ?? null;

// Target bend angles: the chance-weighted mix of the keyframes. Flat array, chain by chain.
function mixAngles(p) {
  const out = [];
  for (const c of CHAINS) for (let i = 0; i < 3; i++) out.push(CLASSES.reduce((s, k) => s + p[k] * POSES[k][c.key][i], 0));
  return out;
}

// Parsed model per side, shared by every hand on the page (each hand clones it).
const modelCache = new Map();
function loadModel(side) {
  if (!modelCache.has(side)) {
    modelCache.set(side, (async () => {
      const [THREE, { GLTFLoader }, SkeletonUtils, bytes] = await Promise.all([
        import('three'),
        import('three/addons/loaders/GLTFLoader.js'),
        import('three/addons/utils/SkeletonUtils.js'),
        import(new URL(`../../assets/hand/${side}-glb.js`, import.meta.url).href)
      ]);
      const bin = atob(bytes.default);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const gltf = await new GLTFLoader().parseAsync(buf.buffer, '');
      return { THREE, clone: SkeletonUtils.clone, scene: gltf.scene };
    })());
    modelCache.get(side).catch(() => modelCache.delete(side)); // a failed load may be retried
  }
  return modelCache.get(side);
}

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

// A soft rim (edges brighter than the face-on middle) on a see-through body: the hologram look
// of the owner's hologram-workshop hand, but in the app's own accent at low strength, not neon.
function rimMaterial(THREE, color, opts) {
  const m = new THREE.MeshPhongMaterial({ color, emissive: color.clone().multiplyScalar(0.12), shininess: 20,
    transparent: true, opacity: 0.55, ...opts });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>',
      `float h3dRim = 1.0 - abs( dot( normalize( normal ), normalize( vViewPosition ) ) );
       gl_FragColor.rgb += diffuse * 0.45 * pow( h3dRim, 2.0 );
       gl_FragColor.a = mix( gl_FragColor.a, 1.0, 0.5 * pow( h3dRim, 3.0 ) );
       #include <dithering_fragment>`);
  };
  m.customProgramCacheKey = () => 'h3d-rim';
  return m;
}

// One posable copy of the model. Bones in the generic hand are all direct children of the
// armature, so finger kinematics are done here: each bone turns about its finger's bend axis by
// the sum of the bends from the knuckle out, and carries the next joint with it.
function buildRig(THREE, src, clone, material, palmward) {
  const root = clone(src);
  const bones = {};
  let mesh = null;
  root.traverse((o) => {
    if (o.isBone) bones[o.name] = o;
    if (o.isSkinnedMesh) mesh = o;
    if (o.name.startsWith('xr_standard')) o.visible = false;
  });
  if (!mesh) throw new Error('hand model has no skinned mesh');
  mesh.material = material;
  mesh.frustumCulled = false; // posed bones leave the bind-pose bounding sphere
  const rest = {};
  for (const c of CHAINS) for (const n of c.bones) {
    if (!bones[n]) throw new Error(`hand model is missing bone "${n}"`);
    rest[n] = { pos: bones[n].position.clone(), quat: bones[n].quaternion.clone() };
  }
  const axes = CHAINS.map((c) => {
    const d = new THREE.Vector3().subVectors(rest[c.bones[1]].pos, rest[c.bones[0]].pos).normalize();
    return new THREE.Vector3().crossVectors(d, palmward).normalize(); // turning d about d x p moves it toward p
  });
  const q = new THREE.Quaternion(), off = new THREE.Vector3(), pos = new THREE.Vector3();
  function pose(angles) {
    CHAINS.forEach((c, ci) => {
      let cum = 0;
      pos.copy(rest[c.bones[0]].pos);
      for (let k = 0; k < 4; k++) {
        if (k < 3) cum += angles[ci * 3 + k];
        q.setFromAxisAngle(axes[ci], cum);
        const b = bones[c.bones[k]];
        b.position.copy(pos);
        b.quaternion.multiplyQuaternions(q, rest[c.bones[k]].quat);
        if (k < 3) pos.add(off.subVectors(rest[c.bones[k + 1]].pos, rest[c.bones[k]].pos).applyQuaternion(q));
      }
    });
  }
  return { root, bones, mesh, pose };
}

export function createHand3D(host, { reducedMotion, side = 'right' } = {}) {
  injectStyle();
  const reduced = reducedMotion ?? (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const root = document.createElement('div');
  root.className = 'h3d';
  host.appendChild(root);

  let mode = 'loading', destroyed = false, curSide = side === 'left' ? 'left' : 'right';
  let probs = normProbs(null), truth = null, decision = null, decisionSure = null;
  let target = mixAngles(probs), current = target.slice();
  let three = null; // { THREE, renderer, scene, camera, pivot, rig, ghost, openSpread }
  let labelEl = null, raf = 0, lastT = 0, onScreen = true, loadSeq = 0;
  const stats = { frames: 0, renderMs: 0 };

  function label() {
    if (mode === 'loading') return H3D_WORDS.loading;
    const top = topOf(probs);
    let s = decision ? H3D_WORDS.decision(H3D_WORDS.pose[decision], decisionSure == null ? null : Math.round(decisionSure * 100)) : H3D_WORDS.label(H3D_WORDS.pose[top], Math.round(probs[top] * 100));
    if (truth) s += H3D_WORDS.truth(poseName(truth));
    return s;
  }
  function showLabel() {
    if (!labelEl) return;
    const s = label();
    labelEl.setAttribute('aria-label', s);
    if (mode === 'fallback') labelEl.querySelector('strong').textContent = s.replace(/^3D hand: /, '');
  }

  function fallback(why) {
    if (destroyed) return;
    if (why) console.warn('hand3d: showing the words instead of the 3D hand:', why);
    disposeThree();
    mode = 'fallback';
    root.dataset.mode = mode;
    root.replaceChildren();
    labelEl = document.createElement('div');
    labelEl.className = 'h3d-fallback';
    labelEl.setAttribute('role', 'img');
    labelEl.innerHTML = '<span></span><strong></strong>';
    labelEl.firstChild.textContent = H3D_WORDS.noGl;
    root.appendChild(labelEl);
    showLabel();
  }

  const running = () => mode === 'model' && !destroyed && !document.hidden && onScreen;
  function kick() { if (!raf && running()) raf = requestAnimationFrame(tick); }
  function tick(now) {
    raf = 0;
    if (!running()) return;
    const dt = lastT ? Math.min(now - lastT, 100) : 16.7;
    lastT = now;
    const k = reduced ? 1 : 1 - Math.exp(-dt / TAU_MS);
    let moving = false;
    for (let i = 0; i < target.length; i++) {
      const d = target[i] - current[i];
      if (Math.abs(d) > SETTLE_RAD && k < 1) { current[i] += d * k; moving = true; } else current[i] = target[i];
    }
    draw();
    if (moving) kick(); else lastT = 0;
  }
  function draw() {
    if (!three) return;
    const t0 = performance.now();
    three.rig.pose(current);
    three.renderer.render(three.scene, three.camera);
    const ms = performance.now() - t0;
    stats.renderMs = stats.frames ? stats.renderMs * 0.9 + ms * 0.1 : ms;
    stats.frames++;
  }

  function setTarget(p, snap, dec = null, sure = null) {
    decision = dec; decisionSure = sure;
    probs = normProbs(p);
    target = mixAngles(probs);
    if (snap || reduced) current = target.slice();
    showLabel();
    if (snap && !reduced && raf) { cancelAnimationFrame(raf); raf = 0; }
    lastT = 0;
    kick();
  }

  function setTruth(name) {
    truth = name && poseName(name) ? (CLOSE_RE.test(name) ? 'close' : name) : null;
    if (three) {
      three.ghost.root.visible = !!truth;
      if (truth) three.ghost.pose(mixAngles(normProbs({ [truth]: 1 })));
    }
    showLabel();
    if (three && !raf) { if (running()) draw(); }
  }

  function resize() {
    if (!three) return;
    const w = Math.max(1, root.clientWidth), h = Math.max(1, root.clientHeight);
    three.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    three.renderer.setSize(w, h, false);
    const cam = three.camera;
    cam.aspect = w / h;
    // Fit the hand's height (with margin) to the view; a narrow view fits its width instead.
    const fitH = three.size * 1.25, half = Math.tan((cam.fov * Math.PI) / 360);
    cam.position.set(0, 0, (fitH / 2 / half) * Math.max(1, 1 / cam.aspect));
    cam.updateProjectionMatrix();
    if (running()) draw();
  }

  function disposeThree() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (!three) return;
    // Our own forceContextLoss() below must not read as a lost context (that would show the fallback).
    three.renderer.domElement.removeEventListener('webglcontextlost', three.onLost);
    for (const r of [three.rig, three.ghost]) { r.mesh.material.dispose(); }
    three.renderer.dispose();
    three.renderer.forceContextLoss?.();
    three = null;
  }

  async function build() {
    const seq = ++loadSeq;
    mode = 'loading';
    root.dataset.mode = mode;
    root.dataset.side = curSide;
    if (!hasWebGL()) { fallback(); return mode; }
    let model;
    try { model = await loadModel(curSide); } catch (err) { if (seq === loadSeq) fallback(err?.message ?? err); return mode; }
    if (destroyed || seq !== loadSeq) return mode;
    try {
      const { THREE } = model;
      disposeThree();
      const css = getComputedStyle(host);
      const tok = (n, d) => (css.getPropertyValue(n).trim() || d);
      const accent = new THREE.Color(tok('--accent', '#38bdf8'));
      const muted = new THREE.Color(tok('--muted', '#94a3b8'));

      const canvas = document.createElement('canvas');
      canvas.className = 'h3d-canvas';
      canvas.setAttribute('role', 'img');
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
      renderer.setClearColor(0x000000, 0);
      const scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 1.4));
      const key = new THREE.DirectionalLight(0xffffff, 1.6);
      key.position.set(0.4, 0.8, 1);
      scene.add(key);
      const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 10);

      // Palm frame of the rest model: up = wrist to middle knuckle, side = pinky to index
      // knuckle, palmward = side x up on a right hand and the reverse on a left one.
      const B = {};
      model.scene.traverse((o) => { if (o.isBone) B[o.name] = o.position; });
      const W = B.wrist, up = new THREE.Vector3().subVectors(B['middle-finger-phalanx-proximal'], W).normalize();
      const sideV = new THREE.Vector3().subVectors(B['index-finger-phalanx-proximal'], B['pinky-finger-phalanx-proximal']);
      sideV.addScaledVector(up, -sideV.dot(up)).normalize();
      const palm = new THREE.Vector3().crossVectors(sideV, up).normalize();
      if (curSide === 'left') palm.negate();
      const rig = buildRig(THREE, model.scene, model.clone, rimMaterial(THREE, accent, {}), palm);
      const ghost = buildRig(THREE, model.scene, model.clone, rimMaterial(THREE, muted, { wireframe: true, opacity: 0.3, depthWrite: false }), palm);
      ghost.mesh.renderOrder = -1;

      // Show the palm to the viewer, fingers up, turned 20 degrees toward the thumb side so the
      // bend reads in depth; the left arm is the mirror view of the right.
      const x = new THREE.Vector3().crossVectors(up, palm);
      const toView = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, palm)).invert();
      const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (curSide === 'left' ? 1 : -1) * 0.35);
      const pivot = new THREE.Group();
      pivot.quaternion.multiplyQuaternions(turn, toView);
      const inner = new THREE.Group();
      inner.add(rig.root, ghost.root);
      pivot.add(inner);
      scene.add(pivot);
      // Centre on the open hand's wrist-to-fingertip span.
      rig.pose(mixAngles(normProbs({ open: 1 })));
      const tipMid = new THREE.Vector3().subVectors(rig.bones['middle-finger-tip'].position, W);
      const size = tipMid.length();
      inner.position.copy(W).add(tipMid.clone().multiplyScalar(0.5)).negate();
      const openSpread = TIPS.reduce((s, t) => s + rig.bones[t].position.distanceTo(W), 0) / TIPS.length;

      const onLost = (e) => { e.preventDefault(); fallback('WebGL context lost'); };
      three = { THREE, renderer, scene, camera, rig, ghost, size, W, openSpread, onLost };
      mode = 'model';
      root.dataset.mode = mode;
      root.replaceChildren(canvas);
      labelEl = canvas;
      canvas.addEventListener('webglcontextlost', onLost);
      setTruth(truth);
      showLabel();
      resize();
      current = target.slice();
      draw();
    } catch (err) {
      fallback(err?.message ?? err);
    }
    return mode;
  }

  const onVis = () => { if (!document.hidden) { lastT = 0; kick(); } };
  document.addEventListener('visibilitychange', onVis);
  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((es) => { onScreen = es[es.length - 1].isIntersecting; if (onScreen) { lastT = 0; kick(); } })
    : null;
  io?.observe(root);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(root);

  const hand = {
    root, stats,
    get mode() { return mode; },
    get canvas() { return mode === 'model' ? labelEl : null; },
    ready: null,
    setProbs(p) { if (!destroyed) setTarget(p, false); },
    setPose(name, { blend = true } = {}) { if (!destroyed) setTarget({ [name]: 1 }, !blend); },
    setDecision(name, { probs: p, shade = DECISION_SHADE, blend = true } = {}) {
      if (destroyed) return;
      const key = typeof name === 'string' && CLOSE_RE.test(name) ? 'close' : name;
      if (!CLASSES.includes(key)) { setTarget(p, !blend); return; }
      const raw = p ? normProbs(p) : null;
      const w = Number.isFinite(shade) ? Math.min(0.49, Math.max(0, shade)) : DECISION_SHADE;
      const mix = Object.fromEntries(CLASSES.map((c) => [c, (c === key ? 1 - w : 0) + (raw ? w * raw[c] : 0)]));
      if (!raw) mix[key] = 1;
      setTarget(mix, !blend, key, raw ? raw[key] : null);
    },
    setTruth(name) { if (!destroyed) setTruth(name); },
    setSide(s) {
      if (destroyed) return Promise.resolve(mode);
      curSide = s === 'left' ? 'left' : 'right';
      hand.ready = build();
      return hand.ready;
    },
    resize,
    label,
    state: () => ({ mode, side: curSide, probs: { ...probs }, top: topOf(probs), decision, truth, reducedMotion: reduced, running: !!raf }),
    tipSpread() {
      if (!three) return null;
      const { rig, W, openSpread } = three;
      return TIPS.reduce((s, t) => s + rig.bones[t].position.distanceTo(W), 0) / TIPS.length / openSpread;
    },
    // For the test page only: the live WebGL context (null in fallback).
    _gl: () => three?.renderer.getContext() ?? null,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      disposeThree();
      document.removeEventListener('visibilitychange', onVis);
      io?.disconnect();
      ro?.disconnect();
      root.remove();
    }
  };
  hand.ready = build();
  return hand;
}
