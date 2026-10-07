// Geography shared by the generator, the API and the shaders (the GLSL in apps/web mirrors arcPoint and project exactly).
export const DEG = Math.PI / 180;
const R_NM = 3440.065; // Earth radius in nautical miles

/** Great-circle distance in nautical miles. */
export function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const a = Math.sin(((lat2 - lat1) * DEG) / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Unit vector (x toward lon 0, y up the axis, z toward lon -90) for a latitude/longitude. */
export function unitVec(lat: number, lon: number): [number, number, number] {
  return [Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.sin(lat * DEG), -Math.cos(lat * DEG) * Math.sin(lon * DEG)];
}

/** Point at fraction t along the great circle (spherical linear interpolation), as latitude/longitude. */
export function arcLatLon(lat0: number, lon0: number, lat1: number, lon1: number, t: number): [number, number] {
  const a = unitVec(lat0, lon0), b = unitVec(lat1, lon1);
  const d = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  if (d < 1e-9) return [lat0, lon0];
  const s0 = Math.sin((1 - t) * d) / Math.sin(d), s1 = Math.sin(t * d) / Math.sin(d);
  const p = [a[0] * s0 + b[0] * s1, a[1] * s0 + b[1] * s1, a[2] * s0 + b[2] * s1];
  return [Math.asin(p[1]) / DEG, Math.atan2(-p[2], p[0]) / DEG];
}

/** Scene position: globe radius R (morph 0) or flat equirectangular map of width 2πR (morph 1), lifted by h. */
export function project(lat: number, lon: number, h: number, morph: number, R = 1): [number, number, number] {
  const u = unitVec(lat, lon);
  const g = [u[0] * (R + h), u[1] * (R + h), u[2] * (R + h)];
  const f = [lon * DEG * R, lat * DEG * R, h];
  return [g[0] + (f[0] - g[0]) * morph, g[1] + (f[1] - g[1]) * morph, g[2] + (f[2] - g[2]) * morph];
}
