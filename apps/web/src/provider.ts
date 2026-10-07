// Data providers. The public sandbox uses StaticProvider (the generated bundle); the Docker stack builds the web app with
// NEXT_PUBLIC_API_URL and uses ApiProvider (the API serves the same bundle from its database and sends alert e-mail).
// Either can be told to fail, so the recovery path is demonstrable.
import type { AlertRule, Bundle } from "@pulse/domain";
import { traceparent } from "@pulse/telemetry";
import { PulseClient } from "@pulse/sdk";

export class FeedError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }
export interface SavedRule extends AlertRule { id: string; createdAt: string }
export interface Delivery { ruleId: string; channel: string; target: string; text: string; delivered: "simulated" | "smtp-sink" | "queued" | "failed"; at: string; day: number }

export interface DataProvider {
  readonly kind: "static" | "api";
  feedDown: boolean;
  loadBundle(): Promise<Bundle>;
  saveRule(rule: AlertRule, idempotencyKey: string): Promise<{ rule: SavedRule; deliveries: Delivery[] }>;
}

const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { traceparent: traceparent() } });
  if (!r.ok) { let msg = `${r.status} ${r.statusText}`; try { msg = (await r.json())?.error?.message ?? msg; } catch { /* not json */ } throw new FeedError(r.status, msg); }
  return r.json() as Promise<T>;
}

export class StaticProvider implements DataProvider {
  readonly kind = "static" as const;
  feedDown = false;
  async loadBundle() {
    if (this.feedDown) { await new Promise((r) => setTimeout(r, 300)); throw new FeedError(503, "data service unavailable (simulated outage)"); }
    return getJson<Bundle>(`${base}/data/bundle.json`);
  }
  async saveRule(rule: AlertRule, key: string) { return { rule: { ...rule, id: key, createdAt: new Date().toISOString() }, deliveries: [] as Delivery[] }; }
}

export class ApiProvider implements DataProvider {
  readonly kind = "api" as const;
  feedDown = false;
  private url: string; private client: PulseClient;
  constructor(url: string, token: string) { this.url = url; this.client = new PulseClient(url, token); }
  async loadBundle() { return getJson<Bundle>(`${this.url}/v1/bundle${this.feedDown ? "?simulate=outage" : ""}`); }
  async saveRule(rule: AlertRule, key: string) { return (await this.client.createAlert(rule, key)) as unknown as { rule: SavedRule; deliveries: Delivery[] }; }
}

export function makeProvider(): DataProvider {
  const api = process.env.NEXT_PUBLIC_API_URL;
  return api ? new ApiProvider(api, process.env.NEXT_PUBLIC_DEMO_TOKEN ?? "meridian-analyst-demo") : new StaticProvider();
}

/** Retry with exponential backoff; reports each wait so the UI can show it. */
export async function withRetry<T>(fn: () => Promise<T>, onWait: (attempt: number, ms: number, err: Error) => void, max = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (attempt >= max) throw e;
      const ms = Math.min(16000, 1000 * 2 ** (attempt - 1));
      onWait(attempt, ms, e as Error);
      await new Promise((r) => setTimeout(r, ms));
    }
  }
}
