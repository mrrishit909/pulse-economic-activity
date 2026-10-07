// Alert rules on abnormal port congestion. Evaluated the same way in the API and in the browser sandbox.
import type { PortDay } from "./congestion.ts";
import { dayToIso, portById } from "./world.ts";

export interface AlertRule { id?: string; name: string; port: string; minZ: number; minConfidence: "low" | "medium" | "high"; channel: "email" | "webhook"; target: string }
const RANK = { low: 0, medium: 1, high: 2 };

export function validateRule(r: unknown): string[] {
  const x = r as Partial<AlertRule>, e: string[] = [];
  if (!x || typeof x !== "object") return ["rule must be an object"];
  if (!x.name || typeof x.name !== "string" || x.name.length > 80) e.push("name: 1-80 characters");
  if (typeof x.port !== "string" || !portById.has(x.port)) e.push("port: a known port id (UN/LOCODE)");
  if (typeof x.minZ !== "number" || !(x.minZ >= 1 && x.minZ <= 20)) e.push("minZ: number between 1 and 20");
  if (!x.minConfidence || !(x.minConfidence in RANK)) e.push("minConfidence: low, medium or high");
  if (x.channel !== "email" && x.channel !== "webhook") e.push("channel: email or webhook");
  if (typeof x.target !== "string" || (x.channel === "email" ? !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x.target) : !/^https:\/\//.test(x.target))) e.push("target: e-mail address or https URL");
  return e;
}

/** Days on which the rule fires: z crosses the threshold with enough confidence; at most once per 14 days. */
export function firings(rule: AlertRule, series: PortDay[], from = 0, to = series.length - 1) {
  const out: { day: number; z: number; dwellMedian: number }[] = [];
  let last = -Infinity;
  for (let d = Math.max(1, from); d <= to; d++) {
    const s = series[d];
    if (s.z >= rule.minZ && RANK[s.confidence] >= RANK[rule.minConfidence] && !(series[d - 1].z >= rule.minZ) && d - last >= 14) { out.push({ day: d, z: s.z, dwellMedian: s.dwellMedian }); last = d; }
  }
  return out;
}

export const notificationText = (rule: AlertRule, f: { day: number; z: number; dwellMedian: number }) =>
  `[PULSE demo] ${rule.name}: ${portById.get(rule.port)!.name} congestion z ${f.z.toFixed(1)} on ${dayToIso(f.day)}, median dwell ${f.dwellMedian.toFixed(1)} days (synthetic data)`;
