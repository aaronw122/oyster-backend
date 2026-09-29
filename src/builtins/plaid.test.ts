import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { SIZES } from "../contract/index.ts";
import { plaidConfigFromEnv, plaidRequest } from "../oauth/providers/plaid.ts";
import { fitAllSizes, runTransform } from "../sandbox/index.ts";
import type { BuiltinContext } from "../sources/builtins.ts";
import { createMemorySourceCache, fetchSources, SourceError } from "../sources/index.ts";
import accountsBalanceGet from "./__fixtures__/plaid/accounts-balance-get.json";
import itemLoginRequired from "./__fixtures__/plaid/error-item-login-required.json";
import { normalizePlaidBalances, type PlaidBalances, plaid } from "./plaid.ts";
import { plaidExample } from "./plaid.example.ts";

// Sandbox-shaped `/accounts/balance/get` responses (First Platypus Bank, ins_109508),
// with balances chosen for the example widget.
const SECRET = "plaid-sandbox-secret-value";
const ACCESS_TOKEN = "access-sandbox-de3ce8ef-33f8-452c-a685-8671031fc0f6";
const ENV = { PLAID_CLIENT_ID: "plaid-client-id", PLAID_SECRET: SECRET };

const BalanceRequest = z.object({
  client_id: z.string(),
  secret: z.string(),
  access_token: z.string(),
  options: z.object({ account_ids: z.array(z.string()) }).optional(),
});

function fakePlaid(reply: () => Response) {
  const requests: Array<{ url: string; body: z.infer<typeof BalanceRequest> }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), body: BalanceRequest.parse(JSON.parse(String(init?.body))) });
    return reply();
  }) as typeof fetch;
  return { fn, requests };
}

const ctx = (fetchFn: typeof fetch, env: Record<string, string | undefined> = ENV): BuiltinContext => ({
  fetch: fetchFn,
  auth: { provider: "plaid", accessToken: ACCESS_TOKEN },
  cache: undefined,
  env,
});

/** Fails with the SourceError the builtin throws. */
async function failure(promise: Promise<unknown>): Promise<SourceError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SourceError);
  return error as SourceError;
}

describe("plaid: normalization", () => {
  test("keeps each account's id, name, mask, type, balances and currency", () => {
    const data = normalizePlaidBalances(accountsBalanceGet, "2026-09-29T12:00:00.000Z");
    expect(data.asOf).toBe("2026-09-29T12:00:00.000Z");
    expect(data.accounts).toHaveLength(4);
    expect(data.accounts[0]).toEqual({
      id: "BxBXxLj1m4HMXBm9WZZmCWVbPjX16EHwv99vp",
      name: "Plaid Checking",
      mask: "1234",
      type: "depository",
      subtype: "checking",
      current: 2431.18,
      available: 2381.18,
      currency: "USD",
    });
    // Credit: `current` is the amount owed; no `available` from this institution.
    expect(data.accounts[2]).toMatchObject({ type: "credit", subtype: "credit card", current: 410.03, available: null });
  });

  test("missing names, masks and currencies fall back; unofficial currencies are kept", () => {
    const raw = {
      accounts: [
        {
          account_id: "a1",
          name: null,
          official_name: "Official",
          mask: null,
          type: "other",
          subtype: null,
          balances: { current: null, available: 5, iso_currency_code: null, unofficial_currency_code: "BTC" },
        },
      ],
    };
    expect(normalizePlaidBalances(raw, "t").accounts).toEqual([
      { id: "a1", name: "Official", mask: null, type: "other", subtype: null, current: null, available: 5, currency: "BTC" },
    ]);
  });

  test("an unexpected payload is a parse error", () => {
    expect(() => normalizePlaidBalances({ accounts: "nope" }, "t")).toThrow(SourceError);
  });
});

describe("plaid: fetch", () => {
  test("sends the server secret and the user's access token in the body; returns normalized balances", async () => {
    const plaidApi = fakePlaid(() => Response.json(accountsBalanceGet));
    const data = (await plaid.fetch({}, ctx(plaidApi.fn))) as PlaidBalances;
    expect(plaidApi.requests[0]!.url).toBe("https://sandbox.plaid.com/accounts/balance/get");
    expect(plaidApi.requests[0]!.body).toEqual({ client_id: "plaid-client-id", secret: SECRET, access_token: ACCESS_TOKEN });
    expect(data.accounts.map((a) => a.mask)).toEqual(["1234", "5678", "3333", "4444"]);
    expect(Number.isNaN(Date.parse(data.asOf))).toBe(false);
  });

  test("accountIds filters to those accounts", async () => {
    const plaidApi = fakePlaid(() => Response.json(accountsBalanceGet));
    const params = plaid.params.parse({ accountIds: " id-1 , id_2 " });
    await plaid.fetch(params, ctx(plaidApi.fn));
    expect(plaidApi.requests[0]!.body.options).toEqual({ account_ids: ["id-1", "id_2"] });
    expect(plaid.params.safeParse({ accountIds: "a,,b" }).success).toBe(false);
    expect(plaid.params.safeParse({ other: "x" }).success).toBe(false);
  });

  test("ITEM_LOGIN_REQUIRED (and other broken connections) ask the user to reconnect", async () => {
    const expired = fakePlaid(() => Response.json(itemLoginRequired, { status: 400 }));
    const error = await failure(plaid.fetch({}, ctx(expired.fn)));
    expect(error.kind).toBe("auth_missing");
    expect(error.message).toContain("ITEM_LOGIN_REQUIRED");

    const revoked = fakePlaid(() => Response.json({ error_type: "INVALID_INPUT", error_code: "INVALID_ACCESS_TOKEN" }, { status: 400 }));
    expect((await failure(plaid.fetch({}, ctx(revoked.fn)))).kind).toBe("auth_missing");
  });

  test("other failures are typed and never contain the secret, the token or Plaid's free text", async () => {
    const leaky = { error_type: "RATE_LIMIT_EXCEEDED", error_code: "RATE_LIMIT", error_message: `${SECRET} ${ACCESS_TOKEN}` };
    const rateLimited = await failure(plaid.fetch({}, ctx(fakePlaid(() => Response.json(leaky, { status: 429 })).fn)));
    expect(rateLimited.kind).toBe("http");
    expect(rateLimited.message).toContain("RATE_LIMIT");

    const badAccount = { error_type: "INVALID_INPUT", error_code: "INVALID_ACCOUNT_ID" };
    const invalid = await failure(plaid.fetch({ accountIds: "x" }, ctx(fakePlaid(() => Response.json(badAccount, { status: 400 })).fn)));
    expect(invalid.kind).toBe("invalid_params");

    const unreachable = (async () => {
      throw new Error(`connect failed ${SECRET}`);
    }) as unknown as typeof fetch;
    const network = await failure(plaid.fetch({}, ctx(unreachable)));
    expect(network.kind).toBe("network");

    const html = await failure(plaid.fetch({}, ctx(fakePlaid(() => new Response("<html>", { status: 502 })).fn)));
    expect(html.kind).toBe("http");

    for (const error of [rateLimited, invalid, network, html]) {
      expect(error.message).not.toContain(SECRET);
      expect(error.message).not.toContain(ACCESS_TOKEN);
    }
  });

  test("a server without Plaid credentials, or a user without a connection, fails before calling Plaid", async () => {
    const plaidApi = fakePlaid(() => Response.json(accountsBalanceGet));
    expect((await failure(plaid.fetch({}, ctx(plaidApi.fn, {})))).kind).toBe("unknown_builtin");
    expect((await failure(plaid.fetch({}, { ...ctx(plaidApi.fn), auth: null }))).kind).toBe("auth_missing");
    expect(plaidApi.requests).toHaveLength(0);
  });

  test("through fetchSources: no stored connection is auth_missing; results are cached per access token", async () => {
    const plaidApi = fakePlaid(() => Response.json(accountsBalanceGet));
    const noConnection = await fetchSources(plaidExample, { resolveAuth: async () => null, fetch: plaidApi.fn, env: ENV });
    expect(noConnection).toMatchObject({ ok: false, error: { kind: "auth_missing" } });

    const cache = createMemorySourceCache();
    const deps = { fetch: plaidApi.fn, env: ENV, cache };
    const alice = async () => ({ provider: "plaid", accessToken: "access-alice" });
    const bob = async () => ({ provider: "plaid", accessToken: "access-bob" });
    await fetchSources(plaidExample, { ...deps, resolveAuth: alice });
    await fetchSources(plaidExample, { ...deps, resolveAuth: alice });
    await fetchSources(plaidExample, { ...deps, resolveAuth: bob });
    expect(plaidApi.requests.map((r) => r.body.access_token)).toEqual(["access-alice", "access-bob"]);
    expect(plaid.ttlMs).toBe(5 * 60_000);
    expect(plaid.sensitive).toBe(true);
  });
});

describe("plaid: example Pearl", () => {
  async function runExample(raw: unknown) {
    const fetched = await fetchSources(plaidExample, {
      resolveAuth: async () => ({ provider: "plaid", accessToken: ACCESS_TOKEN }),
      fetch: fakePlaid(() => Response.json(raw)).fn,
      env: ENV,
    });
    if (!fetched.ok) throw new Error(fetched.error.message);
    const result = await runTransform(plaidExample.transform, fetched.data, plaidExample.inputs);
    if (!result.ok) throw new Error(result.error.message);
    return result.output;
  }

  const withAccounts = (edit: (accounts: typeof accountsBalanceGet.accounts) => unknown[]) => ({
    ...accountsBalanceGet,
    accounts: edit(structuredClone(accountsBalanceGet.accounts)),
  });

  test("shows the checking balance with the other accounts below, fitting all four sizes", async () => {
    const output = await runExample(accountsBalanceGet);
    expect(output).toEqual({
      value: "$2,431.18",
      subtitle: "Checking ••1234",
      items: [
        { label: "Plaid Saving ••5678", value: "$12,840.50" },
        { label: "Plaid Credit C… ••3333", value: "$410.03" },
        { label: "Plaid Money Ma… ••4444", value: "$43,200.00" },
      ],
    });
    const fits = fitAllSizes(output);
    for (const size of SIZES) expect(fits[size]).toMatchObject({ ok: true });
  });

  test("fits all sizes with huge balances, long names, and missing data", async () => {
    const extreme = withAccounts((accounts) =>
      accounts.map((account, i) => ({
        ...account,
        name: "An Extremely Long Account Nickname From The Bank".repeat(2),
        subtype: i === 0 ? "checking" : "a very long subtype name that goes on",
        balances: { ...account.balances, current: -987_654_321_012.34 * (i + 1), iso_currency_code: i % 2 ? "CHF" : "USD" },
      })),
    );
    const huge = await runExample(extreme);
    expect(huge.value).toBe("-$987.7B");
    for (const size of SIZES) expect(fitAllSizes(huge)[size]).toMatchObject({ ok: true });

    const sparse = withAccounts((accounts) =>
      accounts.map((account) => ({ ...account, mask: null, subtype: null, balances: { ...account.balances, current: null, available: null } })),
    );
    const empty = await runExample(sparse);
    expect(empty.value).toBe("--");
    for (const size of SIZES) expect(fitAllSizes(empty)[size]).toMatchObject({ ok: true });

    const none = await runExample({ ...accountsBalanceGet, accounts: [] });
    expect(none).toEqual({ value: "--", subtitle: "No accounts" });
  });
});

describe.skipIf(!process.env.LIVE || !process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET)("plaid: live sandbox", () => {
  test("creates a sandbox Item and reads its balances", async () => {
    const config = plaidConfigFromEnv({ ...process.env, PLAID_ENV: "sandbox" })!;
    const created = await plaidRequest(config, "/sandbox/public_token/create", {
      institution_id: "ins_109508",
      initial_products: ["transactions"],
    });
    const exchanged = await plaidRequest(config, "/item/public_token/exchange", { public_token: created.public_token });
    const accessToken = z.string().parse(exchanged.access_token);
    const data = (await plaid.fetch({}, { fetch, auth: { provider: "plaid", accessToken }, cache: undefined, env: { ...process.env, PLAID_ENV: "sandbox" } })) as PlaidBalances;
    expect(data.accounts.length).toBeGreaterThan(0);
    expect(data.accounts.some((a) => a.subtype === "checking")).toBe(true);
    const output = await runTransform(plaidExample.transform, { bank: data }, plaidExample.inputs);
    expect(output.ok).toBe(true);
    if (output.ok) for (const size of SIZES) expect(fitAllSizes(output.output)[size]).toMatchObject({ ok: true });
  }, 60_000);
});
