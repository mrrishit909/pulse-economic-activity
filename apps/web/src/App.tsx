"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "@pulse/motion";
import { dayToIso, isoToDay } from "@pulse/domain";
import { clock, get, jump, loadBundle, selectCommodity, selectPort, selectRegion, send, set, useApp } from "./store.ts";
import { readLink, writeLink } from "./url.ts";
import { isIntro } from "./journey.ts";
import { telemetry } from "./runtime.ts";
import Intro from "./ui/Intro.tsx";
import { Banner, Inspector, LeftPanel, Notices, Timeline, TopBar } from "./ui/Panels.tsx";
import { AlertDialog, Help, Palette } from "./ui/Dialogs.tsx";
import ListView from "./ui/ListView.tsx";
import Hud from "./ui/Hud.tsx";

const Scene = dynamic(() => import("./scene/Scene.tsx"), { ssr: false });

function hasWebGL() { try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; } }

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.closest?.("dialog")) return;
      const s = get();
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || e.key === "/") { e.preventDefault(); set({ palette: true }); return; }
      if (isIntro(s.view) || e.altKey || e.metaKey || e.ctrlKey || !s.bundle) return;
      const regions = s.bundle.regions, at = regions.findIndex((r) => r.id === s.region);
      switch (e.key) {
        case " ": e.preventDefault(); set({ playing: !s.playing, speed: s.speed || 7, motionPaused: false }); break;
        case "ArrowRight": jump(Math.floor(s.simTime) + (e.shiftKey ? 30 : 1)); break;
        case "ArrowLeft": jump(Math.floor(s.simTime) - (e.shiftKey ? 30 : 1)); break;
        case "]": selectRegion(regions[(at + 1) % regions.length].id); break;
        case "[": selectRegion(regions[(at - 1 + regions.length) % regions.length].id); break;
        case "f": case "F": set({ mapMode: s.mapMode === "flat" ? "globe" : "flat" }); break;
        case "l": case "L": set({ listView: !s.listView }); break;
        case "m": case "M": set({ reduced: !s.reduced }); break;
        case "p": case "P": set({ motionPaused: !s.motionPaused, playing: false }); break;
        case "?": set({ help: true }); break;
        case "Escape": if (s.port) selectPort(null); else if (s.region) selectRegion(null); else if (s.commodity !== "all") { selectCommodity("all"); send({ type: "BACK" }); } break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Restore state from the URL once data is loaded (once), then keep the URL in step with the state. */
function useDeepLink() {
  const ready = useApp((s) => s.load.status === "ready");
  const applied = useRef(false);
  useEffect(() => {
    if (!ready || applied.current) return;
    applied.current = true;
    const l = readLink(location.search);
    if (l.rm) set({ reduced: true });
    if (l.view) set({ listView: true });
    if (l.truth) set({ showTruth: true });
    if (l.map) set({ mapMode: "flat" });
    if (l.region || l.port || l.commodity || l.enter || l.t) send({ type: "ENTER" });
    if (l.commodity) selectCommodity(l.commodity);
    if (l.port) selectPort(l.port); else if (l.region) selectRegion(l.region);
    if (l.t) jump(isoToDay(l.t));
    let last = "";
    setInterval(() => {
      const s = get();
      if (isIntro(s.view)) return;
      const link = writeLink({ t: s.playing ? undefined : dayToIso(Math.floor(s.simTime)), region: s.view === "region" ? s.region ?? undefined : undefined, port: s.view === "port" ? s.port ?? undefined : undefined,
        commodity: s.commodity !== "all" ? s.commodity : undefined, map: s.mapMode === "flat" ? "flat" : undefined, view: s.listView ? "list" : undefined, rm: s.reduced || undefined, truth: s.showTruth || undefined }) || "?enter=1";
      if (link !== last) { last = link; history.replaceState(null, "", link); }
    }, 400);
  }, [ready]);
}

export default function App() {
  const view = useApp((s) => s.view), listView = useApp((s) => s.listView), webgl = useApp((s) => s.webgl), load = useApp((s) => s.load), announce = useApp((s) => s.announce), reduced = useApp((s) => s.reduced), loaded = useApp((s) => s.bundle !== null);
  useKeyboard();
  useDeepLink();
  useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    set({ reduced: prefersReducedMotion() || readLink(location.search).rm === true, webgl: hasWebGL() ? "ok" : "unsupported" });
    const onChange = () => set({ reduced: mq.matches });
    mq.addEventListener("change", onChange);
    telemetry.start();
    loadBundle();
    // read-only handle for the e2e tests and the demo recorder
    (window as unknown as { __pulse: unknown }).__pulse = { state: get, telemetry: () => telemetry.s, clock };
    return () => mq.removeEventListener("change", onChange);
  }, []);
  useEffect(() => { document.documentElement.dataset.reduced = reduced ? "1" : "0"; }, [reduced]);
  const intro = isIntro(view), show3d = !listView && webgl === "ok";
  return (
    <div className={`app view-${view} ${intro ? "is-intro" : "is-sandbox"}`}>
      <a className="skip" href="#main-panels">Skip to the panels</a>
      {webgl !== "unsupported" ? <div className="globe-wrap" aria-hidden={!show3d} style={{ visibility: show3d || intro ? "visible" : "hidden" }}><Scene /></div> : null}
      <div className="sr-only" role="status" aria-live="polite">{announce}</div>
      {load.status === "error" ? <div className="banner warn" role="alert">Could not load the data: {load.message}. <button onClick={() => loadBundle()}>Retry</button></div> : null}
      {load.status === "loading" && !loaded ? <div className="loading" role="status">Loading two years of voyages…</div> : null}
      <Intro />
      {!intro ? (
        <>
          <TopBar />
          <Banner />
          <div id="main-panels" className="panels">
            {listView || webgl !== "ok" ? <ListView /> : null}
            <LeftPanel />
            <Inspector />
          </div>
          <Timeline />
          <Notices />
          <Hud />
        </>
      ) : null}
      <AlertDialog />
      <Palette />
      <Help />
    </div>
  );
}
