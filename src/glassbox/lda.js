// glassbox/lda.js: linear discriminant analysis with optional shrinkage. Pure, deterministic
// (no randomness; ties go to the first class in sorted order). Node + browser.
//
// Without shrinkage it follows scikit-learn's default solver ('svd') so the golden test can match
// feasibility.py: features are scaled by their within-class standard deviation, the pooled
// covariance is divided by (n - classes), directions whose singular value is <= tol are dropped
// (collinear or constant features cannot crash the fit), and priors are the class shares.
//
// Contract
//   fitLDA(X, y, opts?) -> Model (plain JSON-safe object)
//     X: number[][] rows (one per window), y: labels (numbers or strings), same length.
//     opts { shrinkage = 0 (0..1, or 'auto' = Ledoit-Wolf on the scaled within-class data),
//            tol = 1e-4, priors = null ({ label: p } overrides the class shares) }
//     Shrinkage pulls the scaled covariance toward its mean variance:
//       C' = (1 - a) C + a * mean(diag C) * I. Use it when windows are few next to features.
//   Model = { classes (sorted: numeric ascending if all numbers, else string order), priors,
//             coef: number[][] (class x feature), intercept: number[], rank, shrinkage, nFeatures }
//   decision(model, x) -> number[] scores per class;  predict(model, x) -> label
//   predictProba(model, x) -> number[] per class (softmax of the scores; sums to 1)
// Failure behaviour: throws Error on empty input, ragged rows, length mismatch, fewer than 2
//   classes, or NaN/Infinity in X (a silent NaN model would predict one class forever).

const sortClasses = (labels) => {
  const u = [...new Set(labels)];
  return u.every((v) => typeof v === 'number') ? u.sort((a, b) => a - b) : u.map(String).sort();
};

// Cyclic Jacobi eigendecomposition of a symmetric matrix (p is small: features x channels).
function jacobiEigen(A0) {
  const p = A0.length;
  const A = A0.map((r) => r.slice());
  const V = Array.from({ length: p }, (_, i) => { const r = new Array(p).fill(0); r[i] = 1; return r; });
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0, diag = 0;
    for (let i = 0; i < p; i++) { diag += A[i][i] * A[i][i]; for (let j = i + 1; j < p; j++) off += A[i][j] * A[i][j]; }
    if (off <= 1e-30 * diag || off === 0) break;
    for (let i = 0; i < p - 1; i++) {
      for (let j = i + 1; j < p; j++) {
        const aij = A[i][j];
        if (Math.abs(aij) < 1e-300) continue;
        const theta = (A[j][j] - A[i][i]) / (2 * aij);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < p; k++) {
          const aki = A[k][i], akj = A[k][j];
          A[k][i] = c * aki - s * akj; A[k][j] = s * aki + c * akj;
        }
        for (let k = 0; k < p; k++) {
          const aik = A[i][k], ajk = A[j][k];
          A[i][k] = c * aik - s * ajk; A[j][k] = s * aik + c * ajk;
        }
        for (let k = 0; k < p; k++) {
          const vki = V[k][i], vkj = V[k][j];
          V[k][i] = c * vki - s * vkj; V[k][j] = s * vki + c * vkj;
        }
      }
    }
  }
  return { values: A.map((r, i) => r[i]), vectors: V }; // vectors[:, k] is the k-th eigenvector
}

// Ledoit-Wolf shrinkage for centred data Z (rows), the same formula as sklearn.covariance.
function ledoitWolf(Z) {
  const n = Z.length, p = Z[0].length;
  const tr = new Array(p).fill(0);
  const S = Array.from({ length: p }, () => new Array(p).fill(0));
  const Q = Array.from({ length: p }, () => new Array(p).fill(0));
  for (const z of Z) for (let i = 0; i < p; i++) {
    tr[i] += z[i] * z[i];
    for (let j = 0; j < p; j++) { S[i][j] += z[i] * z[j]; Q[i][j] += z[i] * z[i] * z[j] * z[j]; }
  }
  const mu = tr.reduce((a, b) => a + b, 0) / n / p;
  let beta_ = 0, delta_ = 0;
  for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) { beta_ += Q[i][j]; delta_ += S[i][j] * S[i][j]; }
  delta_ /= n * n;
  let beta = (beta_ / n - delta_) / (p * n);
  let delta = (delta_ - (2 * mu * tr.reduce((a, b) => a + b, 0)) / n + p * mu * mu) / p;
  beta = Math.min(beta, delta);
  return beta === 0 ? 0 : beta / delta;
}

export function fitLDA(X, y, { shrinkage = 0, tol = 1e-4, priors = null } = {}) {
  const n = X?.length || 0;
  if (!n) throw new Error('LDA needs at least one window');
  if (!y || y.length !== n) throw new Error('LDA: X and y differ in length');
  const p = X[0].length;
  for (const r of X) {
    if (r.length !== p) throw new Error('LDA: rows have different lengths');
    for (const v of r) if (!Number.isFinite(v)) throw new Error('LDA: X contains NaN or Infinity');
  }
  const classes = sortClasses(y);
  const K = classes.length;
  if (K < 2) throw new Error('LDA needs at least two classes');
  const ci = new Map(classes.map((c, k) => [c, k]));
  const yk = y.map((v) => ci.get(typeof classes[0] === 'number' ? v : String(v)));
  const count = new Array(K).fill(0);
  const means = Array.from({ length: K }, () => new Array(p).fill(0));
  for (let i = 0; i < n; i++) { count[yk[i]]++; const m = means[yk[i]]; for (let j = 0; j < p; j++) m[j] += X[i][j]; }
  for (let k = 0; k < K; k++) for (let j = 0; j < p; j++) means[k][j] /= count[k];
  let pri = count.map((c) => c / n);
  if (priors) { pri = classes.map((c) => Number(priors[c]) || 0); const s = pri.reduce((a, b) => a + b, 0); pri = pri.map((v) => v / s); }
  const xbar = new Array(p).fill(0);
  for (let k = 0; k < K; k++) for (let j = 0; j < p; j++) xbar[j] += pri[k] * means[k][j];

  // Within-class residuals and their standard deviation (population, like numpy's std).
  const Xc = X.map((r, i) => r.map((v, j) => v - means[yk[i]][j]));
  const colMean = new Array(p).fill(0);
  for (const r of Xc) for (let j = 0; j < p; j++) colMean[j] += r[j];
  for (let j = 0; j < p; j++) colMean[j] /= n;
  const std = new Array(p).fill(0);
  for (const r of Xc) for (let j = 0; j < p; j++) std[j] += (r[j] - colMean[j]) ** 2;
  for (let j = 0; j < p; j++) {
    std[j] = Math.sqrt(std[j] / n);
    // sklearn tests std == 0 exactly; float noise in a constant column must count as zero too.
    const scale = Math.max(...means.map((m) => Math.abs(m[j])), 1);
    if (!(std[j] > 1e-12 * scale)) std[j] = 1;
  }
  const Z = Xc.map((r) => r.map((v, j) => v / std[j]));
  const fac = 1 / (n - K);
  let C = Array.from({ length: p }, () => new Array(p).fill(0));
  for (const z of Z) for (let i = 0; i < p; i++) { const zi = z[i]; if (zi === 0) continue; const Ci = C[i]; for (let j = i; j < p; j++) Ci[j] += zi * z[j]; }
  for (let i = 0; i < p; i++) for (let j = i; j < p; j++) { C[i][j] *= fac; C[j][i] = C[i][j]; }
  let a = 0;
  if (shrinkage === 'auto') a = ledoitWolf(Z);
  else if (Number(shrinkage) > 0) a = Math.min(1, Number(shrinkage));
  if (a > 0) {
    const mu = C.reduce((s, r, i) => s + r[i], 0) / p;
    C = C.map((r, i) => r.map((v, j) => (1 - a) * v + (i === j ? a * mu : 0)));
  }
  const { values, vectors } = jacobiEigen(C);
  // Keep directions whose singular value sqrt(lambda) exceeds tol (sklearn's rank rule).
  const keep = values.map((v, k) => [v, k]).filter(([v]) => v > tol * tol).sort((u, w) => w[0] - u[0]);
  const rank = keep.length;
  // scalings[j][r] maps a raw feature j to whitened direction r.
  const scal = Array.from({ length: p }, (_, j) => keep.map(([v, k]) => vectors[j][k] / std[j] / Math.sqrt(v)));
  const proj = (x) => { const z = new Array(rank).fill(0); for (let j = 0; j < p; j++) { const d = x[j] - xbar[j]; if (d === 0) continue; const s = scal[j]; for (let r = 0; r < rank; r++) z[r] += d * s[r]; } return z; };
  const M = means.map(proj);
  // score_k(x) = z.m_k - |m_k|^2 / 2 + log prior_k, folded back into raw feature space.
  const coef = M.map((m) => { const c = new Array(p).fill(0); for (let j = 0; j < p; j++) { let s = 0; for (let r = 0; r < rank; r++) s += scal[j][r] * m[r]; c[j] = s; } return c; });
  const intercept = M.map((m, k) => -0.5 * m.reduce((s, v) => s + v * v, 0) + Math.log(pri[k]) - coef[k].reduce((s, v, j) => s + v * xbar[j], 0));
  return { classes, priors: pri, coef, intercept, rank, shrinkage: a, nFeatures: p };
}

export function decision(model, x) {
  return model.coef.map((c, k) => { let s = model.intercept[k]; for (let j = 0; j < c.length; j++) s += c[j] * x[j]; return s; });
}

export function predict(model, x) {
  const d = decision(model, x);
  let best = 0;
  for (let k = 1; k < d.length; k++) if (d[k] > d[best]) best = k;
  return model.classes[best];
}

export function predictProba(model, x) {
  const d = decision(model, x);
  const m = Math.max(...d);
  const e = d.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}
