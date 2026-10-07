// Shaders. Every position is computed on the GPU from latitude/longitude with the same formulas as packages/domain/src/geo.ts,
// so the globe and the flat map are one geometry with a morph uniform, and a vessel's place on its route is a function of
// the simulation day (scrubbing backwards moves ships backwards).
import * as THREE from "three";

export const MAX_LANES = 64;
export const MAX_PORTS = 40;

const GEO = /* glsl */ `
  const float DEG = 0.017453292519943295;
  uniform float uMorph;
  vec3 unitVec(float lat, float lon) { return vec3(cos(lat * DEG) * cos(lon * DEG), sin(lat * DEG), -cos(lat * DEG) * sin(lon * DEG)); }
  vec3 projectP(float lat, float lon, float h) {
    vec3 g = unitVec(lat, lon) * (1.0 + h);
    vec3 f = vec3(lon * DEG, lat * DEG, h);
    return mix(g, f, uMorph);
  }
  // point at fraction t of the great circle; longitude unwrapped relative to the start so the flat map draws it continuously
  vec2 arcLatLon(vec4 lane, float t) {
    vec3 a = unitVec(lane.x, lane.y), b = unitVec(lane.z, lane.w);
    float d = acos(clamp(dot(a, b), -1.0, 1.0));
    vec3 p = d < 1e-5 ? a : (sin((1.0 - t) * d) * a + sin(t * d) * b) / sin(d);
    float lat = asin(clamp(p.y, -1.0, 1.0)) / DEG, lon = atan(-p.z, p.x) / DEG;
    float dl = lon - lane.y;
    lon = lane.y + dl - 360.0 * floor((dl + 180.0) / 360.0);
    return vec2(lat, lon);
  }
  float arcAngle(vec4 lane) { return acos(clamp(dot(unitVec(lane.x, lane.y), unitVec(lane.z, lane.w)), -1.0, 1.0)); }
  vec3 arcPoint(vec4 lane, float t) { vec2 ll = arcLatLon(lane, t); return projectP(ll.x, ll.y, 0.16 * arcAngle(lane) / 3.14159 * sin(3.14159 * t) + 0.004); }
  vec3 sideAt(vec4 lane, float t) {
    vec3 p = arcPoint(lane, t), q = arcPoint(lane, min(1.0, t + 0.01)), r = arcPoint(lane, max(0.0, t - 0.01));
    vec3 up = normalize(mix(normalize(p), vec3(0.0, 0.0, 1.0), uMorph));
    return normalize(cross(q - r, up));
  }`;

const LANE_UNIFORMS = `uniform vec4 uLanes[${MAX_LANES}]; uniform float uWidth[${MAX_LANES}]; uniform float uMask[${MAX_LANES}]; uniform vec3 uColor[${MAX_LANES}];`;

export function earthMaterial(day: THREE.Texture, lonOffset: number) {
  return new THREE.ShaderMaterial({
    transparent: lonOffset !== 0,
    uniforms: { uDay: { value: day }, uMorph: { value: 0 }, uOffset: { value: lonOffset }, uDim: { value: 0 } },
    vertexShader: /* glsl */ `
      ${GEO}
      uniform float uOffset;
      varying vec2 vUv; varying float vShade;
      void main() {
        float lon = -180.0 + 360.0 * uv.x + uOffset, lat = -90.0 + 180.0 * uv.y;
        vUv = vec2((lon + 180.0) / 360.0, uv.y);
        vec3 p = projectP(lat, lon, 0.0);
        vShade = mix(0.55 + 0.45 * max(0.0, dot(normalize(p), normalize(vec3(0.5, 0.6, 0.6)))), 1.0, uMorph);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uDay; uniform float uMorph; uniform float uOffset; uniform float uDim;
      varying vec2 vUv; varying float vShade;
      void main() {
        vec3 t = texture2D(uDay, vUv).rgb;
        float g = dot(t, vec3(0.3, 0.59, 0.11));
        vec3 col = (mix(vec3(g), t, 0.35) * 0.5 + vec3(0.012, 0.025, 0.05)) * vShade * (1.0 - 0.45 * uDim);
        float a = uOffset != 0.0 ? smoothstep(0.6, 0.95, uMorph) : 1.0;
        gl_FragColor = vec4(col, a);
      }`,
  });
}

export function ribbonMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uMorph: { value: 0 }, uLanes: { value: new Array(MAX_LANES).fill(0).map(() => new THREE.Vector4()) }, uWidth: { value: new Array(MAX_LANES).fill(0) }, uMask: { value: new Array(MAX_LANES).fill(1) }, uColor: { value: new Array(MAX_LANES).fill(0).map(() => new THREE.Color()) } },
    vertexShader: /* glsl */ `
      ${GEO}
      ${LANE_UNIFORMS}
      attribute float aLane; attribute float aT; attribute float aSide;
      varying float vAlpha; varying vec3 vColor; varying float vEdge;
      void main() {
        int i = int(aLane + 0.5);
        vec4 lane = uLanes[i];
        vec3 p = arcPoint(lane, aT) + sideAt(lane, aT) * aSide * 0.5 * uWidth[i];
        vAlpha = 0.13 * uMask[i]; vColor = uColor[i]; vEdge = aSide;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying float vAlpha; varying vec3 vColor; varying float vEdge;
      void main() { gl_FragColor = vec4(vColor, vAlpha * (1.0 - abs(vEdge) * 0.7)); }`,
  });
}

export function vesselMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uMorph: { value: 0 }, uT: { value: 0 }, uScale: { value: 1 }, uLanes: { value: new Array(MAX_LANES).fill(0).map(() => new THREE.Vector4()) }, uWidth: { value: new Array(MAX_LANES).fill(0) }, uMask: { value: new Array(MAX_LANES).fill(1) }, uColor: { value: new Array(MAX_LANES).fill(0).map(() => new THREE.Color()) } },
    vertexShader: /* glsl */ `
      ${GEO}
      ${LANE_UNIFORMS}
      uniform float uT; uniform float uScale;
      attribute float aLane; attribute float aDep; attribute float aArr; attribute float aCargo; attribute float aSeed;
      varying vec3 vColor; varying float vAlpha;
      void main() {
        float f = (uT - aDep) / max(1e-3, aArr - aDep);
        int i = int(aLane + 0.5);
        if (f < 0.0 || f > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; } // not at sea on this day
        vec4 lane = uLanes[i];
        vec3 p = arcPoint(lane, f) + sideAt(lane, f) * (aSeed - 0.5) * 0.8 * uWidth[i];
        vColor = uColor[i]; vAlpha = uMask[i];
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (1.6 + 3.2 * sqrt(aCargo / 270.0)) * uScale;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor; varying float vAlpha;
      void main() { float r = length(gl_PointCoord - 0.5); if (r > 0.5) discard; gl_FragColor = vec4(vColor, vAlpha * smoothstep(0.5, 0.0, r)); }`,
  });
}

export function portMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uMorph: { value: 0 }, uScale: { value: 1 }, uWall: { value: 0 }, uReduced: { value: 0 }, uSelected: { value: -1 }, uSize: { value: new Array(MAX_PORTS).fill(0) }, uZ: { value: new Array(MAX_PORTS).fill(0) } },
    vertexShader: /* glsl */ `
      ${GEO}
      uniform float uScale; uniform float uSize[${MAX_PORTS}]; uniform float uZ[${MAX_PORTS}]; uniform float uSelected;
      attribute float aIdx; attribute float aLat; attribute float aLon;
      varying float vZ; varying float vSel;
      void main() {
        int i = int(aIdx + 0.5);
        vec3 p = projectP(aLat, aLon, 0.006);
        vZ = uZ[i]; vSel = abs(aIdx - uSelected) < 0.5 ? 1.0 : 0.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (8.0 + 18.0 * uSize[i]) * uScale;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uWall; uniform float uReduced;
      varying float vZ; varying float vSel;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        if (r > 0.5) discard;
        float level = clamp((vZ - 2.0) / 6.0, 0.0, 1.0);
        vec3 col = vZ >= 4.0 ? vec3(1.0, 0.42, 0.35) : vZ >= 2.0 ? vec3(1.0, 0.75, 0.33) : vec3(0.85, 0.92, 1.0);
        float core = smoothstep(0.16, 0.1, r);
        // congestion: a slow pulse (under 1 Hz, faster when worse); reduced motion shows a static ring whose width carries the level
        float ringW = uReduced > 0.5 ? 0.04 + 0.1 * level : 0.05;
        float phase = uReduced > 0.5 || vZ < 2.0 ? 1.0 : 0.5 + 0.5 * sin(6.2832 * (0.25 + 0.35 * level) * uWall);
        float ringR = uReduced > 0.5 || vZ < 2.0 ? 0.38 : 0.22 + 0.24 * (1.0 - phase);
        float ring = smoothstep(ringW, 0.0, abs(r - ringR)) * (vZ >= 2.0 ? 0.5 + 0.5 * phase : 0.35);
        float sel = vSel * smoothstep(0.03, 0.0, abs(r - 0.47));
        gl_FragColor = vec4(mix(col, vec3(1.0), sel), max(core, max(ring, sel)));
      }`,
  });
}
