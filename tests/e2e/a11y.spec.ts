// Reduced motion keeps every fact and task; keyboard alone runs the workspace; the list view replaces the map.
import { expect, test } from "@playwright/test";
import { ready, state } from "./helpers.ts";

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("states land instantly and the story still carries its numbers", async ({ page }) => {
    await ready(page);
    expect((await state(page)).reduced).toBe(true);
    await page.getByLabel("Introduction").evaluate((el) => el.querySelectorAll("[data-chapter]")[3].scrollIntoView());
    await expect(page.getByRole("heading", { name: /days before the official figure/ })).toBeVisible();
    await page.getByRole("button", { name: "Replay the slump in East Asia" }).click();
    await expect(page.getByRole("complementary", { name: "Inspector" })).toContainText(/days later/);
  });
});

test("keyboard only: regions, flat map, list view, help, back", async ({ page }) => {
  await ready(page, "/?enter=1");
  await expect.poll(async () => (await state(page)).view).toBe("explore");
  await page.keyboard.press("]");
  await expect.poll(async () => (await state(page)).view).toBe("region");
  const first = (await state(page)).region;
  await page.keyboard.press("]");
  await expect.poll(async () => (await state(page)).region).not.toBe(first);
  await page.keyboard.press("f");
  await expect.poll(async () => (await state(page)).mapMode).toBe("flat");
  const t = (await state(page)).simTime as number;
  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(async () => (await state(page)).simTime).toBe(Math.floor(t) - 30);
  await page.keyboard.press("l");
  await expect(page.getByRole("main", { name: "List view" })).toContainText("Regional pulse index");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await state(page)).view).toBe("explore");
  const unnamed = await page.locator("button:visible").evaluateAll((bs) => bs.filter((b) => !(b.textContent ?? "").trim() && !b.getAttribute("aria-label")).length);
  expect(unnamed).toBe(0);
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard" })).toBeVisible();
});
