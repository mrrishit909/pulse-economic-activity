// Deep links: the state that matters is in the query string, so any view can be shared and restored.
export interface LinkState { t?: string; region?: string; port?: string; commodity?: string; map?: "flat"; view?: "list"; rm?: boolean; enter?: boolean; truth?: boolean }

export function readLink(search: string): LinkState {
  const q = new URLSearchParams(search), s: LinkState = {};
  const t = q.get("t"); if (t && /^\d{4}-\d{2}-\d{2}$/.test(t)) s.t = t;
  const region = q.get("region"); if (region && /^[a-z-]{3,20}$/.test(region)) s.region = region;
  const port = q.get("port"); if (port && /^[A-Z]{5}$/.test(port)) s.port = port;
  const c = q.get("commodity"); if (c && /^[a-z]{2,12}$/.test(c)) s.commodity = c;
  if (q.get("map") === "flat") s.map = "flat";
  if (q.get("view") === "list") s.view = "list";
  if (q.get("rm") === "1") s.rm = true;
  if (q.get("enter") === "1") s.enter = true;
  if (q.get("truth") === "1") s.truth = true;
  return s;
}

export function writeLink(s: LinkState): string {
  const q = new URLSearchParams();
  for (const k of ["t", "region", "port", "commodity", "map", "view"] as const) if (s[k]) q.set(k, s[k]!);
  if (s.rm) q.set("rm", "1");
  if (s.truth) q.set("truth", "1");
  if (s.enter) q.set("enter", "1");
  const str = q.toString();
  return str ? `?${str}` : "";
}
