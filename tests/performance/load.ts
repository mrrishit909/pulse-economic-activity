// Load test: (1) concurrent clients on the read paths; (2) ingestion: batches of 5,000 vessel events, resolved on the way in,
// from several clients at once, reported as rows per second and per day.
// node tests/performance/load.ts [base] [httpClients] [seconds] [ingestClients] [ingestSeconds]
const [base = "http://127.0.0.1:8460", clients = "32", secs = "10", ingestN = "4", ingestSecs = "15"] = process.argv.slice(2);
const H = { authorization: "Bearer meridian-viewer-demo" };
const paths = ["/v1/flows?commodity=crude&from=2026-03-01&to=2026-03-07&limit=200", "/v1/ports/CNNGB/activity?from=2026-01-01&to=2026-04-30", "/v1/regions/east-asia/pulse?from=2025-10-01&to=2026-09-30", "/v1/nowcasts?region=europe", "/v1/ports?near=31,122&km=800"];
const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];

async function reads() {
  const lat: number[] = []; let errors = 0;
  const end = Date.now() + +secs * 1000;
  await Promise.all(Array.from({ length: +clients }, async (_, c) => {
    for (let i = c; Date.now() < end; i++) {
      const t = performance.now();
      const r = await fetch(base + paths[i % paths.length], { headers: H }).catch(() => null);
      lat.push(performance.now() - t);
      if (!r || r.status >= 400) errors++;
      await r?.arrayBuffer();
    }
  }));
  return { requests: lat.length, rps: Math.round(lat.length / +secs), p50: +q(lat, 0.5).toFixed(1), p95: +q(lat, 0.95).toFixed(1), p99: +q(lat, 0.99).toFixed(1), errors };
}

async function ingest() {
  const ports = ["Port of Rotterdam", "SGSIN", "Ningbo-Zhoushan", "USLAX", "Ras Tanura (SA)"];
  const batch = (k: number) => ({ events: Array.from({ length: 5000 }, (_, i) => ({ mmsi: String(200000000 + ((k * 5000 + i) % 700000000)), name: `LOAD TEST ${i % 97}`, port: ports[i % ports.length], event: i % 2 ? "departure" : "arrival", t: new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString(), draught: 10 + (i % 9) })) });
  let rows = 0, batches = 0, errors = 0;
  const lat: number[] = [];
  const end = Date.now() + +ingestSecs * 1000;
  await Promise.all(Array.from({ length: +ingestN }, async (_, c) => {
    for (let k = c; Date.now() < end; k += +ingestN) {
      const t = performance.now();
      const r = await fetch(`${base}/v1/ingest/vessel-events`, { method: "POST", headers: { authorization: "Bearer harbor-ops-demo", "content-type": "application/json", "idempotency-key": `load-${process.pid}-${k}` }, body: JSON.stringify(batch(k)) });
      lat.push(performance.now() - t);
      if (r.status === 201) { rows += ((await r.json()) as { accepted: number }).accepted; batches++; } else { errors++; await r.arrayBuffer(); }
    }
  }));
  const perSec = rows / +ingestSecs;
  return { clients: +ingestN, batches, rows, rowsPerSec: Math.round(perSec), rowsPerDay: Math.round(perSec * 86400), batchP50Ms: +q(lat, 0.5).toFixed(0), batchP95Ms: +q(lat, 0.95).toFixed(0), errors };
}

console.log(JSON.stringify({ base, reads: await reads(), ingest: await ingest() }, null, 1));
