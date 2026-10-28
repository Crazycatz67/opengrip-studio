// protocol.js: a guided recording session as JSON steps. Pure.
//
// Contract
//   Protocol = { name: string, steps: Step[] }, Step = { label, seconds > 0, instruction }
//   Input JSON may also contain { repeat: n, steps: [...] } groups; they are expanded.
//   defaultProtocol(opts?) -> Protocol    (see DEFAULT_SPEC for the shape)
//   validateProtocol(obj) -> { ok, errors: string[], protocol: Protocol|null } (expanded, frozen-free copy)
//   parseProtocolJSON(text) -> same as validateProtocol, plus a JSON syntax error message
//   timeline(protocol) -> [{ ...step, index, start, end }]   seconds from session start
//   totalSeconds(protocol) -> number
//   stepAt(protocol, elapsedSec) -> { index, step, stepElapsed, stepRemaining, progress 0..1, done }
//     Before 0 -> step 0; at/after total -> done: true, step null, progress 1.
// Labels are "gesture" or "gesture@position" (e.g. grip@elbow90). The quality checks read
// them: cal_rest/cal_squeeze are calibration; a gesture containing "grip"/"squeeze" is a grip;
// "elbow"/"bend"/"distractor", or a rest in a non-default position, is arm-only.
//   splitLabel(label) -> { gesture, position|null };  POSITIONS: the 3 arm positions.
//   stepStart(protocol, index) -> seconds from session start where step `index` begins
//     (index past the end gives the total).
//   calibrationSteps(opts?) -> Step-or-group list: cal_rest + sub-max squeezes (the `C` key).
//   insertSteps(protocol, at, steps) -> { ok, errors, protocol }  new protocol with `steps`
//     (validated and expanded like JSON input) placed before index `at`; the input is not changed.

export const DEFAULT_TIMING = { calRest: 5, calSqueezes: 3, restStart: 10, hold: 3, rest: 4, reps: 5, restEnd: 10 };

// Arm positions for grips: limb position changes FMG/EMG as much as a grip does,
// so every gesture is recorded in each. Label format is gesture@position.
export const POSITIONS = [
  { id: 'down', text: 'Arm hanging straight down by your side.' },
  { id: 'elbow90', text: 'Elbow bent to about 90°, forearm level.' },
  { id: 'raised', text: 'Arm raised forward to shoulder height.' },
];

export function splitLabel(label) {
  const s = String(label || '');
  const at = s.indexOf('@');
  return at < 0 ? { gesture: s, position: null } : { gesture: s.slice(0, at), position: s.slice(at + 1) };
}

export function defaultProtocol(opts = {}) {
  const t = { ...DEFAULT_TIMING, ...opts };
  const rep = (n, label, instruction, restLabel, restText) => ({
    repeat: n,
    steps: [
      { label, seconds: t.hold, instruction },
      { label: restLabel, seconds: t.rest, instruction: restText },
    ],
  });
  const steps = [
    ...calibrationSteps(t),
    { label: 'rest', seconds: t.restStart, instruction: 'Rest your arm on the table, hand relaxed. Stay still.' },
  ];
  for (const p of POSITIONS) {
    steps.push({ label: `rest@${p.id}`, seconds: t.rest, instruction: `${p.text} Hand relaxed.` });
    steps.push(rep(t.reps, `grip@${p.id}`, `${p.text} Make a firm fist and hold it.`, `rest@${p.id}`, `${p.text} Relax your hand.`));
    if (p.id === 'down') steps.push(rep(t.reps, `open@${p.id}`, `${p.text} Open your hand wide, fingers spread.`, `rest@${p.id}`, `${p.text} Relax your hand.`));
  }
  // Distractor: the arm movement alone, hand relaxed. A good model must ignore it.
  steps.push(rep(t.reps, 'elbow_bend', 'Hand relaxed: bend your elbow up, then hold.', 'rest', 'Straighten your arm, hand relaxed.'));
  steps.push({ label: 'rest', seconds: t.restEnd, instruction: 'Rest your arm on the table, hand relaxed. Stay still.' });
  return validateProtocol({ name: 'OpenGrip default v2', steps }).protocol;
}

export function calibrationSteps(opts = {}) {
  const t = { ...DEFAULT_TIMING, ...opts };
  // Per-fitting calibration: the rest and squeeze levels become the 0-1 range for this
  // band fitting. Sub-maximal on purpose: max effort is tiring and not repeatable.
  return [
    { label: 'cal_rest', seconds: t.calRest, instruction: 'Calibration: arm on the table, hand fully relaxed.' },
    {
      repeat: t.calSqueezes,
      steps: [
        { label: 'cal_squeeze', seconds: t.hold, instruction: 'Calibration: squeeze firmly but comfortably (not as hard as you can).' },
        { label: 'cal_rest', seconds: t.rest, instruction: 'Relax.' },
      ],
    },
  ];
}

export function stepStart(protocol, index) {
  let t = 0;
  const n = Math.min(Math.max(0, index), protocol.steps.length);
  for (let i = 0; i < n; i++) t += protocol.steps[i].seconds;
  return t;
}

export function insertSteps(protocol, at, steps) {
  const errors = [];
  const add = expand(steps, errors, 'steps', 0);
  if (!add.length && !errors.length) errors.push('No steps to insert');
  if (protocol.steps.length + add.length > 2000) errors.push('Protocol has too many steps (max 2000)');
  if (errors.length) return { ok: false, errors, protocol: null };
  const i = Math.min(Math.max(0, at), protocol.steps.length);
  const out = protocol.steps.map((x) => ({ ...x }));
  out.splice(i, 0, ...add);
  return { ok: true, errors, protocol: { name: protocol.name, steps: out } };
}

function expand(steps, errors, path, depth) {
  const out = [];
  if (!Array.isArray(steps)) { errors.push(`${path}: "steps" must be a list`); return out; }
  steps.forEach((s, i) => {
    const p = `${path}[${i}]`;
    if (!s || typeof s !== 'object') { errors.push(`${p}: must be an object`); return; }
    if ('repeat' in s) {
      const n = Number(s.repeat);
      if (!Number.isInteger(n) || n < 1 || n > 100) { errors.push(`${p}: repeat must be a whole number 1-100`); return; }
      if (depth > 3) { errors.push(`${p}: groups nested too deep`); return; }
      const inner = expand(s.steps, errors, `${p}.steps`, depth + 1);
      for (let k = 0; k < n; k++) out.push(...inner.map((x) => ({ ...x })));
      return;
    }
    const label = typeof s.label === 'string' ? s.label.trim() : '';
    const seconds = Number(s.seconds);
    // Labels end up as a CSV column, so no commas, quotes or line breaks.
    if (!/^[A-Za-z_][\w\- @]{0,39}$/.test(label)) errors.push(`${p}: label must start with a letter and use letters, digits, _ - @ or space (max 40)`);
    if (!(seconds > 0 && seconds <= 3600)) errors.push(`${p}: seconds must be between 0 and 3600`);
    out.push({ label, seconds, instruction: typeof s.instruction === 'string' ? s.instruction : '' });
  });
  return out;
}

export function validateProtocol(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['Protocol must be a JSON object'], protocol: null };
  const steps = expand(obj.steps, errors, 'steps', 0);
  if (!steps.length && !errors.length) errors.push('Protocol has no steps');
  if (steps.length > 2000) errors.push('Protocol has too many steps (max 2000)');
  if (errors.length) return { ok: false, errors, protocol: null };
  return { ok: true, errors, protocol: { name: typeof obj.name === 'string' ? obj.name : 'Custom protocol', steps } };
}

export function parseProtocolJSON(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return { ok: false, errors: [`Not valid JSON: ${e.message}`], protocol: null }; }
  return validateProtocol(obj);
}

export function timeline(protocol) {
  let t = 0;
  return protocol.steps.map((s, index) => {
    const start = t;
    t += s.seconds;
    return { ...s, index, start, end: t };
  });
}

export function totalSeconds(protocol) {
  return protocol.steps.reduce((a, s) => a + s.seconds, 0);
}

export function stepAt(protocol, elapsedSec) {
  const tl = timeline(protocol);
  const total = tl.length ? tl[tl.length - 1].end : 0;
  const e = Math.max(0, elapsedSec);
  if (e >= total) return { index: tl.length, step: null, stepElapsed: 0, stepRemaining: 0, progress: 1, done: true };
  // Linear scan is fine: protocols are tens of steps and this runs a few times a second.
  const s = tl.find((x) => e < x.end);
  return {
    index: s.index, step: s, stepElapsed: e - s.start, stepRemaining: s.end - e,
    progress: total ? e / total : 1, done: false,
  };
}
