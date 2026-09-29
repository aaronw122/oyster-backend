import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { PearlDataSchema, type Pearl, type SavePearlRequest } from "../contract/index.ts";
import { openDb } from "../db/index.ts";
import type { Builtin } from "../sources/builtins.ts";
import { createMemorySourceCache } from "../sources/index.ts";
import { PearlStore } from "../store/pearls.ts";
import { UserStore } from "../store/users.ts";
import { getPearlData, nullAuthResolverFor, type RunFailure, runDraft, type RuntimeDeps, savePearl } from "./index.ts";

type Payload = { value: string; sub?: string; items?: Array<{ label: string; value?: string }>; fail?: boolean };

let db: Database;
let pearls: PearlStore;
let now: number;
let payload: Payload;
let fetchCalls: string[];
let failures: Array<{ pearl: Pearl; failure: RunFailure }>;
let deps: RuntimeDeps;

const fakeFetch = (async (input: string | URL | Request) => {
  fetchCalls.push(String(input));
  return Response.json(payload);
}) as typeof fetch;

const draft: SavePearlRequest = {
  name: "Weather",
  inputs: {},
  sources: [{ id: "w", url: "https://api.test/weather", method: "GET" }],
  transform: `(sources) => {
    if (sources.w.fail) throw new Error("boom: feed changed");
    return { value: sources.w.value, subtitle: sources.w.sub, items: sources.w.items };
  }`,
};

beforeEach(() => {
  db = openDb(":memory:");
  pearls = new PearlStore(db);
  const users = new UserStore(db);
  users.issueToken("alice");
  users.issueToken("bob");
  now = 1_000_000;
  payload = { value: "72°", sub: "Sunny", items: [{ label: "High", value: "80°" }, { label: "Low", value: "60°" }, { label: "Wind", value: "5 mph" }] };
  fetchCalls = [];
  failures = [];
  deps = {
    pearls,
    authResolverFor: nullAuthResolverFor,
    cache: createMemorySourceCache(() => now),
    fetch: fakeFetch,
    resolveHost: async () => ["203.0.113.10"],
    onRefreshFailure: (pearl, failure) => failures.push({ pearl, failure }),
  };
});

async function saved(): Promise<Pearl> {
  const result = await savePearl("alice", draft, deps);
  if (!result.ok) throw new Error(`save failed: ${JSON.stringify(result)}`);
  return result.pearl;
}

const runs = (pearlId: string) =>
  db.query<{ kind: string; size: string | null; ok: number }, [string]>("SELECT kind, size, ok FROM runs WHERE pearl_id = ? ORDER BY id").all(pearlId);

describe("savePearl", () => {
  test("seeds lastGood for all four sizes with projected outputs, status ok, and a save run", async () => {
    const pearl = await saved();
    expect(pearl.status).toBe("ok");
    expect(pearl.lastGood?.inline).toMatchObject({ output: { value: "72°" }, version: 1 });
    expect(pearl.lastGood?.rectangular?.output).toEqual({ value: "72°", subtitle: "Sunny" });
    expect(pearl.lastGood?.small?.output.items).toHaveLength(2);
    expect(pearl.lastGood?.medium?.output.items).toHaveLength(3);
    expect(runs(pearl.id)).toEqual([{ kind: "save", size: null, ok: 1 }]);
  });

  test("update re-seeds lastGood at the new version", async () => {
    const pearl = await saved();
    payload.value = "65°";
    now += 60_000;
    const result = await savePearl("alice", { ...draft, name: "Weather 2" }, deps, pearl.id);
    expect(result).toMatchObject({ ok: true, pearl: { version: 2, name: "Weather 2" } });
    expect(pearls.get("alice", pearl.id)?.lastGood?.small).toMatchObject({ output: { value: "65°" }, version: 2 });
  });

  test("rejects an output that overflows any size and persists nothing", async () => {
    payload.value = "Mostly cloudy"; // 13 code points: fits small/medium, not the 12-char lock screen sizes
    const result = await savePearl("alice", draft, deps);
    expect(result).toMatchObject({ ok: false, failure: { stage: "fit", sizes: ["inline", "rectangular"] } });
    expect(pearls.list("alice")).toEqual([]);
  });

  test("rejects a throwing transform; an update attempt leaves the saved version untouched", async () => {
    const pearl = await saved();
    payload.fail = true;
    now += 60_000;
    const result = await savePearl("alice", { ...draft, name: "broken" }, deps, pearl.id);
    expect(result).toMatchObject({ ok: false, failure: { stage: "transform" } });
    if (result.ok || !("failure" in result)) throw new Error("unreachable");
    expect(result.failure.detail).toContain("boom");
    expect(result.failure.message).not.toContain("boom");
    expect(pearls.get("alice", pearl.id)).toMatchObject({ name: "Weather", version: 1 });
  });

  test("updating another user's Pearl is notFound without running", async () => {
    const pearl = await saved();
    fetchCalls = [];
    now += 60_000;
    expect(await savePearl("bob", draft, deps, pearl.id)).toEqual({ ok: false, notFound: true });
    expect(fetchCalls).toEqual([]);
  });
});

describe("getPearlData", () => {
  test("success returns fresh output (stale false) and persists it as lastGood", async () => {
    const pearl = await saved();
    payload.value = "68°";
    now += 60_000;
    const result = await getPearlData("alice", pearl.id, "small", deps);
    expect(result.status).toBe(200);
    if (result.status !== 200) throw new Error("unreachable");
    expect(PearlDataSchema.parse(result.body)).toMatchObject({ pearlId: pearl.id, version: 1, size: "small", stale: false, output: { value: "68°" } });
    expect(pearls.get("alice", pearl.id)?.lastGood?.small?.output.value).toBe("68°");
    expect(pearls.get("alice", pearl.id)?.lastGood?.medium?.output.value).toBe("72°");
    expect(runs(pearl.id).at(-1)).toEqual({ kind: "refresh", size: "small", ok: 1 });
  });

  test("a throwing transform returns last-good as stale and calls the repair hook", async () => {
    const pearl = await saved();
    payload.fail = true;
    now += 60_000;
    const result = await getPearlData("alice", pearl.id, "medium", deps);
    expect(result).toMatchObject({ status: 200, body: { stale: true, version: 1, output: { value: "72°" } } });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.pearl.id).toBe(pearl.id);
    expect(failures[0]!.failure).toMatchObject({ stage: "transform" });
    expect(failures[0]!.failure.detail).toContain("boom");
    expect(runs(pearl.id).at(-1)).toEqual({ kind: "refresh", size: "medium", ok: 0 });
  });

  test("failure with no last-good for that size is 503 unavailable with a plain message", async () => {
    const pearl = pearls.create("alice", draft); // bypasses save, so no lastGood
    payload.fail = true;
    const result = await getPearlData("alice", pearl.id, "small", deps);
    expect(result).toMatchObject({ status: 503, error: { code: "unavailable" } });
    if (result.status !== 503) throw new Error("unreachable");
    expect(result.error.message).not.toMatch(/boom|transform|https?:|[{}]/);
  });

  test("overflow for one size is stale for that size only", async () => {
    const pearl = await saved();
    payload.value = "Mostly cloudy";
    now += 60_000;
    const inline = await getPearlData("alice", pearl.id, "inline", deps);
    const small = await getPearlData("alice", pearl.id, "small", deps);
    expect(inline).toMatchObject({ status: 200, body: { stale: true, output: { value: "72°" } } });
    expect(small).toMatchObject({ status: 200, body: { stale: false, output: { value: "Mostly cloudy" } } });
    expect(failures.map((f) => f.failure)).toEqual([expect.objectContaining({ stage: "fit", sizes: ["inline"] })]);
  });

  test("unknown and other users' Pearls are 404", async () => {
    const pearl = await saved();
    expect(await getPearlData("bob", pearl.id, "small", deps)).toMatchObject({ status: 404, error: { code: "not_found" } });
    expect(await getPearlData("alice", "nope", "small", deps)).toMatchObject({ status: 404 });
  });

  test("concurrent requests across sizes share one run", async () => {
    const pearl = await saved();
    now += 60_000; // past the source cache TTL
    fetchCalls = [];
    const results = await Promise.all(
      (["inline", "rectangular", "small", "medium"] as const).map((size) => getPearlData("alice", pearl.id, size, deps)),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(fetchCalls).toHaveLength(1);
    // Once settled, the next refresh runs again.
    payload.value = "70°";
    now += 60_000;
    await getPearlData("alice", pearl.id, "small", deps);
    expect(fetchCalls).toHaveLength(2);
  });

  test("source responses are cached for the default TTL (~30s)", async () => {
    const pearl = await saved();
    expect(fetchCalls).toHaveLength(1);
    now += 29_000;
    await getPearlData("alice", pearl.id, "small", deps);
    expect(fetchCalls).toHaveLength(1);
    now += 2_000;
    await getPearlData("alice", pearl.id, "small", deps);
    expect(fetchCalls).toHaveLength(2);
  });

  test("a builtin's own ttlMs overrides the default TTL", async () => {
    let builtinCalls = 0;
    const slow: Builtin = {
      name: "slowfeed",
      description: "test feed",
      params: z.record(z.string(), z.string()),
      ttlMs: 120_000,
      fetch: async () => {
        builtinCalls++;
        return { value: "ok" };
      },
    };
    deps.builtins = [slow];
    const result = await savePearl(
      "alice",
      { name: "B", inputs: {}, sources: [{ id: "b", builtin: "slowfeed", method: "GET" }], transform: "(s) => ({ value: s.b.value })" },
      deps,
    );
    if (!result.ok) throw new Error("save failed");
    now += 60_000;
    await getPearlData("alice", result.pearl.id, "small", deps);
    expect(builtinCalls).toBe(1);
    now += 61_000;
    await getPearlData("alice", result.pearl.id, "small", deps);
    expect(builtinCalls).toBe(2);
  });
});

describe("runDraft", () => {
  test("reports sensitive for sensitive sources and sensitive builtins", async () => {
    const plaid: Builtin = {
      name: "plaid",
      description: "test",
      params: z.record(z.string(), z.string()),
      sensitive: true,
      fetch: async () => ({ value: "$1" }),
    };
    deps.builtins = [plaid];
    expect((await runDraft("alice", draft, deps)).sensitive).toBe(false);
    const flagged = { ...draft, sources: [{ ...draft.sources[0]!, sensitive: true }] };
    expect((await runDraft("alice", flagged, deps)).sensitive).toBe(true);
    const viaBuiltin = { ...draft, sources: [{ id: "w", builtin: "plaid", method: "GET" as const }] };
    expect(await runDraft("alice", viaBuiltin, deps)).toMatchObject({ ok: true, sensitive: true });
  });

  test("fetch failures keep a plain message and a token-free technical detail", async () => {
    const token = "sk-live-SECRET";
    deps.authResolverFor = () => async (provider) => ({ provider, accessToken: token });
    deps.fetch = (async () => new Response(`denied for ${token}`, { status: 401 })) as unknown as typeof fetch;
    const result = await runDraft("alice", { ...draft, sources: [{ ...draft.sources[0]!, auth: { provider: "acme" } }] }, deps);
    expect(result).toMatchObject({ ok: false, failure: { stage: "fetch" } });
    if (result.ok) throw new Error("unreachable");
    expect(result.failure.detail).toContain("401");
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.failure.message).not.toMatch(/https?:|401|[{}]/);
  });
});
