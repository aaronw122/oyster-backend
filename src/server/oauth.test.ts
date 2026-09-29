import type { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import type { Hono } from "hono";
import { ApiErrorSchema } from "../contract/index.ts";
import { loadConfig } from "../config.ts";
import { openDb } from "../db/index.ts";
import {
  codeChallenge,
  createOAuthStartUrl,
  type OAuthProviderAdapter,
  OAuthTokenStore,
  oauth2Adapter,
  STATE_TTL_MS,
} from "../oauth/index.ts";
import { PearlStore } from "../store/pearls.ts";
import { UserStore } from "../store/users.ts";
import { type AppEnv, createApp } from "./app.ts";

const config = loadConfig({ NODE_ENV: "test", PUBLIC_BASE_URL: "https://oyster.test" });
const T0 = Date.parse("2026-09-29T12:00:00Z");

let db: Database;
let app: Hono<AppEnv>;
let tokens: OAuthTokenStore;
let now: number;
let tokenRequests: URLSearchParams[];
let tokenResponse: { status: number; json: unknown };

function adapter(id: string): OAuthProviderAdapter {
  return oauth2Adapter({
    id,
    displayName: id,
    authorizeEndpoint: `https://${id}.example/authorize`,
    tokenEndpoint: `https://${id}.example/token`,
    clientId: `${id}-client`,
    clientSecret: `${id}-secret`,
    scopes: ["read"],
    now: () => now,
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      tokenRequests.push(new URLSearchParams(String(init?.body)));
      return Response.json(tokenResponse.json, { status: tokenResponse.status });
    }) as typeof fetch,
  });
}

beforeEach(() => {
  db = openDb(":memory:");
  const users = new UserStore(db);
  users.issueToken("alice");
  now = T0;
  tokenRequests = [];
  tokenResponse = { status: 200, json: { access_token: "provider-access-token", refresh_token: "provider-refresh", expires_in: 3600 } };
  const providers = new Map([
    ["github", adapter("github")],
    ["spotify", adapter("spotify")],
  ]);
  tokens = new OAuthTokenStore(db, config.tokenEncryptionKey, providers, { now: () => now });
  app = createApp({ config, db, pearls: new PearlStore(db), users, oauth: { providers, tokens, now: () => now } });
});

const pathOf = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

/** Follows /start and returns the provider authorize URL (asserting a redirect to the provider). */
async function start(startUrl: string): Promise<URL> {
  const res = await app.request(pathOf(startUrl));
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "");
}

async function callback(provider: string, params: Record<string, string>) {
  const res = await app.request(`/oauth/${provider}/callback?${new URLSearchParams(params)}`);
  expect(res.status).toBe(302);
  const location = res.headers.get("location") ?? "";
  const url = new URL(location);
  expect(`${url.protocol}//${url.host}${url.pathname}`).toBe("oyster://oauth/complete");
  return { location, params: Object.fromEntries(url.searchParams) };
}

test("start → callback stores an encrypted token and returns to the app", async () => {
  const authorize = await start(createOAuthStartUrl(config, "alice", "github", now));
  expect(authorize.origin).toBe("https://github.example");
  const state = authorize.searchParams.get("state") ?? "";
  expect(authorize.searchParams.get("redirect_uri")).toBe("https://oyster.test/oauth/github/callback");
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");

  const { params } = await callback("github", { code: "auth-code", state });
  expect(params).toEqual({ provider: "github", status: "ok" });

  // PKCE: the verifier sent at exchange matches the challenge sent at authorize.
  const verifier = tokenRequests[0]?.get("code_verifier") ?? "";
  expect(codeChallenge(verifier)).toBe(authorize.searchParams.get("code_challenge") ?? "");
  expect(tokenRequests[0]?.get("code")).toBe("auth-code");
  expect(tokenRequests[0]?.get("redirect_uri")).toBe("https://oyster.test/oauth/github/callback");

  const row = db.query<{ ciphertext: Uint8Array }, []>("SELECT ciphertext FROM oauth_tokens").get();
  expect(Buffer.from(row?.ciphertext ?? []).toString("latin1")).not.toContain("provider-access-token");
  expect(await tokens.resolverFor("alice")("github")).toEqual({ provider: "github", accessToken: "provider-access-token" });
});

test("a state is single-use at both start and callback", async () => {
  const startUrl = createOAuthStartUrl(config, "alice", "github", now);
  const state = (await start(startUrl)).searchParams.get("state") ?? "";

  const replayStart = await app.request(pathOf(startUrl));
  expect(new URL(replayStart.headers.get("location") ?? "").searchParams.get("code")).toBe("state_reused");

  expect((await callback("github", { code: "c", state })).params.status).toBe("ok");
  expect((await callback("github", { code: "c", state })).params).toEqual({
    provider: "github",
    status: "error",
    code: "state_reused",
  });
  expect(tokenRequests).toHaveLength(1);
});

test("tampered, expired and never-started states are rejected without a token exchange", async () => {
  const startUrl = createOAuthStartUrl(config, "alice", "github", now);
  const state = (await start(startUrl)).searchParams.get("state") ?? "";

  const tampered = `${state.slice(0, -3)}AAA`;
  expect((await callback("github", { code: "c", state: tampered })).params.code).toBe("invalid_state");
  expect((await callback("github", { code: "c" })).params.code).toBe("invalid_state");

  const neverStarted = new URL(createOAuthStartUrl(config, "alice", "github", now)).searchParams.get("state") ?? "";
  expect((await callback("github", { code: "c", state: neverStarted })).params.code).toBe("invalid_state");

  now = T0 + STATE_TTL_MS;
  expect((await callback("github", { code: "c", state })).params.code).toBe("state_expired");
  const expiredStart = await app.request(pathOf(startUrl));
  expect(new URL(expiredStart.headers.get("location") ?? "").searchParams.get("code")).toBe("state_expired");

  expect(tokenRequests).toHaveLength(0);
  expect(tokens.has("alice", "github")).toBe(false);
});

test("a state signed for one provider can't be used with another", async () => {
  const githubStart = new URL(createOAuthStartUrl(config, "alice", "github", now));
  const res = await app.request(`/oauth/spotify/start${githubStart.search}`);
  expect(new URL(res.headers.get("location") ?? "").searchParams.get("code")).toBe("provider_mismatch");

  const state = (await start(githubStart.toString())).searchParams.get("state") ?? "";
  expect((await callback("spotify", { code: "c", state })).params).toEqual({
    provider: "spotify",
    status: "error",
    code: "provider_mismatch",
  });
  expect(tokens.has("alice", "spotify")).toBe(false);
});

test("provider denial and failed exchanges redirect with a code and leak nothing", async () => {
  const denyState = (await start(createOAuthStartUrl(config, "alice", "github", now))).searchParams.get("state") ?? "";
  expect((await callback("github", { error: "access_denied", state: denyState })).params.code).toBe("access_denied");

  tokenResponse = { status: 400, json: { error: "invalid_grant", leaked: "provider-access-token" } };
  const failState = (await start(createOAuthStartUrl(config, "alice", "github", now))).searchParams.get("state") ?? "";
  const { location, params } = await callback("github", { code: "c", state: failState });
  expect(params.code).toBe("exchange_failed");
  expect(location).not.toContain("provider-access-token");
  expect(location).not.toContain("github-secret");
  expect(tokens.has("alice", "github")).toBe(false);
});

test("unknown or disabled providers are a 404 JSON error", async () => {
  for (const path of ["/oauth/strava/start?state=x", "/oauth/strava/callback?code=c&state=x"]) {
    const res = await app.request(path);
    expect(res.status).toBe(404);
    const body = ApiErrorSchema.parse(await res.json());
    expect(body.error.code).toBe("unknown_provider");
    expect(JSON.stringify(body)).not.toMatch(/https?:|client|secret|token/i);
  }
});

test("OAuth routes need no bearer token", async () => {
  const res = await app.request(pathOf(createOAuthStartUrl(config, "alice", "github", now)));
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toStartWith("https://github.example/authorize");
});
