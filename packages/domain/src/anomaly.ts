// Trade anomalies against a robust seasonal baseline: weekly lane volumes vs the median of the previous 8 weeks scaled by the
// same week's share of the year where a year of history exists; flagged when the robust z passes the threshold.
import { mad, median } from "./math.ts";

/** Sum a daily series into weeks (week k = days 7k..7k+6). */
export const weekly = (x: ArrayLike<number>) => Array.from({ length: Math.floor(x.length / 7) }, (_, k) => { let s = 0; for (let i = 7 * k; i < 7 * k + 7; i++) s += x[i]; return s; });

/** `unitKt`: cargo per ship; a week of k ships has Poisson noise of about sqrt(k) ships, which floors the scale. */
export function anomalies(weeks: number[], threshold = 3.5, lookback = 8, unitKt = 0) {
  const out: { week: number; value: number; baseline: number; z: number }[] = [];
  for (let k = lookback; k < weeks.length; k++) {
    let hist = weeks.slice(k - lookback, k);
    // a year back exists: rescale the recent history by last year's seasonal ratio (this week vs those weeks)
    if (k >= 52 + lookback) {
      const ly = weeks.slice(k - 52 - lookback, k - 52), ratio = weeks[k - 52] / Math.max(1e-9, median(ly));
      if (Number.isFinite(ratio) && ratio > 0) hist = hist.map((h) => h * ratio);
    }
    const b = median(hist), s = Math.max(mad(hist), Math.sqrt(Math.max(0, b) * unitKt), 0.1 * Math.abs(b), 1e-9);
    const z = (weeks[k] - b) / s;
    if (Math.abs(z) >= threshold) out.push({ week: k, value: weeks[k], baseline: b, z });
  }
  return out;
}
