// Per-frame runtime that must not go through React: the simulation clock as rendered, the motion orchestrator and telemetry.
import { Orchestrator } from "@pulse/motion";
import { Telemetry } from "@pulse/telemetry";
import { clock, get, set } from "./store.ts";
export { clock, jump } from "./store.ts";

export const orchestrator = new Orchestrator();
export const telemetry = new Telemetry((s) => {
  const api = process.env.NEXT_PUBLIC_API_URL;
  if (api && typeof navigator !== "undefined") navigator.sendBeacon?.(`${api}/v1/telemetry`, new Blob([JSON.stringify(s)], { type: "application/json" }));
});

/** Advance (or rewind) simulated time by one frame while playing; clamp to the data window. */
export function advance(dtMs: number, nowMs: number) {
  const s = get();
  if (!s.window.end) return;
  if (clock.t < 0) clock.t = s.simTime;
  if (s.playing && !s.motionPaused) {
    clock.t = Math.max(s.window.start, Math.min(s.window.end, clock.t + (dtMs / 1000) * s.speed));
    if (clock.t >= s.window.end || clock.t <= s.window.start) set({ playing: false, simTime: clock.t });
  }
  if (nowMs - clock.lastSync > 100 && s.playing) { clock.lastSync = nowMs; set({ simTime: clock.t }); }
}
