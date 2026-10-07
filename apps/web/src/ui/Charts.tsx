"use client";
// SVG charts. The time cursor of every chart is moved each animation frame from the same clock the map uses, so charts and map
// never disagree by more than one frame while playing (checked by an e2e test).
import { useEffect, useRef } from "react";
import { clock } from "../store.ts";

export function Cursor({ x0, x1, days, height, top = 0 }: { x0: number; x1: number; days: number; height: number; top?: number }) {
  const ref = useRef<SVGLineElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const t = Math.max(0, clock.t), x = x0 + ((x1 - x0) * t) / (days - 1);
      if (ref.current) { ref.current.setAttribute("x1", String(x)); ref.current.setAttribute("x2", String(x)); ref.current.dataset.day = t.toFixed(4); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [x0, x1, days]);
  return <line ref={ref} className="cursor" data-cursor y1={top} y2={top + height} />;
}

/** Daily series with an optional band, monthly markers and a second (truth) line. */
export function LineChart({ days, series, band, truth, months, w = 320, h = 120, yLabel, markers }: {
  days: number; series: ArrayLike<number>; band?: ArrayLike<number>; truth?: ArrayLike<number> | null; months?: { day: number; value: number; released: number }[];
  w?: number; h?: number; yLabel: string; markers?: { day: number; label: string }[];
}) {
  const pad = { l: 30, r: 6, t: 8, b: 16 };
  const vals: number[] = [];
  for (let i = 0; i < days; i += 3) { const v = series[i]; if (Number.isFinite(v)) { vals.push(v + (band ? band[i] : 0)); vals.push(v - (band ? band[i] : 0)); } }
  for (const m of months ?? []) vals.push(m.value);
  const lo = Math.floor(Math.min(...vals) - 2), hi = Math.ceil(Math.max(...vals) + 2);
  const X = (d: number) => pad.l + ((w - pad.l - pad.r) * d) / (days - 1), Y = (v: number) => pad.t + ((h - pad.t - pad.b) * (hi - v)) / (hi - lo);
  const path = (s: ArrayLike<number>) => { let p = ""; for (let i = 0; i < days; i += 2) if (Number.isFinite(s[i])) p += `${p ? "L" : "M"}${X(i).toFixed(1)},${Y(s[i]).toFixed(1)}`; return p; };
  let area = "";
  if (band) { const up: string[] = [], dn: string[] = []; for (let i = 0; i < days; i += 3) if (Number.isFinite(series[i])) { up.push(`${X(i).toFixed(1)},${Y(series[i] + band[i]).toFixed(1)}`); dn.unshift(`${X(i).toFixed(1)},${Y(series[i] - band[i]).toFixed(1)}`); } area = `M${up.join("L")}L${dn.join("L")}Z`; }
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="chart" role="img" aria-label={yLabel}>
      <text x={2} y={10} className="axis">{hi}</text><text x={2} y={h - pad.b} className="axis">{lo}</text>
      {band ? <path d={area} className="band" /> : null}
      {truth ? <path d={path(truth)} className="truth" /> : null}
      <path d={path(series)} className="series" />
      {(months ?? []).map((m, k) => <g key={k}><circle cx={X(m.day)} cy={Y(m.value)} r={2.6} className="official" /><line x1={X(m.day)} x2={X(m.released)} y1={Y(m.value)} y2={Y(m.value)} className="lag" /></g>)}
      {(markers ?? []).map((m, k) => <g key={`m${k}`}><line x1={X(m.day)} x2={X(m.day)} y1={pad.t} y2={h - pad.b} className="marker" /><text x={X(m.day) + 2} y={h - 4} className="axis">{m.label}</text></g>)}
      <Cursor x0={X(0)} x1={X(days - 1)} days={days} height={h - pad.t - pad.b} top={pad.t} />
    </svg>
  );
}

export function Bars({ rows, w = 320, unit = "" }: { rows: { label: string; value: number; colour?: string }[]; w?: number; unit?: string }) {
  const labelW = 150, right = 40, signed = rows.some((r) => r.value < 0), area = w - labelW - right, zero = signed ? labelW + area / 2 : labelW;
  const max = Math.max(1e-9, ...rows.map((r) => Math.abs(r.value))), scale = (signed ? area / 2 : area) / max, rowH = 15;
  return (
    <svg viewBox={`0 0 ${w} ${rows.length * rowH + 4}`} className="chart" role="img" aria-label={rows.map((r) => `${r.label} ${r.value.toFixed(2)}${unit}`).join(", ")}>
      {signed ? <line x1={zero} x2={zero} y1={0} y2={rows.length * rowH} className="lag" /> : null}
      {rows.map((r, i) => {
        const len = scale * Math.abs(r.value), x = r.value >= 0 ? zero : zero - len;
        const label = r.label.length > 30 ? `${r.label.slice(0, 29)}…` : r.label;
        return <g key={r.label}><text x={2} y={i * rowH + 11} className="axis"><title>{r.label}</title>{label}</text><rect x={x} y={i * rowH + 3} width={Math.max(1, len)} height={9} fill={r.colour ?? "var(--accent)"} /><text x={w - right + 3} y={i * rowH + 11} className="axis">{r.value >= 0 ? "+" : ""}{r.value.toFixed(Math.abs(r.value) < 10 ? 2 : 0)}{unit}</text></g>;
      })}
    </svg>
  );
}

export function Histogram({ a, b, w = 320, h = 90, labelA, labelB }: { a: number[]; b: number[]; w?: number; h?: number; labelA: string; labelB: string }) {
  const na = a.reduce((x, y) => x + y, 0) || 1, nb = b.reduce((x, y) => x + y, 0) || 1, max = Math.max(...a.map((x) => x / na), ...b.map((x) => x / nb), 1e-9), bw = (w - 30) / a.length;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="chart" role="img" aria-label={`Dwell time distribution: ${labelA} versus ${labelB}`}>
      {b.map((v, i) => <rect key={`b${i}`} x={24 + i * bw} y={h - 14 - ((h - 22) * v) / nb / max} width={bw - 1} height={((h - 22) * v) / nb / max} className="hist-base" />)}
      {a.map((v, i) => <rect key={`a${i}`} x={24 + i * bw + bw * 0.25} y={h - 14 - ((h - 22) * v) / na / max} width={bw * 0.5} height={((h - 22) * v) / na / max} className="hist-now" />)}
      {[0, 5, 10, 15].map((d) => <text key={d} x={24 + (d / 0.5) * bw} y={h - 2} className="axis">{d}d</text>)}
    </svg>
  );
}
