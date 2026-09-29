import type { Pearl } from "../contract/index.ts";

/** Who's at RC today: headcount up top, a few first names below, one row per visitor. */
export const recurseExample: Pick<Pearl, "name" | "inputs" | "sources" | "transform"> = {
  name: "Who's at RC today",
  inputs: {},
  sources: [{ id: "hub", builtin: "recurse", method: "GET", params: { date: "today" } }],
  transform: `(sources, inputs, std) => {
  const hub = sources.hub;
  const long = hub.count + " at the hub";
  const value = Array.from(long).length <= 12 ? long : hub.count + " at hub";
  if (hub.count === 0) return { value, subtitle: "No one's checked in yet" };
  const names = hub.visitors.map((v) => v.name.split(/\\s+/)[0]);
  let shown = 1;
  while (shown < names.length) {
    const rest = names.length - shown - 1;
    const candidate = names.slice(0, shown + 1).join(", ") + (rest > 0 ? " +" + rest : "");
    if (Array.from(candidate).length > 24) break;
    shown++;
  }
  const more = names.length > shown ? " +" + (names.length - shown) : "";
  const subtitle = std.truncate(names.slice(0, shown).join(", "), 24 - more.length) + more;
  return {
    value,
    subtitle,
    items: hub.visitors.slice(0, 5).map((v) =>
      v.notes === null ? { label: std.truncate(v.name, 22) } : { label: std.truncate(v.name, 22), value: std.truncate(v.notes, 10) },
    ),
  };
}`,
};
