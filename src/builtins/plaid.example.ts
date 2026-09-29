import type { SavePearlRequest } from "../contract/index.ts";

/** "My checking balance": the checking balance up top, the other accounts below. */
export const plaidExample: SavePearlRequest = {
  name: "My checking balance",
  inputs: { accountType: "checking" },
  sources: [{ id: "bank", builtin: "plaid", method: "GET" }],
  transform: String.raw`(sources, inputs, std) => {
  const accounts = sources.bank.accounts;
  const width = (s) => Array.from(s).length;
  const titleCase = (s) => s.split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
  const money = (n, currency, max) => {
    if (n === null || n === undefined) return "--";
    const code = currency || "USD";
    const full = std.formatMoney(n, code);
    if (width(full) <= max) return full;
    const whole = std.formatMoney(std.round(n), code).replace(/\.00$/, "");
    if (width(whole) <= max) return whole;
    const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
    const unit = units.find((u) => Math.abs(n) >= u[0]) || units[3];
    const compact = std.formatMoney(std.round(n / unit[0], 1), code).replace(/\.?0+$/, "") + unit[1];
    return width(compact) <= max ? compact : std.truncate(compact, max);
  };
  const balance = (a) => (a.current === null ? a.available : a.current);
  const masked = (label, a) => (a.mask ? label + " ••" + a.mask : label);
  const main =
    accounts.find((a) => a.subtype === inputs.accountType) ||
    accounts.find((a) => a.type === "depository") ||
    accounts[0];
  if (!main) return { value: "--", subtitle: "No accounts" };
  const items = accounts
    .filter((a) => a !== main)
    .map((a) => ({ label: masked(std.truncate(a.name, 15), a), value: money(balance(a), a.currency, 10) }));
  return {
    value: money(balance(main), main.currency, 12),
    subtitle: masked(std.truncate(titleCase(main.subtype || main.name), 17), main),
    items,
  };
}`,
};
