// Application state (the source of truth). Animation reads from here; the scene never writes business state except through these actions.
import { useSyncExternalStore } from "react";
import { dayToIso, firings, notificationText, validateRule, type AlertRule, type Bundle, type PortDay } from "@pulse/domain";
import { next, type JourneyEvent, type View } from "./journey.ts";
import { makeProvider, withRetry, type DataProvider, type SavedRule } from "./provider.ts";
import { DeriveClient } from "./worker/client.ts";
import type { Derived, PulseOut } from "./worker/protocol.ts";

export interface Notice { id: string; at: number; text: string; channel: string; delivered: string }

export interface AppState {
  view: View;
  bundle: Bundle | null;
  derived: Derived | null;
  pulses: Record<string, PulseOut> | null;
  load: { status: "idle" | "loading" | "ready" | "error"; message?: string; workerMs?: number };
  feed: { status: "ok" | "down" | "retrying" | "recovered"; attempt: number; waitMs: number; message?: string };
  ais: { status: "ok" | "down" | "recovered"; from: number | null };
  window: { start: number; end: number; now: number };
  simTime: number; // days since the bundle start (fractional)
  playing: boolean;
  speed: number; // simulated days per second; negative rewinds
  commodity: string; // "all" or a commodity key
  region: string | null;
  port: string | null;
  mapMode: "globe" | "flat";
  showTruth: boolean;
  rules: SavedRule[];
  notices: Notice[];
  listView: boolean; reduced: boolean; motionPaused: boolean; hud: boolean; palette: boolean; alertOpen: boolean; help: boolean;
  stress: boolean;
  webgl: "ok" | "lost" | "unsupported";
  announce: string;
}

const initial: AppState = {
  view: "intro0", bundle: null, derived: null, pulses: null, load: { status: "idle" }, feed: { status: "ok", attempt: 0, waitMs: 0 }, ais: { status: "ok", from: null },
  window: { start: 0, end: 0, now: 0 }, simTime: 0, playing: false, speed: 7, commodity: "all", region: null, port: null, mapMode: "globe", showTruth: false,
  rules: [], notices: [], listView: false, reduced: false, motionPaused: false, hud: false, palette: false, alertOpen: false, help: false, stress: false, webgl: "ok", announce: "",
};

let state: AppState = initial;
const subs = new Set<() => void>();
export const get = () => state;
export function set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const s of subs) s();
}
export function useApp<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => sel(state), () => sel(initial));
}

export const provider: DataProvider = makeProvider();
export let worker: DeriveClient | null = null;

/** The simulation clock as rendered (days); the store's simTime follows it a few times a second while playing. */
export const clock = { t: -1, lastSync: 0 };
export function jump(t: number) {
  const w = state.window;
  clock.t = w.end ? Math.max(w.start, Math.min(w.end, t)) : t;
  set({ simTime: clock.t });
}

export function send(e: JourneyEvent) { set((s) => ({ view: next(s.view, e) })); }
export const say = (announce: string) => set({ announce });

export async function loadBundle() {
  const first = state.bundle === null;
  set({ load: { status: "loading" } });
  try {
    const bundle = await withRetry(() => provider.loadBundle(), (attempt, ms, err) => {
      set((s) => ({ feed: { ...s.feed, status: "retrying", attempt, waitMs: ms, message: err.message } }));
      say(`Data service unavailable. Retrying in ${Math.round(ms / 1000)} seconds.`);
    }, first ? 6 : 8);
    worker?.terminate();
    worker = new DeriveClient(bundle);
    const derived = await worker.ready;
    const recovered = state.feed.status !== "ok";
    set({ bundle, derived, pulses: derived.pulses, window: { start: 0, end: bundle.days - 1, now: bundle.now }, load: { status: "ready", workerMs: Math.round(derived.ms) }, feed: { status: recovered ? "recovered" : "ok", attempt: 0, waitMs: 0 } });
    if (clock.t < 0) jump(bundle.now);
    if (recovered) say("Data service recovered.");
  } catch (e) {
    set((s) => ({ load: { status: s.bundle ? "ready" : "error", message: (e as Error).message }, feed: { ...s.feed, status: "down", message: (e as Error).message } }));
  }
}

/** Failure scenario: the AIS feed stops (from the scene's day onward) and the pulse runs on the remaining series. */
export async function cutAis(on: boolean) {
  if (!worker) return;
  const from = Math.floor(state.simTime) - 20;
  const pulses = await worker.pulses(on ? { from } : null);
  set({ pulses, ais: { status: on ? "down" : "recovered", from: on ? from : null } });
  say(on ? `AIS feed cut from ${dayToIso(from)}: vessel-derived series dropped, the pulse runs on power and road data with wider bands.` : "AIS feed restored: vessel series back in, bands narrow again.");
}

const label = (s: AppState) => (s.port ? s.bundle?.ports.find((p) => p.id === s.port)?.name : s.region ? s.bundle?.regions.find((r) => r.id === s.region)?.name : null);
export function selectRegion(id: string | null) {
  if (!id) { set({ region: null, port: null }); send({ type: "BACK" }); return; }
  set({ region: id, port: null }); send({ type: "REGION" }); say(`Region ${label(get())}.`);
}
export function selectPort(id: string | null) {
  if (!id) { set({ port: null }); send({ type: "BACK" }); return; }
  const p = state.bundle?.ports.find((x) => x.id === id);
  set({ port: id, region: p?.region ?? null }); send({ type: "PORT" });
  const z = state.derived?.ports[id].z[Math.floor(state.simTime)];
  say(`Port ${p?.name}. Congestion z ${Number.isFinite(z) ? z!.toFixed(1) : "not yet available"}.`);
}
export function selectCommodity(key: string) {
  set({ commodity: key });
  if (key !== "all") send({ type: "COMMODITY" });
  say(key === "all" ? "All commodities." : `${state.bundle?.commodities.find((c) => c.key === key)?.name} flows.`);
}

/** Save an alert; the rule is replayed over the history so the page can show when it would have fired. */
export async function saveRule(rule: AlertRule) {
  const errors = validateRule(rule);
  if (errors.length) return errors;
  const key = crypto.randomUUID();
  const { rule: saved, deliveries } = await provider.saveRule(rule, key);
  let notices: Notice[];
  if (provider.kind === "api") notices = deliveries.map((d, k) => ({ id: `${saved.id}-${k}`, at: Date.now(), text: d.text, channel: d.channel, delivered: d.delivered }));
  else {
    const p = state.derived!.ports[rule.port];
    const series: PortDay[] = Array.from(p.z, (z, d) => ({ z, calls: p.calls[d], dwellMedian: p.dwellMedian[d], dwellP90: p.dwellP90[d], inPort: p.inPort[d], confidence: (["low", "medium", "high"] as const)[p.conf[d]] }));
    notices = firings(saved, series).map((f, k) => ({ id: `${saved.id}-${k}`, at: Date.now(), text: notificationText(saved, f), channel: saved.channel, delivered: "simulated" }));
  }
  set((s) => ({ rules: [...s.rules, saved], notices: [...notices, ...s.notices], alertOpen: false }));
  say(`Alert saved. Replayed over the history it fires ${notices.length} time${notices.length === 1 ? "" : "s"}.`);
  return [];
}
