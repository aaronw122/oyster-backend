import type { SavePearlRequest } from "../contract/index.ts";

/** Next Manhattan-bound L trains at Bedford Av. Fits every widget size. */
export const mtaExample: Pick<SavePearlRequest, "name" | "inputs" | "sources" | "transform"> = {
  name: "Next L at Bedford Av",
  inputs: { route: "L", stop: "L08N" },
  sources: [
    {
      id: "trains",
      builtin: "mta",
      params: { route: "{inputs.route}", stop: "{inputs.stop}", limit: "5" },
      method: "GET",
    },
  ],
  transform: `(sources, inputs, std) => {
  const t = sources.trains;
  const wait = (m) => (m <= 0 ? "now" : m < 60 ? m + " min" : Math.floor(m / 60) + " hr");
  const towards = std.truncate(t.route + " to " + t.stop.towards, 22);
  if (t.arrivals.length === 0) {
    return { value: std.truncate("No " + t.route + " trains", 12), subtitle: std.truncate(t.stop.name, 24) };
  }
  const first = t.arrivals[0].minutesAway;
  const value = first <= 0 ? t.route + " now" : t.route + " in " + wait(first);
  const later = t.arrivals.slice(1, 4).filter((a) => a.minutesAway < 60).map((a) => a.minutesAway);
  const subtitle = later.length > 0 ? "then " + later.join(", ") + " min" : std.truncate(t.stop.name, 24);
  return {
    value,
    subtitle,
    items: t.arrivals.map((a) => ({ label: towards, value: wait(a.minutesAway) })),
  };
}`,
};
