"use client";
// Alert-rule form, command palette and keyboard help. Native <dialog> for focus trapping and Escape.
import { useEffect, useMemo, useRef, useState } from "react";
import type { AlertRule } from "@pulse/domain";
import { get, jump, saveRule, selectCommodity, selectPort, selectRegion, set, useApp } from "../store.ts";

function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
    const c = () => onClose();
    d.addEventListener("close", c);
    return () => d.removeEventListener("close", c);
  }, [open, onClose]);
  return ref;
}

const NO_PORTS: never[] = [];
export function AlertDialog() {
  const open = useApp((s) => s.alertOpen), port = useApp((s) => s.port), ports = useApp((s) => s.bundle?.ports ?? NO_PORTS);
  const close = useMemo(() => () => set({ alertOpen: false }), []);
  const ref = useDialog(open, close);
  const [rule, setRule] = useState<AlertRule>({ name: "Abnormal congestion", port: "CNNGB", minZ: 4, minConfidence: "medium", channel: "email", target: "desk@meridian.example" });
  useEffect(() => { if (open && port) setRule((r) => ({ ...r, port, name: `Abnormal congestion at ${ports.find((p) => p.id === port)?.name}` })); }, [open, port, ports]);
  const [errors, setErrors] = useState<string[]>([]), [busy, setBusy] = useState(false);
  return (
    <dialog ref={ref} aria-labelledby="alert-title" className="dialog">
      <form method="dialog" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { setErrors(await saveRule(rule)); } catch (err) { setErrors([(err as Error).message]); } setBusy(false); }}>
        <h2 id="alert-title">New congestion alert</h2>
        <label>Name <input value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} /></label>
        <label>Port <select value={rule.port} onChange={(e) => setRule({ ...rule, port: e.target.value })}>{ports.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}</select></label>
        <label>Fire when the congestion score reaches <select value={rule.minZ} onChange={(e) => setRule({ ...rule, minZ: +e.target.value })}>{[2, 3, 4, 6, 8].map((v) => <option key={v} value={v}>z ≥ {v}</option>)}</select></label>
        <label>…with at least this confidence <select value={rule.minConfidence} onChange={(e) => setRule({ ...rule, minConfidence: e.target.value as AlertRule["minConfidence"] })}><option value="low">low</option><option value="medium">medium (8+ calls a week)</option><option value="high">high (20+ calls a week)</option></select></label>
        <label>Channel <select value={rule.channel} onChange={(e) => setRule({ ...rule, channel: e.target.value as AlertRule["channel"], target: e.target.value === "email" ? "desk@meridian.example" : "https://hooks.meridian.example/pulse" })}><option value="email">E-mail</option><option value="webhook">Webhook</option></select></label>
        <label>Send to <input value={rule.target} onChange={(e) => setRule({ ...rule, target: e.target.value })} /></label>
        {errors.length ? <ul className="errors" role="alert">{errors.map((x) => <li key={x}>{x}</li>)}</ul> : null}
        <div className="row"><button className="primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save alert"}</button><button type="button" onClick={close}>Cancel</button></div>
        <p className="muted small">The rule is replayed over the two years of data so you can see when it would have fired. In this public sandbox the e-mail is simulated; the Docker stack sends it to a local mail sink.</p>
      </form>
    </dialog>
  );
}

export function Palette() {
  const open = useApp((s) => s.palette), b = useApp((s) => s.bundle);
  const close = useMemo(() => () => set({ palette: false }), []);
  const ref = useDialog(open, close);
  const [q, setQ] = useState(""), [k, setK] = useState(0);
  const items = useMemo(() => {
    if (!b) return [];
    const t = q.trim().toLowerCase(), hit = (s: string) => !t || s.toLowerCase().includes(t);
    return [
      ...b.ports.filter((p) => hit(`${p.name} ${p.id}`)).slice(0, 8).map((p) => ({ label: `Port · ${p.name} (${p.id})`, run: () => selectPort(p.id) })),
      ...b.regions.filter((r) => hit(r.name)).map((r) => ({ label: `Region · ${r.name}`, run: () => selectRegion(r.id) })),
      ...b.commodities.filter((c) => hit(c.name)).map((c) => ({ label: `Commodity · ${c.name}`, run: () => selectCommodity(c.key) })),
      ...[
        { label: "Go to the latest day", run: () => jump(get().bundle!.now) },
        { label: "Toggle flat map", run: () => set((s) => ({ mapMode: s.mapMode === "flat" ? "globe" : "flat" })) },
        { label: "Toggle list view", run: () => set((s) => ({ listView: !s.listView })) },
        { label: "Toggle reduced motion", run: () => set((s) => ({ reduced: !s.reduced })) },
        { label: "Create congestion alert", run: () => set({ alertOpen: true }) },
      ].filter((a) => hit(a.label)),
    ];
  }, [q, b]);
  const run = (i: number) => { items[i]?.run(); set({ palette: false }); setQ(""); };
  return (
    <dialog ref={ref} className="dialog palette" aria-label="Command palette">
      <input autoFocus placeholder="Search ports, regions, commodities, actions…" value={q} role="combobox" aria-expanded aria-controls="palette-list" aria-activedescendant={`pi-${k}`}
        onChange={(e) => { setQ(e.target.value); setK(0); }}
        onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setK(Math.min(items.length - 1, k + 1)); } if (e.key === "ArrowUp") { e.preventDefault(); setK(Math.max(0, k - 1)); } if (e.key === "Enter") { e.preventDefault(); run(k); } }} />
      <ul id="palette-list" role="listbox">{items.map((it, i) => <li key={i} id={`pi-${i}`} role="option" aria-selected={i === k}><button onClick={() => run(i)}>{it.label}</button></li>)}</ul>
    </dialog>
  );
}

export function Help() {
  const open = useApp((s) => s.help);
  const close = useMemo(() => () => set({ help: false }), []);
  const ref = useDialog(open, close);
  const keys = [["⌘K / Ctrl K / /", "search and commands"], ["Space", "play / pause (7 days a second)"], ["← →", "one day (Shift: 30 days)"], ["[ ]", "previous / next region"], ["F", "globe / flat map"], ["L", "list view"], ["M", "reduced motion"], ["P", "pause all motion"], ["Esc", "back"]];
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="help-title">
      <h2 id="help-title">Keyboard</h2>
      <table><tbody>{keys.map(([a, b]) => <tr key={a}><th scope="row"><kbd>{a}</kbd></th><td>{b}</td></tr>)}</tbody></table>
      <button onClick={close}>Close</button>
    </dialog>
  );
}
