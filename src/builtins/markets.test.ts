import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { BuiltinContext } from "../sources/builtins.ts";
import { createMemorySourceCache, fetchSources, type SourceError } from "../sources/index.ts";
import coingeckoMarkets from "./__fixtures__/markets/coingecko-markets.json";
import twelveDataUnauthorized from "./__fixtures__/markets/twelvedata-error-401.json";
import twelveDataAapl from "./__fixtures__/markets/twelvedata-quote-aapl.json";
import { coinGeckoId, markets, type MarketsData } from "./markets.ts";
import { marketsExample } from "./markets.example.ts";
import { builtinContext, json, recordingFetch, renderExample, sourceError } from "./testing.ts";

// Fixture provenance (all recorded 2026-09-29):
// - twelvedata-quote-aapl.json / twelvedata-error-401.json: raw Twelve Data
//   `/quote?symbol=AAPL` responses (US market open; and a bad key).
// - coingecko-markets.json: real BTC/ETH/SOL data, but NOT a raw `/coins/markets`
//   capture — that endpoint was CloudFront-blocked for this IP, so each row was
//   reshaped one-to-one from the live `/coins/{id}` `market_data.*.usd` fields.
// - The MSFT batch entry below is synthesized from the AAPL record (the demo key
//   serves AAPL only); the per-symbol error follows Twelve Data's documented shape.
// The clock is pinned just after the recordings.
const COINGECKO_RECORDED_AT = Math.max(...coingeckoMarkets.map((row) => Date.parse(row.last_updated)));
const AAPL_RECORDED_AT = twelveDataAapl.last_quote_at * 1000;
const STOCK_KEY = "td-secret-key";

const ctx = (fetchFn: typeof fetch, env: Record<string, string | undefined> = {}) => builtinContext(fetchFn, { env });

const expectSourceError = async (promise: Promise<unknown>, kind: SourceError["kind"]) => (await sourceError(promise, kind)).message;

afterEach(() => setSystemTime());

describe("crypto symbol resolution", () => {
  test("common tickers map to CoinGecko ids in any case; other tokens are raw ids", () => {
    expect(coinGeckoId("BTC")).toBe("bitcoin");
    expect(coinGeckoId("eth")).toBe("ethereum");
    expect(coinGeckoId("AVAX")).toBe("avalanche-2");
    expect(coinGeckoId("bitcoin")).toBe("bitcoin");
    expect(coinGeckoId("Render-Token")).toBe("render-token");
  });
});

describe("markets builtin — crypto (CoinGecko)", () => {
  test("normalizes the recorded response in the requested order", async () => {
    setSystemTime(new Date(COINGECKO_RECORDED_AT + 30_000));
    const { fetch, calls } = recordingFetch(() => json(coingeckoMarkets));
    const data = (await markets.fetch({ kind: "crypto", symbols: "sol, bitcoin,ETH", currency: "usd" }, ctx(fetch))) as MarketsData;

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("ids")).toBe("solana,bitcoin,ethereum");
    expect(calls[0]!.url.searchParams.get("vs_currency")).toBe("usd");
    expect(calls[0]!.headers.has("x-cg-demo-api-key")).toBe(false);

    expect(data.kind).toBe("crypto");
    expect(data.currency).toBe("usd");
    expect(data.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(data.quotes.map((q) => q.symbol)).toEqual(["SOL", "BTC", "ETH"]);
    const btc = coingeckoMarkets.find((row) => row.id === "bitcoin")!;
    expect(data.quotes[1]).toEqual({
      symbol: "BTC",
      name: "Bitcoin",
      price: btc.current_price,
      change24h: btc.price_change_24h,
      changePercent: btc.price_change_percentage_24h,
      marketState: "open",
      isStale: false,
    });
  });

  test("flags a quote as stale when its last update is over 15 minutes old", async () => {
    setSystemTime(new Date(COINGECKO_RECORDED_AT + 20 * 60_000));
    const { fetch } = recordingFetch(() => json(coingeckoMarkets));
    const data = (await markets.fetch({ kind: "crypto", symbols: "BTC", currency: "usd" }, ctx(fetch))) as MarketsData;
    expect(data.quotes[0]!.isStale).toBe(true);
  });

  test("sends the optional Demo key as a header", async () => {
    const { fetch, calls } = recordingFetch(() => json(coingeckoMarkets));
    await markets.fetch({ kind: "crypto", symbols: "BTC", currency: "usd" }, ctx(fetch, { COINGECKO_API_KEY: "cg-demo" }));
    expect(calls[0]!.headers.get("x-cg-demo-api-key")).toBe("cg-demo");
    expect(calls[0]!.url.search).not.toContain("cg-demo");
  });

  test("an unknown coin fails the source with a plain invalid_params message", async () => {
    const { fetch } = recordingFetch(() => json(coingeckoMarkets));
    const result = await fetchSources(
      { inputs: {}, sources: [{ id: "p", builtin: "markets", method: "GET", params: { kind: "crypto", symbols: "BTC,NOTACOIN" } }] },
      { resolveAuth: async () => null, fetch, builtins: [markets], env: {} },
    );
    expect(result).toEqual({
      ok: false,
      error: {
        sourceId: "p",
        kind: "invalid_params",
        message: 'Couldn\'t find a coin called "NOTACOIN". Try its ticker (like BTC) or its full name (like bitcoin).',
      },
    });
  });

  test("an unsupported currency is a params problem, not an outage", async () => {
    const { fetch } = recordingFetch(() => json({ error: "invalid vs_currency" }, 400));
    const message = await expectSourceError(markets.fetch({ kind: "crypto", symbols: "BTC", currency: "xyz" }, ctx(fetch)), "invalid_params");
    expect(message).toBe('"XYZ" isn\'t a currency crypto prices can be shown in.');
  });

  test("rate limits and blocked requests surface as plain http failures", async () => {
    const limited = recordingFetch(() => json({ status: { error_code: 429, error_message: "You've exceeded the Rate Limit." } }, 429));
    expect(await expectSourceError(markets.fetch({ kind: "crypto", symbols: "BTC" }, ctx(limited.fetch)), "http")).toBe(
      "The crypto price service is busy right now. Try again in a minute.",
    );
    const blocked = recordingFetch(() => new Response("<HTML><H1>403 ERROR</H1></HTML>", { status: 403 }));
    const message = await expectSourceError(markets.fetch({ kind: "crypto", symbols: "BTC" }, ctx(blocked.fetch)), "http");
    expect(message).toBe("The crypto price service isn't responding right now (status 403).");
  });

  test("fetchSources caches a result for 60 seconds to respect provider rate limits", async () => {
    let now = COINGECKO_RECORDED_AT;
    const { fetch, calls } = recordingFetch(() => json(coingeckoMarkets));
    const pearl = {
      inputs: {},
      sources: [{ id: "p", builtin: "markets", method: "GET" as const, params: { kind: "crypto", symbols: "BTC,ETH" } }],
    };
    const deps = { resolveAuth: async () => null, fetch, builtins: [markets], env: {}, cache: createMemorySourceCache(() => now) };
    const first = await fetchSources(pearl, deps);
    now += 59_999;
    expect(await fetchSources(pearl, deps)).toEqual(first);
    expect(calls).toHaveLength(1);
    now += 1;
    await fetchSources(pearl, deps);
    expect(calls).toHaveLength(2);
  });
});

describe("markets builtin — stocks (Twelve Data)", () => {
  test("without a server key the source fails as a params problem (not a user connection) and makes no request", async () => {
    const { fetch, calls } = recordingFetch(() => json(twelveDataAapl));
    const result = await fetchSources(
      { inputs: {}, sources: [{ id: "s", builtin: "markets", method: "GET", params: { kind: "stock", symbols: "AAPL" } }] },
      { resolveAuth: async () => null, fetch, builtins: [markets], env: {} },
    );
    expect(result).toEqual({
      ok: false,
      error: { sourceId: "s", kind: "invalid_params", message: "Stock quotes aren't set up on this server yet." },
    });
    expect(calls).toHaveLength(0);
  });

  test("normalizes the recorded AAPL quote; the key travels in a header, never the URL", async () => {
    setSystemTime(new Date(AAPL_RECORDED_AT + 60_000));
    const { fetch, calls } = recordingFetch(() => json(twelveDataAapl));
    const data = (await markets.fetch({ kind: "stock", symbols: "aapl" }, ctx(fetch, { TWELVE_DATA_API_KEY: STOCK_KEY }))) as MarketsData;

    expect(calls[0]!.url.searchParams.get("symbol")).toBe("AAPL");
    expect(calls[0]!.url.href).not.toContain(STOCK_KEY);
    expect(calls[0]!.headers.get("authorization")).toBe(`apikey ${STOCK_KEY}`);
    expect(data).toMatchObject({ kind: "stock", currency: "usd" });
    expect(data.quotes).toEqual([
      {
        symbol: "AAPL",
        name: "Apple Inc.",
        price: Number(twelveDataAapl.close),
        change24h: Number(twelveDataAapl.change),
        changePercent: Number(twelveDataAapl.percent_change),
        marketState: "open",
        isStale: false,
      },
    ]);
  });

  test("a live quote goes stale after 15 minutes without an update; a closed market's close does not", async () => {
    setSystemTime(new Date(AAPL_RECORDED_AT + 16 * 60_000));
    const env = { TWELVE_DATA_API_KEY: STOCK_KEY };
    const open = recordingFetch(() => json(twelveDataAapl));
    const live = (await markets.fetch({ kind: "stock", symbols: "AAPL" }, ctx(open.fetch, env))) as MarketsData;
    expect(live.quotes[0]).toMatchObject({ marketState: "open", isStale: true });

    const closed = recordingFetch(() => json({ ...twelveDataAapl, is_market_open: false }));
    const after = (await markets.fetch({ kind: "stock", symbols: "AAPL" }, ctx(closed.fetch, env))) as MarketsData;
    expect(after.quotes[0]).toMatchObject({ marketState: "closed", isStale: false });
  });

  test("batch quotes keep the requested order; a bad ticker fails with a plain message", async () => {
    const env = { TWELVE_DATA_API_KEY: STOCK_KEY };
    const msft = { ...twelveDataAapl, symbol: "MSFT", name: "Microsoft Corporation", close: "512.5" };
    const ok = recordingFetch(() => json({ AAPL: twelveDataAapl, MSFT: msft }));
    const data = (await markets.fetch({ kind: "stock", symbols: "MSFT,AAPL" }, ctx(ok.fetch, env))) as MarketsData;
    expect(ok.calls[0]!.url.searchParams.get("symbol")).toBe("MSFT,AAPL");
    expect(data.quotes.map((q) => [q.symbol, q.price])).toEqual([
      ["MSFT", 512.5],
      ["AAPL", Number(twelveDataAapl.close)],
    ]);

    const notFound = { code: 404, message: "**symbol** not found: ZZZZQ.", status: "error" };
    const bad = recordingFetch(() => json({ AAPL: twelveDataAapl, ZZZZQ: notFound }));
    const message = await expectSourceError(markets.fetch({ kind: "stock", symbols: "AAPL,ZZZZQ" }, ctx(bad.fetch, env)), "invalid_params");
    expect(message).toBe('Couldn\'t find a stock with the ticker "ZZZZQ". Check the spelling.');
  });

  test("a rejected key is an http failure whose message never echoes the key", async () => {
    const { fetch } = recordingFetch(() => json(twelveDataUnauthorized, 401));
    const result = await fetchSources(
      { inputs: {}, sources: [{ id: "s", builtin: "markets", method: "GET", params: { kind: "stock", symbols: "AAPL" } }] },
      { resolveAuth: async () => null, fetch, builtins: [markets], env: { TWELVE_DATA_API_KEY: STOCK_KEY } },
    );
    expect(result).toEqual({
      ok: false,
      error: { sourceId: "s", kind: "http", message: "The stock quote service didn't accept this server's key." },
    });
  });

  test("a stock priced in another currency is rejected rather than mislabeled", async () => {
    const { fetch } = recordingFetch(() => json(twelveDataAapl));
    const message = await expectSourceError(
      markets.fetch({ kind: "stock", symbols: "AAPL", currency: "eur" }, ctx(fetch, { TWELVE_DATA_API_KEY: STOCK_KEY })),
      "invalid_params",
    );
    expect(message).toBe("AAPL is priced in USD, not EUR.");
  });
});

describe("markets example Pearl", () => {
  const renderMarkets = (fetchFn: typeof fetch) => renderExample(marketsExample, { fetch: fetchFn, builtins: [markets] });

  test("renders the recorded prices and fits all four sizes", async () => {
    setSystemTime(new Date(COINGECKO_RECORDED_AT + 30_000));
    const output = await renderMarkets(recordingFetch(() => json(coingeckoMarkets)).fetch);
    const btc = coingeckoMarkets.find((row) => row.id === "bitcoin")!;
    expect(output.value).toMatch(/^BTC \$[\d,]+$/);
    expect(output.subtitle).toMatch(/^[+-]\d+\.\d% today$/);
    expect(output.items?.map((item) => item.label.split(" ")[0])).toEqual(["BTC", "ETH"]);
    expect(output.value).toBe(`BTC $${Math.round(btc.current_price).toLocaleString("en-US")}`);
  });

  test("still fits every size with worst-case prices and missing change data", async () => {
    setSystemTime(new Date(COINGECKO_RECORDED_AT + 60 * 60_000));
    const extreme = coingeckoMarkets.map((row) => ({
      ...row,
      current_price: row.id === "bitcoin" ? 9_876_543.21 : 0.000012,
      price_change_24h: null,
      price_change_percentage_24h: null,
    }));
    const output = await renderMarkets(recordingFetch(() => json(extreme)).fetch);
    expect(output.value).toBe("$9,876,543");
    expect(output.items?.[1]).toEqual({ label: "ETH no change data", value: "$0.000012" });
  });
});

describe.skipIf(!process.env.LIVE)("markets builtin — live", () => {
  const live = (): BuiltinContext => ({ fetch, auth: null, cache: undefined, env: process.env });

  test("CoinGecko returns BTC and ETH in order", async () => {
    const data = (await markets.fetch({ kind: "crypto", symbols: "BTC,ETH", currency: "usd" }, live())) as MarketsData;
    expect(data.quotes.map((q) => q.symbol)).toEqual(["BTC", "ETH"]);
    expect(data.quotes[0]!.price).toBeGreaterThan(0);
  });

  test.skipIf(!process.env.TWELVE_DATA_API_KEY)("Twelve Data returns AAPL", async () => {
    const data = (await markets.fetch({ kind: "stock", symbols: "AAPL", currency: "usd" }, live())) as MarketsData;
    expect(data.quotes[0]).toMatchObject({ symbol: "AAPL", name: "Apple Inc." });
  });
});
