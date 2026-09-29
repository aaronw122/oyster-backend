import { describe, expect, test } from "bun:test";
import { transit_realtime } from "gtfs-realtime-bindings";
import { isoNow } from "../contract/index.ts";
import { fitAllSizes, runTransform } from "../sandbox/index.ts";
import type { BuiltinContext } from "../sources/builtins.ts";
import { createMemorySourceCache, fetchSources, SourceError } from "../sources/index.ts";
import { createMta, findMtaStops, mta, type MtaArrivals } from "./mta.ts";
import { mtaExample } from "./mta.example.ts";
import stationsJson from "./data/mta-stops.json";

const FIXTURES = `${import.meta.dir}/__fixtures__/mta`;
const L_FEED = new Uint8Array(await Bun.file(`${FIXTURES}/gtfs-l.pb`).arrayBuffer());
const SIX_FEED = new Uint8Array(await Bun.file(`${FIXTURES}/gtfs-6.pb`).arrayBuffer());
const NOT_A_FEED = await Bun.file(`${FIXTURES}/not-a-feed.xml`).text();

/** Feed header time of the recorded L feed, in ms: the "now" of the recording. */
const L_RECORDED_AT = Number(transit_realtime.FeedMessage.decode(L_FEED).header.timestamp) * 1000;

function feedFetch(body: Uint8Array | string, status = 200) {
  const urls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(body, { status });
  }) as unknown as typeof fetch; // test double: only the call shape used by the builtin
  return { fetch: fakeFetch, urls };
}

function ctx(fetchImpl: typeof fetch, cache = createMemorySourceCache()): BuiltinContext {
  return { fetch: fetchImpl, auth: null, cache, env: {} };
}

async function arrivals(params: Record<string, string>, now: number, body: Uint8Array | string = L_FEED) {
  const result = await createMta({ now: () => now }).fetch(params, ctx(feedFetch(body).fetch));
  return result as MtaArrivals;
}

async function sourceError(promise: Promise<unknown>): Promise<SourceError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof SourceError)) throw new Error(`expected SourceError, got ${String(error)}`);
  return error;
}

describe("mta builtin: decode + filter", () => {
  test("returns the next trains at the platform, soonest first, from the L feed", async () => {
    const result = await arrivals({ route: "L", stop: "L08N" }, L_RECORDED_AT);

    expect(result.route).toBe("L");
    expect(result.stop).toEqual({ id: "L08N", name: "Bedford Av", direction: "N", towards: "Manhattan" });
    expect(result.feedTimestamp).toBe(isoNow(new Date(L_RECORDED_AT)));
    expect(result.arrivals).toHaveLength(5);
    const times = result.arrivals.map((arrival) => Date.parse(arrival.arrivalTime));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    for (const arrival of result.arrivals) {
      expect(arrival.route).toBe("L");
      expect(arrival.tripId).not.toBe("");
      expect(arrival.minutesAway).toBe(Math.floor((Date.parse(arrival.arrivalTime) - L_RECORDED_AT) / 60_000));
      expect(arrival.minutesAway).toBeGreaterThanOrEqual(0);
    }
  });

  test("trains that already left are excluded and the rest keep their order", async () => {
    const all = await arrivals({ route: "L", stop: "L08N", limit: "20" }, L_RECORDED_AT);
    const later = L_RECORDED_AT + 10 * 60_000;
    const after = await arrivals({ route: "L", stop: "L08N", limit: "20" }, later);

    const expected = all.arrivals.filter((arrival) => Date.parse(arrival.arrivalTime) >= later).map((a) => a.tripId);
    expect(expected.length).toBeLessThan(all.arrivals.length);
    expect(after.arrivals.map((arrival) => arrival.tripId)).toEqual(expected);
    expect(after.arrivals.every((arrival) => Date.parse(arrival.arrivalTime) >= later)).toBe(true);
  });

  test("limit caps the number of trains", async () => {
    const result = await arrivals({ route: "L", stop: "L08S", limit: "2" }, L_RECORDED_AT);
    expect(result.arrivals).toHaveLength(2);
    expect(result.stop.towards).toBe("Outbound");
  });

  test("express variants ride with their line", async () => {
    const local = await arrivals({ route: "6", stop: "626N", limit: "20" }, L_RECORDED_AT, SIX_FEED);
    const routes = new Set(local.arrivals.map((arrival) => arrival.route));
    expect(routes).toEqual(new Set(["6", "6X"]));

    const express = await arrivals({ route: "6x", stop: "626n", limit: "20" }, L_RECORDED_AT, SIX_FEED);
    expect(express.route).toBe("6");
    expect(express.arrivals).toEqual(local.arrivals);
  });

  test("canceled and deleted trips are dropped", async () => {
    const before = await arrivals({ route: "L", stop: "L08N", limit: "20" }, L_RECORDED_AT);
    const [canceled, deleted] = before.arrivals.map((arrival) => arrival.tripId);
    const message = transit_realtime.FeedMessage.decode(L_FEED);
    const Relationship = transit_realtime.TripDescriptor.ScheduleRelationship;
    for (const entity of message.entity) {
      const trip = entity.tripUpdate?.trip;
      if (!trip) continue;
      if (trip.tripId === canceled) trip.scheduleRelationship = Relationship.CANCELED;
      if (trip.tripId === deleted) trip.scheduleRelationship = Relationship.DELETED;
    }
    const edited = transit_realtime.FeedMessage.encode(message).finish();

    const after = await arrivals({ route: "L", stop: "L08N", limit: "20" }, L_RECORDED_AT, edited);
    expect(after.arrivals.map((arrival) => arrival.tripId)).toEqual(
      before.arrivals.map((arrival) => arrival.tripId).filter((id) => id !== canceled && id !== deleted),
    );
  });
});

describe("mta builtin: errors", () => {
  test("unknown route is invalid_params", async () => {
    const error = await sourceError(arrivals({ route: "K", stop: "L08N" }, L_RECORDED_AT));
    expect(error.kind).toBe("invalid_params");
    expect(error.message).toContain('"K" isn\'t an NYC subway line');
  });

  test("station id without a direction explains both platforms", async () => {
    const error = await sourceError(arrivals({ route: "L", stop: "L08" }, L_RECORDED_AT));
    expect(error.kind).toBe("invalid_params");
    expect(error.message).toContain("L08N");
    expect(error.message).toContain("Manhattan");
  });

  test("unknown stop id is invalid_params", async () => {
    const error = await sourceError(arrivals({ route: "L", stop: "Z99N" }, L_RECORDED_AT));
    expect(error.kind).toBe("invalid_params");
  });

  test("a line that doesn't stop at the station is invalid_params naming the lines that do", async () => {
    const error = await sourceError(arrivals({ route: "L", stop: "626N" }, L_RECORDED_AT));
    expect(error.kind).toBe("invalid_params");
    expect(error.message).toBe("The L train doesn't stop at 86 St; lines there: 4, 5, 6.");
  });

  test("a body that is not GTFS-realtime is a parse error", async () => {
    const error = await sourceError(arrivals({ route: "L", stop: "L08N" }, L_RECORDED_AT, NOT_A_FEED));
    expect(error.kind).toBe("parse");
  });

  test("an HTTP failure is reported without the endpoint", async () => {
    const fake = feedFetch("unavailable", 503);
    const error = await sourceError(mta.fetch({ route: "L", stop: "L08N" }, ctx(fake.fetch)));
    expect(error.kind).toBe("http");
    expect(error.message).not.toContain("http");
    expect(error.message).toContain("503");
  });

  test("a network failure is reported as network", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch; // test double
    const error = await sourceError(mta.fetch({ route: "L", stop: "L08N" }, ctx(failing)));
    expect(error.kind).toBe("network");
  });
});

describe("mta builtin: feed cache", () => {
  test("stops on one feed share a download for 20 seconds", async () => {
    let clock = L_RECORDED_AT;
    const cache = createMemorySourceCache(() => clock);
    const fake = feedFetch(L_FEED);
    const builtin = createMta({ now: () => clock });

    await builtin.fetch({ route: "L", stop: "L08N" }, ctx(fake.fetch, cache));
    await builtin.fetch({ route: "L", stop: "L06S" }, ctx(fake.fetch, cache));
    expect(fake.urls).toHaveLength(1);
    expect(fake.urls[0]).toEndWith("nyct%2Fgtfs-l");

    clock += 20_000;
    await builtin.fetch({ route: "L", stop: "L08N" }, ctx(fake.fetch, cache));
    expect(fake.urls).toHaveLength(2);
  });
});

describe("mta lookup", () => {
  test("station name → lines and both directional stop ids", async () => {
    const matches = await mta.lookup?.("bedford av");
    expect(matches).toContainEqual({
      name: "Bedford Av",
      routes: ["L"],
      stops: [
        { stop: "L08N", towards: "Manhattan" },
        { stop: "L08S", towards: "Outbound" },
      ],
    });
  });
});

describe("findMtaStops", () => {
  test("finds a station by name and lists both platforms", () => {
    const [bedford] = findMtaStops("bedford av", "L");
    expect(bedford).toMatchObject({ id: "L08", name: "Bedford Av", routes: ["L"] });
    expect(bedford?.platforms).toEqual([
      { stop: "L08N", direction: "N", towards: "Manhattan" },
      { stop: "L08S", direction: "S", towards: "Outbound" },
    ]);
  });

  test("understands spelled-out words and ordinals", () => {
    const ids = findMtaStops("14th Street Union Square").map((stop) => stop.id);
    expect(ids).toContain("L03");
    expect(ids).toContain("635");
  });

  test("numbers match whole street numbers only", () => {
    const names = findMtaStops("14 st").map((stop) => stop.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.some((name) => name.includes("145"))).toBe(false);
  });

  test("route filter narrows a shared station name to that line's platform", () => {
    expect(findMtaStops("times sq", "7").map((stop) => stop.id)).toEqual(["725"]);
  });

  test("no match is an empty list", () => {
    expect(findMtaStops("atlantis")).toEqual([]);
    expect(findMtaStops("   ")).toEqual([]);
  });
});

describe("mta example Pearl", () => {
  test("recorded feed → fetchSources → transform fits every size", async () => {
    const fake = feedFetch(L_FEED);
    const fetched = await fetchSources(mtaExample, {
      resolveAuth: async () => null,
      fetch: fake.fetch,
      builtins: [createMta({ now: () => L_RECORDED_AT })],
      env: {},
    });
    if (!fetched.ok) throw new Error(fetched.error.message);

    const run = await runTransform(mtaExample.transform, fetched.data, mtaExample.inputs);
    if (!run.ok) throw new Error(run.error.message);
    expect(run.output.value).toMatch(/^L (now|in \d+ min)$/);
    expect(run.output.subtitle).toMatch(/^then [\d, ]+ min$/);
    expect(run.output.items?.[0]?.label).toBe("L to Manhattan");
    for (const [size, fit] of Object.entries(fitAllSizes(run.output))) {
      expect({ size, ok: fit.ok }).toEqual({ size, ok: true });
    }
  });

  const longest = (values: string[]) => values.reduce((a, b) => ([...b].length > [...a].length ? b : a));
  const stations = Object.values(stationsJson);
  const longestName = longest(stations.map((station) => station.name));
  const longestTowards = longest(stations.flatMap((station) => [station.north, station.south]));

  test.each([
    ["five trains, longest labels", [0, 12, 34, 59, 59]],
    ["trains an hour or more out", [59, 75, 150, 600, 1439]],
    ["no trains", []],
  ])("max-length data fits every size: %s", async (_label, minutes) => {
    const sources = {
      trains: {
        route: "GS",
        stop: { id: "902N", name: longestName, direction: "N", towards: longestTowards },
        feedTimestamp: "2026-09-29T19:41:00Z",
        arrivals: minutes.map((minutesAway, index) => ({
          route: "GS",
          tripId: `trip-${index}`,
          arrivalTime: "2026-09-29T20:00:00Z",
          minutesAway,
        })),
      },
    };
    const run = await runTransform(mtaExample.transform, sources, mtaExample.inputs);
    if (!run.ok) throw new Error(run.error.message);
    for (const [size, fit] of Object.entries(fitAllSizes(run.output))) {
      expect({ size, fit }).toEqual({ size, fit: { ok: true, output: expect.anything() } });
    }
  });
});

describe.skipIf(!process.env.LIVE)("mta builtin (live)", () => {
  test("the L feed decodes and yields upcoming trains at Bedford Av", async () => {
    const result = (await mta.fetch(
      { route: "L", stop: "L08N" },
      { fetch, auth: null, cache: undefined, env: process.env },
    )) as MtaArrivals;
    expect(Date.now() - Date.parse(result.feedTimestamp)).toBeLessThan(10 * 60_000);
    expect(result.arrivals.every((arrival) => arrival.minutesAway >= 0)).toBe(true);
  });
});
