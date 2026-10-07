"use client";
// The public story, four chapters scrolled over the live map. Scrolling moves the camera and the clock: chapter 3 jumps to the
// Ningbo berth outage, chapter 4 unrolls the globe into the flat map. Every number comes from the loaded bundle.
import { useEffect, useRef } from "react";
import { get, jump, selectCommodity, selectRegion, send, set, useApp } from "../store.ts";
import { date, n } from "./fmt.ts";

type Lead = { pulseDay: number; officialDay: number; officialMonth: string; leadDays: number };
type Peak = { port: string; day: number; z: number; dwellMedian: number; baselineMedian: number };

export default function Intro() {
  const ref = useRef<HTMLDivElement>(null);
  const bundle = useApp((s) => s.bundle);
  const view = useApp((s) => s.view);
  const lead = bundle?.results.lead as Lead | undefined, peak = bundle?.results.congestionPeak as Peak | undefined;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const secs = [...el.querySelectorAll<HTMLElement>("[data-chapter]")], mid = el.scrollTop + el.clientHeight * 0.5;
      let chapter = 0;
      secs.forEach((s, i) => { if (mid >= s.offsetTop) chapter = i; });
      const s = get();
      if (s.view === `intro${chapter}` || !s.bundle) return;
      send({ type: "CHAPTER", n: chapter });
      const r = s.bundle.results as unknown as { congestionPeak: Peak; lead: Lead };
      // the clock and filters follow the story
      if (chapter <= 1) { jump(s.bundle.now); selectCommodity(chapter === 1 ? "crude" : "all"); set({ mapMode: "globe" }); }
      if (chapter === 2) { jump(r.congestionPeak.day); selectCommodity("all"); set({ mapMode: "globe" }); }
      if (chapter === 3) { jump(r.lead.pulseDay); set({ mapMode: "flat" }); }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  const go = (k: number) => ref.current?.querySelectorAll<HTMLElement>("[data-chapter]")[k]?.scrollIntoView({ behavior: get().reduced ? "auto" : "smooth" });
  const enter = (shock: boolean) => {
    const s = get();
    send({ type: "ENTER" });
    set({ mapMode: "globe" });
    selectCommodity("all");
    if (shock && lead) { selectRegion("east-asia"); jump(lead.pulseDay - 21); set({ playing: true, speed: 7 }); } else jump(s.bundle?.now ?? 0);
  };
  return (
    <div className="intro" ref={ref} aria-label="Introduction" hidden={!view.startsWith("intro")}>
      <section data-chapter="0" className="chapter">
        <p className="kicker">PULSE · global economic activity</p>
        <h1>Trade moves before the statistics do.</h1>
        <p>{bundle ? n(bundle.voyages.length) : "45,758"} voyages by {bundle ? n(bundle.vessels.length) : "3,455"} ships between {bundle?.ports.length ?? 34} ports over two years, rebuilt from noisy vessel-tracking and port feeds. Scroll.</p>
        <p className="badge-line"><span className="badge">SYNTHETIC DATA</span> Ports are at real coordinates; every ship, cargo, activity series and official figure is generated.</p>
        <button className="ghost" onClick={() => go(1)}>Start</button>
      </section>
      <section data-chapter="1" className="chapter">
        <h2>Every particle is a ship at sea.</h2>
        <p>Its position is its voyage on this day; the ribbon under it is as wide as the lane's last 30 days of cargo. Crude oil is highlighted: from the Gulf to East Asia, India and Europe, and from the US Gulf Coast.</p>
        <p className="legend">{bundle?.commodities.map((c) => <span key={c.key}><span className="sw" style={{ background: c.colour }} /> {c.name}</span>)}</p>
      </section>
      <section data-chapter="2" className="chapter">
        <h2>Ports pulse when ships wait.</h2>
        <p>{peak ? <>On {date(peak.day)} ships at Ningbo-Zhoushan waited a median {n(peak.dwellMedian, 1)} days against {n(peak.baselineMedian, 1)} in the months before: a congestion score of {n(peak.z, 1)}. The faster a port pulses, the further its dwell times sit above normal.</> : "…"}</p>
      </section>
      <section data-chapter="3" className="chapter">
        <h2>The pulse saw the slump {lead ? lead.leadDays : "…"} days before the official figure.</h2>
        <p>{lead ? <>East Asia's activity index, filtered day by day from power, road-freight and shipping data with a model fitted only on what came before, crossed its alarm level on {date(lead.pulseDay)}. The official indicator showed the drop when the {lead.officialMonth} figure was published on {date(lead.officialDay)}.</> : null}</p>
        <div className="cta">
          <button className="primary" onClick={() => enter(false)}>Open the analyst workspace</button>
          <button className="ghost" onClick={() => enter(true)}>Replay the slump in East Asia</button>
        </div>
      </section>
    </div>
  );
}
