// Promise wrapper around the derivation worker.
import type { Bundle } from "@pulse/domain";
import type { Derived, FromWorker, PulseOut } from "./protocol.ts";

export class DeriveClient {
  private w = new Worker(new URL("./derive.worker.ts", import.meta.url), { type: "module" });
  private seq = 0;
  private waiting = new Map<number, (m: FromWorker) => void>();
  ready: Promise<Derived>;
  constructor(bundle: Bundle) {
    let ok!: (d: Derived) => void, bad!: (e: Error) => void;
    this.ready = new Promise((a, b) => { ok = a; bad = b; });
    this.w.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (m.type === "ready") return ok(m.derived);
      if (m.type === "error" && m.id === -1) return bad(new Error(m.message));
      this.waiting.get(m.id)?.(m);
      this.waiting.delete(m.id);
    };
    this.w.postMessage({ type: "init", bundle });
  }
  pulses(drop: { from: number; to?: number } | null): Promise<Record<string, PulseOut>> {
    const id = ++this.seq;
    return new Promise((ok, bad) => {
      this.waiting.set(id, (m) => (m.type === "pulses" ? ok(m.pulses) : bad(new Error(m.type === "error" ? m.message : "unexpected reply"))));
      this.w.postMessage({ type: "pulses", id, drop });
    });
  }
  terminate() { this.w.terminate(); }
}
