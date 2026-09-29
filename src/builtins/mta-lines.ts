// MTA subway line → GTFS-realtime feed mapping. Feeds verified keyless on
// 2026-09-29 (api-endpoint.mta.info, no `x-api-key` needed). Route ids are the
// static GTFS `routes.txt` ids; express variants (6X, 7X, FX) run on the same
// line and are folded into their base line.

const FEED_BASE = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F";

const FEED_BY_LINE: Record<string, string> = {
  "1": "gtfs",
  "2": "gtfs",
  "3": "gtfs",
  "4": "gtfs",
  "5": "gtfs",
  "6": "gtfs",
  "7": "gtfs",
  GS: "gtfs",
  A: "gtfs-ace",
  C: "gtfs-ace",
  E: "gtfs-ace",
  H: "gtfs-ace",
  B: "gtfs-bdfm",
  D: "gtfs-bdfm",
  F: "gtfs-bdfm",
  M: "gtfs-bdfm",
  FS: "gtfs-bdfm",
  G: "gtfs-g",
  J: "gtfs-jz",
  Z: "gtfs-jz",
  L: "gtfs-l",
  N: "gtfs-nqrw",
  Q: "gtfs-nqrw",
  R: "gtfs-nqrw",
  W: "gtfs-nqrw",
  SI: "gtfs-si",
};

// Route ids that ride as another line. `SS` shows up in the Staten Island
// Railway feed next to `SI`; the railway is a single line, so it is folded in.
const LINE_ALIASES: Record<string, string> = {
  "6X": "6",
  "7X": "7",
  FX: "F",
  SS: "SI",
  SIR: "SI",
};

/** Every line id `route` accepts (after folding express variants). */
export const MTA_LINES: readonly string[] = Object.keys(FEED_BY_LINE);

/** One station from the bundled static table; platforms are `<id>N` / `<id>S`. */
export type MtaStation = {
  name: string;
  lat: number;
  lon: number;
  /** Lines with scheduled stops here (base line ids). */
  routes: string[];
  /** Where "N" platform trains head, e.g. "Manhattan", "Uptown & The Bronx". */
  north: string;
  /** Where "S" platform trains head. */
  south: string;
};

/** Folds a route id to its line: `6X` → `6`, `fx` → `F`. Unknown ids pass through uppercased. */
export function baseLine(routeId: string): string {
  const upper = routeId.trim().toUpperCase();
  return LINE_ALIASES[upper] ?? upper;
}

/** Feed URL for a line, or undefined when the line is not an MTA subway line. */
export function feedUrlForLine(line: string): string | undefined {
  const feed = FEED_BY_LINE[baseLine(line)];
  return feed === undefined ? undefined : `${FEED_BASE}${feed}`;
}
