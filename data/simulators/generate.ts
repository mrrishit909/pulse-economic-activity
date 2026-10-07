// Synthetic data generator + pipeline run: world -> raw feeds -> entity resolution -> voyages -> evaluation -> data/fixtures.
// node data/simulators/generate.ts   (deterministic for a seed; writes bundle.json, feeds.ndjson.gz for the API seed, provenance.json)
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import {
  COMMODITIES, DAYS, LANES, OUTAGE, PORTS, REGIONS, SHOCK, anomalies, buildCalls, buildVoyages, commodityDaily, crossValidate, cvSummary,
  fitCargoModels, forecastCoverage, generateWorld, laneDaily, panelsFrom, portSeriesAll, resolveFeeds, shockLead, weekly, type Bundle,
} from "../../packages/domain/src/index.ts";

const out = new URL("../fixtures/", import.meta.url);
mkdirSync(out, { recursive: true });
const seed = Number(process.env.SEED ?? 20261006);
const t0 = Date.now();
const w = generateWorld(seed);
const res = resolveFeeds(w.vessels, w.portFeed, w.ais);
const calls = buildCalls(res.rows);
const vc = (v: number) => w.vessels[v].commodity;
const models = fitCargoModels(calls, w.declared, vc, (v) => w.vessels[v].imo);
const { voyages, unknownLane } = buildVoyages(calls, vc, models);

// ---- score the pipeline against the hidden truth ----
const byMmsi = new Map<string, number>();
for (const v of w.vessels) { byMmsi.set(v.mmsi, v.idx); if (v.mmsi2) byMmsi.set(v.mmsi2, v.idx); }
const pr = res.rows.slice(0, w.portFeed.length), ar = res.rows.slice(w.portFeed.length);
const truthIdx = new Map<string, number>();
w.voyages.forEach((v, i) => truthIdx.set(`${v.vessel}|${Math.round(v.oDep * 4)}`, i));
let matched = 0;
const cargoErr: number[] = [];
for (const v of voyages) {
  const k = Math.round(v[3] * 4), i = truthIdx.get(`${v[1]}|${k}`) ?? truthIdx.get(`${v[1]}|${k - 1}`) ?? truthIdx.get(`${v[1]}|${k + 1}`);
  if (i === undefined || w.voyages[i].lane !== v[0]) continue;
  matched++;
  cargoErr.push(Math.abs(v[6] - w.voyages[i].cargoKt) / w.voyages[i].cargoKt);
}
cargoErr.sort((a, b) => a - b);
const pipeline = {
  rawRows: { portFeed: w.portFeed.length, ais: w.ais.length },
  portAliasAccuracy: pr.filter((x, i) => x.port === w.portFeed[i].truthPort).length / pr.length,
  portFeedVessel: { correct: pr.filter((x, i) => x.vessel === w.portFeed[i].truthVessel).length / pr.length, unresolved: pr.filter((x) => x.vessel === null).length / pr.length, wrong: pr.filter((x, i) => x.vessel !== null && x.vessel !== w.portFeed[i].truthVessel).length / pr.length },
  aisVessel: { correct: ar.filter((x, i) => x.vessel === byMmsi.get(w.ais[i].mmsi)).length / ar.length, unresolved: ar.filter((x) => x.vessel === null).length / ar.length },
  mmsiBindings: res.mmsiBindings, vessels: w.vessels.length, reflagged: w.vessels.filter((v) => v.mmsi2).length,
  calls: calls.length, voyages: voyages.length, trueVoyages: w.voyages.length, unknownLane,
  voyageRecall: matched / w.voyages.length, voyagePrecision: matched / voyages.length,
  cargoAbsPctErr: { median: cargoErr[cargoErr.length >> 1], p90: cargoErr[Math.floor(cargoErr.length * 0.9)] },
  cargoModels: models,
};

// ---- models and their evaluation ----
const bundleCore = { voyages, days: DAYS, activity: { energy: w.activity.energy, transport: w.activity.transport } } as never;
const panels = panelsFrom(bundleCore);
const cv = crossValidate(panels, w.official, "2025-06", DAYS - 1);
const lead = shockLead(panels["east-asia"], w.official, "east-asia", SHOCK.start);
const leadEurope = shockLead(panels.europe, w.official, "europe", SHOCK.start);
const ports = portSeriesAll(voyages, DAYS);
const lanes = laneDaily(voyages, DAYS);
const anom = LANES.flatMap((l) => anomalies(weekly(lanes.vol[l.id]), 3.5, 8, COMMODITIES.find((c) => c.key === l.commodity)!.shipKt).map((a) => ({ lane: l.id, ...a })));
const cd = commodityDaily(voyages, DAYS);
const forecast = Object.fromEntries(COMMODITIES.map((c) => [c.key, forecastCoverage(cd[c.key], 200, DAYS)]));
const ng = ports[OUTAGE.port];
const peak = ng.reduce((b, d, i) => (Number.isFinite(d.z) && (b < 0 || d.z > ng[b].z) ? i : b), -1);

const round = (x: number, k = 3) => (Number.isFinite(x) ? +x.toFixed(k) : null);
const bundle: Bundle = {
  version: "pulse-bundle-v1", seed, start: w.start, days: DAYS, now: DAYS - 1,
  regions: REGIONS, ports: PORTS, commodities: COMMODITIES, lanes: LANES,
  vessels: w.vessels.map((v) => [v.name, v.commodity]),
  voyages,
  activity: { energy: Object.fromEntries(REGIONS.map((g) => [g.id, w.activity.energy[g.id].map((x) => round(x))])), transport: Object.fromEntries(REGIONS.map((g) => [g.id, w.activity.transport[g.id].map((x) => round(x))])) },
  official: w.official.map(({ truthMean: _t, ...o }) => o),
  truth: { factor: Object.fromEntries(REGIONS.map((g) => [g.id, w.factor[g.id].map((x) => +x.toFixed(3))])), shock: { start: SHOCK.start, regions: SHOCK.depth }, outage: OUTAGE },
  results: {
    cv, cvSummary: cvSummary(cv), cvByRegion: Object.fromEntries(REGIONS.map((g) => [g.id, cvSummary(cv.filter((r) => r.region === g.id))])),
    lead, leadEurope, pipeline,
    congestionPeak: { port: OUTAGE.port, day: peak, z: ng[peak].z, dwellMedian: ng[peak].dwellMedian, baselineMedian: ng[OUTAGE.start - 20].dwellMedian },
    anomalies: anom, forecastCoverage80: forecast,
  },
};
const s = JSON.stringify(bundle);
writeFileSync(new URL("bundle.json", out), s);
// raw feeds for the API seed (resolved rows alongside), gzipped NDJSON
const feeds = res.rows.map((r, i) => JSON.stringify(i < w.portFeed.length ? { src: "port", raw: { ...w.portFeed[i], truthVessel: undefined, truthPort: undefined }, vessel: r.vessel, port: r.port, how: r.how } : { src: "ais", raw: w.ais[i - w.portFeed.length], vessel: r.vessel, port: r.port, how: r.how })).join("\n");
writeFileSync(new URL("feeds.ndjson.gz", out), gzipSync(feeds));
writeFileSync(new URL("provenance.json", out), JSON.stringify({
  datasets: [
    { name: "synthetic world (vessels, voyages, AIS and port-authority feeds, activity series, official indicator)", provider: "packages/domain/src/world.ts", license: "MIT (generated)", seed, start: w.start, days: DAYS, sha256: createHash("sha256").update(s).digest("hex") },
    { name: "port locations", provider: "public geography (approximate terminal coordinates); activity at them is invented", license: "facts" },
  ],
  qualityChecks: { ...pipeline, cargoModels: undefined, voyagesSortedByDeparture: voyages.every((v, i) => !i || voyages[i - 1][3] <= v[3]), allLanesKnown: voyages.every((v) => v[0] >= 0 && v[0] < LANES.length) },
  generatedInMs: Date.now() - t0,
}, null, 1));
console.log(JSON.stringify({ voyages: voyages.length, bytes: s.length, cv: cvSummary(cv), lead, leadEurope, peak: bundle.results.congestionPeak, anomalies: anom.length, forecast, recall: pipeline.voyageRecall, ms: Date.now() - t0 }));
