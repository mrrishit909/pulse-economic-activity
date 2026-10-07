// PULSE API: one Fastify process standing in for the blueprint's ingestion-hub, entity-resolution, flow-engine, port-analytics,
// nowcast, commodity, event, timeseries and alerting services (README "Not built" says why it is one process).
// Anonymous callers get the Free tier: data delayed by 30 days. A token unlocks the latest data; tenants see only their own
// alerts and private uploads (row-level security).
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import swagger from "@fastify/swagger";
import { randomBytes, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import nodemailer from "nodemailer";
import { COMMODITIES, LANES, PORTS, dayToIso, firings, flowForecast, geofence, isoToDay, notificationText, resolvePort, validImo, validateRule, type AlertRule, type PortDay } from "../../../packages/domain/src/index.ts";
import { audit, canonical, pool, sha256, withTenant } from "./db.ts";

interface Auth { org: string; slug: string; role: "viewer" | "operator" | "admin"; label: string }
declare module "fastify" { interface FastifyRequest { auth?: Auth; traceId: string; t0: bigint } }

class ApiError extends Error {
  status: number; code: string; details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) { super(message); this.status = status; this.code = code; this.details = details; }
}

const Err = { type: "object", required: ["error"], properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, traceId: { type: "string" }, details: {} } } } };
const Obj = { type: "object", additionalProperties: true };
const date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const Flow = { type: "object", required: ["laneId", "from", "to", "commodity", "date", "kt"], properties: { laneId: { type: "integer" }, from: { type: "string" }, to: { type: "string" }, commodity: { type: "string" }, date, kt: { type: "number" }, valueUsd: { type: "number" }, confidence: { type: "number" }, voyages: { type: "integer" } } };
const PortDayS = { type: "object", properties: { date, calls: { type: "integer" }, dwellMedianDays: { type: ["number", "null"] }, dwellP90Days: { type: ["number", "null"] }, inPort: { type: "integer" }, congestionZ: { type: ["number", "null"] }, confidence: { type: "string" } } };
const PulseDayS = { type: "object", properties: { date, index: { type: "number" }, lo: { type: "number" }, hi: { type: "number" }, confidence: { type: "string" }, components: { type: "object", additionalProperties: { type: "number" } } } };
const Rule = { type: "object", required: ["name", "port", "minZ", "minConfidence", "channel", "target"], properties: { name: { type: "string", maxLength: 80 }, port: { type: "string" }, minZ: { type: "number" }, minConfidence: { type: "string" }, channel: { type: "string" }, target: { type: "string" } } };
const idem = { type: "object", required: ["idempotency-key"], properties: { "idempotency-key": { type: "string", minLength: 8, maxLength: 128 } } };
const sec = [{ bearer: [] }];
const DELAY_DAYS = 30;

function limiter(capacity: number, perSec: number) {
  const b = new Map<string, { tokens: number; at: number }>();
  return (key: string) => {
    const now = Date.now(), s = b.get(key) ?? { tokens: capacity, at: now };
    s.tokens = Math.min(capacity, s.tokens + ((now - s.at) / 1000) * perSec); s.at = now;
    const ok = s.tokens >= 1;
    if (ok) s.tokens -= 1;
    b.set(key, s);
    return { ok, remaining: Math.floor(s.tokens), resetS: Math.ceil((capacity - s.tokens) / perSec) };
  };
}

export async function build(opts: { rateLimit?: number; mail?: { host: string; port: number } | null; logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? true, genReqId: () => randomBytes(8).toString("hex"), bodyLimit: 4 * 1024 * 1024 });
  const art = (await pool.query("SELECT body_gz FROM artifacts WHERE name = 'bundle'")).rows[0];
  if (!art) throw new Error("no bundle in the database: run the seed");
  const bundleGz: Buffer = art.body_gz;
  const meta = JSON.parse(gunzipSync(bundleGz).toString()) as { now: number; days: number; start: string };
  const latest = dayToIso(meta.now);
  const loc = new Map<string, string>((await pool.query("SELECT code, id::text FROM locations")).rows.map((r) => [r.code, r.id]));
  const limit = limiter(opts.rateLimit ?? 120, (opts.rateLimit ?? 120) / 60);
  const mailer = opts.mail === null ? null : nodemailer.createTransport({ host: opts.mail?.host ?? process.env.MAIL_HOST ?? "127.0.0.1", port: opts.mail?.port ?? Number(process.env.MAIL_PORT ?? 1025), secure: false });
  const metrics = new Map<string, { n: number; errors: number; lat: number[] }>();

  await app.register(swagger, {
    openapi: { openapi: "3.1.0", info: { title: "PULSE API", version: "1.0.0", description: "Synthetic trade flows, port congestion and regional activity nowcasts. Anonymous calls see data delayed by 30 days; a bearer token sees the latest. Mutations need an Idempotency-Key. Errors are {error:{code,message,traceId}}. Lists page with ?limit and ?cursor (nextCursor)." },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } }, servers: [{ url: "http://localhost:8460" }] },
  });

  app.addHook("onRequest", async (req, reply) => {
    req.t0 = process.hrtime.bigint();
    const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/.exec(String(req.headers.traceparent ?? ""));
    req.traceId = m ? m[1] : randomBytes(16).toString("hex");
    reply.header("traceparent", `00-${req.traceId}-${randomBytes(8).toString("hex")}-01`).header("x-content-type-options", "nosniff").header("referrer-policy", "no-referrer").header("cache-control", "no-store");
    const origin = String(req.headers.origin ?? ""), allowed = (process.env.CORS_ORIGINS ?? "http://localhost:8461,http://127.0.0.1:8461,http://localhost:3000").split(",");
    if (allowed.includes(origin)) reply.header("access-control-allow-origin", origin).header("vary", "origin").header("access-control-allow-headers", "authorization,content-type,idempotency-key,traceparent").header("access-control-allow-methods", "GET,POST,OPTIONS").header("access-control-expose-headers", "traceparent,ratelimit-limit,ratelimit-remaining,ratelimit-reset");
    if (req.method === "OPTIONS") return reply.code(204).send();
    const h = String(req.headers.authorization ?? "");
    if (h.startsWith("Bearer ")) {
      const r = await pool.query("SELECT t.role, t.label, o.id, o.slug FROM api_tokens t JOIN organizations o ON o.id = t.organization_id WHERE t.token_sha256 = $1", [sha256(h.slice(7))]);
      if (!r.rows[0]) throw new ApiError(401, "unauthenticated", "unknown token");
      req.auth = { org: r.rows[0].id, slug: r.rows[0].slug, role: r.rows[0].role, label: r.rows[0].label };
    }
    const rl = limit(req.auth?.label ?? req.ip);
    reply.header("ratelimit-limit", opts.rateLimit ?? 120).header("ratelimit-remaining", rl.remaining).header("ratelimit-reset", rl.resetS);
    if (!rl.ok) { reply.header("retry-after", rl.resetS); throw new ApiError(429, "rate_limited", "too many requests"); }
  });
  app.addHook("onResponse", async (req, reply) => {
    const route = `${req.method} ${req.routeOptions.url ?? "unmatched"}`, m = metrics.get(route) ?? { n: 0, errors: 0, lat: [] };
    m.n++; if (reply.statusCode >= 500) m.errors++;
    m.lat.push(Number(process.hrtime.bigint() - req.t0) / 1e6); if (m.lat.length > 2000) m.lat.shift();
    metrics.set(route, m);
    req.log.info({ traceId: req.traceId, route, status: reply.statusCode, tenant: req.auth?.slug }, "request");
  });
  app.setErrorHandler((e: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (e instanceof ApiError) return reply.code(e.status).send({ error: { code: e.code, message: e.message, traceId: req.traceId, details: e.details } });
    if (e.validation) return reply.code(400).send({ error: { code: "invalid_request", message: e.message, traceId: req.traceId } });
    req.log.error({ err: e, traceId: req.traceId }, "unhandled");
    return reply.code(e.statusCode && e.statusCode < 500 ? e.statusCode : 500).send({ error: { code: "internal", message: e.statusCode && e.statusCode < 500 ? e.message : "internal error", traceId: req.traceId } });
  });

  const need = (req: FastifyRequest, role?: "operator"): Auth => {
    if (!req.auth) throw new ApiError(401, "unauthenticated", "Bearer token required");
    if (role && req.auth.role === "viewer") throw new ApiError(403, "forbidden", "viewer tokens cannot change anything");
    return req.auth;
  };
  /** Latest date a caller may see: anonymous = the free, 30-day delayed tier. */
  const maxDate = (req: FastifyRequest) => (req.auth ? latest : dayToIso(meta.now - DELAY_DAYS));
  const clampTo = (req: FastifyRequest, to?: string) => (!to || to > maxDate(req) ? maxDate(req) : to);
  async function idempotent(req: FastifyRequest, reply: FastifyReply, run: () => Promise<{ status: number; body: unknown }>) {
    const a = need(req, "operator"), key = String(req.headers["idempotency-key"]), hash = sha256(JSON.stringify(req.body ?? null));
    const prior = await withTenant(a.org, (c) => c.query("SELECT request_sha256, status, response FROM idempotency_keys WHERE key = $1", [key]));
    if (prior.rows[0]) {
      if (prior.rows[0].request_sha256 !== hash) throw new ApiError(409, "idempotency_conflict", "this Idempotency-Key was used with a different request");
      return reply.code(prior.rows[0].status).header("idempotent-replayed", "true").send(prior.rows[0].response);
    }
    const out = await run();
    await withTenant(a.org, (c) => c.query("INSERT INTO idempotency_keys (tenant_id, key, method, path, request_sha256, status, response) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", [a.org, key, req.method, req.url, hash, out.status, out.body]));
    return reply.code(out.status).send(out.body);
  }
  const port = (code: string) => { const p = PORTS.find((x) => x.id === code); if (!p) throw new ApiError(404, "not_found", `no port ${code}`); return p; };
  const cursorOf = (s?: string) => (s ? JSON.parse(Buffer.from(s, "base64url").toString()) : null);
  const mkCursor = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url");

  app.get("/healthz", { schema: { hide: true } }, async () => { await pool.query("SELECT 1"); return { ok: true, latest }; });
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  app.get("/metrics", { schema: { hide: true } }, async (_, reply) => {
    const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
    const lines = ["# TYPE pulse_requests_total counter", "# TYPE pulse_request_latency_ms summary"];
    for (const [r, m] of metrics) { const l = `route="${r}"`; lines.push(`pulse_requests_total{${l}} ${m.n}`, `pulse_request_errors_total{${l}} ${m.errors}`); for (const p of [0.5, 0.95, 0.99]) lines.push(`pulse_request_latency_ms{${l},quantile="${p}"} ${q(m.lat, p).toFixed(2)}`); }
    lines.push(`pulse_db_pool_total ${pool.totalCount}`, `pulse_db_pool_waiting ${pool.waitingCount}`);
    return reply.type("text/plain; version=0.0.4").send(lines.join("\n") + "\n");
  });

  app.get("/v1/bundle", { schema: { tags: ["data"], summary: "The whole synthetic bundle the web app loads (gzip)", querystring: { type: "object", properties: { simulate: { type: "string", enum: ["outage"] } } } } }, async (req, reply) => {
    if ((req.query as { simulate?: string }).simulate === "outage" || process.env.FAIL_FEED === "1") throw new ApiError(503, "data_unavailable", "data service unavailable (simulated outage)");
    return reply.header("content-encoding", "gzip").type("application/json").send(bundleGz);
  });

  app.get("/v1/flows", { schema: { tags: ["flows"], summary: "Lane-day cargo flows (kt) with value and confidence", querystring: { type: "object", properties: { commodity: { type: "string" }, from: date, to: date, date, limit: { type: "integer", minimum: 1, maximum: 2000, default: 500 }, cursor: { type: "string" } } }, response: { 200: { type: "object", required: ["items"], properties: { items: { type: "array", items: Flow }, nextCursor: { type: ["string", "null"] }, delayedTo: { type: ["string", "null"] } } }, 400: Err } } }, async (req) => {
    const q = req.query as { commodity?: string; from?: string; to?: string; date?: string; limit: number; cursor?: string };
    const code = q.commodity ? COMMODITIES.find((c) => c.key === q.commodity || c.code === q.commodity)?.code : undefined;
    if (q.commodity && !code) throw new ApiError(400, "invalid_request", `unknown commodity ${q.commodity}`);
    const from = q.date ?? q.from ?? "1900-01-01", to = clampTo(req, q.date ?? q.to), cur = cursorOf(q.cursor) as [string, string] | null;
    const r = await pool.query(`SELECT f.id::text, f.ts::text AS ts, o.code AS "from", d.code AS "to", f.commodity_code, f.quantity::float8 AS kt, f.value_usd::float8 AS usd, f.confidence, f.voyages
      FROM trade_flows f JOIN locations o ON o.id = f.origin_id JOIN locations d ON d.id = f.destination_id
      WHERE f.ts BETWEEN $1 AND $2 AND ($3::text IS NULL OR f.commodity_code = $3) AND ($4::date IS NULL OR (f.ts, f.id::text) > ($4::date, $5::text))
      ORDER BY f.ts, f.id LIMIT $6`, [from, to, code ?? null, cur?.[0] ?? null, cur?.[1] ?? "", q.limit + 1]);
    const rows = r.rows.slice(0, q.limit);
    const laneOf = (a: string, b: string, cc: string) => LANES.find((l) => l.from === a && l.to === b && COMMODITIES.find((c) => c.key === l.commodity)!.code === cc)!.id;
    return { items: rows.map((x) => ({ laneId: laneOf(x.from, x.to, x.commodity_code), from: x.from, to: x.to, commodity: COMMODITIES.find((c) => c.code === x.commodity_code)!.key, date: x.ts, kt: x.kt, valueUsd: x.usd, confidence: x.confidence, voyages: x.voyages })),
      nextCursor: r.rows.length > q.limit ? mkCursor([rows.at(-1).ts, rows.at(-1).id]) : null, delayedTo: req.auth ? null : maxDate(req) };
  });

  app.get("/v1/ports", { schema: { tags: ["ports"], summary: "Ports, optionally within km of a point (PostGIS)", querystring: { type: "object", properties: { near: { type: "string", pattern: "^-?[\\d.]+,-?[\\d.]+$" }, km: { type: "number", minimum: 1, maximum: 20000, default: 500 } } }, response: { 200: { type: "object", properties: { items: { type: "array", items: Obj } } }, 400: Err } } }, async (req) => {
    const q = req.query as { near?: string; km: number };
    const [lat, lon] = q.near ? q.near.split(",").map(Number) : [0, 0];
    const r = await pool.query(`SELECT code AS id, name, country_code AS cc, region_code AS region, ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lon${q.near ? ", round((ST_Distance(geom, ST_MakePoint($2, $1)::geography) / 1000)::numeric, 1)::float8 AS km" : ""}
      FROM locations WHERE location_type = 'port' ${q.near ? "AND ST_DWithin(geom, ST_MakePoint($2, $1)::geography, $3 * 1000) ORDER BY km" : "ORDER BY code"}`, q.near ? [lat, lon, q.km] : []);
    return { items: r.rows };
  });

  app.get("/v1/ports/:id/activity", { schema: { tags: ["ports"], summary: "Daily calls, dwell distribution and congestion score", params: { type: "object", properties: { id: { type: "string" } } }, querystring: { type: "object", properties: { from: date, to: date } }, response: { 200: { type: "object", properties: { port: Obj, days: { type: "array", items: PortDayS } } }, 404: Err } } }, async (req) => {
    const p = port((req.params as { id: string }).id), q = req.query as { from?: string; to?: string };
    const r = await pool.query("SELECT ts::text AS date, calls, dwell_median, dwell_p90, in_port, congestion_z, confidence FROM port_activity WHERE port_id = $1 AND ts BETWEEN $2 AND $3 ORDER BY ts", [loc.get(p.id), q.from ?? "1900-01-01", clampTo(req, q.to)]);
    return { port: { id: p.id, name: p.name, region: p.region }, days: r.rows.map((x) => ({ date: x.date, calls: x.calls, dwellMedianDays: x.dwell_median, dwellP90Days: x.dwell_p90, inPort: x.in_port, congestionZ: x.congestion_z, confidence: x.confidence })) };
  });

  app.get("/v1/regions/:id/pulse", { schema: { tags: ["regions"], summary: "Daily regional pulse index with 80% band, confidence and per-series contributions", params: { type: "object", properties: { id: { type: "string" } } }, querystring: { type: "object", properties: { from: date, to: date } }, response: { 200: { type: "object", properties: { region: { type: "string" }, days: { type: "array", items: PulseDayS } } }, 404: Err } } }, async (req) => {
    const id = (req.params as { id: string }).id, q = req.query as { from?: string; to?: string };
    if (!loc.has(id) || PORTS.some((p) => p.id === id)) throw new ApiError(404, "not_found", `no region ${id}`);
    const r = await pool.query("SELECT to_char(ts, 'YYYY-MM-DD') AS date, score, components FROM regional_activity_index WHERE region_id = $1 AND ts::date BETWEEN $2 AND $3 ORDER BY ts", [loc.get(id), q.from ?? "1900-01-01", clampTo(req, q.to)]);
    return { region: id, days: r.rows.map((x) => ({ date: x.date, index: x.score, lo: x.score - x.components.band80, hi: x.score + x.components.band80, confidence: x.components.confidence, components: x.components.contributions })) };
  });

  app.get("/v1/commodities/:code", { schema: { tags: ["flows"], summary: "Commodity totals, route decomposition and a 14-day forecast with its interval", params: { type: "object", properties: { code: { type: "string" } } }, response: { 200: Obj, 404: Err } } }, async (req) => {
    const code = (req.params as { code: string }).code, c = COMMODITIES.find((x) => x.key === code || x.code === code);
    if (!c) throw new ApiError(404, "not_found", `no commodity ${code}`);
    const to = maxDate(req), toDay = isoToDay(to);
    const daily = (await pool.query("SELECT (ts - $2::date) AS d, sum(quantity)::float8 AS kt FROM trade_flows WHERE commodity_code = $1 AND ts <= $3 GROUP BY ts ORDER BY ts", [c.code, meta.start, to])).rows;
    const series = new Float64Array(toDay + 1);
    for (const x of daily) series[x.d] = x.kt;
    const lanes = (await pool.query(`SELECT o.code AS "from", d.code AS "to", sum(quantity)::float8 AS kt FROM trade_flows f JOIN locations o ON o.id = f.origin_id JOIN locations d ON d.id = f.destination_id WHERE commodity_code = $1 AND ts > $2::date - 30 AND ts <= $2 GROUP BY 1, 2 ORDER BY 3 DESC`, [c.code, to])).rows;
    const total = lanes.reduce((s, l) => s + l.kt, 0);
    return { commodity: c.key, code: c.code, name: c.name, asOf: to, last30DaysKt: total, routes: lanes.map((l) => ({ ...l, share: l.kt / total })), forecast14d: flowForecast(series, toDay + 1) };
  });

  app.post("/v1/playback", { schema: { tags: ["flows"], summary: "Pre-aggregated frames for timeline playback (lane volumes and port congestion per step)", body: { type: "object", required: ["from", "to"], properties: { from: date, to: date, stepDays: { type: "integer", minimum: 1, maximum: 31, default: 7 }, commodity: { type: "string" } } }, response: { 200: { type: "object", properties: { frames: { type: "array", items: Obj } } }, 400: Err } } }, async (req) => {
    const b = req.body as { from: string; to: string; stepDays?: number; commodity?: string }, step = b.stepDays ?? 7, to = clampTo(req, b.to);
    const nFrames = Math.floor((isoToDay(to) - isoToDay(b.from)) / step) + 1;
    if (nFrames > 120 || nFrames < 1) throw new ApiError(400, "too_many_frames", "between 1 and 120 frames: shorten the window or raise stepDays");
    const code = b.commodity ? COMMODITIES.find((c) => c.key === b.commodity)?.code ?? null : null;
    const frames = [];
    for (let k = 0; k < nFrames; k++) {
      const end = dayToIso(isoToDay(b.from) + k * step);
      const lanes = (await pool.query(`SELECT o.code AS "from", d.code AS "to", f.commodity_code, sum(quantity)::float8 AS kt FROM trade_flows f JOIN locations o ON o.id = f.origin_id JOIN locations d ON d.id = f.destination_id WHERE ts > $1::date - $2::int AND ts <= $1 AND ($3::text IS NULL OR commodity_code = $3) GROUP BY 1, 2, 3`, [end, step, code])).rows;
      const ports = (await pool.query("SELECT l.code AS port, congestion_z AS z FROM port_activity a JOIN locations l ON l.id = a.port_id WHERE ts = $1", [end])).rows;
      frames.push({ date: end, lanes, ports });
    }
    return { frames };
  });

  app.get("/v1/nowcasts", { schema: { tags: ["regions"], summary: "Rolling-origin nowcasts made at each month end, with the official value once published", querystring: { type: "object", properties: { region: { type: "string" }, month: { type: "string", pattern: "^\\d{4}-\\d{2}$" } } }, response: { 200: { type: "object", properties: { items: { type: "array", items: Obj } } } } } }, async (req) => {
    const q = req.query as { region?: string; month?: string }, cut = maxDate(req);
    const r = await pool.query(`SELECT l.code AS region, n.month, n.made_on::text AS "madeOn", n.bridge, n.lo, n.hi, n.gbm, n.naive, o.released_on::text AS "officialReleasedOn", CASE WHEN o.released_on <= $3 THEN n.actual END AS official
      FROM nowcasts n JOIN locations l ON l.id = n.region_id JOIN official_indicators o ON o.region_id = n.region_id AND o.month = n.month
      WHERE ($1::text IS NULL OR l.code = $1) AND ($2::text IS NULL OR n.month = $2) AND n.made_on <= $3 ORDER BY l.code, n.month`, [q.region ?? null, q.month ?? null, cut]);
    return { items: r.rows };
  });

  app.post("/v1/alerts", { schema: { tags: ["alerts"], security: sec, summary: "Create an alert on abnormal port congestion; replays it over the history and notifies", headers: idem, body: Rule, response: { 201: { type: "object", properties: { rule: Obj, deliveries: { type: "array", items: Obj } } }, 400: Err, 401: Err, 403: Err, 409: Err } } }, async (req, reply) =>
    idempotent(req, reply, async () => {
      const a = need(req, "operator"), rule = req.body as AlertRule, errors = validateRule(rule);
      if (errors.length) throw new ApiError(400, "invalid_rule", errors.join("; "), errors);
      const id = randomUUID();
      const series = (await pool.query("SELECT calls, dwell_median, dwell_p90, in_port, congestion_z, confidence FROM port_activity WHERE port_id = $1 ORDER BY ts", [loc.get(rule.port)])).rows
        .map((x): PortDay => ({ calls: x.calls, dwellMedian: x.dwell_median ?? NaN, dwellP90: x.dwell_p90 ?? NaN, inPort: x.in_port, z: x.congestion_z ?? NaN, confidence: x.confidence }));
      const fired = firings(rule, series);
      const deliveries: { ruleId: string; channel: string; target: string; text: string; delivered: string; at: string; day: number }[] = [];
      await withTenant(a.org, async (db) => {
        await db.query("INSERT INTO alert_rules (id, tenant_id, rule, created_by) VALUES ($1,$2,$3,$4)", [id, a.org, rule, a.label]);
        for (const f of fired) {
          const text = notificationText(rule, f);
          let status = "queued";
          if (rule.channel === "email" && mailer) {
            try { await mailer.sendMail({ from: "alerts@pulse.local", to: rule.target, subject: `Port congestion: ${PORTS.find((p) => p.id === rule.port)!.name} z ${f.z.toFixed(1)}`, text }); status = "smtp-sink"; }
            catch (e) { status = "failed"; req.log.warn({ err: e, traceId: req.traceId }, "mail sink unreachable"); }
          }
          await db.query("INSERT INTO alert_deliveries (tenant_id, rule_id, day, channel, target, text, status) VALUES ($1,$2,$3,$4,$5,$6,$7)", [a.org, id, dayToIso(f.day), rule.channel, rule.target, text, status]);
          deliveries.push({ ruleId: id, channel: rule.channel, target: rule.target, text, delivered: status, at: new Date().toISOString(), day: f.day });
        }
        await audit(db, a.org, a.label, "alert.create", id, { port: rule.port, firings: fired.length }, req.traceId);
      });
      return { status: 201, body: { rule: { ...rule, id, createdAt: new Date().toISOString() }, deliveries } };
    }));

  app.get("/v1/alerts", { schema: { tags: ["alerts"], security: sec, response: { 200: { type: "object", properties: { items: { type: "array", items: Obj } } }, 401: Err } } }, async (req) => {
    const a = need(req);
    const r = await withTenant(a.org, (c) => c.query("SELECT id, rule, created_at FROM alert_rules WHERE deleted_at IS NULL ORDER BY created_at"));
    return { items: r.rows.map((x) => ({ id: x.id, ...x.rule, createdAt: x.created_at })) };
  });

  // ---- ingestion: a tenant's private vessel events, resolved on the way in (shares the register with the synthetic feed) ----
  const IngestRow = { type: "object", required: ["event", "t"], properties: { imo: { type: "string" }, mmsi: { type: "string" }, name: { type: "string" }, port: { type: "string" }, lat: { type: "number" }, lon: { type: "number" }, event: { type: "string", enum: ["arrival", "departure"] }, t: { type: "string", format: "date-time" }, draught: { type: "number" } } };
  app.post("/v1/ingest/vessel-events", { schema: { tags: ["ingest"], security: sec, summary: "Upload up to 5,000 private vessel events; each is resolved to a vessel and a port", headers: idem, body: { type: "object", required: ["events"], properties: { events: { type: "array", minItems: 1, maxItems: 5000, items: IngestRow } } }, response: { 201: { type: "object", properties: { accepted: { type: "integer" }, resolvedVessel: { type: "integer" }, resolvedPort: { type: "integer" } } }, 400: Err, 401: Err, 403: Err, 409: Err } } }, async (req, reply) =>
    idempotent(req, reply, async () => {
      const a = need(req, "operator"), evs = (req.body as { events: { imo?: string; mmsi?: string; name?: string; port?: string; lat?: number; lon?: number; event: string; t: string; draught?: number }[] }).events;
      const imos = [...new Set(evs.map((e) => e.imo).filter((x): x is string => !!x && validImo(x)))];
      const reg = new Map<string, string>((await pool.query("SELECT imo, id::text FROM vessels WHERE imo = ANY($1)", [imos])).rows.map((r) => [r.imo, r.id]));
      const rows = evs.map((e) => {
        const p = e.port ? resolvePort(e.port) : e.lat !== undefined && e.lon !== undefined ? geofence(e.lat, e.lon) : null;
        const v = e.imo && validImo(e.imo) ? reg.get(e.imo) ?? null : null;
        return [randomUUID(), a.org, e.imo ?? e.mmsi ?? null, p ? loc.get(p) : null, e.event, e.t, e.draught ?? null, JSON.stringify({ src: "upload", name: e.name, portAlias: e.port, lat: e.lat, lon: e.lon }), v, v ? "imo" : "unresolved"];
      });
      await withTenant(a.org, async (db) => {
        await db.query(`INSERT INTO vessel_events (id, tenant_id, vessel_id, port_id, event_type, ts, draught, metadata, resolved_vessel, resolution)
          SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::uuid[], $5::text[], $6::timestamptz[], $7::float8[], $8::jsonb[], $9::uuid[], $10::text[])`, rows[0].map((_, j) => rows.map((r) => r[j])));
        await audit(db, a.org, a.label, "ingest.vessel_events", null, { rows: rows.length }, req.traceId);
      });
      return { status: 201, body: { accepted: rows.length, resolvedVessel: rows.filter((r) => r[8]).length, resolvedPort: rows.filter((r) => r[3]).length } };
    }));

  app.get("/v1/vessel-events", { schema: { tags: ["ingest"], summary: "Raw events visible to the caller (shared feed + own uploads), with resolution", querystring: { type: "object", properties: { port: { type: "string" }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, source: { type: "string", enum: ["shared", "own"] }, limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 } } }, response: { 200: { type: "object", properties: { items: { type: "array", items: Obj } } } } } }, async (req) => {
    const q = req.query as { port?: string; from?: string; to?: string; source?: string; limit: number };
    const run = (c: { query: typeof pool.query }) => c.query(`SELECT e.vessel_id AS "rawId", l.code AS port, e.event_type AS event, e.ts, e.draught, e.metadata, v.imo AS "resolvedImo", e.resolution, e.tenant_id IS NOT NULL AS private
      FROM vessel_events e LEFT JOIN locations l ON l.id = e.port_id LEFT JOIN vessels v ON v.id = e.resolved_vessel
      WHERE ($1::text IS NULL OR l.code = $1) AND e.ts BETWEEN $2 AND $3 AND ($4::text IS NULL OR ($4 = 'own') = (e.tenant_id IS NOT NULL)) ORDER BY e.ts LIMIT $5`,
      [q.port ?? null, q.from ?? "1900-01-01", q.to ?? `${maxDate(req)}T23:59:59Z`, q.source ?? null, q.limit]);
    const r = req.auth ? await withTenant(req.auth.org, (c) => run(c as never)) : await withTenant("00000000-0000-4000-8000-000000000000", (c) => run(c as never));
    return { items: r.rows };
  });

  app.get("/v1/audit", { schema: { tags: ["admin"], security: sec, response: { 200: { type: "object", properties: { items: { type: "array", items: Obj }, chainValid: { type: "boolean" } } }, 401: Err } } }, async (req) => {
    const a = need(req);
    const r = await withTenant(a.org, (c) => c.query("SELECT tenant_id, actor, action, target, detail, prev_hash, hash, at FROM audit_log ORDER BY id"));
    let prev = "genesis", ok = true;
    for (const x of r.rows) { if (x.prev_hash !== prev || sha256(prev + canonical({ tenant: x.tenant_id, actor: x.actor, action: x.action, target: x.target, detail: x.detail })) !== x.hash) ok = false; prev = x.hash; }
    return { items: r.rows.map((x) => ({ actor: x.actor, action: x.action, target: x.target, at: x.at })), chainValid: ok };
  });

  app.post("/v1/telemetry", { schema: { hide: true } }, async (req, reply) => {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!body || typeof body !== "object") throw new ApiError(400, "invalid_request", "telemetry sample must be an object");
    await pool.query("INSERT INTO client_telemetry (sample) VALUES ($1)", [body]);
    return reply.code(204).send();
  });
  return app;
}
