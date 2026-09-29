import type { Pearl } from "../contract/index.ts";

/**
 * §2a "nearest Citi Bike station with ≥3 open docks" near an office at
 * W 21st St & 6th Ave. The candidate list (real Citi Bike station ids, nearest
 * first, precomputed distances) was resolved at creation; refreshes only check it.
 * `stationIds` repeats the ids as one string because builtin params only
 * template scalar inputs.
 */
export const gbfsExample = {
  name: "Citi Bike docks near the office",
  inputs: {
    stations: [
      { id: "66dc120f-0aca-11e7-82f6-3863bb44ef7c", label: "21st & 6th", distanceMi: 0.1 },
      { id: "66db33fc-0aca-11e7-82f6-3863bb44ef7c", label: "18th & 6th", distanceMi: 0.2 },
      { id: "66dc2995-0aca-11e7-82f6-3863bb44ef7c", label: "25th & 6th", distanceMi: 0.2 },
      { id: "66db95e5-0aca-11e7-82f6-3863bb44ef7c", label: "20th & 7th", distanceMi: 0.3 },
    ],
    stationIds: [
      "66dc120f-0aca-11e7-82f6-3863bb44ef7c",
      "66db33fc-0aca-11e7-82f6-3863bb44ef7c",
      "66dc2995-0aca-11e7-82f6-3863bb44ef7c",
      "66db95e5-0aca-11e7-82f6-3863bb44ef7c",
    ].join(","),
    threshold: 3,
  },
  sources: [
    {
      id: "bike",
      builtin: "gbfs",
      params: { system: "citibike", stations: "{inputs.stationIds}" },
      method: "GET",
    },
  ],
  transform: `(sources, inputs, std) => {
  var live = {};
  sources.bike.stations.forEach(function (s) { live[s.id] = s; });
  var threshold = inputs.threshold;
  var rows = inputs.stations
    .filter(function (c) { return live[c.id]; })
    .map(function (c) { return { label: c.label, distanceMi: c.distanceMi, s: live[c.id] }; });
  function open(r) { return r.s.isInstalled && r.s.isReturning; }
  function docks(n) { return n === 1 ? "1 dock" : n + " docks"; }
  function items(except) {
    return rows
      .filter(function (r) { return r !== except; })
      .map(function (r) {
        return { label: std.truncate(r.label, 22), value: open(r) ? docks(r.s.docksAvailable) : "closed" };
      });
  }
  var pick = rows.find(function (r) { return open(r) && r.s.docksAvailable >= threshold; });
  if (!pick) {
    return { value: "No docks", subtitle: std.truncate("None with " + threshold + "+ open", 24), items: items(null) };
  }
  var label = std.truncate(pick.label, 12);
  var mi = std.formatNumber(pick.distanceMi, { decimals: 1 }) + " mi";
  var headline = label + " • " + mi;
  var fits = Array.from(headline).length <= 12;
  return {
    value: fits ? headline : label,
    subtitle: std.truncate(fits ? docks(pick.s.docksAvailable) : docks(pick.s.docksAvailable) + " • " + mi, 24),
    items: items(pick),
  };
}`,
} satisfies Pick<Pearl, "name" | "inputs" | "sources" | "transform">;
