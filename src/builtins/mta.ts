// MTA subway arrivals. The MTA publishes GTFS-realtime as protobuf; it is
// decoded and filtered here so the sandbox only ever sees small plain JSON.
import { transit_realtime } from "gtfs-realtime-bindings";
import { z } from "zod";
import { isoNow } from "../contract/index.ts";
import type { Builtin, BuiltinContext } from "../sources/builtins.ts";
import { SourceError } from "../sources/types.ts";
import stationsJson from "./data/mta-stops.json";
import { baseLine, feedUrlForLine, MTA_LINES, type MtaStation } from "./mta-lines.ts";

const STATIONS: Record<string, MtaStation> = stationsJson;

const FEED_TTL_MS = 20_000;
const FEED_TIMEOUT_MS = 8_000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export type MtaDirection = "N" | "S";

export type MtaArrival = {
  /** Route id as the train is signed, e.g. "6" or "6X". */
  route: string;
  tripId: string;
  arrivalTime: string;
  /** Whole minutes from fetch time, rounded down; 0 = arriving now. */
  minutesAway: number;
};

export type MtaArrivals = {
  route: string;
  stop: { id: string; name: string; direction: MtaDirection; towards: string };
  feedTimestamp: string;
  arrivals: MtaArrival[];
};

export type MtaStopMatch = {
  id: string;
  name: string;
  routes: string[];
  lat: number;
  lon: number;
  platforms: Array<{ stop: string; direction: MtaDirection; towards: string }>;
};

/** One scheduled stop of one trip, as cached per feed. `time` is epoch seconds. */
type FeedStop = { routeId: string; tripId: string; stopId: string; time: number };
type FeedSnapshot = { timestamp: number; stops: FeedStop[] };

const StopTimeSkipped = transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED;
const TripCanceled = transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED;

const paramsSchema = z.object({
  route: z.string().trim().min(1),
  stop: z.string().trim().min(1),
  limit: z
    .string()
    .regex(/^\d+$/, "must be a whole number")
    .refine((value) => Number(value) >= 1 && Number(value) <= MAX_LIMIT, `must be between 1 and ${MAX_LIMIT}`)
    .optional(),
});

const description = [
  "Live New York City subway arrivals (MTA) for one line at one platform.",
  "Params: `route` = subway line, e.g. L, A, 6, GS (42 St shuttle), FS (Franklin Av shuttle), H (Rockaway Park shuttle), SI (Staten Island Railway); express variants like 6X count as their line.",
  "`stop` = MTA stop id WITH a direction letter: the station id plus N or S, e.g. L08N = Bedford Av, trains toward Manhattan; L08S = Bedford Av, trains away from Manhattan. Each direction's destination label is returned as `stop.towards`. Look up station ids by name with the MTA stop finder.",
  "`limit` = how many upcoming trains to return (default 5, max 20).",
  "Returns: { route, stop: { id, name, direction: \"N\"|\"S\", towards }, feedTimestamp (ISO time), arrivals: [{ route, tripId, arrivalTime (ISO time), minutesAway (whole minutes, 0 = now) }] } — arrivals are soonest first and only include trains still to come; empty when none are scheduled.",
].join(" ");

/** Builds the MTA builtin; `now` is injectable so tests can pin the clock. */
export function createMta(deps: { now?: () => number } = {}): Builtin {
  const now = deps.now ?? Date.now;
  return {
    name: "mta",
    description,
    params: paramsSchema,
    async fetch(params, ctx) {
      const route = baseLine(params.route ?? "");
      const feedUrl = feedUrlForLine(route);
      if (feedUrl === undefined) {
        throw new SourceError(
          "invalid_params",
          `"${params.route}" isn't an NYC subway line. Lines: ${MTA_LINES.join(", ")}.`,
        );
      }
      const stop = resolveStop(params.stop ?? "");
      const limit = params.limit === undefined ? DEFAULT_LIMIT : Number(params.limit);

      const feed = await loadFeed(route, feedUrl, ctx);
      const fetchedAt = now();
      const arrivals = feed.stops
        .filter((entry) => entry.stopId === stop.id && baseLine(entry.routeId) === route && entry.time * 1000 >= fetchedAt)
        .sort((a, b) => a.time - b.time)
        .slice(0, limit)
        .map(
          (entry): MtaArrival => ({
            route: entry.routeId,
            tripId: entry.tripId,
            arrivalTime: isoNow(new Date(entry.time * 1000)),
            minutesAway: Math.floor((entry.time * 1000 - fetchedAt) / 60_000),
          }),
        );

      return {
        route,
        stop,
        feedTimestamp: isoNow(new Date(feed.timestamp * 1000)),
        arrivals,
      } satisfies MtaArrivals;
    },
  };
}

export const mta: Builtin = createMta();

function resolveStop(raw: string): MtaArrivals["stop"] {
  const id = raw.trim().toUpperCase();
  const direction = id.at(-1);
  const stationId = id.slice(0, -1);
  const station = STATIONS[stationId];
  if (station && (direction === "N" || direction === "S")) {
    return { id, name: station.name, direction, towards: direction === "N" ? station.north : station.south };
  }
  const bare = STATIONS[id];
  if (bare) {
    throw new SourceError(
      "invalid_params",
      `Stop "${raw}" needs a direction: use ${id}N for trains toward ${bare.north} or ${id}S for trains toward ${bare.south}.`,
    );
  }
  throw new SourceError("invalid_params", `"${raw}" isn't an NYC subway stop id (for example L08N is Bedford Av).`);
}

async function loadFeed(route: string, url: string, ctx: BuiltinContext): Promise<FeedSnapshot> {
  const cacheKey = `mta:feed:${url}`;
  const cached = ctx.cache?.get(cacheKey);
  if (cached !== undefined) return cached as FeedSnapshot;

  let response: Response;
  try {
    response = await ctx.fetch(url, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
  } catch {
    throw new SourceError("network", `Couldn't reach the MTA's live ${route} train times.`);
  }
  if (!response.ok) {
    throw new SourceError("http", `The MTA's live ${route} train times are unavailable right now (status ${response.status}).`);
  }
  const snapshot = decodeFeed(new Uint8Array(await response.arrayBuffer()), route);
  ctx.cache?.set(cacheKey, snapshot, FEED_TTL_MS);
  return snapshot;
}

/** Decodes a GTFS-realtime FeedMessage into the stops of every running trip. */
export function decodeFeed(bytes: Uint8Array, route: string): FeedSnapshot {
  let message: transit_realtime.FeedMessage;
  try {
    message = transit_realtime.FeedMessage.decode(bytes);
  } catch {
    throw new SourceError("parse", `The MTA sent live ${route} train times in a form Oyster couldn't read.`);
  }
  const stops: FeedStop[] = [];
  for (const entity of message.entity) {
    const update = entity.tripUpdate;
    if (!update || entity.isDeleted || update.trip.scheduleRelationship === TripCanceled) continue;
    const routeId = update.trip.routeId ?? "";
    const tripId = update.trip.tripId ?? "";
    for (const stopTime of update.stopTimeUpdate ?? []) {
      if (!stopTime.stopId || stopTime.scheduleRelationship === StopTimeSkipped) continue;
      const time = toSeconds(stopTime.arrival?.time) ?? toSeconds(stopTime.departure?.time);
      if (time === undefined) continue;
      stops.push({ routeId, tripId, stopId: stopTime.stopId, time });
    }
  }
  return { timestamp: toSeconds(message.header.timestamp) ?? 0, stops };
}

function toSeconds(value: number | { toNumber(): number } | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const seconds = typeof value === "number" ? value : value.toNumber();
  return seconds > 0 ? seconds : undefined;
}

// ── Station search ──────────────────────────────────────────────────────────

const WORD_ALIASES: Record<string, string> = {
  street: "st",
  avenue: "av",
  ave: "av",
  square: "sq",
  boulevard: "blvd",
  parkway: "pkwy",
  road: "rd",
  place: "pl",
  center: "ctr",
  centre: "ctr",
  heights: "hts",
  junction: "jct",
  plaza: "plz",
  highway: "hwy",
  terminal: "term",
  mount: "mt",
  fort: "ft",
  saint: "st",
};
const IGNORED_WORDS: Record<string, true> = { station: true, stop: true, subway: true, the: true, and: true };

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/&/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "" && !IGNORED_WORDS[word])
    .map((word) => word.replace(/^(\d+)(st|nd|rd|th)$/, "$1"))
    .map((word) => WORD_ALIASES[word] ?? word);
}

/**
 * Finds subway stations by name (e.g. "bedford", "14th street union square",
 * "Times Sq"), optionally only those served by `route`. Pure lookup over the
 * bundled MTA static table; best matches first, at most 10.
 */
export function findMtaStops(query: string, route?: string): MtaStopMatch[] {
  const wanted = tokens(query);
  if (wanted.length === 0) return [];
  const line = route === undefined ? undefined : baseLine(route);
  const joined = wanted.join(" ");
  const matches: Array<{ match: MtaStopMatch; rank: number }> = [];
  for (const [id, station] of Object.entries(STATIONS)) {
    if (line !== undefined && !station.routes.includes(line)) continue;
    const have = tokens(station.name);
    const hit = wanted.every((word) =>
      have.some((candidate) => (/^\d+$/.test(word) ? candidate === word : candidate.startsWith(word))),
    );
    if (!hit) continue;
    const name = have.join(" ");
    const rank = name === joined ? 0 : name.startsWith(joined) ? 1 : 2;
    matches.push({
      rank,
      match: {
        id,
        name: station.name,
        routes: station.routes,
        lat: station.lat,
        lon: station.lon,
        platforms: [
          { stop: `${id}N`, direction: "N", towards: station.north },
          { stop: `${id}S`, direction: "S", towards: station.south },
        ],
      },
    });
  }
  return matches
    .sort((a, b) => a.rank - b.rank || a.match.name.localeCompare(b.match.name) || a.match.id.localeCompare(b.match.id))
    .slice(0, 10)
    .map(({ match }) => match);
}
