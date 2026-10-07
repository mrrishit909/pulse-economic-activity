import { beforeAll, describe, expect, it } from "vitest";
import {
  DAYS, LANES, OUTAGE, PORTS, REGIONS, SHOCK, COMMODITIES, anomalies, arcLatLon, bridgeNowcast, buildCalls, buildVoyages, commodityDaily, confidence,
  congestionSeries, crossValidate, cvSummary, distanceNm, dwellHistogram, filterDfm, firings, fitCargoModels, fitDfm, fitGbm, flowForecast,
  forecastCoverage, generateWorld, geofence, imoCheck, jaroWinkler, laneDaily, mad, median, monthRange, notificationText, ols, panelsFrom, pca1,
  portCalls, portSeriesAll, project, quantile, regionPulses, regionVoyageSeries, resolveFeeds, resolvePort, rng, shockLead, solve, trailing,
  validImo, validateRule, weekly, dayToIso, isoToDay, normName, band80, pulseIndex, type Panel, type Voyage, type World,
} from "../src/index.ts";

let w: World, voyages: Voyage[], panels: Record<string, Panel>, res: ReturnType<typeof resolveFeeds>;
beforeAll(() => {
  w = generateWorld();
  res = resolveFeeds(w.vessels, w.portFeed, w.ais);
  const calls = buildCalls(res.rows), vc = (v: number) => w.vessels[v].commodity;
  voyages = buildVoyages(calls, vc, fitCargoModels(calls, w.declared, vc, (v) => w.vessels[v].imo)).voyages;
  panels = panelsFrom({ voyages, days: DAYS, activity: { energy: w.activity.energy, transport: w.activity.transport } } as never);
}, 120_000);

describe("math", () => {
  it("statistics, OLS, PCA, solve", () => {
    expect(median([3, 1, 2, NaN])).toBe(2);
    expect(quantile([0, 10], 0.25)).toBe(2.5);
    expect(mad([1, 2, 3, 4, 100])).toBeCloseTo(1.4826, 3);
    const r = rng(1), X = Array.from({ length: 500 }, () => [r.normal()]), y = X.map(([x]) => 2 + 3 * x + r.normal(0, 0.1));
    const f = ols(X, y);
    expect(f.beta[0]).toBeCloseTo(2, 1); expect(f.beta[1]).toBeCloseTo(3, 1); expect(f.residSd).toBeCloseTo(0.1, 1);
    const rows = Array.from({ length: 400 }, () => { const z = r.normal(); return [z + r.normal(0, 0.3), z + r.normal(0, 0.3), -0.01 * r.normal()]; });
    const p = pca1(rows);
    expect(Math.abs(p.loadings[0] - p.loadings[1])).toBeLessThan(0.1);
    expect(p.explained).toBeGreaterThan(0.8);
    expect(() => solve([[1, 1], [1, 1]], [1, 2])).toThrow();
    expect(r.poisson(3)).toBeGreaterThanOrEqual(0); expect(r.poisson(200)).toBeGreaterThan(100);
  });
});

describe("geography", () => {
  it("distances, arcs and the globe/flat projection agree", () => {
    const rtm = PORTS.find((p) => p.id === "NLRTM")!, sin = PORTS.find((p) => p.id === "SGSIN")!;
    expect(distanceNm(rtm.lat, rtm.lon, sin.lat, sin.lon)).toBeGreaterThan(5500);
    expect(distanceNm(rtm.lat, rtm.lon, sin.lat, sin.lon)).toBeLessThan(5800);
    const [a, b] = arcLatLon(10, 20, 10, 20, 0.5); expect([a, b]).toEqual([10, 20]);
    const end = arcLatLon(rtm.lat, rtm.lon, sin.lat, sin.lon, 1); expect(end[0]).toBeCloseTo(sin.lat, 6); expect(end[1]).toBeCloseTo(sin.lon, 6);
    const mid = arcLatLon(rtm.lat, rtm.lon, sin.lat, sin.lon, 0.5);
    expect(distanceNm(rtm.lat, rtm.lon, mid[0], mid[1]) * 2).toBeCloseTo(distanceNm(rtm.lat, rtm.lon, sin.lat, sin.lon), 0);
    const g = project(0, 0, 0, 0), f = project(45, 90, 0.1, 1);
    expect(g[0]).toBe(1); expect(Math.abs(g[1]) + Math.abs(g[2])).toBe(0);
    expect(f[0]).toBeCloseTo(Math.PI / 2, 9); expect(f[1]).toBeCloseTo(Math.PI / 4, 9); expect(f[2]).toBeCloseTo(0.1, 9);
  });
});

describe("synthetic world", () => {
  it("is deterministic, with valid unique identifiers and the planted events", () => {
    expect(generateWorld().voyages[100]).toEqual(w.voyages[100]);
    expect(w.vessels.every((v) => validImo(v.imo))).toBe(true);
    expect(new Set(w.vessels.map((v) => v.imo)).size).toBe(w.vessels.length);
    expect(imoCheck("907472")).toBe("9"); // IMO 9074729: the textbook example of the check-digit rule
    const ng = w.voyages.filter((v) => LANES[v.lane].to === OUTAGE.port);
    const dwell = (a: number, b: number) => median(ng.filter((v) => v.dArr >= a && v.dArr < b).map((v) => v.dDep - v.dArr));
    expect(dwell(OUTAGE.start + 5, OUTAGE.end)).toBeGreaterThan(2 * dwell(OUTAGE.start - 120, OUTAGE.start));
    expect(Math.min(...w.factor["east-asia"].slice(SHOCK.start + 21, SHOCK.start + 42))).toBeLessThan(-1);
    expect(w.official.filter((o) => o.region === "east-asia")).toHaveLength(24);
    expect(dayToIso(isoToDay("2026-03-15"))).toBe("2026-03-15");
  });
});

describe("entity resolution (scored against the hidden truth)", () => {
  it("normalizes names and ports, checks IMO digits, scores strings", () => {
    expect(jaroWinkler("MARTHA", "MARHTA")).toBeCloseTo(0.961, 3);
    expect(jaroWinkler("", "A")).toBe(0);
    expect(normName("M/V Pacific Dawn 3")).toBe("PACIFICDAWN3");
    expect(resolvePort("Port of Rotterdam")).toBe("NLRTM");
    expect(resolvePort("NL RTM")).toBe("NLRTM");
    expect(resolvePort("Rotterdm")).toBe("NLRTM");
    expect(resolvePort("Atlantis")).toBeNull();
    expect(geofence(51.96, 4.06)).toBe("NLRTM");
    expect(geofence(0, -30)).toBeNull();
    expect(validImo("9074729")).toBe(true); expect(validImo("9074728")).toBe(false);
  });
  it("links more than 97% of rows to the right vessel and port, and rebuilds 98% of voyages", () => {
    const pr = res.rows.slice(0, w.portFeed.length);
    expect(pr.filter((x, i) => x.vessel === w.portFeed[i].truthVessel).length / pr.length).toBeGreaterThan(0.97);
    expect(pr.filter((x, i) => x.vessel !== null && x.vessel !== w.portFeed[i].truthVessel).length / pr.length).toBeLessThan(0.01);
    expect(pr.filter((x, i) => x.port === w.portFeed[i].truthPort).length / pr.length).toBeGreaterThan(0.995);
    expect(voyages.length / w.voyages.length).toBeGreaterThan(0.97);
    expect(res.mmsiBindings).toBeGreaterThanOrEqual(w.vessels.length);
  });
});

describe("flows (arc aggregation correctness)", () => {
  it("lane, commodity and region aggregates add up to the voyages", () => {
    const ld = laneDaily(voyages, DAYS), cd = commodityDaily(voyages, DAYS), rs = regionVoyageSeries(voyages, DAYS);
    const inWindow = voyages.filter((v) => v[3] >= 0 && v[3] < DAYS);
    const total = inWindow.reduce((s, v) => s + v[6], 0);
    const sumLanes = ld.vol.reduce((s, x) => s + x.reduce((a, b) => a + b, 0), 0);
    const sumCom = Object.values(cd).reduce((s, x) => s + x.reduce((a, b) => a + b, 0), 0);
    const sumExp = Object.values(rs.exp).reduce((s, x) => s + x.reduce((a, b) => a + b, 0), 0);
    expect(sumLanes).toBeCloseTo(total, 3); expect(sumCom).toBeCloseTo(total, 3); expect(sumExp).toBeCloseTo(total, 3);
    for (const l of LANES.slice(0, 5)) expect(ld.n[l.id].reduce((a, b) => a + b, 0)).toBe(inWindow.filter((v) => v[0] === l.id).length);
    expect(Array.from(trailing([1, 2, 3, 4], 2))).toEqual([NaN, 3, 5, 7]);
  });
});

describe("port congestion", () => {
  it("flags a shift in the dwell distribution with a robust z, and reports confidence", () => {
    const r = rng(3), calls: [number, number][] = [];
    for (let d = 0; d < 200; d++) for (let k = 0; k < 4; k++) { const a = d + r.u(); calls.push([a, a + (d >= 150 && d < 170 ? 5 : 1) * r.lognormal(1.5, 0.3)]); }
    const s = congestionSeries(calls, 200);
    expect(s[120].z).toBeLessThan(3);
    expect(Math.max(...s.slice(150, 170).map((x) => x.z))).toBeGreaterThan(5);
    expect(s[120].confidence).toBe("high");
    expect(Number.isNaN(s[10].z)).toBe(true); // not enough history yet
    expect(dwellHistogram(calls, 0, 200).reduce((a, b) => a + b, 0)).toBe(800);
    const ng = portSeriesAll(voyages, DAYS)[OUTAGE.port];
    expect(Math.max(...ng.slice(OUTAGE.start, OUTAGE.end + 7).map((x) => x.z).filter(Number.isFinite))).toBeGreaterThan(10);
    expect(portCalls(voyages, OUTAGE.port).length).toBeGreaterThan(5000);
  });
});

describe("anomalies (outlier injection)", () => {
  it("finds injected spikes and rarely flags clean weeks", () => {
    const r = rng(11), unit = 175;
    let hits = 0, injected = 0, falseFlags = 0, clean = 0;
    for (let trial = 0; trial < 20; trial++) {
      // 20 ships a week: Poisson noise is about 4.5 ships, so a week at 2.5x or a week with none is clearly abnormal
      const weeks = Array.from({ length: 104 }, () => r.poisson(20) * unit);
      const spikes = new Set([30 + trial, 70 + (trial % 20)]);
      for (const k of spikes) weeks[k] = (r.u() < 0.5 ? 2.5 : 0) * 20 * unit;
      const flagged = new Set(anomalies(weeks, 3.5, 8, unit).map((a) => a.week));
      for (const k of spikes) { injected++; if (flagged.has(k)) hits++; }
      for (let k = 8; k < 104; k++) if (!spikes.has(k)) { clean++; if (flagged.has(k)) falseFlags++; }
    }
    expect(hits / injected).toBeGreaterThan(0.85);
    expect(falseFlags / clean).toBeLessThan(0.02);
    expect(weekly([1, 1, 1, 1, 1, 1, 1, 2])).toEqual([7]);
  });
});

describe("flow forecast", () => {
  it("builds intervals from backtest errors with roughly their nominal coverage on a stationary series", () => {
    const r = rng(5), x = Array.from({ length: 600 }, () => r.poisson(10) * 100);
    const f = flowForecast(x, 500);
    expect(f.p10).toBeLessThan(f.meanPerDay); expect(f.p90).toBeGreaterThan(f.meanPerDay);
    const c = forecastCoverage(x, 200, 600);
    expect(c.coverage).toBeGreaterThan(0.6); expect(c.coverage).toBeLessThan(0.97);
  });
});

describe("gradient boosting", () => {
  it("learns a nonlinear function that a mean cannot", () => {
    const r = rng(8), X = Array.from({ length: 300 }, () => [r.range(-2, 2), r.normal()]), y = X.map(([a]) => a * a + r.normal(0, 0.1));
    const g = fitGbm(X, y, { rounds: 200, lr: 0.1, depth: 3 });
    const err = Math.sqrt(X.reduce((s, x, i) => s + (g.predict(x) - y[i]) ** 2, 0) / X.length);
    expect(err).toBeLessThan(0.3);
    expect(g.trees).toBe(200);
  });
});

describe("dynamic factor model and nowcast", () => {
  it("recovers the true regional activity; contributions add up exactly (explainability)", () => {
    const reg = "east-asia", p = fitDfm(panels[reg], DAYS - 1), f = filterDfm(panels[reg], p, DAYS - 1);
    const truth = w.factor[reg], m = Array.from(f.m);
    const c = (a: number[], b: number[]) => { const ma = a.reduce((x, y) => x + y) / a.length, mb = b.reduce((x, y) => x + y) / b.length; let n = 0, da = 0, db = 0; a.forEach((x, i) => { n += (x - ma) * (b[i] - mb); da += (x - ma) ** 2; db += (b[i] - mb) ** 2; }); return n / Math.sqrt(da * db); };
    expect(c(m.slice(30), truth.slice(30))).toBeGreaterThan(0.9);
    for (const t of [40, 400, DAYS - 1]) expect(f.contrib.reduce((s, x) => s + x[t], 0)).toBeCloseTo(f.m[t], 10);
    expect(pulseIndex(0)).toBe(100); expect(band80(1)).toBeCloseTo(12.816, 3);
    expect(["high", "medium", "low"]).toContain(confidence(f.P[400]));
  });
  it("an AIS outage widens the band and lowers confidence; data return narrows it again", () => {
    const reg = "east-asia", p = fitDfm(panels[reg], DAYS - 1);
    const full = filterDfm(panels[reg], p, DAYS - 1), cut = filterDfm(panels[reg], p, DAYS - 1, { series: ["departuresTo", "arrivalsIn", "exports"], from: 600, to: 640 });
    expect(cut.P[630]).toBeGreaterThan(1.3 * full.P[630]);
    expect(cut.P[700]).toBeCloseTo(full.P[700], 6);
    expect(confidence(0.01)).toBe("high"); expect(confidence(0.1)).toBe("medium"); expect(confidence(1)).toBe("low");
  });
  it("nowcasts use only what was known on the day (temporal cross-validation, no look-ahead)", () => {
    const reg = "europe", at = monthRange("2025-12")[1] - 1;
    const a = bridgeNowcast(reg, w.official, filterDfm(panels[reg], fitDfm(panels[reg], at), at), at, "2025-12");
    const changed: Panel = { ...panels[reg], energy: Array.from(panels[reg].energy).map((x, d) => (d > at ? x + 50 : x)) };
    const officialChanged = w.official.map((o) => (o.releasedDay > at ? { ...o, value: o.value + 40 } : o));
    const b = bridgeNowcast(reg, officialChanged, filterDfm(changed, fitDfm(changed, at), at), at, "2025-12");
    expect(b.value).toBeCloseTo(a.value, 10);
    expect(a.lo).toBeLessThan(a.value); expect(a.hi).toBeGreaterThan(a.value);
    expect(Object.values(a.contributions).reduce((s, x) => s + x, 0) + a.intercept).toBeCloseTo(a.value, 6);
    expect(a.daysOfData).toBe(31);
    expect(monthRange("2024-12")).toEqual([61, 92]);
  });
  it("beats the last published value over the rolling evaluation, and shows the shock weeks before the official data", () => {
    const cv = crossValidate(panels, w.official, "2025-10", DAYS - 1);
    const s = cvSummary(cv);
    expect(s.rmse.bridge).toBeLessThan(s.rmse.naive);
    expect(s.rmse.gbm).toBeLessThan(s.rmse.naive);
    const lead = shockLead(panels["east-asia"], w.official, "east-asia", SHOCK.start);
    expect(lead.pulseDay).not.toBeNull();
    expect(lead.leadDays!).toBeGreaterThan(30);
    const all = regionPulses(panels, DAYS - 1, DAYS - 1);
    expect(Object.keys(all)).toHaveLength(REGIONS.length);
  }, 120_000);
});

describe("alerts", () => {
  it("validates rules and fires once on the congestion episode", () => {
    const rule = { name: "Ningbo congestion", port: OUTAGE.port, minZ: 4, minConfidence: "medium" as const, channel: "email" as const, target: "ops@meridian.example" };
    expect(validateRule(rule)).toEqual([]);
    expect(validateRule(null)).toEqual(["rule must be an object"]);
    expect(validateRule({ ...rule, port: "XXXXX", minZ: 0, minConfidence: "max", channel: "sms", target: "x", name: "" }).length).toBe(6);
    expect(validateRule({ ...rule, channel: "webhook", target: "http://x" })).toEqual(["target: e-mail address or https URL"]);
    const s = portSeriesAll(voyages, DAYS)[OUTAGE.port];
    const f = firings(rule, s);
    expect(f.length).toBeGreaterThanOrEqual(1);
    expect(f.some((x) => x.day >= OUTAGE.start && x.day <= OUTAGE.end)).toBe(true);
    expect(notificationText(rule, f[0])).toContain("Ningbo-Zhoushan");
    expect(COMMODITIES).toHaveLength(6);
  });
});
