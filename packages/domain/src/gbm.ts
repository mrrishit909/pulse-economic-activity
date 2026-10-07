// Gradient boosting with shallow regression trees (squared error). Small on purpose: a few hundred rows, a handful of features.
type Node = { f: number; t: number; l: Node; r: Node } | { v: number };

function grow(X: number[][], y: number[], idx: number[], depth: number, minLeaf: number): Node {
  const mean = idx.reduce((s, i) => s + y[i], 0) / idx.length;
  if (depth === 0 || idx.length < 2 * minLeaf) return { v: mean };
  let best = { sse: Infinity, f: -1, t: 0, l: [] as number[], r: [] as number[] };
  for (let f = 0; f < X[0].length; f++) {
    const s = [...idx].filter((i) => Number.isFinite(X[i][f])).sort((a, b) => X[a][f] - X[b][f]);
    let sl = 0, ql = 0, st = 0, qt = 0;
    for (const i of s) { st += y[i]; qt += y[i] ** 2; }
    for (let k = 0; k < s.length - 1; k++) {
      sl += y[s[k]]; ql += y[s[k]] ** 2;
      const nl = k + 1, nr = s.length - nl;
      if (nl < minLeaf || nr < minLeaf || X[s[k]][f] === X[s[k + 1]][f]) continue;
      const sse = ql - sl * sl / nl + (qt - ql) - (st - sl) ** 2 / nr;
      if (sse < best.sse) best = { sse, f, t: (X[s[k]][f] + X[s[k + 1]][f]) / 2, l: s.slice(0, nl), r: s.slice(nl) };
    }
  }
  if (best.f < 0) return { v: mean };
  return { f: best.f, t: best.t, l: grow(X, y, best.l, depth - 1, minLeaf), r: grow(X, y, best.r, depth - 1, minLeaf) };
}
const evalNode = (n: Node, x: number[]): number => ("v" in n ? n.v : Number.isFinite(x[n.f]) && x[n.f] <= n.t ? evalNode(n.l, x) : evalNode(n.r, x));

export function fitGbm(X: number[][], y: number[], o: { rounds?: number; lr?: number; depth?: number; minLeaf?: number } = {}) {
  const rounds = o.rounds ?? 150, lr = o.lr ?? 0.05, depth = o.depth ?? 2, minLeaf = o.minLeaf ?? 5;
  const base = y.reduce((a, b) => a + b, 0) / y.length;
  const pred = y.map(() => base), trees: Node[] = [], idx = y.map((_, i) => i);
  for (let k = 0; k < rounds; k++) {
    const res = y.map((v, i) => v - pred[i]);
    const tree = grow(X, res, idx, depth, minLeaf);
    trees.push(tree);
    for (const i of idx) pred[i] += lr * evalNode(tree, X[i]);
  }
  return { predict: (x: number[]) => base + lr * trees.reduce((s, t) => s + evalNode(t, x), 0), trees: trees.length };
}
