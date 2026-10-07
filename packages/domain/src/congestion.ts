// Port congestion from dwell-time distributions: each day, the median dwell of calls that arrived in the last 7 days, compared
// with the same statistic over the 90 days before that (robust z on median/MAD). Confidence comes from how many calls back it.
import { mad, median, quantile } from "./math.ts";
import { LANES, type Port } from "./world.ts";
import type { Voyage } from "./pipeline.ts";

export interface PortDay { calls: number; dwellMedian: number; dwellP90: number; inPort: number; z: number; confidence: "high" | "medium" | "low" }

/** Discharge and loading calls at a port as [arrival, departure] pairs in days. */
export function portCalls(voyages: Voyage[], port: string) {
  const out: [number, number][] = [];
  for (const v of voyages) {
    const l = LANES[v[0]];
    if (l.from === port) out.push([v[2], v[3]]);
    if (l.to === port) out.push([v[4], v[5]]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

export function congestionSeries(calls: [number, number][], days: number, window = 7, baseline = 90): PortDay[] {
  const byDay: number[][] = Array.from({ length: days }, () => []);
  for (const [a, d] of calls) { const k = Math.floor(a); if (k >= 0 && k < days) byDay[k].push(d - a); }
  const med: number[] = [];
  const out: PortDay[] = [];
  let inPort = 0;
  const arrivals = new Int32Array(days + 1), departures = new Int32Array(days + 1);
  for (const [a, d] of calls) { if (a < days) arrivals[Math.max(0, Math.floor(a))]++; if (d < days) departures[Math.max(0, Math.floor(d))]++; }
  for (let t = 0; t < days; t++) {
    inPort += arrivals[t] - departures[t];
    const w = byDay.slice(Math.max(0, t - window + 1), t + 1).flat();
    const m = w.length ? median(w) : NaN;
    med.push(m);
    const base = med.slice(Math.max(0, t - window - baseline), Math.max(0, t - window)).filter(Number.isFinite);
    const s = base.length >= 30 ? Math.max(mad(base), 0.05) : NaN;
    const z = Number.isFinite(s) && Number.isFinite(m) ? (m - median(base)) / s : NaN;
    out.push({ calls: w.length, dwellMedian: m, dwellP90: w.length ? quantile(w, 0.9) : NaN, inPort, z, confidence: w.length >= 20 ? "high" : w.length >= 8 ? "medium" : "low" });
  }
  return out;
}

/** Dwell histogram (0.5-day bins up to 15 days) for calls arriving in [from, to). */
export function dwellHistogram(calls: [number, number][], from: number, to: number, bins = 30, width = 0.5) {
  const h = new Array(bins).fill(0);
  for (const [a, d] of calls) if (a >= from && a < to) h[Math.min(bins - 1, Math.floor((d - a) / width))]++;
  return h;
}

export type PortSummary = Port & { series: PortDay[] };
