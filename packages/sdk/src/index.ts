// Typed client for the PULSE API (shapes match docs/openapi.json): bearer token, a W3C traceparent per call, an Idempotency-Key
// on every mutation, cursor pagination, and error bodies turned into ApiError.
import type { AlertRule } from "@pulse/domain";

export class ApiError extends Error {
  status: number; code: string; traceId?: string;
  constructor(status: number, code: string, message: string, traceId?: string) { super(message); this.status = status; this.code = code; this.traceId = traceId; }
}
export interface Flow { laneId: number; from: string; to: string; commodity: string; date: string; kt: number; ktSd: number; voyages: number }
export interface PortDay { date: string; calls: number; dwellMedianDays: number | null; dwellP90Days: number | null; inPort: number; congestionZ: number | null; confidence: string }
export interface PulseDay { date: string; index: number; lo: number; hi: number; confidence: string; components: Record<string, number> }

const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

export class PulseClient {
  private base: string; private token?: string;
  constructor(base: string, token?: string) { this.base = base.replace(/\/$/, ""); this.token = token; }
  private async req<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { traceparent: `00-${hex(16)}-${hex(8)}-01` };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["idempotency-key"] = idempotencyKey ?? crypto.randomUUID();
    const r = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) throw new ApiError(r.status, j?.error?.code ?? "http_error", j?.error?.message ?? r.statusText, j?.error?.traceId);
    return j as T;
  }
  flows(q: { commodity?: string; from?: string; to?: string; date?: string; limit?: number; cursor?: string } = {}) {
    return this.req<{ items: Flow[]; nextCursor: string | null }>("GET", `/v1/flows?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`);
  }
  async *allFlows(q: { commodity?: string; from?: string; to?: string } = {}) {
    let cursor: string | undefined;
    do { const p = await this.flows({ ...q, limit: 1000, cursor }); yield* p.items; cursor = p.nextCursor ?? undefined; } while (cursor);
  }
  portActivity(id: string, from?: string, to?: string) { return this.req<{ port: { id: string; name: string }; days: PortDay[] }>("GET", `/v1/ports/${id}/activity?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`); }
  regionPulse(id: string, from?: string, to?: string) { return this.req<{ region: string; days: PulseDay[] }>("GET", `/v1/regions/${id}/pulse?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`); }
  commodity(code: string) { return this.req<Record<string, unknown>>("GET", `/v1/commodities/${code}`); }
  nowcasts(q: { region?: string; month?: string } = {}) { return this.req<{ items: Record<string, unknown>[] }>("GET", `/v1/nowcasts?${new URLSearchParams(q as Record<string, string>)}`); }
  playback(body: { from: string; to: string; stepDays?: number; commodity?: string }) { return this.req<{ frames: Record<string, unknown>[] }>("POST", "/v1/playback", body); }
  createAlert(rule: AlertRule, idempotencyKey?: string) { return this.req<{ rule: AlertRule & { id: string }; deliveries: { text: string; delivered: string; day: number }[] }>("POST", "/v1/alerts", rule, idempotencyKey); }
}
