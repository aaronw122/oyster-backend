import { z } from "zod";
import { PlaidApiError, type PlaidConfig, plaidConfigFromEnv, plaidRequest } from "../oauth/providers/plaid.ts";
import type { Builtin, BuiltinContext } from "../sources/builtins.ts";
import { SourceError } from "../sources/types.ts";

// Real-time balances (`/accounts/balance/get`) are billed and rate-limited per Item,
// so a refreshed widget reuses a result for 5 minutes (per access token, see fetchSources).
const CACHE_TTL_MS = 5 * 60_000;

// Plaid errors meaning the stored connection no longer works; the user must reconnect.
// https://plaid.com/docs/errors/item/, https://plaid.com/docs/errors/invalid-input/
const RECONNECT_CODES: Record<string, true> = {
  ITEM_LOGIN_REQUIRED: true,
  INVALID_ACCESS_TOKEN: true,
  ITEM_NOT_FOUND: true,
  ACCESS_NOT_GRANTED: true,
  USER_PERMISSION_REVOKED: true,
  ITEM_LOCKED: true,
  INVALID_CREDENTIALS: true,
  INVALID_MFA: true,
  NO_ACCOUNTS: true,
  ITEM_NO_LONGER_AVAILABLE: true,
  ITEM_CONCURRENTLY_DELETED: true,
};

const PlaidParams = z
  .object({
    accountIds: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]+(\s*,\s*[A-Za-z0-9_-]+)*$/, "accountIds must be comma-separated account ids")
      .optional(),
  })
  .strict();

const PlaidBalanceResponse = z.object({
  accounts: z.array(
    z.object({
      account_id: z.string(),
      name: z.string().nullish(),
      official_name: z.string().nullish(),
      mask: z.string().nullish(),
      type: z.string().nullish(),
      subtype: z.string().nullish(),
      balances: z.object({
        current: z.number().nullish(),
        available: z.number().nullish(),
        iso_currency_code: z.string().nullish(),
        unofficial_currency_code: z.string().nullish(),
      }),
    }),
  ),
});

export type PlaidAccount = {
  id: string;
  name: string;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  current: number | null;
  available: number | null;
  currency: string | null;
};
export type PlaidBalances = { accounts: PlaidAccount[]; asOf: string };

/** Converts a raw `/accounts/balance/get` response into the normalized shape. */
export function normalizePlaidBalances(raw: unknown, asOf: string): PlaidBalances {
  const parsed = PlaidBalanceResponse.safeParse(raw);
  if (!parsed.success) throw new SourceError("parse", "the bank data service returned an unexpected balance response");
  return {
    accounts: parsed.data.accounts.map((account) => ({
      id: account.account_id,
      name: account.name ?? account.official_name ?? "Account",
      mask: account.mask ?? null,
      type: account.type ?? null,
      subtype: account.subtype ?? null,
      current: account.balances.current ?? null,
      available: account.balances.available ?? null,
      currency: account.balances.iso_currency_code ?? account.balances.unofficial_currency_code ?? null,
    })),
    asOf,
  };
}

/** Maps a failed Plaid call to a source failure; messages carry only Plaid's error code. */
function sourceErrorFor(error: PlaidApiError): SourceError {
  if (error.errorCode !== null && RECONNECT_CODES[error.errorCode]) {
    return new SourceError("auth_missing", `the bank connection needs to be reconnected (${error.errorCode})`);
  }
  if (error.errorCode === "INVALID_ACCOUNT_ID") {
    return new SourceError("invalid_params", "accountIds contains an account that isn't in this bank connection");
  }
  if (error.status === null) return new SourceError("network", "the bank data service could not be reached");
  return new SourceError("http", `the bank data service returned an error (${error.errorCode ?? `HTTP ${error.status}`})`);
}

async function fetchPlaidBalances(rawParams: Record<string, string>, ctx: BuiltinContext): Promise<PlaidBalances> {
  const parsedParams = PlaidParams.safeParse(rawParams);
  if (!parsedParams.success) {
    throw new SourceError("invalid_params", parsedParams.error.issues.map((issue) => issue.message).join("; "));
  }
  if (!ctx.auth) throw new SourceError("auth_missing", "no plaid credential; the user must connect their bank");
  let config: PlaidConfig | null;
  try {
    config = plaidConfigFromEnv(ctx.env);
  } catch {
    config = null;
  }
  if (!config) throw new SourceError("unknown_builtin", "bank balances aren't configured on this server");

  const accountIds = parsedParams.data.accountIds
    ?.split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  const body: Record<string, unknown> = { access_token: ctx.auth.accessToken };
  if (accountIds?.length) body.options = { account_ids: accountIds };

  let raw: Record<string, unknown>;
  try {
    raw = await plaidRequest(config, "/accounts/balance/get", body, ctx.fetch);
  } catch (error) {
    if (error instanceof PlaidApiError) throw sourceErrorFor(error);
    throw new SourceError("network", "the bank data service could not be reached");
  }
  return normalizePlaidBalances(raw, new Date().toISOString());
}

export const plaid: Builtin = {
  name: "plaid",
  description: [
    "Live balances of the user's own bank accounts (checking, savings, credit cards) via Plaid.",
    "Needs the user to connect their bank first (sign-in provider: plaid). Sensitive: you only ever see the shape, never values.",
    "Params: accountIds (optional, comma-separated Plaid account ids; default all accounts).",
    "Returns { accounts: [{ id, name, mask, type, subtype, current, available, currency }], asOf }.",
    "name is the bank's account name like Plaid Checking; mask is the last 4 digits like 1234 (may be null);",
    "type is depository | credit | loan | investment | other; subtype is e.g. checking, savings, credit card;",
    "current is the balance (for credit and loans: the amount owed); available is what can be spent (may be null);",
    "currency is an ISO code like USD (may be null); asOf is an ISO timestamp.",
    "Pick accounts in the transform by subtype or type rather than by id.",
  ].join(" "),
  params: PlaidParams,
  auth: { provider: "plaid" },
  sensitive: true,
  ttlMs: CACHE_TTL_MS,
  fetch: fetchPlaidBalances,
};
