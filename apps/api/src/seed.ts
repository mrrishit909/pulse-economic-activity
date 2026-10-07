// Loads the generated data (data/fixtures, made by data/simulators/generate.ts) into Postgres as the owner: locations, the vessel
// register, the raw feed rows with their resolution, lane-day flows, port congestion, the regional pulse, official figures,
// nowcasts and the bundle itself. Demo tokens are local only and listed in the README.
import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import pg from "pg";
import { COMMODITIES, LANES, SERIES, band80, confidence, dayToIso, laneDaily, panelsFrom, portSeriesAll, regionPulses, uuidFor, type Bundle, type CvRow } from "../../../packages/domain/src/index.ts";
import { sha256 } from "./db.ts";

export const ORGS = [
  { id: uuidFor(9, 1), slug: "meridian", name: "Meridian Macro (demo fund)", plan: "institutional" },
  { id: uuidFor(9, 2), slug: "harbor", name: "Harbor Logistics (demo supply-chain team)", plan: "pro" },
] as const;
export const TOKENS = [
  { token: "meridian-analyst-demo", org: "meridian", role: "operator" },
  { token: "meridian-viewer-demo", org: "meridian", role: "viewer" },
  { token: "harbor-ops-demo", org: "harbor", role: "operator" },
] as const;
export const locId = (code: string) => uuidFor(7, [...code].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 1e9);

async function insertMany(c: pg.Client, table: string, cols: string[], types: string[], rows: unknown[][], chunk = 5000) {
  for (let k = 0; k < rows.length; k += chunk) {
    const part = rows.slice(k, k + chunk);
    const arrays = cols.map((_, j) => part.map((r) => r[j]));
    await c.query(`INSERT INTO ${table} (${cols.join(",")}) SELECT * FROM unnest(${types.map((t, j) => `$${j + 1}::${t}[]`).join(",")})`, arrays);
  }
}

export async function seed(url = process.env.OWNER_DATABASE_URL ?? "postgresql://pulse:owner-dev-only@127.0.0.1:55460/pulse", reset = false, withFeeds = true) {
  const fx = new URL("../../../data/fixtures/", import.meta.url);
  const raw = readFileSync(new URL("bundle.json", fx));
  const b: Bundle = JSON.parse(raw.toString());
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("BEGIN");
  if (reset) await c.query("TRUNCATE alert_deliveries, alert_rules, vessel_events, trade_flows, regional_activity_index, port_activity, official_indicators, nowcasts, artifacts, vessels, locations, api_tokens, idempotency_keys, audit_log, client_telemetry, organizations CASCADE");
  if ((await c.query("SELECT count(*)::int AS n FROM locations")).rows[0].n > 0 && !reset) { await c.query("ROLLBACK"); await c.end(); console.log(JSON.stringify({ msg: "already seeded" })); return; }
  for (const o of ORGS) await c.query("INSERT INTO organizations (id, slug, name, plan) VALUES ($1,$2,$3,$4)", [o.id, o.slug, o.name, o.plan]);
  for (const t of TOKENS) await c.query("INSERT INTO api_tokens (token_sha256, organization_id, role, label) VALUES ($1,$2,$3,$4)", [sha256(t.token), ORGS.find((o) => o.slug === t.org)!.id, t.role, t.token]);
  for (const r of b.regions) await c.query("INSERT INTO locations (id, code, name, location_type, geom) VALUES ($1,$2,$3,'region',ST_MakePoint($4,$5)::geography)", [locId(r.id), r.id, r.name, r.lon, r.lat]);
  for (const p of b.ports) await c.query("INSERT INTO locations (id, code, name, location_type, country_code, region_code, geom) VALUES ($1,$2,$3,'port',$4,$5,ST_MakePoint($6,$7)::geography)", [locId(p.id), p.id, p.name, p.cc, p.region, p.lon, p.lat]);

  // the register: IMO from the generator's feed (the API never sees MMSIs except in raw AIS rows)
  const feeds = withFeeds ? gunzipSync(readFileSync(new URL("feeds.ndjson.gz", fx))).toString().split("\n").map((l) => JSON.parse(l)) : [];
  const imoOf = new Map<number, string>();
  for (const f of feeds) if (f.src === "port" && f.vessel !== null && /^\d{7}$/.test(f.raw.imo) && f.how === "imo") imoOf.set(f.vessel, f.raw.imo);
  const vesselRows = b.vessels.map((v, i) => [uuidFor(8, i), imoOf.get(i) ?? `UNK${i}`, v[0], v[1]]);
  await insertMany(c, "vessels", ["id", "imo", "name", "vessel_class"], ["uuid", "text", "text", "text"], vesselRows);
  const start = Date.parse(b.start);
  const at = (d: number) => new Date(start + d * 86400e3).toISOString();
  if (feeds.length) {
    const ev = feeds.map((f, i) => {
      const portCode: string | null = f.port;
      return [uuidFor(10, i), f.src === "port" ? f.raw.imo || null : f.raw.mmsi, portCode ? locId(portCode) : null, f.raw.event, at(f.raw.t), f.raw.draught,
        JSON.stringify(f.src === "port" ? { src: "port", name: f.raw.name, portAlias: f.raw.port } : { src: "ais", name: f.raw.name, lat: f.raw.lat, lon: f.raw.lon }),
        f.vessel === null ? null : uuidFor(8, f.vessel), f.how];
    });
    await insertMany(c, "vessel_events", ["id", "vessel_id", "port_id", "event_type", "ts", "draught", "metadata", "resolved_vessel", "resolution"], ["uuid", "text", "uuid", "text", "timestamptz", "float8", "jsonb", "uuid", "text"], ev);
  }
  // lane-day flows with a value and a confidence (relative 90% half-width of the summed cargo estimates)
  const ld = laneDaily(b.voyages, b.days), flows: unknown[][] = [];
  for (const l of LANES) for (let d = 0; d < b.days; d++) if (ld.n[l.id][d]) {
    const kt = ld.vol[l.id][d], usd = kt * 1000 * COMMODITIES.find((x) => x.key === l.commodity)!.usdPerT;
    flows.push([uuidFor(11, l.id * 1000 + d), locId(l.from), locId(l.to), COMMODITIES.find((x) => x.key === l.commodity)!.code, dayToIso(d), +kt.toFixed(1), Math.round(usd), +(1.645 * Math.sqrt(ld.vari[l.id][d]) / Math.max(1e-9, kt)).toFixed(4), "ais+port-authority, cargo from draught", ld.n[l.id][d]]);
  }
  await insertMany(c, "trade_flows", ["id", "origin_id", "destination_id", "commodity_code", "ts", "quantity", "value_usd", "confidence", "source", "voyages"], ["uuid", "uuid", "uuid", "text", "date", "numeric", "numeric", "float8", "text", "int"], flows);
  const ports = portSeriesAll(b.voyages, b.days), pa: unknown[][] = [];
  for (const [code, s] of Object.entries(ports)) s.forEach((x, d) => pa.push([locId(code), dayToIso(d), x.calls, Number.isFinite(x.dwellMedian) ? x.dwellMedian : null, Number.isFinite(x.dwellP90) ? x.dwellP90 : null, x.inPort, Number.isFinite(x.z) ? x.z : null, x.confidence]));
  await insertMany(c, "port_activity", ["port_id", "ts", "calls", "dwell_median", "dwell_p90", "in_port", "congestion_z", "confidence"], ["uuid", "date", "int", "float8", "float8", "int", "float8", "text"], pa);
  const pulses = regionPulses(panelsFrom(b), b.now, b.now), rai: unknown[][] = [];
  for (const [reg, { f }] of Object.entries(pulses)) for (let d = 0; d < b.days; d++)
    rai.push([locId(reg), at(d), +(100 + 10 * f.m[d]).toFixed(3), JSON.stringify({ band80: +band80(f.P[d]).toFixed(3), confidence: confidence(f.P[d]), contributions: Object.fromEntries(SERIES.map((s, i) => [s, +(10 * f.contrib[i][d]).toFixed(3)])) }), "dfm-v1"]);
  await insertMany(c, "regional_activity_index", ["region_id", "ts", "score", "components", "model_version"], ["uuid", "timestamptz", "float8", "jsonb", "text"], rai);
  await insertMany(c, "official_indicators", ["region_id", "month", "value", "released_on"], ["uuid", "text", "float8", "date"], b.official.map((o) => [locId(o.region), o.month, o.value, dayToIso(o.releasedDay)]));
  const cv = b.results.cv as CvRow[];
  await insertMany(c, "nowcasts", ["region_id", "month", "made_on", "bridge", "lo", "hi", "gbm", "naive", "actual"], ["uuid", "text", "date", "float8", "float8", "float8", "float8", "float8", "float8"],
    cv.map((r) => { const [y, m] = r.month.split("-").map(Number); const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); return [locId(r.region), r.month, end, r.bridge, r.lo, r.hi, r.gbm, r.naive, r.actual]; }));
  await c.query("INSERT INTO artifacts (name, sha256, body_gz) VALUES ('bundle', $1, $2)", [createHash("sha256").update(raw).digest("hex"), gzipSync(raw)]);
  await c.query("COMMIT");
  await c.end();
  console.log(JSON.stringify({ msg: "seeded", vessels: vesselRows.length, events: feeds.length, flows: flows.length, portDays: pa.length, pulseDays: rai.length }));
}

if (import.meta.url === `file://${process.argv[1]}`) await seed(undefined, process.argv.includes("--reset"));
