// Entity resolution: raw feed rows -> canonical vessels and ports. Ports: alias dictionary, then fuzzy match; AIS by geofence.
// Vessels: IMO with a valid check digit; otherwise a fuzzy name match among vessels seen at that port within hours.
// MMSI -> vessel is learned from AIS rows that coincide with resolved port-feed rows (MMSIs change when a ship is re-flagged).
import { distanceNm } from "./geo.ts";
import { PORTS, imoCheck, portAliases, type AisRow, type PortRow, type Vessel } from "./world.ts";

export const normName = (s: string) => s.toUpperCase().replace(/^(M\/V|MV|MT)\s+/, "").replace(/[^A-Z0-9]/g, "");
const normPort = (s: string) => s.toUpperCase().replace(/\bPORT OF\b|\bANCHORAGE\b|\([A-Z]{2}\)/g, "").replace(/[^A-Z0-9]/g, "");

/** Jaro-Winkler similarity in [0, 1]. */
export function jaroWinkler(a: string, b: string) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const w = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const ma = new Array(a.length).fill(false), mb = new Array(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++) for (let j = Math.max(0, i - w); j < Math.min(b.length, i + w + 1); j++) if (!mb[j] && a[i] === b[j]) { ma[i] = mb[j] = true; m++; break; }
  if (!m) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) if (ma[i]) { while (!mb[k]) k++; if (a[i] !== b[k]) t++; k++; }
  const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let l = 0;
  while (l < 4 && a[l] === b[l]) l++;
  return jaro + l * 0.1 * (1 - jaro);
}

export const validImo = (imo: string) => /^\d{7}$/.test(imo) && imoCheck(imo.slice(0, 6)) === imo[6];

const aliasIndex = new Map<string, string>();
for (const p of PORTS) for (const a of portAliases(p)) aliasIndex.set(normPort(a), p.id);
const aliasList = [...aliasIndex.entries()];

/** Port name/alias/LOCODE from a port-authority row -> port id (null when nothing scores 0.9 or better). */
export function resolvePort(raw: string): string | null {
  const n = normPort(raw);
  const hit = aliasIndex.get(n);
  if (hit) return hit;
  let best: [number, string | null] = [0, null];
  for (const [a, id] of aliasList) { const s = jaroWinkler(n, a); if (s > best[0]) best = [s, id]; }
  return best[0] >= 0.9 ? best[1] : null;
}

/** AIS position -> port id when within 25 nm of a port. */
export function geofence(lat: number, lon: number): string | null {
  let best: [number, string | null] = [25, null];
  for (const p of PORTS) { const d = distanceNm(lat, lon, p.lat, p.lon); if (d < best[0]) best = [d, p.id]; }
  return best[1];
}

export interface ResolvedRow { vessel: number | null; port: string | null; t: number; event: "arrival" | "departure"; draught: number | null; src: "port" | "ais"; how: string }

/**
 * Resolve both feeds. `registry` is the public vessel register (IMO and name; MMSIs are not in it). Rows are processed in time
 * order; an MMSI is bound to a vessel when an AIS row and a resolved port row agree on port, event and time (within 3 hours).
 */
export function resolveFeeds(registry: Pick<Vessel, "idx" | "imo" | "name">[], portFeed: PortRow[], ais: AisRow[]) {
  const byImo = new Map(registry.map((v) => [v.imo, v.idx]));
  const names = registry.map((v) => normName(v.name));
  const byName = new Map<string, number[]>();
  names.forEach((n, i) => byName.set(n, [...(byName.get(n) ?? []), registry[i].idx]));

  // pass 1: port-feed rows with a valid IMO
  const recent = new Map<string, { t: number; vessel: number; event: string }[]>(); // port -> resolved rows (for context and AIS binding)
  const portRows: ResolvedRow[] = portFeed.map((r) => {
    const port = resolvePort(r.port);
    const ok = validImo(r.imo) && byImo.has(r.imo);
    const row: ResolvedRow = { vessel: ok ? byImo.get(r.imo)! : null, port, t: r.t, event: r.event, draught: r.draught, src: "port", how: ok ? "imo" : "unresolved" };
    if (ok && port) { const l = recent.get(port) ?? []; l.push({ t: r.t, vessel: row.vessel!, event: r.event }); recent.set(port, l); }
    return row;
  });
  // pass 2: no usable IMO -> names, first among vessels that called at this port within 40 days, then a unique exact name
  const best = (n: string, cands: number[]) => {
    let b = 0, s2 = 0, idx = -1;
    for (const c of cands) { const s = jaroWinkler(n, names[c]); if (s > b) { s2 = b; b = s; idx = c; } else if (s > s2 && c !== idx) s2 = s; }
    return { b, s2, idx };
  };
  portRows.forEach((row, i) => {
    if (row.vessel !== null) return;
    const n = normName(portFeed[i].name);
    const near = [...new Set((row.port ? recent.get(row.port) ?? [] : []).filter((x) => Math.abs(x.t - row.t) < 40).map((x) => x.vessel))];
    const m = best(n, near);
    if (m.b >= 0.9 && m.b - m.s2 > 0.01 && m.idx >= 0) { row.vessel = m.idx; row.how = "name-at-port"; return; }
    const exact = byName.get(n);
    if (exact?.length === 1) { row.vessel = exact[0]; row.how = "name-exact"; }
  });
  for (const [i, row] of portRows.entries()) if (row.vessel !== null && row.how !== "imo" && row.port) { const l = recent.get(row.port) ?? []; l.push({ t: row.t, vessel: row.vessel, event: portFeed[i].event }); recent.set(row.port, l); }
  for (const l of recent.values()) l.sort((a, b) => a.t - b.t);
  // AIS: bind MMSI to vessel through coincident port rows; later rows reuse the binding
  const mmsiTo = new Map<string, number>();
  const aisRows = ais.map((a) => {
    const port = geofence(a.lat, a.lon);
    let vessel = mmsiTo.get(a.mmsi) ?? null, how = vessel !== null ? "mmsi" : "unresolved";
    if (port) {
      const cands = (recent.get(port) ?? []).filter((x) => x.event === a.event && Math.abs(x.t - a.t) < 0.125);
      const n = normName(a.name);
      const scored = cands.map((c) => ({ c, s: jaroWinkler(n, names[c.vessel]) })).sort((x, y) => y.s - x.s);
      if (scored[0] && scored[0].s >= 0.9 && (vessel === null || vessel !== scored[0].c.vessel)) { vessel = scored[0].c.vessel; mmsiTo.set(a.mmsi, vessel); how = "coincident-port-row"; }
    }
    return { vessel, port, t: a.t, event: a.event, draught: a.draught, src: "ais" as const, how };
  });
  const out = portRows.concat(aisRows);
  return { rows: out, mmsiBindings: mmsiTo.size };
}
