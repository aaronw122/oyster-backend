import type { Pearl } from "../contract/index.ts";

/** Crypto prices: the lead coin's price up top, 24h move below, one row per coin. */
export const marketsExample: Pick<Pearl, "name" | "inputs" | "sources" | "transform"> = {
  name: "Crypto prices",
  inputs: { coins: "BTC,ETH" },
  sources: [
    {
      id: "prices",
      builtin: "markets",
      method: "GET",
      params: { kind: "crypto", symbols: "{inputs.coins}", currency: "usd" },
    },
  ],
  transform: `(sources, inputs, std) => {
  const data = sources.prices;
  const currency = data.currency.toUpperCase();
  const price = (n) => {
    if (n >= 1000) return std.formatMoney(Math.round(n), currency).replace(/\\.00$/, "");
    if (n >= 1) return std.formatMoney(n, currency);
    const digits = std.formatNumber(n, { decimals: n >= 0.01 ? 4 : 8 }).replace(/0+$/, "").replace(/\\.$/, "");
    return std.formatMoney(0, currency).replace("0.00", "") + digits;
  };
  const change = (q) =>
    q.changePercent === null ? "no change data" : (q.changePercent >= 0 ? "+" : "") + std.formatNumber(q.changePercent, { decimals: 1 }) + "%";
  const lead = data.quotes[0];
  const headline = lead.symbol + " " + price(lead.price);
  return {
    value: Array.from(headline).length <= 12 ? headline : std.truncate(price(lead.price), 12),
    subtitle: std.truncate(change(lead) + (lead.changePercent === null ? "" : " today") + (lead.isStale ? " (delayed)" : ""), 24),
    items: data.quotes.map((q) => ({
      label: std.truncate(q.symbol + " " + change(q), 22),
      value: std.truncate(price(q.price), 10),
    })),
  };
}`,
};
