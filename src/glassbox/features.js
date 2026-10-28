// glassbox/features.js: sliding windows and the classic time-domain features for the Glass Box
// classifier. Pure ES module (Node + browser).
//
// The definitions match the Python reference (nxt/experiments/feasibility.py) exactly, so the
// golden test can compare numbers: a 200 ms window with a 50 ms step, and per channel
//   mav  mean |x|                       rms  sqrt(mean x^2)
//   wl   sum |x[i+1]-x[i]|              zc   sign changes with |x[i]-x[i+1]| >= threshold
//   ssc  slope sign changes where either neighbouring slope has |d| >= threshold
// plus 'mean' (the signed mean level), which is what an FMG band actually carries: its pressure
// is a slow level with an ADC offset, so zero crossings and slope changes say little about it.
//
// Contract
//   FEATURES = ['mav','rms','wl','zc','ssc','mean'];  DEFAULT_FEATURES = the first five.
//   windowSamples(rateHz, { winMs=200, stepMs=50, win?, step? }) -> { win, step } in samples
//     (win/step given in samples win over the ms values; both are at least 1, win at least 2).
//   featureNames(features, channelNames) -> string[]  'mav:ch1', ... (feature-major order)
//   featuresAt(data, end, win, opts?) -> number[]   causal: uses samples end-win+1 .. end only
//     data: number[][] per channel (column arrays); opts { features, zcThreshold=1, center=false }
//     Layout is feature-major, like feasibility.py's concatenate([mav, rms, wl, zc, ssc]):
//     column = featureIndex * nChannels + channelIndex.
//     center=true subtracts the window's own mean before the five time-domain features (still
//     causal); 'mean' always uses the raw values. Off by default to stay identical to Python.
//   windowStarts(n, win, step) -> start indices 0, step, ... while start < n - win
//     (the same range as Python's range(0, len - WIN, STEP), so the last full window is skipped).
// Failure behaviour: never throws on NaN (the feature becomes NaN); end < win-1 throws RangeError
//   (a window must not reach before the recording: that would not be causal).

export const FEATURES = ['mav', 'rms', 'wl', 'zc', 'ssc', 'mean'];
export const DEFAULT_FEATURES = ['mav', 'rms', 'wl', 'zc', 'ssc'];

export function windowSamples(rateHz, { winMs = 200, stepMs = 50, win, step } = {}) {
  const r = Number(rateHz) > 0 ? Number(rateHz) : 100;
  const w = Math.max(2, Math.round(win ?? (winMs * r) / 1000));
  const s = Math.max(1, Math.round(step ?? (stepMs * r) / 1000));
  return { win: w, step: s };
}

export function featureNames(features = DEFAULT_FEATURES, channelNames = []) {
  const out = [];
  for (const f of features) for (const c of channelNames) out.push(`${f}:${c}`);
  return out;
}

export function windowStarts(n, win, step) {
  const out = [];
  for (let s = 0; s < n - win; s += step) out.push(s);
  return out;
}

// One channel's features, written into out at the feature-major columns.
function channelFeatures(x, a, b, feats, th, center, out, c, nCh) {
  const W = b - a;
  let mean = 0;
  for (let i = a; i < b; i++) mean += x[i];
  mean /= W;
  const off = center ? mean : 0;
  let sa = 0, s2 = 0, wl = 0, zc = 0, ssc = 0;
  for (let i = a; i < b; i++) {
    const v = x[i] - off;
    sa += Math.abs(v);
    s2 += v * v;
    if (i + 1 < b) {
      const v1 = x[i + 1] - off;
      const d0 = v1 - v;
      wl += Math.abs(d0);
      if (v * v1 < 0 && Math.abs(v - v1) >= th) zc++;
      if (i + 2 < b) {
        const d1 = x[i + 2] - x[i + 1];
        if (d0 * d1 < 0 && (Math.abs(d0) >= th || Math.abs(d1) >= th)) ssc++;
      }
    }
  }
  const val = { mav: sa / W, rms: Math.sqrt(s2 / W), wl, zc, ssc, mean };
  for (let f = 0; f < feats.length; f++) out[f * nCh + c] = val[feats[f]];
}

export function featuresAt(data, end, win, { features = DEFAULT_FEATURES, zcThreshold = 1, center = false } = {}) {
  if (end < win - 1) throw new RangeError(`window of ${win} samples ending at ${end} reaches before the recording`);
  for (const f of features) if (!FEATURES.includes(f)) throw new Error(`unknown feature ${f}`);
  const nCh = data.length;
  const out = new Array(features.length * nCh);
  const a = end - win + 1, b = end + 1;
  for (let c = 0; c < nCh; c++) channelFeatures(data[c], a, b, features, zcThreshold, center, out, c, nCh);
  return out;
}
