import { z } from "zod";
import { isoNow } from "../contract/index.ts";
import type { Builtin, BuiltinContext } from "../sources/builtins.ts";
import { SourceError } from "../sources/types.ts";

/**
 * Known systems → GBFS auto-discovery (`gbfs.json`). Verified live 2026-09-29:
 * Citi Bike's own https://gbfs.citibikenyc.com/gbfs/2.3/gbfs.json lists the
 * Lyft-hosted GBFS 2.3 feeds below; Lyft serves no 3.x feed for these systems
 * yet, but the parser also accepts GBFS 3.x payloads.
 */
export const GBFS_SYSTEMS = {
  citibike: { label: "Citi Bike", discoveryUrl: "https://gbfs.lyft.com/gbfs/2.3/bkn/gbfs.json" },
  baywheels: { label: "Bay Wheels", discoveryUrl: "https://gbfs.lyft.com/gbfs/2.3/bay/gbfs.json" },
  divvy: { label: "Divvy", discoveryUrl: "https://gbfs.lyft.com/gbfs/2.3/chi/gbfs.json" },
  bluebikes: { label: "Bluebikes", discoveryUrl: "https://gbfs.lyft.com/gbfs/2.3/bos/gbfs.json" },
  biketown: { label: "Biketown", discoveryUrl: "https://gbfs.lyft.com/gbfs/2.3/pdx/gbfs.json" },
} as const;
type SystemId = keyof typeof GBFS_SYSTEMS;
const SYSTEM_IDS = Object.keys(GBFS_SYSTEMS) as [SystemId, ...SystemId[]];

const REQUEST_TIMEOUT_MS = 8_000;
const ELECTRIC_PROPULSION: Record<string, true> = { electric_assist: true, electric: true };
const USED_FEEDS: Record<string, true> = { station_information: true, station_status: true, vehicle_types: true };

export type GbfsStation = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  capacity: number | null;
  bikesAvailable: number;
  ebikesAvailable: number;
  docksAvailable: number;
  isRenting: boolean;
  isReturning: boolean;
  isInstalled: boolean;
  lastReported: string | null;
};

export type GbfsResult = {
  system: SystemId;
  lastUpdated: string | null;
  ttl: number;
  stations: GbfsStation[];
};

type Feed = { lastUpdated: string | null; ttl: number; data: Record<string, unknown> };
type Row = Record<string, unknown>;

const params = z.object({
  system: z.enum(SYSTEM_IDS).default("citibike"),
  stations: z.string().optional(),
});

export const gbfs: Builtin = {
  name: "gbfs",
  description: [
    "Live bike-share dock and bike availability (GBFS), e.g. Citi Bike in New York.",
    `Params: system (one of ${SYSTEM_IDS.join(", ")}; default citibike);`,
    "stations (optional comma-separated station ids; output keeps that order, unknown ids are left out; omit for every station).",
    "Returns { system, lastUpdated (ISO), ttl (seconds), stations: [{ id, name, lat, lon, capacity,",
    "bikesAvailable, ebikesAvailable, docksAvailable, isRenting, isReturning, isInstalled, lastReported (ISO) }] }.",
    "docksAvailable = empty docks to return a bike; bikesAvailable includes e-bikes.",
  ].join(" "),
  params,
  // Normalized result, per system + stations. Raw feeds are cached separately for
  // their advertised `ttl` (shared across station selections); feed ttls vary, so
  // this stays short.
  ttlMs: 30_000,
  async fetch(rawParams, ctx) {
    const system = rawParams.system as SystemId;
    const wanted = parseStationIds(rawParams.stations);
    const directoryUrl = GBFS_SYSTEMS[system].discoveryUrl;
    const discovery = await getFeed(directoryUrl, "system directory", ctx);
    const feeds = feedUrls(discovery.data, new URL(directoryUrl).origin);
    const infoUrl = feeds.get("station_information");
    const statusUrl = feeds.get("station_status");
    if (!infoUrl || !statusUrl) {
      throw new SourceError("parse", `${GBFS_SYSTEMS[system].label} does not publish station feeds`);
    }
    const [info, status] = await Promise.all([
      getFeed(infoUrl, "station list", ctx),
      getFeed(statusUrl, "station status", ctx),
    ]);
    const statusRows = rowsOf(status, "stations");
    const needsTypes = statusRows.some((row) => typeof row.num_ebikes_available !== "number");
    const typesUrl = feeds.get("vehicle_types");
    const electricTypes =
      needsTypes && typesUrl ? electricTypeIds(await getFeed(typesUrl, "vehicle types", ctx)) : new Set<string>();

    const statusById = new Map(statusRows.map((row) => [String(row.station_id), row]));
    const joined = new Map<string, GbfsStation>();
    for (const row of rowsOf(info, "stations")) {
      const id = String(row.station_id);
      const live = statusById.get(id);
      if (live) joined.set(id, normalizeStation(id, row, live, electricTypes));
    }
    const stations = wanted
      ? wanted.flatMap((id) => joined.get(id) ?? [])
      : [...joined.values()];
    const result: GbfsResult = { system, lastUpdated: status.lastUpdated, ttl: status.ttl, stations };
    return result;
  },
};

function parseStationIds(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  const ids = raw.split(",").map((id) => id.trim()).filter((id) => id !== "");
  return ids.length === 0 ? null : [...new Set(ids)];
}

/** GET + parse one feed, cached for the feed's own `ttl`. */
async function getFeed(url: string, what: string, ctx: BuiltinContext): Promise<Feed> {
  const key = `gbfs:${url}`;
  const cached = ctx.cache?.get(key) as Feed | undefined;
  if (cached !== undefined) return cached;

  let response: Response;
  try {
    response = await ctx.fetch(url, {
      headers: { Accept: "application/json" },
      // Never follow redirects: the same-origin check in `feedUrls` must hold for the host actually read.
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "could not be reached";
    throw new SourceError("network", `the bike-share ${what} ${reason}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new SourceError("http", `the bike-share ${what} returned HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SourceError("parse", `the bike-share ${what} was not valid JSON`);
  }
  if (!isRow(body) || !isRow(body.data)) throw new SourceError("parse", `the bike-share ${what} had no data`);

  const ttl = typeof body.ttl === "number" && body.ttl >= 0 ? body.ttl : 0;
  const feed: Feed = { lastUpdated: toIso(body.last_updated), ttl, data: body.data };
  ctx.cache?.set(key, feed, ttl * 1000);
  return feed;
}

/**
 * 2.x: `data.<lang>.feeds` (prefer `en`); 3.x: `data.feeds`. Only the feeds this
 * builtin reads are returned, and each must live on the directory's own origin:
 * builtin fetches bypass the URL-source SSRF guard, so a tampered directory
 * must not be able to point us anywhere else.
 */
function feedUrls(data: Row, origin: string): Map<string, string> {
  let feeds = data.feeds;
  if (!Array.isArray(feeds)) {
    const language = isRow(data.en) ? data.en : Object.values(data).find(isRow);
    feeds = language?.feeds;
  }
  const urls = new Map<string, string>();
  if (!Array.isArray(feeds)) return urls;
  for (const feed of feeds) {
    if (!isRow(feed) || typeof feed.name !== "string" || typeof feed.url !== "string") continue;
    if (!Object.hasOwn(USED_FEEDS, feed.name)) continue;
    const url = URL.parse(feed.url);
    if (url?.origin !== origin) {
      throw new SourceError("forbidden_url", "the bike-share system directory points to an untrusted host");
    }
    urls.set(feed.name, url.href);
  }
  return urls;
}

function rowsOf(feed: Feed, key: string): Row[] {
  const rows = feed.data[key];
  return Array.isArray(rows) ? rows.filter(isRow) : [];
}

function electricTypeIds(feed: Feed): Set<string> {
  const ids = new Set<string>();
  for (const type of rowsOf(feed, "vehicle_types")) {
    if (typeof type.propulsion_type === "string" && Object.hasOwn(ELECTRIC_PROPULSION, type.propulsion_type)) {
      ids.add(String(type.vehicle_type_id));
    }
  }
  return ids;
}

function normalizeStation(id: string, info: Row, status: Row, electricTypes: Set<string>): GbfsStation {
  return {
    id,
    name: localizedText(info.name) ?? id,
    lat: Number(info.lat),
    lon: Number(info.lon),
    capacity: typeof info.capacity === "number" ? info.capacity : null,
    // 2.x `num_bikes_available`; 3.x renamed it `num_vehicles_available`.
    bikesAvailable: count(status.num_bikes_available ?? status.num_vehicles_available),
    ebikesAvailable:
      typeof status.num_ebikes_available === "number"
        ? count(status.num_ebikes_available)
        : electricCount(status.vehicle_types_available, electricTypes),
    docksAvailable: count(status.num_docks_available),
    isRenting: flag(status.is_renting),
    isReturning: flag(status.is_returning),
    isInstalled: flag(status.is_installed),
    lastReported: toIso(status.last_reported),
  };
}

function electricCount(available: unknown, electricTypes: Set<string>): number {
  if (!Array.isArray(available)) return 0;
  let total = 0;
  for (const entry of available) {
    if (isRow(entry) && electricTypes.has(String(entry.vehicle_type_id))) total += count(entry.count);
  }
  return total;
}

/** 2.x plain string; 3.x `[{ text, language }]` (prefer `en`). */
function localizedText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const entries = value.filter(isRow);
  const entry = entries.find((candidate) => candidate.language === "en") ?? entries[0];
  return typeof entry?.text === "string" ? entry.text : null;
}

/** 2.x POSIX seconds; 3.x RFC 3339 strings. */
function toIso(value: unknown): string | null {
  const date =
    typeof value === "number" ? new Date(value * 1000) : typeof value === "string" ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? isoNow(date) : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** 2.x `1`/`0`; 3.x booleans. */
function flag(value: unknown): boolean {
  return value === true || value === 1;
}

function isRow(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
