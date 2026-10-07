// Realistic failures, demonstrated and recovered: the AIS feed stops (the nowcast runs on the remaining series with wider bands),
// the data service goes down (backoff and reload), the GPU context is lost (list view, then back).
import { expect, test } from "@playwright/test";
import { band, ready, state } from "./helpers.ts";

test("AIS outage widens the pulse band and lowers confidence; restoring narrows it", async ({ page }) => {
  await ready(page, "/?enter=1&region=east-asia");
  const day = (await state(page)).now as number;
  const before = (await band(page, "east-asia", day)) as number;
  await page.getByRole("button", { name: /Failure lab/ }).click();
  await page.getByRole("menuitem", { name: "Cut the AIS feed" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "AIS feed cut" })).toBeVisible();
  await expect.poll(async () => (await band(page, "east-asia", day)) as number).toBeGreaterThan(before * 1.1);
  await page.getByRole("alert").filter({ hasText: "AIS feed cut" }).getByRole("button", { name: "Restore" }).click();
  await expect.poll(async () => (await band(page, "east-asia", day)) as number).toBeCloseTo(before, 4);
});

test("data service outage: retries with backoff, recovers", async ({ page }) => {
  await ready(page, "/?enter=1");
  await page.getByRole("button", { name: /Failure lab/ }).click();
  await page.getByRole("menuitem", { name: "Take the data service down" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Data service unavailable" })).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => ((await state(page)).feed as { status: string }).status).toBe("retrying");
  await page.getByRole("button", { name: /Failure lab/ }).click();
  await page.getByRole("menuitem", { name: "Bring the data service back" }).click();
  await expect(page.getByText(/Data service recovered/).first()).toBeVisible({ timeout: 30_000 });
});

test("GPU context loss falls back to the list view and comes back", async ({ page }) => {
  await ready(page, "/?enter=1");
  const ok = await page.evaluate(() => !!document.querySelector<HTMLCanvasElement>(".globe canvas")?.getContext("webgl2")?.getExtension("WEBGL_lose_context"));
  test.skip(!ok, "no WEBGL_lose_context");
  await page.evaluate(() => { const w = window as unknown as { __lose: WEBGL_lose_context }; w.__lose = document.querySelector<HTMLCanvasElement>(".globe canvas")!.getContext("webgl2")!.getExtension("WEBGL_lose_context")!; w.__lose.loseContext(); });
  await expect.poll(async () => (await state(page)).webgl).toBe("lost");
  await expect(page.getByRole("main", { name: "List view" })).toContainText("GPU context was lost");
  await page.evaluate(() => (window as unknown as { __lose: WEBGL_lose_context }).__lose.restoreContext());
  await expect.poll(async () => (await state(page)).webgl).toBe("ok");
});
