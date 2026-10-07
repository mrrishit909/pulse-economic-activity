// Section 16: playback synchronization between map and charts under 100 ms, and a stress scene (10x the ships) with its cost.
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { ready } from "./helpers.ts";

test("map and chart cursors stay within 100 ms of each other while playing at 30 days a second", async ({ page }) => {
  await ready(page, "/?enter=1&region=east-asia&t=2026-01-01");
  await page.getByRole("button", { name: "▶▶ 30 d/s" }).click();
  await page.waitForTimeout(500);
  const skews: number[] = [];
  for (let i = 0; i < 40; i++) {
    const s = await page.evaluate(() => new Promise<number>((ok) => requestAnimationFrame(() => {
      const map = (window as unknown as { __pulse: { clock: { t: number } } }).__pulse.clock.t;
      const cursors = [...document.querySelectorAll<SVGLineElement>("[data-cursor]")].map((c) => +(c.dataset.day ?? NaN)).filter(Number.isFinite);
      ok(Math.max(...cursors.map((c) => Math.abs(c - map))));
    })));
    skews.push((s / 30) * 1000); // days apart -> milliseconds of playback
    await page.waitForTimeout(50);
  }
  const worst = Math.max(...skews);
  console.log(`worst map/chart skew ${worst.toFixed(1)} ms over ${skews.length} samples`);
  expect(worst).toBeLessThan(100);
  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/sync-e2e.json", JSON.stringify({ speedDaysPerSecond: 30, samples: skews.length, worstSkewMs: +worst.toFixed(1) }, null, 1));
});

test("stress: ten times the ships on the GPU", async ({ page }) => {
  await ready(page, "/?enter=1");
  await page.getByRole("button", { name: /Failure lab/ }).click();
  await page.getByRole("menuitem", { name: /Stress test/ }).click();
  await page.getByRole("button", { name: "▶ 7 d/s" }).click();
  await page.getByRole("button", { name: "Telemetry" }).click();
  await page.waitForTimeout(4000);
  const t = await page.evaluate(() => (window as unknown as { __pulse: { telemetry: () => Record<string, unknown> } }).__pulse.telemetry());
  expect(t.objects as number).toBeGreaterThan(400000);
  expect(t.fps as number).toBeGreaterThan(0);
  writeFileSync("docs/performance-e2e.json", JSON.stringify({ note: "headless Chrome with SwiftShader (software GL): FPS is a floor, not a GPU figure", ...t }, null, 1));
});
