// Regional pulse: a one-factor dynamic factor model per region. Two-step estimation (principal component for the loadings,
// AR(1) for the factor), then a Kalman filter that handles missing days (the ragged edge, feed outages) and splits every
// filtered value exactly into the contribution of each input series. A bridge regression maps the monthly mean of the factor
// onto the official indicator; gradient boosting is fitted on the same information as a second nowcast.
import { clamp, mad, mean, median, ols, pca1, sd } from "./math.ts";
import { fitGbm } from "./gbm.ts";
import { dayToIso, isoToDay, type Official } from "./world.ts";

export const SERIES = ["energy", "transport", "departuresTo", "arrivalsIn", "exports"] as const;
export type SeriesName = (typeof SERIES)[number];
export const SERIES_LABEL: Record<SeriesName, string> = { energy: "Power demand", transport: "Road freight", departuresTo: "Cargo departing toward the region", arrivalsIn: "Cargo arriving", exports: "Cargo departing from the region" };

/** Raw inputs for one region: daily series, NaN = missing. Volumes are 7-day sums in kt. */
export type Panel = Record<SeriesName, ArrayLike<number>>;

export interface DfmParams { dow: Record<string, number[]>; mu: number[]; sigma: number[]; lambda: number[]; R: number[]; phi: number; Q: number; explained: number; fitTo: number }

const transform = (name: SeriesName, v: number) => (name === "energy" || name === "transport" ? v : Number.isFinite(v) ? Math.log1p(Math.max(0, v)) : NaN);

function prepared(panel: Panel, p: Pick<DfmParams, "dow" | "mu" | "sigma">, days: number) {
  return SERIES.map((s, i) => Array.from({ length: days }, (_, d) => {
    let v = transform(s, panel[s][d]);
    if (p.dow[s]) v -= p.dow[s][(d + 1) % 7];
    return clamp((v - p.mu[i]) / p.sigma[i], -4, 4); // NaN stays NaN; outliers are clipped at 4 sigma
  }));
}

/** Estimate on days [0, fitTo]. */
export function fitDfm(panel: Panel, fitTo: number): DfmParams {
  const dow: Record<string, number[]> = {};
  for (const s of ["energy", "transport"] as const) {
    const all = Array.from({ length: fitTo + 1 }, (_, d) => panel[s][d]);
    const m = median(all);
    dow[s] = Array.from({ length: 7 }, (_, k) => median(all.filter((_, d) => (d + 1) % 7 === k)) - m);
  }
  const raw = SERIES.map((s) => Array.from({ length: fitTo + 1 }, (_, d) => { let v = transform(s, panel[s][d]); if (dow[s]) v -= dow[s][(d + 1) % 7]; return v; }));
  const mu = raw.map((x) => median(x)), sigma = raw.map((x) => Math.max(1e-6, mad(x) || sd(x)));
  const X = prepared(panel, { dow, mu, sigma }, fitTo + 1);
  const rows = Array.from({ length: fitTo + 1 }, (_, d) => X.map((x) => x[d]));
  const { loadings, explained } = pca1(rows);
  // factor proxy, scaled to unit variance; loadings rescaled to match
  const F = rows.map((r) => (r.every(Number.isFinite) ? r.reduce((s, x, i) => s + x * loadings[i], 0) : NaN));
  const fsd = sd(F) || 1;
  const f = F.map((x) => x / fsd);
  const lambda = SERIES.map((_, i) => ols(f.map((x) => [x]), X[i]).beta[1]);
  const R = SERIES.map((_, i) => { const e = X[i].map((x, d) => x - lambda[i] * f[d]); return Math.max(0.05, sd(e) ** 2); });
  const ar = ols(f.slice(0, -1).map((x) => [x]), f.slice(1));
  const phi = clamp(ar.beta[1], 0, 0.999);
  return { dow, mu, sigma, lambda, R, phi, Q: Math.max(1e-4, ar.residSd ** 2), explained, fitTo };
}

export interface Filtered { m: Float64Array; P: Float64Array; contrib: Float64Array[] }

/** Kalman filter through `upto`. `drop` removes series from a day on (e.g. an AIS outage) to show the ragged edge. */
export function filterDfm(panel: Panel, p: DfmParams, upto: number, drop?: { series: SeriesName[]; from: number; to?: number }): Filtered {
  const n = upto + 1, X = prepared(panel, p, n);
  const m = new Float64Array(n), P = new Float64Array(n), contrib = SERIES.map(() => new Float64Array(n));
  let mp = 0, Pp = p.Q / Math.max(1e-6, 1 - p.phi ** 2), c = SERIES.map(() => 0);
  const dropped = new Set(drop?.series.map((s) => SERIES.indexOf(s)));
  for (let t = 0; t < n; t++) {
    if (t > 0) { mp = p.phi * m[t - 1]; Pp = p.phi ** 2 * P[t - 1] + p.Q; c = c.map((x) => p.phi * x); }
    let info = 1 / Pp;
    const add = SERIES.map(() => 0);
    for (let i = 0; i < SERIES.length; i++) {
      const x = X[i][t];
      if (!Number.isFinite(x) || (drop && dropped.has(i) && t >= drop.from && (drop.to === undefined || t <= drop.to))) continue;
      info += p.lambda[i] ** 2 / p.R[i];
      add[i] = (p.lambda[i] * x) / p.R[i];
    }
    P[t] = 1 / info;
    c = c.map((ci, i) => P[t] * (ci / Pp + add[i]));
    let s = 0;
    for (let i = 0; i < SERIES.length; i++) { contrib[i][t] = c[i]; s += c[i]; }
    m[t] = s; // the prior mean is phi*m[t-1], which is already inside the carried contributions
  }
  return { m, P, contrib };
}

export const pulseIndex = (m: number) => 100 + 10 * m;
export const band80 = (P: number) => 1.2816 * 10 * Math.sqrt(P);
export const confidence = (P: number): "high" | "medium" | "low" => (Math.sqrt(P) < 0.25 ? "high" : Math.sqrt(P) < 0.5 ? "medium" : "low");

/** Day index range [start, endExclusive) of a YYYY-MM month. */
export function monthRange(month: string): [number, number] {
  const [y, mo] = month.split("-").map(Number);
  return [isoToDay(`${month}-01`), isoToDay(`${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, "0")}-01`)];
}
const monthMean = (x: ArrayLike<number>, month: string, upto: number) => { const [a, b] = monthRange(month); const s = Array.from(x).slice(a, Math.min(b, upto + 1)); return s.length ? mean(s) : NaN; };

export interface Nowcast { region: string; month: string; atDay: number; value: number; lo: number; hi: number; contributions: Record<SeriesName, number>; intercept: number; daysOfData: number }

/** Bridge nowcast of `month` using only what was known on `atDay` (officials released by then, data through then). */
export function bridgeNowcast(region: string, official: Official[], f: Filtered, atDay: number, month: string): Nowcast {
  const known = official.filter((o) => o.region === region && o.releasedDay <= atDay);
  const fit = ols(known.map((o) => [monthMean(f.m, o.month, atDay)]), known.map((o) => o.value));
  const [a, b] = fit.beta;
  const fm = monthMean(f.m, month, atDay), Pm = monthMean(f.P, month, atDay);
  const sdPred = Math.sqrt(fit.residSd ** 2 + b * b * Pm / 4);
  const contributions = Object.fromEntries(SERIES.map((s, i) => [s, b * monthMean(f.contrib[i], month, atDay)])) as Record<SeriesName, number>;
  const [m0, m1] = monthRange(month);
  return { region, month, atDay, value: a + b * fm, lo: a + b * fm - 1.2816 * sdPred, hi: a + b * fm + 1.2816 * sdPred, contributions, intercept: a, daysOfData: Math.max(0, Math.min(m1, atDay + 1) - m0) };
}

export interface CvRow { region: string; month: string; actual: number; bridge: number; lo: number; hi: number; gbm: number; ensemble: number; naive: number; ar1: number }

/**
 * Rolling-origin evaluation: at the last day of each month from `firstMonth`, refit everything on what existed then and
 * nowcast that month (its official value comes out 45 days later). Benchmarks: the last published value, and an AR(1) on
 * published values run forward two months.
 */
export function crossValidate(panels: Record<string, Panel>, official: Official[], firstMonth: string, lastDay: number): CvRow[] {
  const months = [...new Set(official.map((o) => o.month))].filter((m) => m >= firstMonth && monthRange(m)[1] - 1 <= lastDay);
  const rows: CvRow[] = [];
  for (const month of months) {
    const at = monthRange(month)[1] - 1;
    const filt: Record<string, Filtered> = {};
    for (const [reg, panel] of Object.entries(panels)) filt[reg] = filterDfm(panel, fitDfm(panel, at), at);
    // gradient boosting, pooled over regions, trained on released months
    const feats = (reg: string, mo: string) => {
      const prev = official.filter((o) => o.region === reg && o.releasedDay <= at).at(-1);
      const pm = dayToIso(monthRange(mo)[0] - 1).slice(0, 7);
      return [monthMean(filt[reg].m, mo, at), monthMean(filt[reg].m, pm, at), prev?.value ?? NaN, monthMean(Array.from(panels[reg].energy), mo, at)];
    };
    const train = official.filter((o) => o.releasedDay <= at && o.month >= "2024-11");
    const gbm = fitGbm(train.map((o) => feats(o.region, o.month)), train.map((o) => o.value), { rounds: 150, lr: 0.05, depth: 2, minLeaf: 6 });
    for (const reg of Object.keys(panels)) {
      const actual = official.find((o) => o.region === reg && o.month === month)!;
      const nc = bridgeNowcast(reg, official, filt[reg], at, month);
      const pub = official.filter((o) => o.region === reg && o.releasedDay <= at);
      const last = pub.at(-1)!;
      const arf = ols(pub.slice(0, -1).map((o) => [o.value]), pub.slice(1).map((o) => o.value));
      const ar1 = arf.beta[0] + arf.beta[1] * (arf.beta[0] + arf.beta[1] * last.value);
      const g = gbm.predict(feats(reg, month));
      rows.push({ region: reg, month, actual: actual.value, bridge: nc.value, lo: nc.lo, hi: nc.hi, gbm: g, ensemble: (nc.value + g) / 2, naive: last.value, ar1 });
    }
  }
  return rows;
}

export function cvSummary(rows: CvRow[]) {
  const rmse = (k: keyof CvRow) => Math.sqrt(mean(rows.map((r) => ((r[k] as number) - r.actual) ** 2)));
  return { n: rows.length, rmse: { bridge: rmse("bridge"), gbm: rmse("gbm"), ensemble: rmse("ensemble"), naive: rmse("naive"), ar1: rmse("ar1") }, coverage80: mean(rows.map((r) => (r.actual >= r.lo && r.actual <= r.hi ? 1 : 0))) };
}
