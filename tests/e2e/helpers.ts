import { expect, type Page } from "@playwright/test";

type H = { __pulse?: { state: () => Record<string, unknown>; clock: { t: number }; telemetry: () => Record<string, unknown> } };
export const state = (page: Page) => page.evaluate(() => {
  const h = (window as unknown as H).__pulse;
  if (!h) return { load: { status: "booting" } } as Record<string, unknown>;
  const s = h.state();
  return { view: s.view, load: s.load, feed: s.feed, ais: s.ais, simTime: s.simTime, playing: s.playing, commodity: s.commodity, region: s.region, port: s.port, mapMode: s.mapMode, reduced: s.reduced, listView: s.listView, webgl: s.webgl, notices: (s.notices as unknown[]).length, now: (s.window as { now: number }).now };
});
export const band = (page: Page, region: string, day: number) => page.evaluate(([r, d]) => (window as unknown as H).__pulse!.state().pulses && ((window as unknown as H).__pulse!.state().pulses as Record<string, { band: Float32Array }>)[r as string].band[d as number], [region, day] as const);
export async function ready(page: Page, url = "/") {
  await page.goto(url);
  await expect.poll(async () => (await state(page)).load, { timeout: 60_000 }).toMatchObject({ status: "ready" });
}
export const results = (page: Page) => page.evaluate(() => (window as unknown as H).__pulse!.state().bundle && ((window as unknown as H).__pulse!.state().bundle as { results: Record<string, unknown> }).results) as Promise<{ lead: { pulseDay: number; officialDay: number; leadDays: number }; congestionPeak: { day: number; z: number } }>;
/** Move the range input like a user dragging it (fires React's onChange). */
export const setDay = (page: Page, day: number) => page.getByRole("slider", { name: "Simulation day" }).evaluate((el, d) => {
  const input = el as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(d));
  input.dispatchEvent(new Event("input", { bubbles: true }));
}, day);
