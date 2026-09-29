import { z } from "zod";
import { isoNow } from "../contract/index.ts";
import type { Builtin, BuiltinContext } from "../sources/builtins.ts";
import { SourceError } from "../sources/types.ts";

// Crypto: CoinGecko `/coins/markets` (keyless, or a free Demo key from
// COINGECKO_API_KEY for a stable 100 calls/min). Stocks: Twelve Data `/quote`
// with a server-held free key from TWELVE_DATA_API_KEY (8 credits/min, 800/day;
// one credit per symbol). fetchSources caches results for 60s (`ttlMs`) to stay
// inside both limits.

const TIMEOUT_MS = 8_000;
/** A live quote whose last update is older than this is flagged `isStale`. */
const STALE_AFTER_MS = 15 * 60_000;
const MAX_CRYPTO_SYMBOLS = 25;
/** Twelve Data's free plan allows 8 credits per minute, one per symbol. */
const MAX_STOCK_SYMBOLS = 8;

const COINGECKO_URL = "https://api.coingecko.com/api/v3/coins/markets";
const TWELVE_DATA_URL = "https://api.twelvedata.com/quote";

/** Common tickers → CoinGecko ids. Anything else is treated as a raw CoinGecko id. */
export const CRYPTO_TICKERS: Readonly<Record<string, string>> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  USDT: "tether",
  BNB: "binancecoin",
  SOL: "solana",
  USDC: "usd-coin",
  XRP: "ripple",
  DOGE: "dogecoin",
  TRX: "tron",
  ADA: "cardano",
  AVAX: "avalanche-2",
  SHIB: "shiba-inu",
  TON: "the-open-network",
  LINK: "chainlink",
  DOT: "polkadot",
  BCH: "bitcoin-cash",
  LTC: "litecoin",
  NEAR: "near",
  MATIC: "matic-network",
  POL: "polygon-ecosystem-token",
  UNI: "uniswap",
  XLM: "stellar",
  ATOM: "cosmos",
  XMR: "monero",
  ETC: "ethereum-classic",
  HBAR: "hedera-hashgraph",
  FIL: "filecoin",
  APT: "aptos",
  ARB: "arbitrum",
  OP: "optimism",
  SUI: "sui",
  PEPE: "pepe",
  DAI: "dai",
  ALGO: "algorand",
  AAVE: "aave",
};

export type MarketState = "open" | "closed";

export type MarketQuote = {
  symbol: string;
  name: string;
  price: number;
  /** Absolute change over the last 24h (crypto) or since the previous close (stocks). */
  change24h?: number;
  /** Percent change over the same window; null when the provider has none. */
  changePercent: number | null;
  marketState?: MarketState;
  isStale: boolean;
};

export type MarketsData = {
  kind: "crypto" | "stock";
  currency: string;
  asOf: string;
  quotes: MarketQuote[];
};

const paramsSchema = z.object({
  kind: z.enum(["crypto", "stock"]),
  symbols: z.string().trim().min(1, "list at least one symbol"),
  currency: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{3,5}$/, "use a currency code like usd")
    .default("usd"),
});

export const markets: Builtin = {
  name: "markets",
  description: [
    "Live prices for cryptocurrencies (CoinGecko) or US stocks (Twelve Data).",
    'Params: kind ("crypto" or "stock"); symbols (comma-separated, e.g. "BTC,ETH" or "AAPL,MSFT";',
    'crypto also accepts CoinGecko ids like "bitcoin"); currency (optional, default "usd").',
    "Returns { kind, currency, asOf, quotes: [{ symbol, name, price, change24h?, changePercent,",
    'marketState?: "open"|"closed", isStale }] } in the requested order. changePercent is the percent',
    "change over 24h (crypto) or since the previous close (stocks) and may be null. Crypto trades",
    "around the clock; stock quotes are the last trade, so check marketState before calling them live.",
  ].join(" "),
  params: paramsSchema,
  ttlMs: 60_000,
  async fetch(rawParams, ctx) {
    const params = paramsSchema.parse(rawParams);
    const symbols = splitSymbols(params.symbols);
    return params.kind === "crypto"
      ? fetchCrypto(symbols, params.currency, ctx)
      : fetchStocks(symbols, params.currency, ctx);
  },
};

function splitSymbols(raw: string): string[] {
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const part of raw.split(",")) {
    const symbol = part.trim();
    if (symbol === "" || seen.has(symbol.toUpperCase())) continue;
    seen.add(symbol.toUpperCase());
    symbols.push(symbol);
  }
  if (symbols.length === 0) throw new SourceError("invalid_params", "List at least one symbol, like BTC or AAPL.");
  return symbols;
}

// ── Crypto (CoinGecko) ──────────────────────────────────────────────────────

type CoinGeckoRow = {
  id: string;
  symbol: string;
  name: string;
  current_price: number | null;
  price_change_24h: number | null;
  price_change_percentage_24h: number | null;
  last_updated: string | null;
};

/** Resolves a requested token to a CoinGecko id: known ticker first, then a raw id. */
export function coinGeckoId(symbol: string): string {
  return CRYPTO_TICKERS[symbol.toUpperCase()] ?? symbol.toLowerCase();
}

async function fetchCrypto(symbols: string[], currency: string, ctx: BuiltinContext): Promise<MarketsData> {
  if (symbols.length > MAX_CRYPTO_SYMBOLS) {
    throw new SourceError("invalid_params", `Pick at most ${MAX_CRYPTO_SYMBOLS} coins.`);
  }
  for (const symbol of symbols) {
    if (!/^[a-z0-9-]{1,64}$/i.test(symbol)) {
      throw new SourceError("invalid_params", `"${symbol}" doesn't look like a coin name. Try a ticker like BTC.`);
    }
  }
  const ids = symbols.map(coinGeckoId);
  const url = new URL(COINGECKO_URL);
  url.searchParams.set("vs_currency", currency);
  url.searchParams.set("ids", [...new Set(ids)].join(","));
  url.searchParams.set("precision", "full");
  const headers: Record<string, string> = { accept: "application/json" };
  const demoKey = ctx.env.COINGECKO_API_KEY;
  if (demoKey) headers["x-cg-demo-api-key"] = demoKey;

  const { status, body } = await requestJson(url, headers, ctx, "crypto price");
  if (status === 400) {
    throw new SourceError("invalid_params", `"${currency.toUpperCase()}" isn't a currency crypto prices can be shown in.`);
  }
  if (status !== 200) throw unavailable("crypto price", status);
  if (!Array.isArray(body)) throw new SourceError("parse", "The crypto price service sent something unexpected.");

  const byId = new Map<string, CoinGeckoRow>();
  for (const row of body as CoinGeckoRow[]) {
    if (row && typeof row.id === "string") byId.set(row.id, row);
  }
  const now = Date.now();
  const quotes = symbols.map((symbol, index): MarketQuote => {
    const row = byId.get(ids[index]!);
    if (!row || typeof row.current_price !== "number") {
      throw new SourceError(
        "invalid_params",
        `Couldn't find a coin called "${symbol}". Try its ticker (like BTC) or its full name (like bitcoin).`,
      );
    }
    const updated = row.last_updated ? Date.parse(row.last_updated) : Number.NaN;
    const quote: MarketQuote = {
      symbol: row.symbol.toUpperCase(),
      name: row.name,
      price: row.current_price,
      changePercent: finiteNumber(row.price_change_percentage_24h),
      marketState: "open",
      isStale: !Number.isFinite(updated) || now - updated > STALE_AFTER_MS,
    };
    if (typeof row.price_change_24h === "number") quote.change24h = row.price_change_24h;
    return quote;
  });
  return { kind: "crypto", currency, asOf: isoNow(new Date(now)), quotes };
}

// ── Stocks (Twelve Data) ────────────────────────────────────────────────────

type TwelveDataQuote = {
  symbol?: string;
  name?: string;
  currency?: string;
  close?: string;
  change?: string;
  percent_change?: string;
  is_market_open?: boolean;
  timestamp?: number;
  last_quote_at?: number;
  status?: string;
  code?: number;
  message?: string;
};

async function fetchStocks(symbols: string[], currency: string, ctx: BuiltinContext): Promise<MarketsData> {
  const apiKey = ctx.env.TWELVE_DATA_API_KEY;
  // A server setting, not a user connection: never `auth_missing` (that asks the user to connect).
  if (!apiKey) throw new SourceError("invalid_params", "Stock quotes aren't set up on this server yet.");
  if (symbols.length > MAX_STOCK_SYMBOLS) {
    throw new SourceError("invalid_params", `Pick at most ${MAX_STOCK_SYMBOLS} stocks.`);
  }
  const tickers = symbols.map((symbol) => symbol.toUpperCase());
  for (const ticker of tickers) {
    if (!/^[A-Z0-9.\-]{1,12}(:[A-Z0-9]{1,10})?$/.test(ticker)) {
      throw new SourceError("invalid_params", `"${ticker}" doesn't look like a stock ticker. Try one like AAPL.`);
    }
  }
  const url = new URL(TWELVE_DATA_URL);
  url.searchParams.set("symbol", tickers.join(","));
  // Header auth keeps the key out of URLs (and so out of any logged error).
  const { status, body } = await requestJson(
    url,
    { accept: "application/json", authorization: `apikey ${apiKey}` },
    ctx,
    "stock quote",
  );
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    if (status !== 200) throw unavailable("stock quote", status);
    throw new SourceError("parse", "The stock quote service sent something unexpected.");
  }
  // One symbol → a bare quote (or a top-level error); several → keyed by symbol.
  const single = tickers.length === 1 || (body as TwelveDataQuote).status === "error";
  if (single) throwIfServiceError(body as TwelveDataQuote, tickers.length === 1 ? tickers[0]! : undefined);
  if (status !== 200) throw unavailable("stock quote", status);

  const now = Date.now();
  const quotes = tickers.map((ticker): MarketQuote => {
    const entry = (single ? body : (body as Record<string, unknown>)[ticker]) as TwelveDataQuote | undefined;
    if (!entry) throw unknownStock(ticker);
    throwIfServiceError(entry, ticker);
    if (entry.close === undefined) throw unknownStock(ticker);
    const price = Number(entry.close);
    if (!Number.isFinite(price)) throw new SourceError("parse", "The stock quote service sent something unexpected.");
    const quoteCurrency = (entry.currency ?? "").toLowerCase();
    if (quoteCurrency !== currency) {
      throw new SourceError(
        "invalid_params",
        `${ticker} is priced in ${quoteCurrency.toUpperCase() || "another currency"}, not ${currency.toUpperCase()}.`,
      );
    }
    const open = entry.is_market_open === true;
    const lastUpdateMs = (entry.last_quote_at ?? entry.timestamp ?? 0) * 1000;
    const quote: MarketQuote = {
      symbol: entry.symbol ?? ticker,
      name: entry.name ?? ticker,
      price,
      changePercent: finiteNumber(entry.percent_change),
      marketState: open ? "open" : "closed",
      // A closed market's last trade is expected to be old; only a live quote can go stale.
      isStale: open && now - lastUpdateMs > STALE_AFTER_MS,
    };
    const change = finiteNumber(entry.change);
    if (change !== null) quote.change24h = change;
    return quote;
  });
  return { kind: "stock", currency, asOf: isoNow(new Date(now)), quotes };
}

/**
 * Twelve Data reports errors as `{ code, message, status: "error" }`, top-level
 * or per symbol in a batch (sometimes with HTTP 200). `ticker` names the symbol
 * the error belongs to, when known.
 */
function throwIfServiceError(body: TwelveDataQuote, ticker: string | undefined): void {
  if (body.status !== "error") return;
  if (body.code === 429) throw busy("stock quote");
  if (body.code === 401) throw new SourceError("http", "The stock quote service didn't accept this server's key.");
  if (body.code === 403 && ticker !== undefined) {
    throw new SourceError("invalid_params", `${ticker} isn't included in this server's stock quote plan.`);
  }
  if ((body.code === 400 || body.code === 404) && ticker !== undefined) throw unknownStock(ticker);
  throw new SourceError("http", "The stock quote service couldn't answer right now.");
}

function unknownStock(ticker: string): SourceError {
  return new SourceError("invalid_params", `Couldn't find a stock with the ticker "${ticker}". Check the spelling.`);
}

// ── Shared HTTP helpers ─────────────────────────────────────────────────────

/** GETs `url`; a body that isn't JSON comes back as `undefined` so callers can judge by status. */
async function requestJson(
  url: URL,
  headers: Record<string, string>,
  ctx: BuiltinContext,
  service: string,
): Promise<{ status: number; body: unknown }> {
  let response: Response;
  let text: string;
  try {
    response = await ctx.fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    text = await response.text();
  } catch {
    throw new SourceError("network", `Couldn't reach the ${service} service.`);
  }
  if (response.status === 429) throw busy(service);
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    if (response.ok) throw new SourceError("parse", `The ${service} service sent something unexpected.`);
    return { status: response.status, body: undefined };
  }
}

function unavailable(service: string, status: number): SourceError {
  return new SourceError("http", `The ${service} service isn't responding right now (status ${status}).`);
}

function busy(service: string): SourceError {
  return new SourceError("http", `The ${service} service is busy right now. Try again in a minute.`);
}

/** Providers send numbers as numbers or numeric strings, and null when unknown. */
function finiteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}
