// Messages between the page and the derivation worker. Arrays are per day (index = day since the bundle's start).
import type { Bundle } from "@pulse/domain";

export interface PulseOut { index: Float32Array; band: Float32Array; conf: Uint8Array; contrib: Float32Array[]; lambda: number[]; explained: number; truth: Float32Array }
export interface PortOut { calls: Uint16Array; dwellMedian: Float32Array; dwellP90: Float32Array; inPort: Int16Array; z: Float32Array; conf: Uint8Array; arrivals: Float32Array; dwellAt: Float32Array }
export interface Derived {
  pulses: Record<string, PulseOut>;
  ports: Record<string, PortOut>;
  lane30: Float32Array[]; // trailing 30-day kt per day, per lane
  commodity: Record<string, Float32Array>; // kt departing per day
  ms: number;
}
export type ToWorker = { type: "init"; bundle: Bundle } | { type: "pulses"; id: number; drop: { from: number; to?: number } | null };
export type FromWorker = { type: "ready"; derived: Derived } | { type: "pulses"; id: number; pulses: Record<string, PulseOut>; ms: number } | { type: "error"; id: number; message: string };
