// Statistics and small linear algebra used across the pipeline. NaN means "missing" everywhere and is skipped, never imputed silently.

export const finite = (xs: ArrayLike<number>) => Array.from(xs).filter((x) => Number.isFinite(x));
export const sum = (xs: ArrayLike<number>) => { let s = 0; for (let i = 0; i < xs.length; i++) if (Number.isFinite(xs[i])) s += xs[i]; return s; };
export const mean = (xs: ArrayLike<number>) => { const f = finite(xs); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : NaN; };
export function sd(xs: ArrayLike<number>) {
  const f = finite(xs), m = mean(f);
  return f.length > 1 ? Math.sqrt(f.reduce((a, b) => a + (b - m) ** 2, 0) / (f.length - 1)) : NaN;
}
export function quantile(xs: ArrayLike<number>, q: number) {
  const f = finite(xs).sort((a, b) => a - b);
  if (!f.length) return NaN;
  const pos = (f.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return f[lo] + (f[hi] - f[lo]) * (pos - lo);
}
export const median = (xs: ArrayLike<number>) => quantile(xs, 0.5);
/** Median absolute deviation scaled to a normal sigma. */
export const mad = (xs: ArrayLike<number>) => { const m = median(xs); return 1.4826 * median(finite(xs).map((x) => Math.abs(x - m))); };
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/** Gaussian elimination with partial pivoting. */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) throw new Error("singular system");
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}

/** Ordinary least squares with an intercept column added. Returns [intercept, ...slopes] and the residual sd. */
export function ols(X: number[][], y: number[]) {
  const rows = X.map((r, i) => [1, ...r, y[i]]).filter((r) => r.every(Number.isFinite));
  const k = X[0].length + 1;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0)), Xty = new Array(k).fill(0);
  for (const r of rows) for (let i = 0; i < k; i++) { Xty[i] += r[i] * r[k]; for (let j = 0; j < k; j++) XtX[i][j] += r[i] * r[j]; }
  for (let i = 1; i < k; i++) XtX[i][i] += 1e-9; // tiny ridge so a constant column cannot make it singular
  const beta = solve(XtX, Xty);
  const res = rows.map((r) => r[k] - beta.reduce((s, b, i) => s + b * r[i], 0));
  return { beta, residSd: Math.sqrt(res.reduce((a, b) => a + b * b, 0) / Math.max(1, rows.length - k)), n: rows.length };
}

/** First principal component of standardized complete-case rows (power iteration). Sign fixed so loadings sum positive. */
export function pca1(rows: number[][], iters = 200) {
  const complete = rows.filter((r) => r.every(Number.isFinite));
  const k = rows[0].length;
  const C = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const r of complete) for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) C[i][j] += (r[i] * r[j]) / complete.length;
  let v = new Array(k).fill(1 / Math.sqrt(k));
  let lambda = 0;
  for (let it = 0; it < iters; it++) {
    const w = C.map((row) => row.reduce((s, c, j) => s + c * v[j], 0));
    lambda = Math.hypot(...w);
    v = w.map((x) => x / lambda);
  }
  if (v.reduce((a, b) => a + b, 0) < 0) v = v.map((x) => -x);
  const total = C.reduce((s, row, i) => s + row[i], 0);
  return { loadings: v, explained: lambda / total, n: complete.length };
}
