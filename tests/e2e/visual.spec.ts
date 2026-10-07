// Visual regression on key motion states (settled, reduced motion): crude flows on the globe, the flat map, a congested port.
import { expect, test } from "@playwright/test";
import { ready } from "./helpers.ts";

test.use({ reducedMotion: "reduce" });
test("crude flows, flat map, congested port", async ({ page }) => {
  await ready(page, "/?commodity=crude&t=2026-03-17&rm=1");
  await page.waitForTimeout(1500);
  await expect(page.locator(".globe")).toHaveScreenshot("crude-globe.png", { maxDiffPixelRatio: 0.05 });
  await ready(page, "/?map=flat&t=2026-03-17&rm=1&enter=1");
  await page.waitForTimeout(1500);
  await expect(page.locator(".globe")).toHaveScreenshot("flat-map.png", { maxDiffPixelRatio: 0.05 });
  await ready(page, "/?port=CNNGB&t=2026-03-17&rm=1");
  await page.waitForTimeout(1200);
  await expect(page.getByRole("complementary", { name: "Inspector" })).toHaveScreenshot("port-card.png");
});
