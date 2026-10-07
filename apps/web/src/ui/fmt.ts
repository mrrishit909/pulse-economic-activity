import { dayToIso } from "@pulse/domain";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const date = (day: number) => { const s = dayToIso(Math.floor(day)); return `${+s.slice(8, 10)} ${MON[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}`; };
export const monthName = (m: string) => `${MON[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
export const n = (x: number, d = 0) => (Number.isFinite(x) ? x.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }) : "–");
export const kt = (x: number) => (x >= 1000 ? `${n(x / 1000, 2)} Mt` : `${n(x)} kt`);
export const confText = ["low", "medium", "high"] as const;
export const confIcon = ["○", "◐", "●"] as const;
export const signed = (x: number, d = 1) => `${x >= 0 ? "+" : "−"}${n(Math.abs(x), d)}`;
