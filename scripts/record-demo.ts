// Records the demo scenario as a captioned video (docs/video/demo.webm; convert to mp4 with ffmpeg). Drives the static export
// served by scripts/serve.ts on :8469. Captions are an overlay injected for the recording only.
import { chromium, type Page } from "@playwright/test";
import { mkdirSync, renameSync } from "node:fs";

const url = process.env.URL ?? "http://127.0.0.1:8469/";
const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
mkdirSync("docs/video", { recursive: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: "docs/video", size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
const wait = (ms: number) => page.waitForTimeout(ms);
async function caption(p: Page, text: string, ms = 3500) {
  await p.evaluate((t) => {
    let el = document.getElementById("rec-caption");
    if (!el) { el = document.createElement("div"); el.id = "rec-caption"; el.style.cssText = "position:fixed;left:50%;bottom:112px;transform:translateX(-50%);z-index:99;max-width:820px;padding:10px 16px;border-radius:10px;background:rgba(3,5,10,.9);border:1px solid #5ef2c2;color:#e6ebf2;font:15px/1.4 system-ui;text-align:center;pointer-events:none"; document.body.appendChild(el); }
    el.textContent = t;
  }, text);
  await wait(ms);
}
type W = { __pulse?: { state: () => { load: { status: string }; bundle: { results: { lead: { pulseDay: number; leadDays: number }; congestionPeak: { day: number } } } } } };
const scrollTo = (k: number) => page.getByLabel("Introduction").evaluate((el, n) => el.querySelectorAll("[data-chapter]")[n].scrollIntoView({ behavior: "smooth" }), k);
const setDay = (d: number) => page.getByRole("slider", { name: "Simulation day" }).evaluate((el, v) => { const i = el as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(i, String(v)); i.dispatchEvent(new Event("input", { bubbles: true })); }, d);

await page.goto(url);
await page.waitForFunction(() => (window as unknown as W).__pulse?.state().load.status === "ready", null, { timeout: 60_000 });
const r = await page.evaluate(() => (window as unknown as W).__pulse!.state().bundle.results);
await caption(page, "PULSE: two years of synthetic shipping, rebuilt from noisy vessel-tracking and port-authority feeds into a live map of trade.", 5500);
await caption(page, "Every dot is a ship at sea on this day; every ribbon is a lane, as wide as its last 30 days of cargo.", 200); await scrollTo(1); await wait(5000);
await caption(page, "Crude oil highlighted: the Gulf to East Asia, India and Europe, and the US Gulf Coast to Rotterdam and Ningbo.", 5000);
await caption(page, "Ports pulse when ships wait. During a berth outage at Ningbo-Zhoushan the median stay quadrupled.", 200); await scrollTo(2); await wait(6000);
await caption(page, "The globe unrolls into a flat map on the same geometry, so nothing jumps.", 200); await scrollTo(3); await wait(5500);
await caption(page, `East Asia's activity index flagged the slump ${r.lead.leadDays} days before the official indicator showed it.`, 5000);
await page.getByRole("button", { name: "Open the analyst workspace" }).click();
await caption(page, "The workspace: commodity flows, a pulse index for nine regions with its uncertainty band, and port congestion scores.", 5000);
await page.getByRole("complementary", { name: "Markets" }).getByRole("button", { name: /Crude oil/ }).click();
await caption(page, "Choosing crude oil recolours the map and decomposes the flow by route, with a confidence on the inferred tonnage.", 6000);
await setDay(365);
await page.getByRole("button", { name: "▶▶ 30 d/s" }).click();
await caption(page, "Playback at 30 days a second: ships sail, ribbons widen and narrow, the charts' cursors move with the map.", 10000);
await page.getByRole("button", { name: "Pause", exact: true }).click();
await setDay(r.congestionPeak.day);
await page.keyboard.press("Control+k");
await page.getByPlaceholder(/Search ports/).pressSequentially("Ningbo", { delay: 90 });
await page.keyboard.press("Enter");
await caption(page, "Ningbo-Zhoushan at the outage: ships waited a median 6.4 days against 1.6 before; the histogram compares the last 14 days with the 90 before.", 9500);
await page.getByRole("button", { name: "Replay the East Asia slump" }).click();
await caption(page, "Rewind to three weeks before the slump and play at 7 days a second. Watch the pulse index for East Asia.", 13000);
await page.getByRole("button", { name: "Pause", exact: true }).click();
await caption(page, "The index crossed its alarm level while the official figure for the month was still weeks from publication.", 6000);
await page.getByRole("complementary", { name: "Inspector" }).evaluate((el) => el.scrollTo({ top: 420, behavior: "smooth" }));
await caption(page, "Every value splits into what drove it: power demand, road freight, cargo departing toward the region, arrivals and exports.", 8500);
await page.keyboard.press("Control+k");
await page.getByPlaceholder(/Search ports/).pressSequentially("Ningbo", { delay: 80 });
await page.keyboard.press("Enter");
await page.getByRole("button", { name: "Alert on abnormal congestion" }).click();
await caption(page, "An alert on abnormal congestion at Ningbo, replayed over the history: when would it have fired?", 3500);
await page.getByRole("dialog").getByRole("button", { name: "Save alert" }).click();
await caption(page, "It fires once, during the outage. Here the e-mail is simulated; the Docker stack sends it to a mail sink.", 5500);
await page.getByRole("button", { name: /Failure lab/ }).click();
await page.getByRole("menuitem", { name: "Cut the AIS feed" }).click();
await caption(page, "Failure: the vessel-tracking feed stops. The pulse runs on power and road data alone, with wider bands and lower confidence.", 9000);
await page.getByRole("alert").filter({ hasText: "AIS feed cut" }).getByRole("button", { name: "Restore" }).click();
await caption(page, "Feed restored: the vessel series return and the band narrows again.", 4000);
await page.keyboard.press("f");
await caption(page, "The flat analytical map, and every figure is also in tables (list view) for keyboard and screen-reader users.", 5000);
await page.keyboard.press("l"); await wait(3500); await page.keyboard.press("l");
await caption(page, "Synthetic data throughout. Code, tests and the write-up: github.com/mrrishit909/pulse-economic-activity.", 4500);
const v = page.video();
await ctx.close();
await browser.close();
if (v) renameSync(await v.path(), "docs/video/demo.webm");
console.log("wrote docs/video/demo.webm");
