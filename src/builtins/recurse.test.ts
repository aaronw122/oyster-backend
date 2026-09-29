import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { fetchSources } from "../sources/index.ts";
import hubVisits from "./__fixtures__/recurse/hub-visits.json";
import { hubDate, recurse, type RecurseHubData } from "./recurse.ts";
import { recurseExample } from "./recurse.example.ts";
import { builtinContext, json, recordingFetch, renderExample, sourceError } from "./testing.ts";

// Fixture provenance: shape recorded from the live `GET /api/v1/hub_visits`
// on 2026-09-29 (55 visits, one page), trimmed to five rows and ANONYMIZED —
// every name, id, and note is invented. Field names, value types, timestamp
// format, and the `app_data` / `created_by_app` variants match the recording.
const TOKEN = "rc-secret-token";
const ENV = { RC_PAT: TOKEN };

const ctx = (fetchFn: typeof fetch, env: Record<string, string | undefined> = ENV) => builtinContext(fetchFn, { env });

function visit(id: number, name: string, notes = "") {
  return { ...hubVisits[0]!, person: { id, name }, notes };
}

afterEach(() => setSystemTime());

describe("recurse builtin", () => {
  test("normalizes the recorded visits: sorted by name, notes trimmed or null", async () => {
    const { fetch, calls } = recordingFetch(() => json(hubVisits));
    const data = (await recurse.fetch({ date: "2026-09-29" }, ctx(fetch))) as RecurseHubData;

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("date")).toBe("2026-09-29");
    expect(calls[0]!.url.searchParams.get("per_page")).toBe("200");
    expect(calls[0]!.url.searchParams.get("page")).toBe("1");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.url.href).not.toContain(TOKEN);

    expect(data).toEqual({
      date: "2026-09-29",
      count: 5,
      visitors: [
        { id: 7012, name: "Ada Okafor", notes: "pairing" },
        { id: 7430, name: "Beatriz Lindqvist", notes: null },
        { id: 7611, name: "Kenji Arroyo", notes: null },
        { id: 7208, name: "Milo Hartmann", notes: null },
        { id: 6691, name: "Wren Castillo", notes: null },
      ],
    });
  });

  test("follows pages until one comes back short", async () => {
    const full = Array.from({ length: 200 }, (_, i) => visit(i + 1, `Person ${String(i + 1).padStart(3, "0")}`));
    const pages: Record<string, unknown[]> = { "1": full, "2": [visit(500, "Zed Last")] };
    const { fetch, calls } = recordingFetch((url) => json(pages[url.searchParams.get("page")!] ?? []));
    const data = (await recurse.fetch({ date: "2026-09-29" }, ctx(fetch))) as RecurseHubData;

    expect(calls.map((c) => c.url.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(data.count).toBe(201);
    expect(data.visitors.at(-1)).toEqual({ id: 500, name: "Zed Last", notes: null });
  });

  test("stops after a bounded number of pages even if the API never runs dry", async () => {
    const full = Array.from({ length: 200 }, (_, i) => visit(i + 1, `Person ${i + 1}`));
    const { fetch, calls } = recordingFetch(() => json(full));
    const data = (await recurse.fetch({ date: "2026-09-29" }, ctx(fetch))) as RecurseHubData;
    expect(calls).toHaveLength(10);
    expect(data.count).toBe(200); // same people on every page are counted once
  });

  test('"today" is the New York date, not the UTC date', async () => {
    // 2026-09-30 02:30 UTC is still 22:30 on the 29th in New York (EDT).
    setSystemTime(new Date("2026-09-30T02:30:00Z"));
    expect(hubDate(new Date())).toBe("2026-09-29");
    const { fetch, calls } = recordingFetch(() => json([]));
    const data = (await recurse.fetch({}, ctx(fetch))) as RecurseHubData;
    expect(calls[0]!.url.searchParams.get("date")).toBe("2026-09-29");
    expect(data).toEqual({ date: "2026-09-29", count: 0, visitors: [] });

    // Five hours later (04:30 in New York) the hub day has rolled over.
    setSystemTime(new Date("2026-09-30T08:30:00Z"));
    await recurse.fetch({ date: "today" }, ctx(fetch));
    expect(calls[1]!.url.searchParams.get("date")).toBe("2026-09-30");
  });

  test("an impossible date is a plain params problem and makes no request", async () => {
    const { fetch, calls } = recordingFetch(() => json([]));
    const error = await sourceError(recurse.fetch({ date: "2026-02-30" }, ctx(fetch)));
    expect(error.kind).toBe("invalid_params");
    expect(error.message).toBe('"2026-02-30" isn\'t a real date. Use one like 2026-09-29.');
    expect(calls).toHaveLength(0);
  });

  test("without a server token the source fails plainly and makes no request", async () => {
    const { fetch, calls } = recordingFetch(() => json(hubVisits));
    const result = await fetchSources(
      { inputs: {}, sources: [{ id: "hub", builtin: "recurse", method: "GET", params: {} }] },
      { resolveAuth: async () => null, fetch, builtins: [recurse], env: {} },
    );
    expect(result).toEqual({
      ok: false,
      error: { sourceId: "hub", kind: "invalid_params", message: "Recurse Center isn't set up on this server yet." },
    });
    expect(calls).toHaveLength(0);
  });

  test("a rejected token gets the same plain message and never echoes the token", async () => {
    for (const [status, body] of [
      [401, { message: "unauthorized" }],
      [404, { message: "not_found" }],
    ] as const) {
      const { fetch } = recordingFetch(() => json(body, status));
      const result = await fetchSources(
        { inputs: {}, sources: [{ id: "hub", builtin: "recurse", method: "GET", params: { date: "today" } }] },
        { resolveAuth: async () => null, fetch, builtins: [recurse], env: ENV },
      );
      expect(result).toEqual({
        ok: false,
        error: { sourceId: "hub", kind: "invalid_params", message: "Recurse Center isn't set up on this server yet." },
      });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
  });

  test("outages and odd bodies surface as plain http/parse failures", async () => {
    const down = recordingFetch(() => new Response("<html>oops</html>", { status: 502 }));
    const outage = await sourceError(recurse.fetch({}, ctx(down.fetch)));
    expect([outage.kind, outage.message]).toEqual(["http", "Recurse Center isn't responding right now (status 502)."]);

    const odd = recordingFetch(() => json({ visits: [] }));
    const parse = await sourceError(recurse.fetch({}, ctx(odd.fetch)));
    expect([parse.kind, parse.message]).toEqual(["parse", "Recurse Center sent something unexpected."]);
  });
});

describe("recurse example Pearl", () => {
  const renderHub = (fetchFn: typeof fetch) => renderExample(recurseExample, { fetch: fetchFn, builtins: [recurse], env: ENV });

  test("renders the recorded visits and fits all four sizes", async () => {
    const output = await renderHub(recordingFetch(() => json(hubVisits)).fetch);
    expect(output.value).toBe("5 at the hub");
    expect(output.subtitle).toBe("Ada, Beatriz, Kenji +2");
    expect(output.items?.[0]).toEqual({ label: "Ada Okafor", value: "pairing" });
    expect(output.items?.[1]).toEqual({ label: "Beatriz Lindqvist" });
  });

  test("an empty hub still reads plainly and fits", async () => {
    const output = await renderHub(recordingFetch(() => json([])).fetch);
    expect(output).toEqual({ value: "0 at the hub", subtitle: "No one's checked in yet" });
  });

  test("a crowded hub with very long names and notes still fits every size", async () => {
    const longName = "Maximiliana-Evangelina Throckmorton-Featherstonehaugh";
    const crowd = Array.from({ length: 120 }, (_, i) =>
      visit(i + 1, `${longName} ${i}`, "Working on a very long note about compilers and 🦀 all day long"),
    );
    const output = await renderHub(recordingFetch(() => json(crowd)).fetch);
    expect(output.value).toBe("120 at hub");
    expect(output.subtitle).toBe("Maximiliana-Evange… +119");
    expect(output.items?.[0]?.value).toBe("Working o…");
  });
});

describe.skipIf(!process.env.LIVE || !process.env.RC_PAT)("recurse builtin — live", () => {
  test("today's hub visits come back in the normalized shape", async () => {
    const data = (await recurse.fetch({}, { fetch, auth: null, cache: undefined, env: process.env })) as RecurseHubData;
    expect(data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.count).toBe(data.visitors.length);
    for (const visitor of data.visitors) {
      expect(typeof visitor.id).toBe("number");
      expect(typeof visitor.name).toBe("string");
      expect(visitor.notes === null || typeof visitor.notes === "string").toBe(true);
    }
  }, 30_000);
});
