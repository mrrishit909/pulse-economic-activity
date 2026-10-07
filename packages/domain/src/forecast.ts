// Commodity flow forecast: next 14 days of departures as the trailing 28-day daily mean, with an interval taken from the
// empirical errors of the same rule in a rolling backtest (so the interval width is measured, not assumed).
import { quantile } from "./math.ts";

export function flowForecast(daily: ArrayLike<number>, at: number, horizon = 14, window = 28, backtestFrom = 120) {
  const rule = (t: number) => { let s = 0; for (let i = t - window; i < t; i++) s += daily[i]; return s / window; };
  const errs: number[] = [];
  for (let t = Math.max(window, backtestFrom); t + horizon <= at; t += 7) {
    let actual = 0;
    for (let i = t; i < t + horizon; i++) actual += daily[i];
    errs.push(actual / horizon / rule(t) - 1);
  }
  const level = rule(at);
  const lo = quantile(errs, 0.1), hi = quantile(errs, 0.9);
  return { meanPerDay: level, p10: level * (1 + lo), p90: level * (1 + hi), backtests: errs.length };
}

/** Share of backtest windows whose actual mean fell inside the 80% interval built from the windows before it. */
export function forecastCoverage(daily: ArrayLike<number>, from: number, to: number, horizon = 14) {
  let inside = 0, n = 0;
  for (let t = from; t + horizon <= to; t += horizon) {
    const f = flowForecast(daily, t, horizon);
    if (!Number.isFinite(f.p10)) continue;
    let actual = 0;
    for (let i = t; i < t + horizon; i++) actual += daily[i];
    actual /= horizon;
    n++;
    if (actual >= f.p10 && actual <= f.p90) inside++;
  }
  return { coverage: n ? inside / n : NaN, windows: n };
}
