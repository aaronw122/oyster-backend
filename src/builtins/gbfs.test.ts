import { describe, expect, test } from "bun:test";
import { fitAllSizes, runTransform } from "../sandbox/index.ts";
import type { BuiltinContext } from "../sources/builtins.ts";
import { createMemorySourceCache, fetchSources, SourceError } from "../sources/index.ts";
import { gbfsExample } from "./gbfs.example.ts";
import { GBFS_SYSTEMS, type GbfsResult, gbfs } from "./gbfs.ts";
import v2Discovery from "./__fixtures__/gbfs/v2/gbfs.json";
import v2Info from "./__fixtures__/gbfs/v2/station_information.json";
import v2Status from "./__fixtures__/gbfs/v2/station_status.json";
import v2Types from "./__fixtures__/gbfs/v2/vehicle_types.json";
import v3Discovery from "./__fixtures__/gbfs/v3/gbfs.json";
import v3Info from "./__fixtures__/gbfs/v3/station_information.json";
import v3Status from "./__fixtures__/gbfs/v3/station_status.json";
import v3Types from "./__fixtures__/gbfs/v3/vehicle_types.json";

// Real Citi Bike ids from the recorded feeds.
const W21_6 = "66dc120f-0aca-11e7-82f6-3863bb44ef7c";
const W18_6 = "66db33fc-0aca-11e7-82f6-3863bb44ef7c";
const W25_6 = "66dc2995-0aca-11e7-82f6-3863bb44ef7c";
const W20_7 = "66db95e5-0aca-11e7-82f6-3863bb44ef7c";

type Payloads = Record<string, unknown>;
type StatusRow = (typeof v2Status.data.stations)[number];

const clone = <T>(value: T): T => structuredClone(value);

const v2: Payloads = {
  [GBFS_SYSTEMS.citibike.discoveryUrl]: v2Discovery,
  "https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_information.json": v2Info,
  "https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json": v2Status,
  "https://gbfs.lyft.com/gbfs/2.3/bkn/en/vehicle_types.json": v2Types,
};
const v3: Payloads = {
  [GBFS_SYSTEMS.citibike.discoveryUrl]: v3Discovery,
  "https://gbfs.lyft.com/gbfs/3.0/bkn/station_information.json": v3Info,
  "https://gbfs.lyft.com/gbfs/3.0/bkn/station_status.json": v3Status,
  "https://gbfs.lyft.com/gbfs/3.0/bkn/vehicle_types.json": v3Types,
};

function withStatus(edit: (row: StatusRow) => StatusRow | null): Payloads {
  const status = clone(v2Status);
  status.data.stations = status.data.stations.flatMap((row) => edit(row) ?? []);
  return { ...v2, "https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json": status };
}

function fakeFetch(payloads: Payloads) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    return url in payloads ? Response.json(payloads[url]) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

function ctx(fetchFn: typeof fetch, cache?: BuiltinContext["cache"]): BuiltinContext {
  return { fetch: fetchFn, auth: null, cache, env: {} };
}

async function run(payloads: Payloads, params: Record<string, string> = {}): Promise<GbfsResult> {
  const parsed = gbfs.params.parse(params);
  return (await gbfs.fetch(parsed, ctx(fakeFetch(payloads).fn))) as GbfsResult;
}

describe("gbfs builtin: normalization", () => {
  test("joins station_information and station_status on station_id", async () => {
    const result = await run(v2);
    expect(result.system).toBe("citibike");
    expect(result.ttl).toBe(v2Status.ttl);
    expect(result.lastUpdated).toBe(new Date(v2Status.last_updated * 1000).toISOString());
    // The two feeds list stations in different orders; every joined row must carry its own status.
    expect(result.stations.map((s) => s.id)).toEqual(v2Info.data.stations.map((s) => s.station_id));
    for (const station of result.stations) {
      const live = v2Status.data.stations.find((row) => row.station_id === station.id)!;
      expect(station.docksAvailable).toBe(live.num_docks_available);
      expect(station.bikesAvailable).toBe(live.num_bikes_available);
    }
    expect(result.stations.find((s) => s.id === W21_6)).toEqual({
      id: W21_6,
      name: "W 21 St & 6 Ave",
      lat: 40.74173969,
      lon: -73.99415556,
      capacity: 74,
      bikesAvailable: 53,
      ebikesAvailable: 37,
      docksAvailable: 19,
      isRenting: true,
      isReturning: true,
      isInstalled: true,
      lastReported: new Date(1790710757 * 1000).toISOString(),
    });
  });

  test("stations param filters and orders; unknown and duplicate ids drop out", async () => {
    const result = await run(v2, { stations: ` ${W25_6},nope, ${W21_6},${W25_6},` });
    expect(result.stations.map((s) => s.id)).toEqual([W25_6, W21_6]);
  });

  test("a station missing from either feed is absent", async () => {
    const result = await run(withStatus((row) => (row.station_id === W18_6 ? null : row)), {
      stations: `${W21_6},${W18_6},${W25_6}`,
    });
    expect(result.stations.map((s) => s.id)).toEqual([W21_6, W25_6]);
  });

  test("GBFS 3.x payloads normalize to the same output as 2.x", async () => {
    const [fromV2, fromV3] = await Promise.all([run(v2), run(v3)]);
    // 3.x has no num_ebikes_available: e-bikes come from vehicle_types propulsion.
    expect(fromV3).toEqual(fromV2);
  });

  test("status flags map 0/1 to booleans", async () => {
    const result = await run(
      withStatus((row) => (row.station_id === W21_6 ? { ...row, is_returning: 0, is_renting: 0 } : row)),
      { stations: W21_6 },
    );
    expect(result.stations[0]).toMatchObject({ isReturning: false, isRenting: false, isInstalled: true });
  });

  test("feeds are cached for their own ttl", async () => {
    let nowMs = 0;
    const cache = createMemorySourceCache(() => nowMs);
    const { fn, calls } = fakeFetch(v2);
    const params = gbfs.params.parse({});
    await gbfs.fetch(params, ctx(fn, cache));
    expect(calls).toHaveLength(3); // discovery + information + status (2.x has num_ebikes_available)
    nowMs = (v2Status.ttl - 1) * 1000;
    await gbfs.fetch(params, ctx(fn, cache));
    expect(calls).toHaveLength(3);
    nowMs = v2Status.ttl * 1000;
    await gbfs.fetch(params, ctx(fn, cache));
    expect(calls).toHaveLength(6);
  });

  test("HTTP failures surface as http SourceErrors", async () => {
    const payloads = { ...v2 };
    delete payloads["https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json"];
    const error = await run(payloads).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).kind).toBe("http");
  });

  test("feed URLs on another origin are refused before any request", async () => {
    const directory = clone(v2Discovery);
    const status = directory.data.en.feeds.find((feed) => feed.name === "station_status")!;
    status.url = "http://169.254.169.254/latest/meta-data/station_status.json";
    const { fn, calls } = fakeFetch({ ...v2, [GBFS_SYSTEMS.citibike.discoveryUrl]: directory });
    const error = await gbfs.fetch(gbfs.params.parse({}), ctx(fn)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).kind).toBe("forbidden_url");
    expect(calls).toEqual([GBFS_SYSTEMS.citibike.discoveryUrl]);
  });

  test("unknown systems are rejected as invalid params", async () => {
    const result = await fetchSources(
      { inputs: {}, sources: [{ id: "bike", builtin: "gbfs", params: { system: "nowhere" }, method: "GET" }] },
      { resolveAuth: async () => null, fetch: fakeFetch(v2).fn, builtins: [gbfs] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_params");
  });
});

async function runExample(payloads: Payloads, inputs: Record<string, unknown> = gbfsExample.inputs) {
  const fetched = await fetchSources(
    { ...gbfsExample, inputs },
    { resolveAuth: async () => null, fetch: fakeFetch(payloads).fn, builtins: [gbfs] },
  );
  if (!fetched.ok) throw new Error(fetched.error.message);
  const result = await runTransform(gbfsExample.transform, fetched.data, inputs);
  if (!result.ok) throw new Error(result.error.message);
  const fits = fitAllSizes(result.output);
  for (const fit of Object.values(fits)) expect(fit).toMatchObject({ ok: true });
  return result.output;
}

describe("gbfs example Pearl", () => {
  test("picks the nearest station with enough docks and fits every size", async () => {
    const output = await runExample(v2);
    expect(output).toEqual({
      value: "21st & 6th",
      subtitle: "19 docks • 0.1 mi",
      items: [
        { label: "18th & 6th", value: "1 dock" },
        { label: "25th & 6th", value: "11 docks" },
        { label: "20th & 7th", value: "4 docks" },
      ],
    });
  });

  test("exactly the threshold qualifies; closed and short stations are skipped", async () => {
    const output = await runExample(
      withStatus((row) => {
        if (row.station_id === W21_6) return { ...row, is_returning: 0 };
        if (row.station_id === W18_6) return { ...row, num_docks_available: 2 };
        if (row.station_id === W25_6) return { ...row, num_docks_available: 3 };
        return row;
      }),
    );
    expect(output.value).toBe("25th & 6th");
    expect(output.subtitle).toBe("3 docks • 0.2 mi");
    expect(output.items?.[0]).toEqual({ label: "21st & 6th", value: "closed" });
  });

  test("the distance joins the headline only when it fits the 12-character lock-screen budget", async () => {
    const inputs = clone(gbfsExample.inputs);
    inputs.stations[0]!.label = "W21";
    expect(await runExample(v2, inputs)).toMatchObject({ value: "W21 • 0.1 mi", subtitle: "19 docks" });
    inputs.stations[0]!.label = "W 21";
    expect(await runExample(v2, inputs)).toMatchObject({ value: "W 21", subtitle: "19 docks • 0.1 mi" });
  });

  test("gracefully reports when no station meets the threshold", async () => {
    const output = await runExample(withStatus((row) => ({ ...row, num_docks_available: 0 })));
    expect(output.value).toBe("No docks");
    expect(output.subtitle).toBe("None with 3+ open");
    expect(output.items).toHaveLength(4);
  });

  test("tells the user to recreate when every stored station is gone from the feed", async () => {
    const stored = new Set(gbfsExample.inputs.stations.map((station) => station.id));
    const output = await runExample(withStatus((row) => (stored.has(row.station_id) ? null : row)));
    expect(output).toEqual({ value: "No stations", subtitle: "Recreate this widget" });
  });

  test("max-length labels, big numbers, and a station gone from the feed still fit", async () => {
    const inputs = clone(gbfsExample.inputs);
    for (const station of inputs.stations) station.label = "Avenue of the Americas & W 21st Street";
    inputs.stations[0]!.distanceMi = 12.345;
    const output = await runExample(
      withStatus((row) =>
        row.station_id === W20_7 ? null : { ...row, num_docks_available: 1000, num_bikes_available: 9999 },
      ),
      inputs,
    );
    expect(output.items).toHaveLength(2);
  });
});

describe.skipIf(!process.env.LIVE)("gbfs builtin (live Citi Bike)", () => {
  test("fetches and joins the real feeds", async () => {
    const result = (await gbfs.fetch(
      gbfs.params.parse({ stations: `${W21_6},${W18_6}` }),
      ctx(fetch),
    )) as GbfsResult;
    expect(result.stations.length).toBeGreaterThan(0);
    for (const station of result.stations) {
      expect(station.name.length).toBeGreaterThan(0);
      expect(Number.isFinite(station.docksAvailable)).toBe(true);
    }
    expect(Date.parse(result.lastUpdated ?? "")).toBeGreaterThan(0);
  });
});
