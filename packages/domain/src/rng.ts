// Seeded randomness: every generated world, feed and scenario is reproducible from its seed.

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = ReturnType<typeof rng>;

export function rng(seed: number) {
  const u = mulberry32(seed);
  const r = {
    u,
    range: (a: number, b: number) => a + (b - a) * u(),
    int: (a: number, b: number) => Math.floor(a + (b - a + 1) * u()),
    pick: <T>(xs: readonly T[]) => xs[Math.floor(u() * xs.length)],
    normal: (m = 0, s = 1) => m + s * Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u()),
    /** Poisson draw (Knuth for small means, normal approximation above 50). */
    poisson(lambda: number) {
      if (lambda > 50) return Math.max(0, Math.round(r.normal(lambda, Math.sqrt(lambda))));
      const L = Math.exp(-lambda); let k = 0, p = 1;
      do { k++; p *= u(); } while (p > L);
      return k - 1;
    },
    lognormal: (median: number, sigma: number) => median * Math.exp(sigma * r.normal()),
  };
  return r;
}

/** Deterministic uuid-shaped id from (kind, n), so ids are stable across runs and databases. */
export function uuidFor(kind: number, n: number) {
  const h = (x: number) => (x >>> 0).toString(16).padStart(8, "0");
  let a = (n * 2654435761) ^ (kind * 40503);
  a = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  const b = Math.imul(n + 0x9e3779b9, 0x85ebca6b) ^ kind;
  return `${h(a)}-${h(n).slice(4)}-4${h(kind).slice(5)}-8${h(b).slice(5)}-${h(b ^ a)}${h(n).slice(4)}`;
}
