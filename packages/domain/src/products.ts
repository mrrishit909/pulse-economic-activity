// The data bundle (what the generator writes and both the browser and the API load) and the products derived from it.
import { congestionSeries, portCalls, type PortDay } from "./congestion.ts";
import { fitDfm, filterDfm, type CvRow, type DfmParams, type Filtered, type Panel } from "./dfm.ts";
import { mean } from "./math.ts";
import { regionVoyageSeries, trailing, type Voyage } from "./pipeline.ts";
import { COMMODITIES, LANES, PORTS, REGIONS, type Commodity, type Lane, type Official, type Port, type Region } from "./world.ts";

export interface Bundle {
  version: string; seed: number; start: string; days: number; now: number;
  regions: Region[]; ports: Port[]; commodities: Commodity[]; lanes: Lane[];
  vessels: [name: string, commodity: string][];
  voyages: Voyage[];
  activity: { energy: Record<string, (number | null)[]>; transport: Record<string, (number | null)[]> };
  official: Omit<Official, "truthMean">[];
  /** generator truth, shown only as a "truth" layer for judging the models; never an input to them */
  truth: { factor: Record<string, number[]>; shock: { start: number; regions: Record<string, number> }; outage: { port: string; start: number; end: number } };
  results: Record<string, unknown> & { cv: CvRow[] };
}

const num = (x: (number | null)[]) => x.map((v) => (v === null ? NaN : v));

export function panelsFrom(b: Pick<Bundle, "voyages" | "activity" | "days">): Record<string, Panel> {
  const rs = regionVoyageSeries(b.voyages, b.days);
  return Object.fromEntries(REGIONS.map((g) => [g.id, { energy: num(b.activity.energy[g.id]), transport: num(b.activity.transport[g.id]), departuresTo: trailing(rs.depTo[g.id]), arrivalsIn: trailing(rs.arrIn[g.id]), exports: trailing(rs.exp[g.id]) }]));
}

export interface RegionPulse { params: DfmParams; f: Filtered }
export function regionPulses(panels: Record<string, Panel>, fitTo: number, upto: number, drop?: Parameters<typeof filterDfm>[3]): Record<string, RegionPulse> {
  return Object.fromEntries(Object.entries(panels).map(([k, p]) => { const params = fitDfm(p, fitTo); return [k, { params, f: filterDfm(p, params, upto, drop) }]; }));
}

export function portSeriesAll(voyages: Voyage[], days: number): Record<string, PortDay[]> {
  return Object.fromEntries(PORTS.map((p) => [p.id, congestionSeries(portCalls(voyages, p.id), days)]));
}

/** kt departing per day by commodity, and by lane. */
export function commodityDaily(voyages: Voyage[], days: number) {
  const out = Object.fromEntries(COMMODITIES.map((c) => [c.key, new Float64Array(days)])) as Record<string, Float64Array>;
  for (const v of voyages) { const d = Math.floor(v[3]); if (d >= 0 && d < days) out[LANES[v[0]].commodity][d] += v[6]; }
  return out;
}

/**
 * When did each source show the shock? Pulse: first day the upper 80% bound fell more than one factor sd below its own
 * previous-90-day mean, with the model fitted on data from before the shock and filtered day by day (no look-ahead).
 * Official: first published month more than 5 points (one factor sd) below the mean of the three before it.
 */
export function shockLead(panel: Panel, official: Pick<Official, "region" | "month" | "value" | "releasedDay">[], region: string, shockStart: number, horizon = 120) {
  const params = fitDfm(panel, shockStart - 1);
  const f = filterDfm(panel, params, Math.min(shockStart + horizon, panel.energy.length - 1));
  let pulseDay: number | null = null;
  for (let d = shockStart; d < f.m.length; d++) {
    const base = mean(Array.from(f.m.slice(d - 97, d - 7)));
    if (f.m[d] + 1.2816 * Math.sqrt(f.P[d]) < base - 1) { pulseDay = d; break; }
  }
  const pub = official.filter((o) => o.region === region).sort((a, b) => a.month.localeCompare(b.month));
  let officialDay: number | null = null, officialMonth: string | null = null;
  for (let i = 3; i < pub.length; i++) {
    if (pub[i].releasedDay < shockStart) continue;
    if (pub[i].value < mean(pub.slice(i - 3, i).map((o) => o.value)) - 5) { officialDay = pub[i].releasedDay; officialMonth = pub[i].month; break; }
  }
  return { pulseDay, officialDay, officialMonth, leadDays: pulseDay !== null && officialDay !== null ? officialDay - pulseDay : null, fittedTo: shockStart - 1 };
}
