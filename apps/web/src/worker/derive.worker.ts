/// <reference lib="webworker" />
// Derives everything the page draws from the bundle: regional pulses (DFM + Kalman, with per-series contributions), port
// congestion from dwell distributions, lane and commodity flows. Re-runs the pulses when the AIS feed is cut.
import { LANES, PORTS, band80, commodityDaily, confidence, laneDaily, panelsFrom, portCalls, congestionSeries, regionPulses, type Bundle, type Panel, type RegionPulse } from "@pulse/domain";
import type { Derived, FromWorker, PortOut, PulseOut, ToWorker } from "./protocol.ts";

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);
let bundle: Bundle, panels: Record<string, Panel>;
const CONF = { high: 2, medium: 1, low: 0 } as const;

function pulsesOut(rp: Record<string, RegionPulse>): Record<string, PulseOut> {
  return Object.fromEntries(Object.entries(rp).map(([k, { params, f }]) => [k, {
    index: Float32Array.from(f.m, (m) => 100 + 10 * m), band: Float32Array.from(f.P, (P) => band80(P)), conf: Uint8Array.from(f.P, (P) => CONF[confidence(P)]),
    contrib: f.contrib.map((c) => Float32Array.from(c, (x) => 10 * x)), lambda: params.lambda, explained: params.explained,
    truth: Float32Array.from(bundle.truth.factor[k], (x) => 100 + 10 * x),
  }]));
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  try {
    if (m.type === "init") {
      const t0 = performance.now();
      bundle = m.bundle;
      panels = panelsFrom(bundle);
      const pulses = pulsesOut(regionPulses(panels, bundle.now, bundle.now));
      const ports: Record<string, PortOut> = {};
      for (const p of PORTS) {
        const calls = portCalls(bundle.voyages, p.id), s = congestionSeries(calls, bundle.days);
        const arrivals = new Float32Array(bundle.days);
        for (const [a] of calls) if (a >= 0 && a < bundle.days) arrivals[Math.floor(a)]++;
        ports[p.id] = { calls: Uint16Array.from(s, (x) => x.calls), dwellMedian: Float32Array.from(s, (x) => x.dwellMedian), dwellP90: Float32Array.from(s, (x) => x.dwellP90),
          inPort: Int16Array.from(s, (x) => x.inPort), z: Float32Array.from(s, (x) => x.z), conf: Uint8Array.from(s, (x) => CONF[x.confidence]), arrivals,
          dwellAt: Float32Array.from(calls.flatMap(([a, d]) => [a, d - a])) };
      }
      const ld = laneDaily(bundle.voyages, bundle.days);
      const lane30 = LANES.map((l) => { const out = new Float32Array(bundle.days); let s = 0; for (let d = 0; d < bundle.days; d++) { s += ld.vol[l.id][d]; if (d >= 30) s -= ld.vol[l.id][d - 30]; out[d] = s; } return out; });
      const commodity = Object.fromEntries(Object.entries(commodityDaily(bundle.voyages, bundle.days)).map(([k, v]) => [k, Float32Array.from(v)]));
      const derived: Derived = { pulses, ports, lane30, commodity, ms: performance.now() - t0 };
      post({ type: "ready", derived });
    } else if (m.type === "pulses") {
      const t0 = performance.now();
      const drop = m.drop ? { series: ["departuresTo", "arrivalsIn", "exports"] as ("departuresTo" | "arrivalsIn" | "exports")[], from: m.drop.from, to: m.drop.to } : undefined;
      post({ type: "pulses", id: m.id, pulses: pulsesOut(regionPulses(panels, bundle.now, bundle.now, drop)), ms: performance.now() - t0 });
    }
  } catch (e) {
    post({ type: "error", id: "id" in m ? m.id : -1, message: e instanceof Error ? e.message : String(e) });
  }
};
