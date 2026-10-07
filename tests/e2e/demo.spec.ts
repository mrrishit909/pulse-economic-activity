// Blueprint 04, section 17: the demo scenario end to end.
import { expect, test } from "@playwright/test";
import { ready, results, setDay, state } from "./helpers.ts";

test("world map -> crude flows -> congested port -> rewind to the shock -> pulse before the official figure -> congestion alert", async ({ page }) => {
  await ready(page);
  // 1. live-style world map, told as a story
  await expect(page.getByRole("heading", { name: /Trade moves before the statistics do/ })).toBeVisible();
  const intro = page.getByLabel("Introduction");
  for (const n of [1, 2, 3]) {
    await intro.evaluate((el, k) => el.querySelectorAll("[data-chapter]")[k].scrollIntoView(), n);
    await expect.poll(async () => (await state(page)).view).toBe(`intro${n}`);
  }
  await expect.poll(async () => (await state(page)).mapMode).toBe("flat");
  await page.getByRole("button", { name: "Open the analyst workspace" }).click();
  await expect.poll(async () => (await state(page)).view).toBe("explore");

  // 2. choose crude oil: flows recolour, the inspector decomposes the routes
  await page.getByRole("complementary", { name: "Markets" }).getByRole("button", { name: /Crude oil/ }).click();
  await expect.poll(async () => (await state(page)).commodity).toBe("crude");
  const insp = page.getByRole("complementary", { name: "Inspector" });
  await expect(insp.getByRole("heading", { name: /Crude oil/ })).toBeVisible();
  await expect(insp).toContainText("Route decomposition");
  await expect(insp).toContainText(/Ras Tanura → Ningbo/);
  await expect(insp).toContainText(/90%, cargo estimated from draught/); // data-confidence on an inferred metric

  // 3. a port with simulated congestion: search for it at the peak of the berth outage
  const r = await results(page);
  await setDay(page, r.congestionPeak.day);
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/Search ports/).fill("Ningbo");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await state(page)).port).toBe("CNNGB");
  await expect(insp).toContainText("congested");
  await expect(insp).toContainText(/Dwell times/);
  await expect(insp.getByRole("img", { name: /Dwell time distribution/ })).toBeVisible();

  // 4-5. rewind to the synthetic shock and play: the pulse alarm fires before the official figure appears
  await page.getByRole("button", { name: "Replay the East Asia slump" }).click();
  await expect.poll(async () => (await state(page)).region).toBe("east-asia");
  await expect.poll(async () => (await state(page)).simTime as number, { timeout: 30_000 }).toBeGreaterThan(r.lead.pulseDay + 3);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(insp).toContainText(`${r.lead.leadDays} days later`);
  await expect(insp).toContainText(/Official figure not out yet/);
  await expect(insp.getByRole("img", { name: /East Asia pulse index/ })).toBeVisible();

  // deep link restores the region view at the paused day
  await expect.poll(() => page.url()).toContain("region=east-asia");
  const link = page.url();

  // 6. alert on abnormal port congestion; replayed over the history it fires during the outage
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/Search ports/).fill("Ningbo");
  await page.keyboard.press("Enter");
  await insp.getByRole("button", { name: "Alert on abnormal congestion" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save alert" }).click();
  await expect(page.getByRole("log", { name: "Notifications" })).toContainText("Simulated e-mail");
  await expect(page.getByRole("log", { name: "Notifications" })).toContainText(/Ningbo-Zhoushan congestion z/);

  await ready(page, link.replace("http://127.0.0.1:8469", ""));
  await expect.poll(async () => (await state(page)).view).toBe("region");
  await expect.poll(async () => (await state(page)).region).toBe("east-asia");
});
