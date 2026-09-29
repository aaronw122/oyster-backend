import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { z } from "zod";
import itemLoginRequired from "../../builtins/__fixtures__/plaid/error-item-login-required.json";
import itemPublicTokenExchange from "../../builtins/__fixtures__/plaid/item-public-token-exchange.json";
import linkTokenCreate from "../../builtins/__fixtures__/plaid/link-token-create.json";
import linkTokenGetExit from "../../builtins/__fixtures__/plaid/link-token-get-exit.json";
import linkTokenGetSuccess from "../../builtins/__fixtures__/plaid/link-token-get-success.json";
import { loadConfig } from "../../config.ts";
import { openDb } from "../../db/index.ts";
import { nullAuthResolverFor } from "../../runtime/index.ts";
import { type AppEnv, createApp } from "../../server/app.ts";
import { createMemorySourceCache } from "../../sources/index.ts";
import { PearlStore } from "../../store/pearls.ts";
import { UserStore } from "../../store/users.ts";
import { createOAuthStartUrl, loadProviders, OAuthError, type OAuthProviderAdapter, OAuthTokenStore } from "../index.ts";
import { type PlaidConfig, plaidAdapter, plaidConfigFromEnv } from "./plaid.ts";

const SECRET = "plaid-sandbox-secret-value";
const CONFIG: PlaidConfig = { clientId: "plaid-client-id", secret: SECRET, environment: "sandbox" };
const appConfig = loadConfig({ NODE_ENV: "test", PUBLIC_BASE_URL: "https://oyster.test" });
const T0 = Date.parse("2026-09-29T12:00:00Z");

type Call = { url: string; body: Record<string, unknown> };
type Reply = { status?: number; json: unknown };

/** Fake Plaid API: replies per endpoint path (a queue, last reply repeats) and records every request. */
function fakePlaid(replies: Record<string, Reply[]>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const queue = replies[new URL(url).pathname];
    if (!queue?.length) return Response.json({ error_code: "NOT_FOUND" }, { status: 404 });
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    return Response.json(reply.json, { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { fn, calls, paths: () => calls.map((call) => new URL(call.url).pathname) };
}

const successReplies = (): Record<string, Reply[]> => ({
  "/link/token/create": [{ json: linkTokenCreate }],
  "/link/token/get": [{ json: linkTokenGetSuccess }],
  "/item/public_token/exchange": [{ json: itemPublicTokenExchange }],
});

const noSleep = async () => {};

/** The recorded `/link/token/create` request body. */
const LinkTokenCreateBody = z.object({
  user: z.object({ client_user_id: z.string() }),
  hosted_link: z.object({ completion_redirect_uri: z.string(), is_mobile_app: z.boolean() }),
});

describe("plaid: env", () => {
  test("enabled only with both credentials; sandbox by default; unknown env is rejected", () => {
    expect(plaidConfigFromEnv({})).toBeNull();
    expect(plaidConfigFromEnv({ PLAID_CLIENT_ID: "id" })).toBeNull();
    expect(plaidConfigFromEnv({ PLAID_CLIENT_ID: "id", PLAID_SECRET: "s" })).toEqual({ clientId: "id", secret: "s", environment: "sandbox" });
    expect(plaidConfigFromEnv({ PLAID_CLIENT_ID: "id", PLAID_SECRET: "s", PLAID_ENV: "Production" })?.environment).toBe("production");
    expect(() => plaidConfigFromEnv({ PLAID_CLIENT_ID: "id", PLAID_SECRET: "s", PLAID_ENV: "development" })).toThrow();
    expect(loadProviders({}).has("plaid")).toBe(false);
    const providers = loadProviders({ PLAID_CLIENT_ID: "id", PLAID_SECRET: "s" });
    expect(providers.get("plaid")?.displayName).toBe("your bank");
  });

  test("production credentials talk to the production host", async () => {
    const plaid = fakePlaid(successReplies());
    const adapter = plaidAdapter({ ...CONFIG, environment: "production" }, { fetch: plaid.fn });
    await adapter.authorizeUrl({ state: "n".repeat(20), redirectUri: "https://srv/cb", userId: "alice", saveFlowData: () => {} });
    expect(new URL(plaid.calls[0]!.url).origin).toBe("https://production.plaid.com");
  });
});

describe("plaid: Hosted Link through the OAuth routes", () => {
  let db: Database;
  let app: Hono<AppEnv>;
  let tokens: OAuthTokenStore;
  let plaid: ReturnType<typeof fakePlaid>;

  function mount(replies: Record<string, Reply[]>, pollAttempts = 3) {
    plaid = fakePlaid(replies);
    const providers = new Map<string, OAuthProviderAdapter>([
      ["plaid", plaidAdapter(CONFIG, { fetch: plaid.fn, sleep: noSleep, sessionPollAttempts: pollAttempts })],
    ]);
    tokens = new OAuthTokenStore(db, appConfig.tokenEncryptionKey, providers, { now: () => T0 });
    const pearls = new PearlStore(db);
    const runtime = { pearls, authResolverFor: nullAuthResolverFor, cache: createMemorySourceCache() };
    app = createApp({ config: appConfig, db, pearls, users: new UserStore(db), runtime, oauth: { providers, tokens, now: () => T0 } });
  }

  beforeEach(() => {
    db = openDb(":memory:");
    new UserStore(db).issueToken("alice");
  });

  /** /start as the browser runs it: the Hosted Link URL and the binding cookie. */
  async function start() {
    const startUrl = new URL(createOAuthStartUrl(appConfig, "alice", "plaid", T0));
    const res = await app.request(`${startUrl.pathname}${startUrl.search}`);
    expect(res.status).toBe(302);
    return { location: res.headers.get("location") ?? "", cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
  }

  /** Follows Plaid's completion redirect (from the link token request) back to our callback. */
  async function completeLink(cookie: string) {
    const url = new URL(LinkTokenCreateBody.parse(plaid.calls[0]!.body).hosted_link.completion_redirect_uri);
    const res = await app.request(`${url.pathname}${url.search}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(302);
    return Object.fromEntries(new URL(res.headers.get("location") ?? "").searchParams);
  }

  test("start → Hosted Link → callback stores an encrypted access token", async () => {
    mount(successReplies());
    const { location, cookie } = await start();
    expect(location).toBe(linkTokenCreate.hosted_link_url);

    const create = plaid.calls[0]!;
    expect(create.url).toBe("https://sandbox.plaid.com/link/token/create");
    expect(create.body).toMatchObject({ client_id: CONFIG.clientId, secret: SECRET, products: ["transactions"], country_codes: ["US"] });
    const { hosted_link: hosted, user } = LinkTokenCreateBody.parse(create.body);
    expect(hosted.is_mobile_app).toBe(true);
    const completion = new URL(hosted.completion_redirect_uri);
    expect(`${completion.origin}${completion.pathname}`).toBe("https://oyster.test/oauth/plaid/callback");
    // Plaid only ever sees an opaque per-user id, stable across flows, and the opaque nonce.
    const clientUserId = user.client_user_id;
    expect(clientUserId).not.toContain("alice");
    expect(JSON.stringify(create.body)).not.toContain("alice");

    expect(await completeLink(cookie)).toEqual({ provider: "plaid", status: "ok" });
    expect(plaid.paths()).toEqual(["/link/token/create", "/link/token/get", "/item/public_token/exchange"]);
    expect(plaid.calls[1]!.body.link_token).toBe(linkTokenCreate.link_token);
    expect(plaid.calls[2]!.body.public_token).toBe(linkTokenGetSuccess.link_sessions[0]!.results!.item_add_results[0]!.public_token);

    const row = db.query<{ ciphertext: Uint8Array }, []>("SELECT ciphertext FROM oauth_tokens").get();
    expect(Buffer.from(row?.ciphertext ?? []).toString("latin1")).not.toContain(itemPublicTokenExchange.access_token);
    expect(await tokens.resolverFor("alice")("plaid")).toEqual({ provider: "plaid", accessToken: itemPublicTokenExchange.access_token });
    // The link token is erased once the callback consumed it.
    expect(db.query<{ flow_data: string | null }, []>("SELECT flow_data FROM oauth_state_nonces").get()?.flow_data).toBeNull();

    // Same user, next flow: same client_user_id.
    mount(successReplies());
    await start();
    expect(LinkTokenCreateBody.parse(plaid.calls[0]!.body).user.client_user_id).toBe(clientUserId);
  });

  test("a session not recorded yet is polled until its public token appears", async () => {
    const pending = { ...linkTokenGetSuccess, link_sessions: [] };
    mount({ ...successReplies(), "/link/token/get": [{ json: pending }, { json: linkTokenGetSuccess }] });
    const { cookie } = await start();
    expect(await completeLink(cookie)).toEqual({ provider: "plaid", status: "ok" });
    expect(plaid.paths()).toEqual(["/link/token/create", "/link/token/get", "/link/token/get", "/item/public_token/exchange"]);
  });

  test("exiting Link is a cancellation; a Link error or a never-finished session fails; nothing is stored", async () => {
    mount({ ...successReplies(), "/link/token/get": [{ json: linkTokenGetExit }] });
    let { cookie } = await start();
    expect(await completeLink(cookie)).toEqual({ provider: "plaid", status: "error", code: "access_denied" });

    const [exitSession] = linkTokenGetExit.link_sessions;
    const linkError = { error_code: "INSTITUTION_DOWN", error_type: "INSTITUTION_ERROR" };
    const errored = { ...linkTokenGetExit, link_sessions: [{ ...exitSession, on_exit: { ...exitSession!.on_exit, error: linkError } }] };
    mount({ ...successReplies(), "/link/token/get": [{ json: errored }] });
    ({ cookie } = await start());
    expect(await completeLink(cookie)).toEqual({ provider: "plaid", status: "error", code: "provider_error" });

    mount({ ...successReplies(), "/link/token/get": [{ json: { ...linkTokenGetSuccess, link_sessions: [] } }] });
    ({ cookie } = await start());
    expect(await completeLink(cookie)).toEqual({ provider: "plaid", status: "error", code: "exchange_failed" });
    expect(plaid.paths().filter((p) => p === "/link/token/get")).toHaveLength(3);

    expect(plaid.paths()).not.toContain("/item/public_token/exchange");
    expect(await tokens.resolverFor("alice")("plaid")).toBeNull();
  });

  test("Plaid failures redirect back to the app with a code and never leak the secret", async () => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => logged.push(args.join(" "));
    try {
      const invalidSecret = { error_type: "INVALID_INPUT", error_code: "INVALID_API_KEYS", error_message: `bad secret ${SECRET}` };
      mount({ "/link/token/create": [{ status: 400, json: invalidSecret }] });
      const failedStart = await start();
      const params = Object.fromEntries(new URL(failedStart.location).searchParams);
      expect(params).toEqual({ provider: "plaid", status: "error", code: "provider_error" });
      expect(failedStart.location.startsWith("oyster://oauth/complete")).toBe(true);

      mount({ ...successReplies(), "/item/public_token/exchange": [{ status: 400, json: itemLoginRequired }] });
      const { cookie } = await start();
      expect(await completeLink(cookie)).toEqual({ provider: "plaid", status: "error", code: "exchange_failed" });

      expect(logged.join("\n")).not.toContain(SECRET);
      expect(logged.join("\n")).toContain("INVALID_API_KEYS");
    } finally {
      console.error = original;
    }
  });

  test("the callback can't be completed from another browser", async () => {
    mount(successReplies());
    await start();
    expect(await completeLink("oyster_oauth_x=forged")).toEqual({ provider: "plaid", status: "error", code: "invalid_state" });
    expect(plaid.paths()).toEqual(["/link/token/create"]);
  });
});

describe("plaid: adapter errors", () => {
  test("exchange without a stored link token fails without calling Plaid", async () => {
    const plaid = fakePlaid(successReplies());
    const adapter = plaidAdapter(CONFIG, { fetch: plaid.fn, sleep: noSleep });
    const error = await adapter.exchange({ query: new URLSearchParams(), redirectUri: "r" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OAuthError);
    expect(error).toMatchObject({ code: "exchange_failed" });
    expect(plaid.calls).toHaveLength(0);
  });

  test("error messages carry no secret, token, or Plaid free text", async () => {
    const plaid = fakePlaid({
      "/link/token/get": [{ status: 400, json: { error_code: `LEAK ${SECRET}`, error_message: SECRET } }],
    });
    const adapter = plaidAdapter(CONFIG, { fetch: plaid.fn, sleep: noSleep });
    const error = await adapter.exchange({ query: new URLSearchParams(), redirectUri: "r", flowData: "link-sandbox-x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OAuthError);
    expect(String(error)).not.toContain(SECRET);
    expect(String(error)).not.toContain("link-sandbox-x");
  });
});

describe.skipIf(!process.env.LIVE || !process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET)("plaid: live sandbox link token", () => {
  test("creates a Hosted Link URL", async () => {
    const config = plaidConfigFromEnv({ ...process.env, PLAID_ENV: "sandbox" })!;
    let saved = "";
    const url = await plaidAdapter(config).authorizeUrl({
      state: "live-test-nonce-0123456789",
      redirectUri: "https://oyster.test/oauth/plaid/callback",
      userId: "live-test-user",
      saveFlowData: (data) => {
        saved = data;
      },
    });
    expect(url).toStartWith("https://");
    expect(saved).toStartWith("link-sandbox-");
  });
});
