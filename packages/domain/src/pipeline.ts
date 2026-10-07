// Flow engine: resolved feed rows -> port calls -> voyages with an estimated cargo (from draught, calibrated on customs
// declarations) -> lane-day flows and regional activity series. Everything downstream (congestion, the pulse, the nowcast)
// reads these products, never the generator's truth.
import { ols, sd, mean } from "./math.ts";
import { COMMODITIES, LANES, PORTS, commodityByKey, portById, type World } from "./world.ts";
import type { ResolvedRow } from "./resolve.ts";

export interface Call { vessel: number; port: string; arr: number; dep: number; arrDraught: number | null; depDraught: number | null }
/** Compact voyage used by the browser and the API: lane, vessel, four times in days, cargo estimate and its sd (kt). */
export type Voyage = [lane: number, vessel: number, oArr: number, oDep: number, dArr: number, dDep: number, cargoKt: number, cargoSdKt: number];

/** Merge port and AIS rows into calls: per vessel and port, an arrival then the next departure within 40 days. */
export function buildCalls(rows: ResolvedRow[]): Call[] {
  const by = new Map<string, ResolvedRow[]>();
  for (const r of rows) if (r.vessel !== null && r.port) { const k = `${r.vessel}|${r.port}`; const l = by.get(k); if (l) l.push(r); else by.set(k, [r]); }
  const calls: Call[] = [];
  for (const [k, l] of by) {
    l.sort((a, b) => a.t - b.t);
    // cluster rows of the same event within 0.3 days; prefer the port feed's time and draught
    const events: { event: string; t: number; draught: number | null }[] = [];
    for (const r of l) {
      const last = events.at(-1);
      if (last && last.event === r.event && r.t - last.t < 0.3) { if (r.src === "port") { last.t = r.t; last.draught = r.draught ?? last.draught; } else last.draught ??= r.draught; continue; }
      events.push({ event: r.event, t: r.t, draught: r.draught });
    }
    const [v, port] = k.split("|");
    for (let i = 0; i < events.length - 1; i++)
      if (events[i].event === "arrival" && events[i + 1].event === "departure" && events[i + 1].t - events[i].t < 40)
        calls.push({ vessel: +v, port, arr: events[i].t, dep: events[i + 1].t, arrDraught: events[i].draught, depDraught: events[i + 1].draught });
  }
  return calls.sort((a, b) => a.arr - b.arr);
}

const laneKey = new Map(LANES.map((l) => [`${l.from}|${l.to}|${l.commodity}`, l.id]));

/** Cargo ~ draught per commodity, fitted on calls with a customs declaration; residual sd gives the confidence of every estimate. */
export function fitCargoModels(calls: Call[], declared: World["declared"], vesselCommodity: (v: number) => string, imoOf: (v: number) => string) {
  const decl = new Map<string, { t: number; kt: number }[]>();
  for (const d of declared) { const k = `${d.imo}|${d.port}`; decl.set(k, [...(decl.get(k) ?? []), { t: d.t, kt: d.cargoKt }]); }
  const models: Record<string, { a: number; b: number; sd: number; n: number; meanKt: number; sdKt: number }> = {};
  for (const c of COMMODITIES) {
    const X: number[][] = [], y: number[] = [];
    for (const call of calls) {
      if (vesselCommodity(call.vessel) !== c.key || call.arrDraught === null) continue;
      const d = decl.get(`${imoOf(call.vessel)}|${call.port}`)?.find((x) => Math.abs(x.t - call.arr) < 1);
      if (d) { X.push([call.arrDraught]); y.push(d.kt); }
    }
    const f = ols(X, y);
    models[c.key] = { a: f.beta[0], b: f.beta[1], sd: f.residSd, n: f.n, meanKt: mean(y), sdKt: sd(y) };
  }
  return models;
}

/** Pair each loaded departure with the vessel's next call: that is a voyage on a known lane. */
export function buildVoyages(calls: Call[], vesselCommodity: (v: number) => string, models: ReturnType<typeof fitCargoModels>) {
  const byVessel = new Map<number, Call[]>();
  for (const c of calls) { const l = byVessel.get(c.vessel); if (l) l.push(c); else byVessel.set(c.vessel, [c]); }
  const voyages: Voyage[] = [];
  let unknownLane = 0;
  for (const [v, l] of byVessel) {
    const com = commodityByKey.get(vesselCommodity(v))!, mid = (com.draught[0] + com.draught[1]) / 2;
    for (let i = 0; i < l.length - 1; i++) {
      const o = l[i], d = l[i + 1];
      const loaded = (o.depDraught ?? 0) > mid || (d.arrDraught ?? 0) > mid;
      if (!loaded) continue;
      const lane = laneKey.get(`${o.port}|${d.port}|${com.key}`);
      if (lane === undefined) { unknownLane++; continue; }
      const m = models[com.key], dr = d.arrDraught ?? o.depDraught;
      const [kt, kSd] = dr !== null && Number.isFinite(m.b) ? [m.a + m.b * dr, m.sd] : [m.meanKt, m.sdKt];
      voyages.push([lane, v, +o.arr.toFixed(3), +o.dep.toFixed(3), +d.arr.toFixed(3), +d.dep.toFixed(3), +Math.max(0, kt).toFixed(1), +kSd.toFixed(1)]);
    }
  }
  voyages.sort((a, b) => a[3] - b[3]);
  return { voyages, unknownLane };
}

/** Lane volumes by departure day (kt) with variance (kt^2) from the cargo estimates. Aggregates exactly to the voyages. */
export function laneDaily(voyages: Voyage[], days: number) {
  const vol = LANES.map(() => new Float64Array(days)), vari = LANES.map(() => new Float64Array(days)), n = LANES.map(() => new Uint16Array(days));
  for (const v of voyages) { const d = Math.floor(v[3]); if (d >= 0 && d < days) { vol[v[0]][d] += v[6]; vari[v[0]][d] += v[7] ** 2; n[v[0]][d]++; } }
  return { vol, vari, n };
}

/** Per-region daily series derived from voyages: kt departing toward, arriving in, and departing from the region's ports. */
export function regionVoyageSeries(voyages: Voyage[], days: number) {
  const regions = [...new Set(PORTS.map((p) => p.region))];
  const z = () => Object.fromEntries(regions.map((r) => [r, new Float64Array(days)])) as Record<string, Float64Array>;
  const depTo = z(), arrIn = z(), exp = z();
  for (const v of voyages) {
    const lane = LANES[v[0]], from = portById.get(lane.from)!.region, to = portById.get(lane.to)!.region;
    const od = Math.floor(v[3]), ad = Math.floor(v[4]);
    if (od >= 0 && od < days) { depTo[to][od] += v[6]; exp[from][od] += v[6]; }
    if (ad >= 0 && ad < days) arrIn[to][ad] += v[6];
  }
  return { depTo, arrIn, exp };
}

/** Trailing k-day sum (NaN until k days exist). */
export function trailing(x: ArrayLike<number>, k = 7) {
  const out = new Float64Array(x.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < x.length; i++) { s += x[i]; if (i >= k) s -= x[i - k]; if (i >= k - 1) out[i] = s; }
  return out;
}
