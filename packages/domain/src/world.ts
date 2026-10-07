// The synthetic world. Ports sit at real coordinates (public geography); every vessel, voyage, cargo, activity series and official
// indicator is invented by a seeded generator with a hidden true process (regional activity factors, a demand shock, a berth
// outage). The pipeline only ever sees the noisy feeds; the truth is kept to score it.
import { rng, type Rng } from "./rng.ts";
import { distanceNm } from "./geo.ts";

export const START = "2024-10-01"; // day 0
export const DAYS = 730;
export const dayMs = 86400e3;
export const dayToIso = (d: number) => new Date(Date.parse(START) + d * dayMs).toISOString().slice(0, 10);
export const isoToDay = (s: string) => Math.round((Date.parse(s.slice(0, 10)) - Date.parse(START)) / dayMs);

export interface Region { id: string; name: string; lat: number; lon: number }
export interface Port { id: string; name: string; region: string; lat: number; lon: number; cc: string }
export interface Commodity { key: string; code: string; name: string; unit: "kt" | "TEU"; shipKt: number; speedKn: number; serviceDays: number; beta: number; usdPerT: number; draught: [number, number]; colour: string }
export interface Lane { id: number; from: string; to: string; commodity: string; baseKt: number; distanceNm: number; voyageDays: number }

export const REGIONS: Region[] = [
  { id: "east-asia", name: "East Asia", lat: 33, lon: 124 }, { id: "se-asia", name: "Southeast Asia", lat: 3, lon: 104 },
  { id: "south-asia", name: "South Asia", lat: 21, lon: 73 }, { id: "middle-east", name: "Middle East", lat: 26, lon: 51 },
  { id: "europe", name: "Europe", lat: 50, lon: 6 }, { id: "north-america", name: "North America", lat: 36, lon: -98 },
  { id: "latin-america", name: "Latin America", lat: -20, lon: -50 }, { id: "africa", name: "Africa", lat: -10, lon: 22 },
  { id: "oceania", name: "Oceania", lat: -26, lon: 135 },
];

const P = (id: string, name: string, region: string, lat: number, lon: number, cc: string, _b?: number): Port => ({ id, name, region, lat, lon, cc });
export const PORTS: Port[] = [
  P("SARTA", "Ras Tanura", "middle-east", 26.64, 50.16, "SA", 6), P("AEFJR", "Fujairah", "middle-east", 25.17, 56.36, "AE", 4),
  P("IQBSR", "Basra Oil Terminal", "middle-east", 29.68, 48.81, "IQ", 4), P("QARLF", "Ras Laffan", "middle-east", 25.92, 51.59, "QA", 5),
  P("CNNGB", "Ningbo-Zhoushan", "east-asia", 29.94, 121.86, "CN", 9), P("CNTAO", "Qingdao", "east-asia", 36.07, 120.32, "CN", 9),
  P("CNSHA", "Shanghai", "east-asia", 30.63, 122.07, "CN", 8), P("KRPUS", "Busan", "east-asia", 35.08, 128.83, "KR", 6),
  P("KRULS", "Ulsan", "east-asia", 35.5, 129.39, "KR", 3), P("JPCHB", "Chiba", "east-asia", 35.58, 140.08, "JP", 5),
  P("TWKHH", "Kaohsiung", "east-asia", 22.61, 120.28, "TW", 4), P("SGSIN", "Singapore", "se-asia", 1.26, 103.84, "SG", 7),
  P("MYPKG", "Port Klang", "se-asia", 3.0, 101.39, "MY", 3), P("INSIK", "Sikka", "south-asia", 22.43, 69.83, "IN", 5),
  P("INNSA", "Nhava Sheva", "south-asia", 18.95, 72.95, "IN", 3), P("AUPHE", "Port Hedland", "oceania", -20.31, 118.58, "AU", 7),
  P("AUNTL", "Newcastle", "oceania", -32.92, 151.79, "AU", 5), P("AUGLT", "Gladstone", "oceania", -23.84, 151.26, "AU", 4),
  P("NLRTM", "Rotterdam", "europe", 51.95, 4.05, "NL", 9), P("BEANR", "Antwerp", "europe", 51.28, 4.3, "BE", 3),
  P("DEHAM", "Hamburg", "europe", 53.54, 9.97, "DE", 3), P("ESALG", "Algeciras", "europe", 36.13, -5.44, "ES", 3),
  P("USHOU", "Houston", "north-america", 29.73, -95.02, "US", 5), P("USSAB", "Sabine Pass", "north-america", 29.73, -93.87, "US", 4),
  P("USLAX", "Los Angeles", "north-america", 33.74, -118.26, "US", 6), P("USNYC", "New York", "north-america", 40.67, -74.08, "US", 4),
  P("CAVAN", "Vancouver", "north-america", 49.29, -123.11, "CA", 4), P("BRTUB", "Tubarao", "latin-america", -20.29, -40.24, "BR", 4),
  P("BRSSZ", "Santos", "latin-america", -23.98, -46.3, "BR", 4), P("ARROS", "Rosario", "latin-america", -32.95, -60.63, "AR", 3),
  P("MXZLO", "Manzanillo", "latin-america", 19.06, -104.31, "MX", 3), P("NGBON", "Bonny", "africa", 4.42, 7.15, "NG", 3),
  P("ZADUR", "Durban", "africa", -29.87, 31.03, "ZA", 3), P("ZARCB", "Richards Bay", "africa", -28.8, 32.04, "ZA", 3),
];

export const COMMODITIES: Commodity[] = [
  { key: "crude", code: "2709", name: "Crude oil", unit: "kt", shipKt: 270, speedKn: 12.5, serviceDays: 1.4, beta: 0.1, usdPerT: 560, draught: [9, 21], colour: "#ff9f43" },
  { key: "lng", code: "2711", name: "LNG", unit: "kt", shipKt: 72, speedKn: 17, serviceDays: 1.0, beta: 0.1, usdPerT: 550, draught: [9.5, 11.5], colour: "#7fd1ff" },
  { key: "ironore", code: "2601", name: "Iron ore", unit: "kt", shipKt: 175, speedKn: 12, serviceDays: 2.2, beta: 0.14, usdPerT: 105, draught: [8, 18], colour: "#e07a5f" },
  { key: "coal", code: "2701", name: "Coal", unit: "kt", shipKt: 80, speedKn: 12, serviceDays: 2.0, beta: 0.1, usdPerT: 130, draught: [7, 13], colour: "#b0a8b9" },
  { key: "grain", code: "1201", name: "Soybeans and grain", unit: "kt", shipKt: 65, speedKn: 12.5, serviceDays: 2.8, beta: 0.06, usdPerT: 420, draught: [7, 12.5], colour: "#f6d365" },
  { key: "containers", code: "CONT", name: "Containers", unit: "TEU", shipKt: 140, speedKn: 16, serviceDays: 1.1, beta: 0.12, usdPerT: 3000, draught: [11, 14.5], colour: "#5ef2c2" },
];
export const TEU_PER_KT = 1000 / 10.5; // ~10.5 t per loaded TEU

const L = (from: string, to: string, commodity: string, baseKt: number) => ({ from, to, commodity, baseKt });
const LANE_DEFS = [
  L("SARTA", "CNNGB", "crude", 900), L("SARTA", "KRULS", "crude", 450), L("SARTA", "INSIK", "crude", 400), L("SARTA", "NLRTM", "crude", 250),
  L("IQBSR", "INSIK", "crude", 350), L("IQBSR", "CNTAO", "crude", 420), L("AEFJR", "SGSIN", "crude", 300), L("USHOU", "NLRTM", "crude", 380),
  L("USHOU", "CNNGB", "crude", 220), L("NGBON", "NLRTM", "crude", 180), L("NGBON", "INSIK", "crude", 200),
  L("QARLF", "JPCHB", "lng", 120), L("QARLF", "NLRTM", "lng", 70), L("USSAB", "NLRTM", "lng", 110), L("USSAB", "JPCHB", "lng", 60),
  L("AUGLT", "JPCHB", "lng", 90), L("AUGLT", "KRPUS", "lng", 60),
  L("AUPHE", "CNTAO", "ironore", 900), L("AUPHE", "CNNGB", "ironore", 700), L("BRTUB", "CNTAO", "ironore", 450), L("BRTUB", "NLRTM", "ironore", 120),
  L("AUPHE", "KRPUS", "ironore", 200),
  L("AUNTL", "JPCHB", "coal", 260), L("AUNTL", "KRPUS", "coal", 150), L("ZARCB", "INSIK", "coal", 230), L("CAVAN", "KRPUS", "coal", 120), L("AUNTL", "TWKHH", "coal", 120),
  L("BRSSZ", "CNTAO", "grain", 280), L("ARROS", "NLRTM", "grain", 90), L("CAVAN", "JPCHB", "grain", 70),
  L("CNSHA", "USLAX", "containers", 420), L("CNSHA", "NLRTM", "containers", 360), L("KRPUS", "USLAX", "containers", 160), L("SGSIN", "NLRTM", "containers", 220),
  L("CNSHA", "SGSIN", "containers", 200), L("NLRTM", "USNYC", "containers", 140), L("CNSHA", "MXZLO", "containers", 90), L("TWKHH", "USLAX", "containers", 110),
  L("INNSA", "NLRTM", "containers", 100), L("ZADUR", "SGSIN", "containers", 60), L("MYPKG", "DEHAM", "containers", 120), L("CNNGB", "ESALG", "containers", 100),
  L("BEANR", "USNYC", "containers", 80),
];
export const ROUTE_FACTOR = 1.3; // great circles cross land; sea routes are longer (Suez, Malacca, Cape): one factor for all lanes

export const portById = new Map(PORTS.map((p) => [p.id, p]));
export const commodityByKey = new Map(COMMODITIES.map((c) => [c.key, c]));
export const LANES: Lane[] = LANE_DEFS.map((l, id) => {
  const a = portById.get(l.from)!, b = portById.get(l.to)!, c = commodityByKey.get(l.commodity)!;
  const nm = distanceNm(a.lat, a.lon, b.lat, b.lon) * ROUTE_FACTOR;
  return { id, ...l, distanceNm: Math.round(nm), voyageDays: nm / (c.speedKn * 24) };
});

/** The hidden shock: a demand slump in East Asia (Europe follows two weeks later at a third of the size), and a berth outage at Ningbo. */
export const SHOCK = { start: isoToDay("2026-02-16"), ramp: 21, hold: 21, recover: 60, depth: { "east-asia": -2.4, europe: -0.9 } as Record<string, number>, lagDays: { europe: 14 } as Record<string, number> };
export const OUTAGE = { port: "CNNGB", start: isoToDay("2026-02-23"), end: isoToDay("2026-03-23"), share: 0.3 };
/** Berths per terminal side, sized from the lanes that use it for about 65% utilisation at base volume. */
export function berthCount(portId: string, side: "load" | "discharge") {
  let berthDays = 0;
  for (const l of LANES) if ((side === "load" ? l.from : l.to) === portId) { const c = commodityByKey.get(l.commodity)!; berthDays += (l.baseKt * 1.3 / c.shipKt) * c.serviceDays * (side === "load" ? 0.8 : 1); }
  return Math.max(1, Math.ceil(berthDays / 0.65));
}
export const OFFICIAL = { lagDays: 45, scale: 5, noise: 0.5 };

export function shockAt(region: string, d: number) {
  const depth = SHOCK.depth[region];
  if (!depth) return 0;
  const t = d - SHOCK.start - (SHOCK.lagDays[region] ?? 0);
  if (t < 0) return 0;
  const w = t < SHOCK.ramp ? t / SHOCK.ramp : t < SHOCK.ramp + SHOCK.hold ? 1 : Math.max(0, 1 - (t - SHOCK.ramp - SHOCK.hold) / SHOCK.recover);
  return depth * w;
}

export interface Vessel { idx: number; imo: string; mmsi: string; mmsi2: string | null; reflagDay: number | null; name: string; commodity: string }
/** True voyage: origin arrival/departure and destination arrival/departure in fractional days; cargo in kt. */
export interface TrueVoyage { lane: number; vessel: number; oArr: number; oDep: number; dArr: number; dDep: number; cargoKt: number; draughtLoaded: number }
export interface AisRow { mmsi: string; name: string; lat: number; lon: number; t: number; event: "arrival" | "departure"; draught: number | null }
export interface PortRow { imo: string; name: string; port: string; t: number; event: "arrival" | "departure"; draught: number | null; truthVessel: number; truthPort: string }
export interface Official { region: string; month: string; value: number; releasedDay: number; truthMean: number }
export interface World {
  seed: number; start: string; days: number;
  factor: Record<string, number[]>; // TRUE regional activity (hidden from the pipeline)
  vessels: Vessel[]; voyages: TrueVoyage[];
  ais: AisRow[]; portFeed: PortRow[]; declared: { imo: string; port: string; t: number; cargoKt: number }[];
  activity: { energy: Record<string, number[]>; transport: Record<string, number[]> };
  official: Official[];
}

export function imoCheck(six: string) {
  let s = 0;
  for (let i = 0; i < 6; i++) s += +six[i] * (7 - i);
  return String(s % 10);
}

const WORDS1 = ["PACIFIC", "ATLANTIC", "OCEAN", "NORDIC", "GOLDEN", "SILVER", "EASTERN", "CORAL", "ARCTIC", "STAR", "BLUE", "NEW", "GRAND", "SEA", "CAPE", "MARE", "AZURE", "IRON", "DAWN", "TITAN"];
const WORDS2 = ["DAWN", "GRACE", "SPIRIT", "VOYAGER", "PIONEER", "HARMONY", "FORTUNE", "PRIDE", "HORIZON", "LEGEND", "BREEZE", "MERIDIAN", "PEARL", "VENTURE", "GLORY", "PROGRESS", "UNITY", "CROWN", "TRADER", "QUEEN"];

function nameVariant(r: Rng, name: string) {
  const x = r.u();
  let v = x < 0.45 ? name : x < 0.6 ? name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : x < 0.75 ? `M/V ${name}` : x < 0.85 ? `MV ${name}` : x < 0.93 ? name.replace(/ /g, "") : name;
  if (r.u() < 0.03) { const i = r.int(0, v.length - 1); v = v.slice(0, i) + "QXZ"[r.int(0, 2)] + v.slice(i + 1); } // one-letter typo
  return v;
}
export function portAliases(p: Port) {
  return [p.name, p.name.toUpperCase(), p.id, `Port of ${p.name}`, `${p.name} (${p.cc})`, `${p.name} Anchorage`, `${p.cc} ${p.id.slice(2)}`];
}
function portVariant(r: Rng, p: Port) {
  let v = r.pick(portAliases(p));
  if (r.u() < 0.02) { const i = r.int(1, v.length - 1); v = v.slice(0, i) + v.slice(i + 1); } // dropped letter
  return v;
}

export function generateWorld(seed = 20261006): World {
  const r = rng(seed);
  // ---- true activity: a global factor and regional factors, AR(1) daily, plus the shock ----
  const phi = 0.996, sig = Math.sqrt(1 - phi * phi);
  const g: number[] = [r.normal()];
  for (let d = 1; d < DAYS; d++) g.push(phi * g[d - 1] + sig * r.normal());
  const factor: Record<string, number[]> = {};
  for (const reg of REGIONS) {
    let u = r.normal();
    factor[reg.id] = Array.from({ length: DAYS }, (_, d) => { if (d) u = phi * u + sig * r.normal(); return 0.55 * g[d] + 0.835 * u + shockAt(reg.id, d); });
  }

  // ---- voyages: departures follow destination demand; queues at both ends ----
  type Pending = { lane: number; ready: number; cargoKt: number };
  const pending: Pending[] = [];
  for (const lane of LANES) {
    const c = commodityByKey.get(lane.commodity)!, dest = portById.get(lane.to)!;
    for (let d = 0; d < DAYS; d++) {
      const doy = ((d + 274) % 365) / 365; // day 0 is 1 October
      const season = lane.commodity === "lng" ? 1 + 0.18 * Math.cos(2 * Math.PI * (doy - 0.04)) : lane.commodity === "grain" ? (lane.from === "CAVAN" ? 1 + 0.6 * Math.cos(2 * Math.PI * (doy - 0.85)) : 1 + 0.7 * Math.cos(2 * Math.PI * (doy - 0.38))) : 1;
      const demand = lane.baseKt * Math.max(0.05, season) * Math.exp(c.beta * factor[dest.region][d]);
      const n = r.poisson(demand / c.shipKt);
      for (let k = 0; k < n; k++) pending.push({ lane: lane.id, ready: d + r.u(), cargoKt: c.shipKt * r.range(0.85, 1.0) });
    }
  }
  pending.sort((a, b) => a.ready - b.ready);

  // multi-berth FIFO queue per port and terminal side; an outage removes a share of discharge berths for a period
  const berths = new Map<string, number[]>();
  const serve = (port: Port, side: "load" | "discharge", arr: number, service: number) => {
    const key = `${port.id}:${side}`;
    if (!berths.has(key)) berths.set(key, new Array(berthCount(port.id, side)).fill(-Infinity));
    const free = berths.get(key)!;
    const usable = side === "discharge" && port.id === OUTAGE.port ? Math.max(1, Math.ceil(free.length * OUTAGE.share)) : free.length;
    let best = -1, bestStart = Infinity;
    for (let j = 0; j < free.length; j++) {
      let s = Math.max(arr, free[j]);
      if (j >= usable && s >= OUTAGE.start && s < OUTAGE.end) s = OUTAGE.end;
      if (s < bestStart) { bestStart = s; best = j; }
    }
    const end = bestStart + service;
    free[best] = end;
    return end;
  };

  const vessels: Vessel[] = [];
  const usedIds = new Set<string>();
  const freeAt: { idx: number; t: number; at: string }[] = [];
  const voyages: TrueVoyage[] = [];
  const originDone: { p: Pending; oArr: number; oDep: number; v: number }[] = [];
  for (const p of pending) {
    const lane = LANES[p.lane], c = commodityByKey.get(lane.commodity)!, from = portById.get(lane.from)!;
    // vessel: the first of this class that can be here in time (ballast leg at the same speed), else a new one
    let vi = -1;
    for (const f of freeAt) {
      if (vessels[f.idx].commodity !== c.key) continue;
      const at = portById.get(f.at)!;
      if (f.t + distanceNm(at.lat, at.lon, from.lat, from.lon) * ROUTE_FACTOR / (c.speedKn * 24) <= p.ready) { vi = f.idx; break; }
    }
    if (vi < 0) {
      vi = vessels.length;
      let six = String(r.int(100000, 999999));
      while (usedIds.has(six)) six = String(r.int(100000, 999999));
      usedIds.add(six);
      const reflag = r.u() < 0.03;
      vessels.push({ idx: vi, imo: six + imoCheck(six), mmsi: String(r.int(200, 775)) + six, mmsi2: reflag ? String(r.int(200, 775)) + String(999999 - +six).padStart(6, "0") : null,
        reflagDay: reflag ? r.int(120, DAYS - 120) : null, name: `${r.pick(WORDS1)} ${r.pick(WORDS2)}${r.u() < 0.3 ? ` ${r.int(1, 9)}` : ""}`, commodity: c.key });
      freeAt.push({ idx: vi, t: Infinity, at: lane.from });
    }
    const oDep = serve(from, "load", p.ready, r.lognormal(c.serviceDays * 0.8, 0.3));
    const slot = freeAt.find((f) => f.idx === vi)!;
    slot.t = Infinity; // busy until its discharge is known
    originDone.push({ p, oArr: p.ready, oDep, v: vi });
    // provisional availability so the pool stays realistic: voyage + typical discharge
    slot.t = oDep + lane.voyageDays * r.range(0.97, 1.08) + c.serviceDays * 1.5;
    slot.at = lane.to;
  }
  // discharge queues, in order of arrival at destination
  const legs = originDone.map((o) => ({ ...o, dArr: o.oDep + LANES[o.p.lane].voyageDays * r.range(0.97, 1.08) })).sort((a, b) => a.dArr - b.dArr);
  for (const o of legs) {
    const lane = LANES[o.p.lane], c = commodityByKey.get(lane.commodity)!, to = portById.get(lane.to)!;
    const dDep = serve(to, "discharge", o.dArr, r.lognormal(c.serviceDays, 0.35));
    const [ballast, loaded] = c.draught;
    voyages.push({ lane: lane.id, vessel: o.v, oArr: o.oArr, oDep: o.oDep, dArr: o.dArr, dDep, cargoKt: o.p.cargoKt, draughtLoaded: ballast + (loaded - ballast) * (o.p.cargoKt / c.shipKt) + r.normal(0, 0.25) });
  }
  voyages.sort((a, b) => a.oDep - b.oDep);

  // ---- raw feeds: AIS (MMSI, name, position) and port authority (IMO, name, port alias), both noisy ----
  const ais: AisRow[] = [], portFeed: PortRow[] = [], declared: World["declared"] = [];
  const mmsiAt = (v: Vessel, t: number) => (v.mmsi2 && v.reflagDay !== null && t >= v.reflagDay ? v.mmsi2 : v.mmsi);
  for (const [vi, vy] of voyages.entries()) {
    const v = vessels[vy.vessel], lane = LANES[vy.lane];
    for (const [portId, arr, dep, loadedAt] of [[lane.from, vy.oArr, vy.oDep, "dep"], [lane.to, vy.dArr, vy.dDep, "arr"]] as const) {
      const p = portById.get(portId)!;
      for (const [event, t] of [["arrival", arr], ["departure", dep]] as const) {
        const draught = (loadedAt === "dep" && event === "departure") || (loadedAt === "arr" && event === "arrival") ? vy.draughtLoaded : commodityByKey.get(v.commodity)!.draught[0] + r.normal(0, 0.2);
        if (r.u() > 0.02) ais.push({ mmsi: mmsiAt(v, t), name: nameVariant(r, v.name), lat: p.lat + r.normal(0, 0.04), lon: p.lon + r.normal(0, 0.04), t: t + r.normal(0, 0.01), event, draught: r.u() < 0.9 ? +draught.toFixed(1) : null });
        if (r.u() > 0.03) {
          let imo = r.u() < 0.05 ? "" : v.imo;
          if (imo && r.u() < 0.01) imo = imo.slice(0, 3) + String((+imo[3] + 1) % 10) + imo.slice(4); // typo: breaks the check digit
          portFeed.push({ imo, name: nameVariant(r, v.name), port: portVariant(r, p), t: t + Math.abs(r.normal(0, 0.02)), event, draught: +draught.toFixed(1), truthVessel: v.idx, truthPort: p.id });
        }
      }
      if (loadedAt === "arr" && r.u() < 0.25) declared.push({ imo: v.imo, port: p.id, t: vy.dArr, cargoKt: +vy.cargoKt.toFixed(1) });
      void vi;
    }
  }
  ais.sort((a, b) => a.t - b.t);
  portFeed.sort((a, b) => a.t - b.t);

  // ---- non-maritime activity series (power demand, road freight), noisy, with gaps and outliers ----
  const energy: Record<string, number[]> = {}, transport: Record<string, number[]> = {};
  for (const reg of REGIONS) {
    energy[reg.id] = factor[reg.id].map((f, d) => {
      if (r.u() < 0.01) return NaN;
      const wk = [5, 6].includes((d + 1) % 7) ? -0.5 : 0; // 2024-10-01 was a Tuesday
      return f + wk + r.normal(0, 0.6) + (r.u() < 0.003 ? r.pick([-6, 6]) : 0);
    });
    transport[reg.id] = factor[reg.id].map((f, d) => (r.u() < 0.01 ? NaN : f + ([5, 6].includes((d + 1) % 7) ? -1 : 0) + r.normal(0, 0.9)));
  }

  // ---- the lagging official indicator: monthly, published 45 days after the month ends ----
  const official: Official[] = [];
  for (const reg of REGIONS) {
    let m0 = 0;
    while (m0 < DAYS) {
      const iso = dayToIso(m0), y = +iso.slice(0, 4), mo = +iso.slice(5, 7);
      const next = isoToDay(`${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, "0")}-01`);
      if (next > DAYS) break;
      const truthMean = factor[reg.id].slice(m0, next).reduce((a, b) => a + b, 0) / (next - m0);
      official.push({ region: reg.id, month: iso.slice(0, 7), value: +(100 + OFFICIAL.scale * truthMean + r.normal(0, OFFICIAL.noise)).toFixed(2), releasedDay: next - 1 + OFFICIAL.lagDays, truthMean });
      m0 = next;
    }
  }
  return { seed, start: START, days: DAYS, factor, vessels, voyages, ais, portFeed, declared, activity: { energy, transport }, official };
}
