// API contract, tiers, authorization matrix, tenant isolation, idempotency, ingestion with entity resolution, rate limits and failure
// injection, against a real Postgres/PostGIS. Every JSON body is validated against the OpenAPI document the server publishes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import pg from "pg";
import { readFileSync } from "node:fs";
import { LANES, laneDaily, type Bundle } from "../../../packages/domain/src/index.ts";
import { migrate } from "../src/migrate.ts";
import { seed } from "../src/seed.ts";
import { build } from "../src/server.ts";
import { pool } from "../src/db.ts";

type App = Awaited<ReturnType<typeof build>>;
let app: App;
let spec: { paths: Record<string, Record<string, { responses: Record<string, { content?: { "application/json"?: { schema: object } } }> }>> };
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addFormat("date-time", (s: string) => !Number.isNaN(Date.parse(s)));
const OP = { authorization: "Bearer meridian-analyst-demo" }, VIEW = { authorization: "Bearer meridian-viewer-demo" }, OTHER = { authorization: "Bearer harbor-ops-demo" };
const bundle: Bundle = JSON.parse(readFileSync(new URL("../../../data/fixtures/bundle.json", import.meta.url), "utf8"));

async function call(method: "GET" | "POST", url: string, headers: Record<string, string> = {}, body?: unknown, route?: string) {
  const r = await app.inject({ method, url, headers: body ? { "content-type": "application/json", ...headers } : headers, payload: body ? JSON.stringify(body) : undefined });
  const schema = spec.paths[route ?? url.split("?")[0]]?.[method.toLowerCase()]?.responses?.[String(r.statusCode)]?.content?.["application/json"]?.schema;
  if (schema && String(r.headers["content-type"] ?? "").includes("json") && !ajv.validate(schema, r.json())) throw new Error(`${method} ${url} ${r.statusCode} does not match its OpenAPI schema: ${ajv.errorsText()}`);
  return r;
}

beforeAll(async () => {
  await migrate();
  await seed(undefined, true);
  app = await build({ logger: false, rateLimit: 60, mail: null });
  await app.ready();
  spec = app.swagger() as unknown as typeof spec;
}, 240_000);
afterAll(async () => { await app.close(); await pool.end(); });

describe("contract", () => {
  it("is OpenAPI 3.1 and covers blueprint section 6", () => {
    const s = app.swagger() as { openapi: string; paths: Record<string, unknown> };
    expect(s.openapi).toBe("3.1.0");
    for (const p of ["/v1/flows", "/v1/ports/{id}/activity", "/v1/regions/{id}/pulse", "/v1/commodities/{code}", "/v1/playback", "/v1/nowcasts", "/v1/alerts"]) expect(Object.keys(s.paths)).toContain(p);
  });
});

describe("flows and tiers", () => {
  it("pages lane-day flows that add up to the pipeline's own aggregates", async () => {
    const a = await call("GET", "/v1/flows?commodity=crude&from=2026-03-01&to=2026-03-01&limit=5", OP);
    const b = await call("GET", `/v1/flows?commodity=crude&from=2026-03-01&to=2026-03-01&limit=5&cursor=${a.json().nextCursor}`, OP);
    const ids = new Set([...a.json().items, ...b.json().items].map((f: { laneId: number }) => `${f.laneId}`));
    expect(ids.size).toBe(a.json().items.length + b.json().items.length);
    const all = (await call("GET", "/v1/flows?date=2026-03-01&limit=2000", OP)).json().items as { laneId: number; kt: number }[];
    const ld = laneDaily(bundle.voyages, bundle.days), day = 516;
    for (const f of all) expect(f.kt).toBeCloseTo(ld.vol[f.laneId][day], 1);
    expect(all.length).toBe(LANES.filter((l) => ld.n[l.id][day] > 0).length);
    expect((await call("GET", "/v1/flows?commodity=unobtanium")).statusCode).toBe(400);
  });
  it("anonymous callers get the free tier: 30 days delayed", async () => {
    const anon = await call("GET", "/v1/flows?from=2026-09-20&to=2026-09-30&limit=10");
    expect(anon.json().items).toHaveLength(0);
    expect(anon.json().delayedTo).toBe("2026-08-31");
    expect((await call("GET", "/v1/flows?from=2026-09-20&to=2026-09-30&limit=10", VIEW)).json().items.length).toBeGreaterThan(0);
    const days = (await call("GET", "/v1/ports/CNNGB/activity?from=2026-08-01", {}, undefined, "/v1/ports/{id}/activity")).json().days;
    expect(days.at(-1).date).toBe("2026-08-31");
  });
});

describe("ports, regions, commodities, playback, nowcasts", () => {
  it("finds ports near a point with PostGIS and shows the Ningbo congestion", async () => {
    const near = (await call("GET", "/v1/ports?near=31,122&km=300")).json().items;
    expect(near[0].id).toBe("CNSHA");
    expect(near.map((p: { id: string }) => p.id)).toContain("CNNGB");
    const ng = (await call("GET", "/v1/ports/CNNGB/activity?from=2026-02-20&to=2026-03-31", OP, undefined, "/v1/ports/{id}/activity")).json().days;
    expect(Math.max(...ng.map((d: { congestionZ: number | null }) => d.congestionZ ?? 0))).toBeGreaterThan(10);
    expect((await call("GET", "/v1/ports/XXXXX/activity", OP, undefined, "/v1/ports/{id}/activity")).statusCode).toBe(404);
  });
  it("returns the pulse with contributions that add up (explainability through the API)", async () => {
    const d = (await call("GET", "/v1/regions/east-asia/pulse?from=2026-03-10&to=2026-03-10", OP, undefined, "/v1/regions/{id}/pulse")).json().days[0];
    const sum = Object.values(d.components as Record<string, number>).reduce((s, x) => s + x, 0);
    expect(100 + sum).toBeCloseTo(d.index, 1);
    expect(d.hi).toBeGreaterThan(d.index);
    expect((await call("GET", "/v1/regions/CNNGB/pulse", OP, undefined, "/v1/regions/{id}/pulse")).statusCode).toBe(404);
  });
  it("commodity routes, playback frames and nowcasts", async () => {
    const c = (await call("GET", "/v1/commodities/crude", OP, undefined, "/v1/commodities/{code}")).json();
    expect(c.routes.reduce((s: number, r: { share: number }) => s + r.share, 0)).toBeCloseTo(1, 6);
    expect(c.forecast14d.p90).toBeGreaterThan(c.forecast14d.p10);
    expect((await call("GET", "/v1/commodities/gold", OP, undefined, "/v1/commodities/{code}")).statusCode).toBe(404);
    const p = (await call("POST", "/v1/playback", OP, { from: "2026-02-01", to: "2026-03-29", stepDays: 7, commodity: "crude" })).json();
    expect(p.frames).toHaveLength(9);
    expect(p.frames[0].lanes.every((l: { commodity_code: string }) => l.commodity_code === "2709")).toBe(true);
    expect((await call("POST", "/v1/playback", OP, { from: "2024-10-01", to: "2026-09-30", stepDays: 1 })).statusCode).toBe(400);
    const n = (await call("GET", "/v1/nowcasts?region=east-asia&month=2026-03", OP)).json().items[0];
    expect(n.official).toBeCloseTo(bundle.official.find((o) => o.region === "east-asia" && o.month === "2026-03")!.value, 6);
    const anon = (await call("GET", "/v1/nowcasts?region=east-asia")).json().items;
    expect(anon.every((x: { madeOn: string }) => x.madeOn <= "2026-08-31")).toBe(true);
    expect(anon.find((x: { month: string }) => x.month === "2026-07").official).toBeNull(); // published 14 Sep, after the free tier's cut
  });
});

describe("alerts: authorization, idempotency, tenant isolation, audit", () => {
  const rule = { name: "Ningbo congestion", port: "CNNGB", minZ: 4, minConfidence: "medium", channel: "email", target: "desk@meridian.example" };
  it("needs an operator token and an Idempotency-Key; replays and conflicts", async () => {
    expect((await call("POST", "/v1/alerts", { "idempotency-key": "anon-key-001" }, rule)).statusCode).toBe(401);
    expect((await call("POST", "/v1/alerts", { ...VIEW, "idempotency-key": "view-key-001" }, rule)).statusCode).toBe(403);
    expect((await call("POST", "/v1/alerts", OP, rule)).statusCode).toBe(400);
    const a = await call("POST", "/v1/alerts", { ...OP, "idempotency-key": "alert-key-0001" }, rule);
    expect(a.statusCode).toBe(201);
    expect(a.json().rule.port).toBe("CNNGB");
    expect(a.json().deliveries.length).toBeGreaterThanOrEqual(1);
    expect(a.json().deliveries[0].text).toContain("Ningbo-Zhoushan");
    const b = await call("POST", "/v1/alerts", { ...OP, "idempotency-key": "alert-key-0001" }, rule);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(b.json().rule.id).toBe(a.json().rule.id);
    expect((await call("POST", "/v1/alerts", { ...OP, "idempotency-key": "alert-key-0001" }, { ...rule, minZ: 6 })).statusCode).toBe(409);
    expect((await call("POST", "/v1/alerts", { ...OP, "idempotency-key": "alert-key-0002" }, { ...rule, port: "ZZZZZ" })).json().error.code).toBe("invalid_rule");
    expect((await call("GET", "/v1/alerts", OP)).json().items).toHaveLength(1);
    expect((await call("GET", "/v1/alerts", OTHER)).json().items).toHaveLength(0);
  });
  it("row-level security blocks reads without a tenant and cross-tenant writes", async () => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://pulse_app:app-dev-only@127.0.0.1:55460/pulse" });
    await c.connect();
    expect((await c.query("SELECT count(*)::int n FROM alert_rules")).rows[0].n).toBe(0);
    const harbor = (await c.query("SELECT id FROM organizations WHERE slug = 'harbor'")).rows[0].id;
    await c.query("BEGIN"); await c.query("SELECT set_config('app.tenant', $1, true)", [harbor]);
    expect((await c.query("SELECT count(*)::int n FROM alert_rules")).rows[0].n).toBe(0);
    await expect(c.query("INSERT INTO alert_rules (id, tenant_id, rule) SELECT gen_random_uuid(), id, '{}' FROM organizations WHERE slug = 'meridian'")).rejects.toThrow(/row-level security/);
    await c.query("ROLLBACK"); await c.end();
  });
  it("ingests private vessel events with resolution; only their tenant sees them", async () => {
    const imo = (await pool.query("SELECT imo FROM vessels WHERE imo NOT LIKE 'UNK%' LIMIT 1")).rows[0].imo;
    const events = [
      { imo, name: "whatever", port: "Port of Rotterdam", event: "arrival", t: "2026-09-01T10:00:00Z", draught: 18.2 },
      { mmsi: "538001234", name: "SOME SHIP", lat: 1.27, lon: 103.85, event: "departure", t: "2026-09-02T10:00:00Z" },
      { imo: "1234567", name: "BAD CHECK DIGIT", port: "NLRTM", event: "arrival", t: "2026-09-03T10:00:00Z" },
    ];
    const r = await call("POST", "/v1/ingest/vessel-events", { ...OTHER, "idempotency-key": "ingest-key-0001" }, { events });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ accepted: 3, resolvedVessel: 1, resolvedPort: 3 });
    expect((await call("GET", "/v1/vessel-events?source=own", OTHER)).json().items).toHaveLength(3);
    expect((await call("GET", "/v1/vessel-events?source=own", OP)).json().items).toHaveLength(0);
    expect((await call("GET", "/v1/vessel-events?source=own")).json().items).toHaveLength(0);
    expect((await call("GET", "/v1/vessel-events?port=CNNGB&limit=5", OP)).json().items).toHaveLength(5);
    expect((await call("POST", "/v1/ingest/vessel-events", { ...VIEW, "idempotency-key": "ingest-key-0002" }, { events })).statusCode).toBe(403);
  });
  it("keeps a valid hash-chained audit log per tenant", async () => {
    const a = (await call("GET", "/v1/audit", OP)).json();
    expect(a.items.map((x: { action: string }) => x.action)).toEqual(["alert.create"]);
    expect(a.chainValid).toBe(true);
    const h = (await call("GET", "/v1/audit", OTHER)).json();
    expect(h.items.map((x: { action: string }) => x.action)).toEqual(["ingest.vessel_events"]);
  });
});

describe("operations", () => {
  it("simulated outage, trace context, metrics, rate limit", async () => {
    const o = await call("GET", "/v1/bundle?simulate=outage");
    expect(o.statusCode).toBe(503);
    expect(o.json().error.traceId).toMatch(/^[0-9a-f]{32}$/);
    const ok = await app.inject({ method: "GET", url: "/v1/bundle" });
    expect(ok.headers["content-encoding"]).toBe("gzip");
    const tp = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
    expect(String((await app.inject({ method: "GET", url: "/v1/ports", headers: { traceparent: tp } })).headers.traceparent)).toContain("0123456789abcdef0123456789abcdef");
    expect((await app.inject({ method: "GET", url: "/metrics" })).body).toMatch(/pulse_request_latency_ms\{route="GET \/v1\/flows",quantile="0.95"\}/);
    let last = 200;
    for (let i = 0; i < 80 && last !== 429; i++) last = (await app.inject({ method: "GET", url: "/v1/ports", headers: VIEW })).statusCode;
    expect(last).toBe(429);
  });
});
