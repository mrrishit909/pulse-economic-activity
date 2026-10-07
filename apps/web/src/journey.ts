// The product's view states as a deterministic machine (packages/motion). The store asks it which view follows an event; the scene
// then animates toward the camera and layer targets of that view. Reduced motion changes how fast, never where.
import { transition, type MachineDef } from "@pulse/motion";

export type View = "intro0" | "intro1" | "intro2" | "intro3" | "explore" | "region" | "port" | "commodity";
export type JourneyEvent = { type: "CHAPTER"; n: number } | { type: "ENTER" } | { type: "REGION" } | { type: "PORT" } | { type: "COMMODITY" } | { type: "BACK" };

const intro = (n: number): View => (["intro0", "intro1", "intro2", "intro3"] as const)[Math.max(0, Math.min(3, n))];
const introState = { on: { CHAPTER: (e: { n: number }) => intro(e.n), ENTER: "explore" as View, REGION: "region" as View, PORT: "port" as View } };
const sandbox = { on: { REGION: "region" as View, PORT: "port" as View, COMMODITY: "commodity" as View, BACK: "explore" as View } };
export const journey: MachineDef<View, JourneyEvent> = {
  initial: "intro0",
  states: { intro0: introState, intro1: introState, intro2: introState, intro3: introState, explore: { on: { ...sandbox.on, BACK: "explore", CHAPTER: (e) => intro(e.n) } }, region: sandbox, port: sandbox, commodity: sandbox },
};
export const next = (v: View, e: JourneyEvent) => transition(journey, v, e);
export const isIntro = (v: View) => v.startsWith("intro");
