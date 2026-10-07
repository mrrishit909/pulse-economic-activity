"use client";
// The map: Earth as one mesh that morphs between globe and flat map, lane ribbons as wide as their 30-day volume, every ship at
// sea as a particle on its route, ports that pulse when ships wait. The canvas is a view of the store.
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { project, unitVec, LANES, PORTS, COMMODITIES, OUTAGE } from "@pulse/domain";
import { get, selectPort, set, useApp } from "../store.ts";
import { advance, clock, orchestrator, telemetry } from "../runtime.ts";
import { isIntro, type View } from "../journey.ts";
import { MAX_LANES, earthMaterial, portMaterial, ribbonMaterial, vesselMaterial } from "./materials.ts";

const DEG = Math.PI / 180;
type Cam = [number, number, number, number, number, number]; // camera position, target

/** Camera for a view: on the globe a point above (lat, lon) at distance d, on the flat map straight down at (lon, lat). */
export function camFor(lat: number, lon: number, d: number, morph: number): Cam {
  const u = unitVec(lat, lon), g: Cam = [u[0] * d, u[1] * d, u[2] * d, 0, 0, 0];
  const f: Cam = [lon * DEG, lat * DEG - 0.12 * d, d * 0.95, lon * DEG, lat * DEG, 0];
  return g.map((x, i) => x + (f[i] - x) * morph) as Cam;
}
const focus = { lat: 20, lon: 60, d: 3.4 }; // the user's own pan/zoom, on top of the view's target

function viewTarget(v: View): { lat: number; lon: number; d: number; morph: number } {
  const s = get(), morph = s.mapMode === "flat" ? 1 : 0;
  const reg = s.bundle?.regions.find((r) => r.id === s.region), port = s.bundle?.ports.find((p) => p.id === s.port);
  switch (v) {
    case "intro0": return { lat: 22, lon: 70, d: 3.9, morph: 0 };
    case "intro1": return { lat: 24, lon: 78, d: 2.9, morph: 0 };
    case "intro2": return { lat: 30, lon: 123, d: 2.0, morph: 0 };
    case "intro3": return { lat: 20, lon: 75, d: 3.6, morph: 1 };
    case "region": return reg ? { lat: reg.lat, lon: reg.lon, d: morph ? 1.8 : 2.1, morph } : { ...focus, morph };
    case "port": return port ? { lat: port.lat, lon: port.lon, d: morph ? 1.0 : 1.5, morph } : { ...focus, morph };
    default: return { lat: 18, lon: 60, d: morph ? 4.2 : 3.4, morph };
  }
}

function Stars() {
  const g = useMemo(() => {
    const n = 2500, pos = new Float32Array(n * 3);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) { const u = rnd() * 2 - 1, th = rnd() * 2 * Math.PI, r = Math.sqrt(1 - u * u), R = 60 + 30 * rnd(); pos.set([R * r * Math.cos(th), R * u, R * r * Math.sin(th)], i * 3); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); return geo;
  }, []);
  const ref = useRef<THREE.PointsMaterial>(null);
  useFrame(() => { if (ref.current) ref.current.opacity = 0.7 * (1 - (orchestrator.get("morph")?.[0] ?? 0)); });
  return <points geometry={g}><pointsMaterial ref={ref} size={1.2} sizeAttenuation={false} color="#c8d3e6" transparent opacity={0.7} depthWrite={false} /></points>;
}

function Earth({ lowDetail }: { lowDetail: boolean }) {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const { main, strip, geo, stripGeo } = useMemo(() => {
    const tex = new THREE.TextureLoader().load(`${base}/textures/earth-day-${lowDetail ? "1k" : "2k"}.jpg`);
    tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = THREE.RepeatWrapping; tex.anisotropy = 4;
    return { main: earthMaterial(tex, 0), strip: earthMaterial(tex, 360), geo: new THREE.PlaneGeometry(1, 1, lowDetail ? 128 : 256, lowDetail ? 64 : 128), stripGeo: new THREE.PlaneGeometry(1, 1, 64, 128) };
  }, [base, lowDetail]);
  // the strip repeats longitudes 180..270 to the right of the flat map, so trans-Pacific routes stay on a map; hidden on the globe
  useMemo(() => { const uv = stripGeo.getAttribute("uv") as THREE.BufferAttribute; for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 0.25); }, [stripGeo]);
  useFrame(() => {
    const m = orchestrator.get("morph")?.[0] ?? 0, dim = ["port", "region"].includes(get().view) ? 0.3 : 0;
    for (const mat of [main, strip]) { mat.uniforms.uMorph.value = m; mat.uniforms.uDim.value = dim; }
  });
  return <><mesh geometry={geo} material={main} frustumCulled={false} /><mesh geometry={stripGeo} material={strip} frustumCulled={false} renderOrder={-1} /></>;
}

function laneUniforms(mats: THREE.ShaderMaterial[]) {
  const s = get(), d = Math.max(0, Math.min(s.window.end, Math.floor(clock.t)));
  for (const m of mats) {
    LANES.forEach((l, i) => {
      const a = PORTS.find((p) => p.id === l.from)!, b = PORTS.find((p) => p.id === l.to)!, c = COMMODITIES.find((x) => x.key === l.commodity)!;
      (m.uniforms.uLanes.value[i] as THREE.Vector4).set(a.lat, a.lon, b.lat, b.lon);
      (m.uniforms.uColor.value[i] as THREE.Color).set(c.colour);
      const kt = (s.derived?.lane30[i][d] ?? 0) / 30;
      m.uniforms.uWidth.value[i] = 0.0015 + 0.0009 * Math.sqrt(kt);
      m.uniforms.uMask.value[i] = s.commodity === "all" || s.commodity === l.commodity ? 1 : 0.07;
    });
  }
}

function Flows() {
  const voyages = useApp((s) => s.bundle?.voyages ?? null);
  const stress = useApp((s) => s.stress);
  const { gl, size } = useThree();
  const ribbon = useMemo(() => ribbonMaterial(), []), vessels = useMemo(() => vesselMaterial(), []);
  const ribbonGeo = useMemo(() => {
    const N = 64, lane: number[] = [], t: number[] = [], side: number[] = [], idx: number[] = [];
    LANES.forEach((_, li) => {
      const base = lane.length;
      for (let k = 0; k <= N; k++) for (const sd of [-1, 1]) { lane.push(li); t.push(k / N); side.push(sd); }
      for (let k = 0; k < N; k++) { const a = base + 2 * k; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(lane.length * 3), 3));
    g.setAttribute("aLane", new THREE.Float32BufferAttribute(lane, 1)); g.setAttribute("aT", new THREE.Float32BufferAttribute(t, 1)); g.setAttribute("aSide", new THREE.Float32BufferAttribute(side, 1));
    g.setIndex(idx);
    return g;
  }, []);
  const vesselGeo = useMemo(() => {
    if (!voyages) return null;
    const k = stress ? 10 : 1, n = voyages.length * k;
    const aLane = new Float32Array(n), aDep = new Float32Array(n), aArr = new Float32Array(n), aCargo = new Float32Array(n), aSeed = new Float32Array(n);
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let r = 0; r < k; r++) voyages.forEach((v, i) => {
      const j = r * voyages.length + i, shift = r ? (rnd() - 0.5) * 20 : 0; // stress copies: same routes, shifted in time
      aLane[j] = v[0]; aDep[j] = v[3] + shift; aArr[j] = v[4] + shift; aCargo[j] = v[6]; aSeed[j] = rnd();
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    for (const [name, a] of Object.entries({ aLane, aDep, aArr, aCargo, aSeed })) g.setAttribute(name, new THREE.BufferAttribute(a, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
    return g;
  }, [voyages, stress]);
  const last = useRef(0);
  useFrame((_, dt) => {
    const m = orchestrator.get("morph")?.[0] ?? 0;
    ribbon.uniforms.uMorph.value = m; vessels.uniforms.uMorph.value = m;
    vessels.uniforms.uT.value = clock.t;
    vessels.uniforms.uScale.value = Math.min(2, gl.getPixelRatio()) * (size.width < 700 ? 0.8 : 1);
    last.current += dt;
    if (last.current > 0.2) { last.current = 0; laneUniforms([ribbon, vessels]); }
  });
  useEffect(() => { laneUniforms([ribbon, vessels]); }, [ribbon, vessels, voyages]);
  return (
    <>
      <mesh geometry={ribbonGeo} material={ribbon} frustumCulled={false} />
      {vesselGeo ? <points geometry={vesselGeo} material={vessels} frustumCulled={false} /> : null}
    </>
  );
}

function Ports() {
  const derived = useApp((s) => s.derived);
  const portSel = useApp((s) => s.port);
  const { gl, camera, size } = useThree();
  const mat = useMemo(() => portMaterial(), []);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(PORTS.length * 3), 3));
    g.setAttribute("aIdx", new THREE.Float32BufferAttribute(PORTS.map((_, i) => i), 1));
    g.setAttribute("aLat", new THREE.Float32BufferAttribute(PORTS.map((p) => p.lat), 1));
    g.setAttribute("aLon", new THREE.Float32BufferAttribute(PORTS.map((p) => p.lon), 1));
    return g;
  }, []);
  useEffect(() => { mat.uniforms.uSelected.value = portSel ? PORTS.findIndex((p) => p.id === portSel) : -1; }, [portSel, mat]);
  // click: nearest port on screen within 16 px (34 ports: a projection loop is cheaper than GPU picking)
  useEffect(() => {
    const el = gl.domElement;
    let down: [number, number] | null = null;
    const onDown = (e: PointerEvent) => { down = [e.clientX, e.clientY]; };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || isIntro(get().view)) return;
      const r = el.getBoundingClientRect(), m = orchestrator.get("morph")?.[0] ?? 0;
      let best: [number, string | null] = [16, null];
      const camDir = camera.position.clone().normalize();
      for (const p of PORTS) {
        const v = new THREE.Vector3(...project(p.lat, p.lon, 0.006, m));
        if (m < 0.5 && v.clone().normalize().dot(camDir) < 0.1) continue; // far side of the globe
        v.project(camera);
        const d = Math.hypot((v.x * 0.5 + 0.5) * r.width - (e.clientX - r.left), (-v.y * 0.5 + 0.5) * r.height - (e.clientY - r.top));
        if (d < best[0]) best = [d, p.id];
      }
      if (best[1]) selectPort(best[1]);
    };
    el.addEventListener("pointerdown", onDown); el.addEventListener("pointerup", onUp);
    return () => { el.removeEventListener("pointerdown", onDown); el.removeEventListener("pointerup", onUp); };
  }, [gl, camera]);
  useFrame((st) => {
    const s = get(), d = Math.max(0, Math.min(s.window.end, Math.floor(clock.t)));
    mat.uniforms.uMorph.value = orchestrator.get("morph")?.[0] ?? 0;
    mat.uniforms.uWall.value = s.motionPaused ? 0 : st.clock.elapsedTime;
    mat.uniforms.uReduced.value = s.reduced ? 1 : 0;
    mat.uniforms.uScale.value = Math.min(2, gl.getPixelRatio()) * (size.width < 700 ? 0.8 : 1);
    if (derived) PORTS.forEach((p, i) => {
      const a = derived.ports[p.id].arrivals; let n = 0;
      for (let k = Math.max(0, d - 29); k <= d; k++) n += a[k];
      mat.uniforms.uSize.value[i] = Math.min(1, Math.sqrt(n / 30 / 12));
      const z = derived.ports[p.id].z[d];
      mat.uniforms.uZ.value[i] = Number.isFinite(z) ? z : 0;
    });
  });
  return <points geometry={geo} material={mat} frustumCulled={false} />;
}

function CameraRig() {
  const { camera, gl } = useThree();
  const lastKey = useRef("");
  useEffect(() => {
    const el = gl.domElement;
    let drag: [number, number] | null = null;
    const down = (e: PointerEvent) => { drag = [e.clientX, e.clientY]; };
    const move = (e: PointerEvent) => {
      if (!drag || isIntro(get().view)) return;
      const dx = e.clientX - drag[0], dy = e.clientY - drag[1];
      drag = [e.clientX, e.clientY];
      const k = get().mapMode === "flat" ? 0.12 * focus.d : 0.25 * focus.d;
      focus.lon -= dx * k; focus.lat = Math.max(-75, Math.min(80, focus.lat + dy * k * (get().mapMode === "flat" ? -1 : 1)));
      orchestrator.set("cam", camFor(focus.lat, focus.lon, focus.d, orchestrator.get("morph")?.[0] ?? 0));
    };
    const up = () => { drag = null; };
    const wheel = (e: WheelEvent) => {
      if (isIntro(get().view)) return;
      e.preventDefault();
      focus.d = Math.max(get().mapMode === "flat" ? 0.4 : 1.15, Math.min(6, focus.d * Math.exp(e.deltaY * 0.001)));
      orchestrator.set("cam", camFor(focus.lat, focus.lon, focus.d, orchestrator.get("morph")?.[0] ?? 0));
    };
    el.addEventListener("pointerdown", down); window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); el.addEventListener("wheel", wheel, { passive: false });
    return () => { el.removeEventListener("pointerdown", down); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); el.removeEventListener("wheel", wheel); };
  }, [gl]);
  useFrame((_, dt) => {
    const s = get();
    orchestrator.policy.reduced = s.reduced; orchestrator.policy.paused = s.motionPaused;
    advance(dt * 1000, performance.now());
    orchestrator.tick(Math.min(100, dt * 1000));
    telemetry.frame(performance.now());
    const key = `${s.view}|${s.mapMode}|${s.region}|${s.port}`;
    if (key !== lastKey.current) {
      const t = viewTarget(s.view);
      Object.assign(focus, { lat: t.lat, lon: t.lon, d: t.d });
      if (!orchestrator.get("morph")) orchestrator.set("morph", [t.morph]);
      // camera and morph travel together, so the map unwraps around the same place the globe was showing
      orchestrator.to("morph", [t.morph], 1400);
      const camNow = orchestrator.get("cam");
      if (!camNow) orchestrator.set("cam", camFor(t.lat, t.lon, t.d, t.morph)); else orchestrator.to("cam", camFor(t.lat, t.lon, t.d, t.morph), 1400);
      lastKey.current = key;
    }
    // while the morph tweens and the user is not dragging, keep the camera on the morphing surface
    if (orchestrator.busy("morph") && !orchestrator.busy("cam")) orchestrator.set("cam", camFor(focus.lat, focus.lon, focus.d, orchestrator.get("morph")![0]));
    const c = orchestrator.get("cam")!;
    camera.position.set(c[0], c[1], c[2]);
    camera.up.set(0, 1, 0);
    camera.lookAt(c[3], c[4], c[5]);
  });
  return null;
}

function TelemetryProbe() {
  const { gl } = useThree();
  useEffect(() => {
    requestAnimationFrame(() => telemetry.mark("sceneLoadMs", performance.now()));
    const el = gl.domElement;
    const lost = (e: Event) => { e.preventDefault(); telemetry.contextLost(); set({ webgl: "lost" }); };
    const restored = () => set({ webgl: "ok" });
    el.addEventListener("webglcontextlost", lost); el.addEventListener("webglcontextrestored", restored);
    const iv = setInterval(() => {
      const i = gl.info, s = get();
      telemetry.sample({ calls: i.render.calls, triangles: i.render.triangles, points: i.render.points, geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs?.length ?? 0 }, (s.bundle?.voyages.length ?? 0) * (s.stress ? 10 : 1));
    }, 500);
    const flush = setInterval(() => telemetry.flush(), 30000);
    return () => { clearInterval(iv); clearInterval(flush); el.removeEventListener("webglcontextlost", lost); el.removeEventListener("webglcontextrestored", restored); };
  }, [gl]);
  return null;
}

export const OUTAGE_PORT = OUTAGE.port;

export default function Scene() {
  const lowDetail = typeof window !== "undefined" && (window.innerWidth < 700 || (navigator.hardwareConcurrency ?? 8) <= 4);
  return (
    <Canvas className="globe" aria-hidden dpr={[1, lowDetail ? 1.5 : 2]} gl={{ antialias: !lowDetail, powerPreference: "high-performance", preserveDrawingBuffer: true }}
      camera={{ fov: 40, near: 0.01, far: 500, position: [0, 0, 4] }}
      onCreated={({ gl, scene, camera }) => { gl.setClearColor("#03050a"); const t0 = performance.now(); gl.compile(scene, camera); telemetry.mark("shaderCompileMs", performance.now() - t0); }}>
      <TelemetryProbe />
      <Stars />
      <Earth lowDetail={lowDetail} />
      <Flows />
      <Ports />
      <CameraRig />
    </Canvas>
  );
}
