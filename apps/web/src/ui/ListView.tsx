"use client";
// Text-and-table alternative to the map: every figure the map and charts show is reachable here without WebGL or motion.
import { LANES } from "@pulse/domain";
import { selectPort, selectRegion, useApp } from "../store.ts";
import { confText, date, kt, n } from "./fmt.ts";

export default function ListView() {
  const b = useApp((s) => s.bundle), d = useApp((s) => s.derived), pulses = useApp((s) => s.pulses), t = Math.floor(useApp((s) => s.simTime)), webgl = useApp((s) => s.webgl);
  if (!b || !d || !pulses) return null;
  const name = (id: string) => b.ports.find((p) => p.id === id)!.name;
  return (
    <main className="listview" aria-label="List view">
      {webgl !== "ok" ? <p className="banner warn" role="status">{webgl === "lost" ? "The GPU context was lost. The map comes back when the browser restores it; everything is available here meanwhile." : "This browser has no WebGL, so the workspace runs as tables."}</p> : null}
      <p>Day {date(t)}. {n(b.voyages.length)} voyages, {b.ports.length} ports, {b.regions.length} regions.</p>
      <div className="table-wrap"><table>
        <caption>Regional pulse index (100 = normal, 10 points = one standard deviation)</caption>
        <thead><tr><th scope="col">Region</th><th scope="col">Index</th><th scope="col">80% band</th><th scope="col">Confidence</th><th scope="col">30-day change</th><th scope="col" /></tr></thead>
        <tbody>{b.regions.map((r) => { const p = pulses[r.id]; return <tr key={r.id}><td>{r.name}</td><td>{n(p.index[t], 1)}</td><td>±{n(p.band[t], 1)}</td><td>{confText[p.conf[t]]}</td><td>{n(p.index[t] - p.index[Math.max(0, t - 30)], 1)}</td><td><button onClick={() => selectRegion(r.id)}>Open</button></td></tr>; })}</tbody>
      </table></div>
      <div className="table-wrap"><table>
        <caption>Port congestion: median dwell of ships arriving in the last 7 days against the 90 days before</caption>
        <thead><tr><th scope="col">Port</th><th scope="col">z</th><th scope="col">Median dwell</th><th scope="col">Calls (7 d)</th><th scope="col">Confidence</th><th scope="col" /></tr></thead>
        <tbody>{b.ports.map((p) => { const s = d.ports[p.id]; return <tr key={p.id}><td>{p.name}</td><td>{n(s.z[t], 1)}</td><td>{n(s.dwellMedian[t], 2)} d</td><td>{s.calls[t]}</td><td>{confText[s.conf[t]]}</td><td><button onClick={() => selectPort(p.id)}>Open</button></td></tr>; })}</tbody>
      </table></div>
      <div className="table-wrap"><table>
        <caption>Lanes: cargo departed in the last 30 days</caption>
        <thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Commodity</th><th scope="col">30 days</th></tr></thead>
        <tbody>{LANES.map((l) => <tr key={l.id}><td>{name(l.from)}</td><td>{name(l.to)}</td><td>{l.commodity}</td><td>{kt(d.lane30[l.id][t])}</td></tr>)}</tbody>
      </table></div>
    </main>
  );
}
