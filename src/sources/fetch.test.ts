import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { PearlSource } from "../contract/index.ts";
import type { Builtin } from "./builtins.ts";
import {
  type AuthResolver,
  createMemorySourceCache,
  type FetchSourcesDeps,
  fetchSources,
  fillTemplate,
  SourceError,
} from "./index.ts";

const TOKEN = "tok_super_secret_123";

type Call = { url: string; headers: Record<string, string> };

function fakeFetch(respond: (url: string) => Response | Promise<Response> = () => Response.json({ ok: 1 })) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    return respond(url);
  }) as typeof fetch;
  return { fn, calls };
}

const noAuth: AuthResolver = async () => null;
const withToken: AuthResolver = async (provider) => ({ provider, accessToken: TOKEN });

function urlSource(url: string, extra: Partial<PearlSource> = {}): PearlSource {
  return { id: "s", url, method: "GET", ...extra };
}

describe("fillTemplate", () => {
  test("fills nested input refs with URL-encoding", () => {
    const inputs = { city: "New York & Co", loc: { lat: 40.7, lon: -73.9 } };
    expect(fillTemplate("https://x.test/w?q={inputs.city}&lat={inputs.loc.lat}&lon={inputs.loc.lon}", inputs)).toBe(
      "https://x.test/w?q=New%20York%20%26%20Co&lat=40.7&lon=-73.9",
    );
  });

  test("rejects non-inputs refs, missing values, and non-scalars", () => {
    for (const [template, inputs] of [
      ["https://x.test/{env.SECRET}", {}],
      ["https://x.test/{token}", {}],
      ["https://x.test/{inputs.missing}", {}],
      ["https://x.test/{inputs.loc}", { loc: { lat: 1 } }],
    ] as const) {
      expect(() => fillTemplate(template, inputs)).toThrow(SourceError);
    }
  });
});

describe("fetchSources: URL sources", () => {
  test("GETs the filled URL as JSON, keyed by source id", async () => {
    const { fn, calls } = fakeFetch((url) => Response.json({ url }));
    const result = await fetchSources(
      {
        inputs: { stop: "A/B" },
        sources: [urlSource("https://x.test/stops/{inputs.stop}", { id: "stop" }), urlSource("https://y.test/", { id: "y" })],
      },
      { resolveAuth: noAuth, fetch: fn },
    );
    expect(result).toEqual({
      ok: true,
      data: { stop: { url: "https://x.test/stops/A%2FB" }, y: { url: "https://y.test/" } },
    });
    expect(calls[0]!.headers.Accept).toBe("application/json");
    expect(calls.every((call) => call.headers.Authorization === undefined)).toBe(true);
  });

  test("template error is reported without fetching", async () => {
    const { fn, calls } = fakeFetch();
    const result = await fetchSources(
      { inputs: {}, sources: [urlSource("https://x.test/{secrets.key}")] },
      { resolveAuth: noAuth, fetch: fn },
    );
    expect(result).toMatchObject({ ok: false, error: { sourceId: "s", kind: "template" } });
    expect(calls).toHaveLength(0);
  });

  test("injects a bearer token when the source requires auth", async () => {
    const { fn, calls } = fakeFetch();
    const requested: string[] = [];
    const result = await fetchSources(
      { inputs: {}, sources: [urlSource("https://api.test/me", { auth: { provider: "plaid" } })] },
      {
        resolveAuth: async (provider) => {
          requested.push(provider);
          return { provider, accessToken: TOKEN };
        },
        fetch: fn,
      },
    );
    expect(result.ok).toBe(true);
    expect(requested).toEqual(["plaid"]);
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("missing credential → auth_missing, no request", async () => {
    const { fn, calls } = fakeFetch();
    const result = await fetchSources(
      { inputs: {}, sources: [urlSource("https://api.test/me", { auth: { provider: "plaid" } })] },
      { resolveAuth: noAuth, fetch: fn },
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "auth_missing" } });
    expect(calls).toHaveLength(0);
  });

  test("non-2xx → http with status, not body", async () => {
    const { fn } = fakeFetch(() => new Response("upstream says: internal detail", { status: 503 }));
    const result = await fetchSources({ inputs: {}, sources: [urlSource("https://x.test/")] }, { resolveAuth: noAuth, fetch: fn });
    expect(result).toMatchObject({ ok: false, error: { kind: "http" } });
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toContain("503");
    expect(result.error.message).not.toContain("internal detail");
  });

  test("invalid JSON → parse", async () => {
    const { fn } = fakeFetch(() => new Response("<html>nope</html>", { status: 200 }));
    const result = await fetchSources({ inputs: {}, sources: [urlSource("https://x.test/")] }, { resolveAuth: noAuth, fetch: fn });
    expect(result).toMatchObject({ ok: false, error: { kind: "parse" } });
  });

  test("thrown fetch → network", async () => {
    const { fn } = fakeFetch(() => {
      throw new TypeError("connection refused");
    });
    const result = await fetchSources({ inputs: {}, sources: [urlSource("https://x.test/")] }, { resolveAuth: noAuth, fetch: fn });
    expect(result).toMatchObject({ ok: false, error: { kind: "network" } });
  });

  test("slow upstream times out → network", async () => {
    const hang = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;
    const result = await fetchSources(
      { inputs: {}, sources: [urlSource("https://x.test/")] },
      { resolveAuth: noAuth, fetch: hang, timeoutMs: 20 },
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "network" } });
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toContain("timed out");
  });

  test("first failing source in declaration order is reported", async () => {
    const { fn } = fakeFetch((url) => (url.includes("bad") ? new Response("", { status: 404 }) : Response.json({})));
    const result = await fetchSources(
      {
        inputs: {},
        sources: [
          urlSource("https://x.test/good", { id: "good" }),
          urlSource("https://x.test/bad", { id: "bad" }),
          urlSource("https://x.test/{nope}", { id: "later" }),
        ],
      },
      { resolveAuth: noAuth, fetch: fn },
    );
    expect(result).toMatchObject({ ok: false, error: { sourceId: "bad", kind: "http" } });
  });

  test("error messages never contain the token", async () => {
    const { fn } = fakeFetch(() => {
      throw new Error(`socket closed while sending Authorization: Bearer ${TOKEN}`);
    });
    const result = await fetchSources(
      { inputs: {}, sources: [urlSource("https://x.test/", { auth: { provider: "plaid" } })] },
      { resolveAuth: withToken, fetch: fn },
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe("fetchSources: builtins", () => {
  function fakeBuiltin(overrides: Partial<Builtin> = {}) {
    const calls: Array<{ params: Record<string, string>; token: string | undefined }> = [];
    const builtin: Builtin = {
      name: "fake",
      description: "test builtin",
      params: z.object({ station: z.string().min(1) }),
      async fetch(params, ctx) {
        calls.push({ params, token: ctx.auth?.accessToken });
        return { station: params.station, bikes: 3 };
      },
      ...overrides,
    };
    return { builtin, calls };
  }

  const builtinSource = (params: Record<string, string>): PearlSource => ({
    id: "b",
    builtin: "fake",
    params,
    method: "GET",
  });

  test("dispatches with inputs filled into params without URL-encoding", async () => {
    const { builtin, calls } = fakeBuiltin();
    const result = await fetchSources(
      { inputs: { home: "W 52 St & 6 Ave" }, sources: [builtinSource({ station: "{inputs.home}" })] },
      { resolveAuth: noAuth, builtins: [builtin] },
    );
    expect(result).toEqual({ ok: true, data: { b: { station: "W 52 St & 6 Ave", bikes: 3 } } });
    expect(calls).toEqual([{ params: { station: "W 52 St & 6 Ave" }, token: undefined }]);
  });

  test("unknown builtin", async () => {
    const result = await fetchSources(
      { inputs: {}, sources: [{ ...builtinSource({}), builtin: "nope" }] },
      { resolveAuth: noAuth, builtins: [] },
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "unknown_builtin" } });
  });

  test("params failing the builtin schema → invalid_params, builtin not called", async () => {
    const { builtin, calls } = fakeBuiltin();
    const result = await fetchSources(
      { inputs: {}, sources: [builtinSource({ station: "" })] },
      { resolveAuth: noAuth, builtins: [builtin] },
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "invalid_params" } });
    expect(calls).toHaveLength(0);
  });

  test("auth-requiring builtin receives the credential, or fails auth_missing", async () => {
    const { builtin, calls } = fakeBuiltin({ auth: { provider: "plaid" } });
    const deps: FetchSourcesDeps = { resolveAuth: withToken, builtins: [builtin] };
    expect((await fetchSources({ inputs: {}, sources: [builtinSource({ station: "x" })] }, deps)).ok).toBe(true);
    expect(calls[0]!.token).toBe(TOKEN);

    const missing = await fetchSources(
      { inputs: {}, sources: [builtinSource({ station: "x" })] },
      { resolveAuth: noAuth, builtins: [builtin] },
    );
    expect(missing).toMatchObject({ ok: false, error: { kind: "auth_missing" } });
  });

  test("builtin failures keep SourceError kinds; other throws are network; token is redacted", async () => {
    const typed = fakeBuiltin({
      async fetch() {
        throw new SourceError("http", "upstream 500");
      },
    });
    const typedResult = await fetchSources(
      { inputs: {}, sources: [builtinSource({ station: "x" })] },
      { resolveAuth: noAuth, builtins: [typed.builtin] },
    );
    expect(typedResult).toMatchObject({ ok: false, error: { kind: "http", message: "upstream 500" } });

    const leaky = fakeBuiltin({
      auth: { provider: "plaid" },
      async fetch(_params, ctx) {
        throw new Error(`bad token ${ctx.auth?.accessToken}`);
      },
    });
    const leakyResult = await fetchSources(
      { inputs: {}, sources: [builtinSource({ station: "x" })] },
      { resolveAuth: withToken, builtins: [leaky.builtin] },
    );
    expect(leakyResult).toMatchObject({ ok: false, error: { kind: "network" } });
    expect(JSON.stringify(leakyResult)).not.toContain(TOKEN);
  });
});

describe("fetchSources: cache", () => {
  test("hit avoids a second fetch until the TTL expires", async () => {
    let now = 1_000;
    const cache = createMemorySourceCache(() => now);
    const { fn, calls } = fakeFetch(() => Response.json({ n: calls.length }));
    const pearl = { inputs: { q: "x" }, sources: [urlSource("https://x.test/?q={inputs.q}")] };
    const deps: FetchSourcesDeps = { resolveAuth: noAuth, fetch: fn, cache, defaultTtlMs: 30_000 };

    expect(await fetchSources(pearl, deps)).toEqual({ ok: true, data: { s: { n: 1 } } });
    now += 29_999;
    expect(await fetchSources(pearl, deps)).toEqual({ ok: true, data: { s: { n: 1 } } });
    expect(calls).toHaveLength(1);
    now += 1;
    expect(await fetchSources(pearl, deps)).toEqual({ ok: true, data: { s: { n: 2 } } });
    expect(calls).toHaveLength(2);
  });

  test("different resolved inputs or credentials do not share entries; failures are not cached", async () => {
    const cache = createMemorySourceCache(() => 0);
    const { fn, calls } = fakeFetch((url) => (url.endsWith("fail") ? new Response("", { status: 500 }) : Response.json({})));
    const source = urlSource("https://x.test/{inputs.q}", { auth: { provider: "p" } });
    const as = (accessToken: string): AuthResolver => async (provider) => ({ provider, accessToken });

    await fetchSources({ inputs: { q: "a" }, sources: [source] }, { resolveAuth: as("t1"), fetch: fn, cache });
    await fetchSources({ inputs: { q: "b" }, sources: [source] }, { resolveAuth: as("t1"), fetch: fn, cache });
    await fetchSources({ inputs: { q: "a" }, sources: [source] }, { resolveAuth: as("t2"), fetch: fn, cache });
    await fetchSources({ inputs: { q: "a" }, sources: [source] }, { resolveAuth: as("t1"), fetch: fn, cache });
    expect(calls).toHaveLength(3);

    await fetchSources({ inputs: { q: "fail" }, sources: [source] }, { resolveAuth: as("t1"), fetch: fn, cache });
    await fetchSources({ inputs: { q: "fail" }, sources: [source] }, { resolveAuth: as("t1"), fetch: fn, cache });
    expect(calls).toHaveLength(5);
  });
});
