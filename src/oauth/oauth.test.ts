import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../config.ts";
import { openDb } from "../db/index.ts";
import { UserStore } from "../store/users.ts";
import {
  codeChallenge,
  createOAuthStartUrl,
  loadProviders,
  OAuthError,
  type OAuthProviderAdapter,
  OAuthTokenStore,
  oauth2Adapter,
  STATE_TTL_MS,
  signState,
  type StoredToken,
  verifyState,
} from "./index.ts";

const config = loadConfig({ NODE_ENV: "test" });
const SECRET = config.oauthStateSecret;
const T0 = Date.parse("2026-09-29T12:00:00Z");

describe("signed state", () => {
  const payload = { userId: "alice", provider: "github", nonce: "n".repeat(24), exp: T0 + STATE_TTL_MS };

  test("round-trips and rejects tampering, wrong secret and expiry", () => {
    const state = signState(SECRET, payload);
    expect(verifyState(SECRET, state, T0)).toEqual({ ok: true, payload });

    const [body, sig] = state.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...payload, userId: "mallory" })).toString("base64url");
    expect(verifyState(SECRET, `${forged}.${sig}`, T0)).toEqual({ ok: false, code: "invalid_state" });
    expect(verifyState(SECRET, `${body}.${sig.slice(0, -2)}`, T0)).toEqual({ ok: false, code: "invalid_state" });
    expect(verifyState("other-secret", state, T0)).toEqual({ ok: false, code: "invalid_state" });
    expect(verifyState(SECRET, "garbage", T0)).toEqual({ ok: false, code: "invalid_state" });
    expect(verifyState(SECRET, state, payload.exp)).toEqual({ ok: false, code: "state_expired" });
  });

  test("start URL carries a verifiable 10-minute state for the user and provider", () => {
    const url = new URL(createOAuthStartUrl(config, "alice", "github", T0));
    expect(`${url.origin}${url.pathname}`).toBe(`${config.publicBaseUrl}/oauth/github/start`);
    const verified = verifyState(SECRET, url.searchParams.get("state") ?? "", T0);
    if (!verified.ok) throw new Error("state should verify");
    expect(verified.payload).toMatchObject({ userId: "alice", provider: "github", exp: T0 + STATE_TTL_MS });
    expect(verifyState(SECRET, url.searchParams.get("state") ?? "", T0 + STATE_TTL_MS).ok).toBe(false);
  });
});

type Call = { url: string; headers: Headers; body: URLSearchParams };

function fakeTokenEndpoint(responses: Array<{ status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), body: new URLSearchParams(String(init?.body)) });
    const next = responses.shift();
    if (!next) throw new Error("unexpected token request");
    return Response.json(next.json, { status: next.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const baseCfg = {
  id: "demo",
  displayName: "Demo",
  apiOrigins: ["https://api.example"],
  authorizeEndpoint: "https://auth.example/authorize",
  tokenEndpoint: "https://auth.example/token",
  clientId: "client-id",
  clientSecret: "client-secret",
  scopes: ["read:a", "read:b"],
};

describe("oauth2Adapter", () => {
  test("authorize URL carries client, redirect, scopes, state and S256 challenge", async () => {
    const adapter = oauth2Adapter({ ...baseCfg, extraAuthorizeParams: { access_type: "offline" } });
    const url = new URL(await adapter.authorizeUrl({ state: "s1", redirectUri: "https://srv/cb", codeVerifier: "v".repeat(43) }));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-id",
      redirect_uri: "https://srv/cb",
      scope: "read:a read:b",
      state: "s1",
      code_challenge: codeChallenge("v".repeat(43)),
      code_challenge_method: "S256",
      access_type: "offline",
    });
  });

  test("exchange posts the code + verifier as a form and parses expiry", async () => {
    const { calls, fetchFn } = fakeTokenEndpoint([{ json: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } }]);
    const adapter = oauth2Adapter({ ...baseCfg, fetch: fetchFn, now: () => T0 });
    const token = await adapter.exchange({
      query: new URLSearchParams({ code: "abc", state: "s" }),
      redirectUri: "https://srv/cb",
      codeVerifier: "verifier",
    });
    expect(token).toEqual({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: "2026-09-29T13:00:00Z" });
    expect(calls[0]?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(calls[0]?.body ?? [])).toEqual({
      grant_type: "authorization_code",
      code: "abc",
      redirect_uri: "https://srv/cb",
      code_verifier: "verifier",
      client_id: "client-id",
      client_secret: "client-secret",
    });
  });

  test("basic client auth keeps the secret out of the body", async () => {
    const { calls, fetchFn } = fakeTokenEndpoint([{ json: { access_token: "at" } }]);
    const adapter = oauth2Adapter({ ...baseCfg, clientAuth: "basic", fetch: fetchFn });
    await adapter.exchange({ query: new URLSearchParams({ code: "c" }), redirectUri: "r" });
    expect(calls[0]?.headers.get("authorization")).toBe(`Basic ${btoa("client-id:client-secret")}`);
    expect(calls[0]?.body.has("client_secret")).toBe(false);
  });

  test("denial, missing code and failed exchanges map to codes without provider material", async () => {
    const { fetchFn } = fakeTokenEndpoint([
      { status: 400, json: { error: "invalid_grant", access_token_hint: "SECRET-LEAK" } },
      { json: { token_type: "bearer" } },
    ]);
    const adapter = oauth2Adapter({ ...baseCfg, fetch: fetchFn });
    const codeOf = (p: Promise<unknown>) =>
      p.then(
        () => "resolved",
        (err: unknown) => {
          expect(err).toBeInstanceOf(OAuthError);
          expect((err as Error).message).not.toContain("SECRET-LEAK");
          return (err as OAuthError).code;
        },
      );
    const exchange = (q: Record<string, string>) => adapter.exchange({ query: new URLSearchParams(q), redirectUri: "r" });
    expect(await codeOf(exchange({ error: "access_denied" }))).toBe("access_denied");
    expect(await codeOf(exchange({ error: "server_error" }))).toBe("provider_error");
    expect(await codeOf(exchange({}))).toBe("missing_code");
    expect(await codeOf(exchange({ code: "c" }))).toBe("exchange_failed");
    expect(await codeOf(exchange({ code: "c" }))).toBe("exchange_failed");
  });

  test("refresh keeps the old refresh token when the provider omits it", async () => {
    const { calls, fetchFn } = fakeTokenEndpoint([{ json: { access_token: "at-2", expires_in: 60 } }]);
    // A mid-second clock still yields a whole-second contract timestamp.
    const adapter = oauth2Adapter({ ...baseCfg, fetch: fetchFn, now: () => T0 + 250 });
    const fresh = await adapter.refresh?.({ accessToken: "at-1", refreshToken: "rt-1" });
    expect(fresh).toEqual({ accessToken: "at-2", refreshToken: "rt-1", expiresAt: "2026-09-29T12:01:00Z" });
    expect(calls[0]?.body.get("grant_type")).toBe("refresh_token");
    expect(calls[0]?.body.get("refresh_token")).toBe("rt-1");
  });
});

describe("providers", () => {
  test("only providers with both client id and secret are enabled", () => {
    const providers = loadProviders({
      OAUTH_GITHUB_CLIENT_ID: "id",
      OAUTH_GITHUB_CLIENT_SECRET: "secret",
      OAUTH_SPOTIFY_CLIENT_ID: "id",
      OAUTH_STRAVA_CLIENT_SECRET: "secret",
      OAUTH_GOOGLE_CLIENT_ID: " ",
      OAUTH_GOOGLE_CLIENT_SECRET: "secret",
    });
    expect([...providers.keys()]).toEqual(["github"]);
    expect(loadProviders({}).size).toBe(0);
  });

  test("every preset requests read-only scopes", async () => {
    const env: Record<string, string> = {};
    for (const id of ["GITHUB", "GOOGLE", "SPOTIFY", "STRAVA"]) {
      env[`OAUTH_${id}_CLIENT_ID`] = "id";
      env[`OAUTH_${id}_CLIENT_SECRET`] = "secret";
    }
    const providers = loadProviders(env);
    expect([...providers.keys()].sort()).toEqual(["github", "google", "spotify", "strava"]);
    for (const adapter of providers.values()) {
      const url = new URL(await adapter.authorizeUrl({ state: "s", redirectUri: "r", codeVerifier: "v".repeat(43) }));
      const scopes = (url.searchParams.get("scope") ?? "").split(/[ ,]/);
      for (const scope of scopes) expect(scope).toMatch(/(^read(:|$)|\.readonly$|-read(-|$)|:read$)/);
    }
  });

  test("each preset's tokens are bound to its own https API origins", () => {
    const env: Record<string, string> = {};
    for (const id of ["GITHUB", "GOOGLE", "SPOTIFY", "STRAVA"]) {
      env[`OAUTH_${id}_CLIENT_ID`] = "id";
      env[`OAUTH_${id}_CLIENT_SECRET`] = "secret";
    }
    const origins = Object.fromEntries([...loadProviders(env).values()].map((adapter) => [adapter.id, adapter.apiOrigins]));
    expect(origins).toEqual({
      github: ["https://api.github.com"],
      google: ["https://www.googleapis.com", "https://tasks.googleapis.com"],
      spotify: ["https://api.spotify.com"],
      strava: ["https://www.strava.com"],
    });
  });

  test("an adapter refuses API origins that aren't bare https origins", () => {
    for (const origin of ["http://api.example", "https://api.example/", "https://api.example/v1"]) {
      expect(() => oauth2Adapter({ ...baseCfg, apiOrigins: [origin] })).toThrow("bare https origin");
    }
  });
});

describe("OAuthTokenStore", () => {
  let db: Database;
  let now: number;

  beforeEach(() => {
    db = openDb(":memory:");
    new UserStore(db).issueToken("alice");
    new UserStore(db).issueToken("bob");
    now = T0;
  });

  const refreshingAdapter = (onRefresh: (t: StoredToken) => Promise<StoredToken>): OAuthProviderAdapter => ({
    id: "demo",
    displayName: "Demo",
    apiOrigins: ["https://api.example"],
    authorizeUrl: async () => "https://auth.example",
    exchange: async () => ({ accessToken: "unused" }),
    refresh: onRefresh,
  });
  const storeWith = (adapter?: OAuthProviderAdapter) =>
    new OAuthTokenStore(db, config.tokenEncryptionKey, new Map(adapter ? [[adapter.id, adapter]] : []), { now: () => now });

  test("encrypts at rest and decrypts for the owning user only", async () => {
    const store = storeWith();
    store.save("alice", "demo", { accessToken: "plain-access-token", refreshToken: "plain-refresh" });
    const row = db.query<{ ciphertext: Uint8Array }, []>("SELECT ciphertext FROM oauth_tokens").get();
    expect(Buffer.from(row?.ciphertext ?? []).toString("latin1")).not.toContain("plain-access-token");

    expect(await store.get("alice", "demo")).toEqual({ provider: "demo", accessToken: "plain-access-token" });
    expect(await store.resolverFor("alice")("demo")).toEqual({ provider: "demo", accessToken: "plain-access-token" });
    expect(await store.resolverFor("bob")("demo")).toBeNull();

    // A ciphertext moved onto another user's row doesn't decrypt (bound via AAD).
    db.exec("INSERT INTO oauth_tokens SELECT 'bob', provider, ciphertext, iv, tag, updated_at FROM oauth_tokens");
    expect(await store.get("bob", "demo")).toBeNull();
    // A different key can't read it.
    const otherKey = Buffer.alloc(32, 9).toString("base64");
    expect(await new OAuthTokenStore(db, otherKey).get("alice", "demo")).toBeNull();
  });

  test("refreshes an expired token once and persists it", async () => {
    let refreshes = 0;
    const store = storeWith(
      refreshingAdapter(async (t) => {
        refreshes++;
        expect(t.refreshToken).toBe("rt-1");
        return { accessToken: "at-2", refreshToken: "rt-2", expiresAt: new Date(now + 3_600_000).toISOString() };
      }),
    );
    store.save("alice", "demo", { accessToken: "at-1", refreshToken: "rt-1", expiresAt: new Date(T0 + 10_000).toISOString() });
    // Still valid, but inside the refresh skew window → refreshed.
    const [a, b] = await Promise.all([store.get("alice", "demo"), store.get("alice", "demo")]);
    expect(a).toEqual({ provider: "demo", accessToken: "at-2" });
    expect(b).toEqual(a);
    expect(refreshes).toBe(1);
    // Persisted: a store without the adapter sees the new, unexpired token.
    expect(await storeWith().get("alice", "demo")).toEqual({ provider: "demo", accessToken: "at-2" });
  });

  test("expired without a refresh path, or with a failing refresh, yields null", async () => {
    const plain = storeWith();
    plain.save("alice", "demo", { accessToken: "at-1", refreshToken: "rt-1", expiresAt: new Date(T0 - 1).toISOString() });
    expect(await plain.get("alice", "demo")).toBeNull();

    const noRefreshToken = storeWith(refreshingAdapter(async () => ({ accessToken: "never" })));
    noRefreshToken.save("alice", "demo", { accessToken: "at-1", expiresAt: new Date(T0 - 1).toISOString() });
    expect(await noRefreshToken.get("alice", "demo")).toBeNull();

    const failing = storeWith(
      refreshingAdapter(async () => {
        throw new OAuthError("refresh_failed", "nope");
      }),
    );
    failing.save("alice", "demo", { accessToken: "at-1", refreshToken: "rt-1", expiresAt: new Date(T0 - 1).toISOString() });
    expect(await failing.get("alice", "demo")).toBeNull();
    // Non-expiring tokens are returned as-is.
    failing.save("alice", "demo", { accessToken: "forever" });
    expect(await failing.get("alice", "demo")).toEqual({ provider: "demo", accessToken: "forever" });
  });

  test("a failed refresh inside the skew window still returns the unexpired token", async () => {
    const failing = storeWith(
      refreshingAdapter(async () => {
        throw new OAuthError("refresh_failed", "nope");
      }),
    );
    failing.save("alice", "demo", { accessToken: "at-1", refreshToken: "rt-1", expiresAt: new Date(T0 + 10_000).toISOString() });
    expect(await failing.get("alice", "demo")).toEqual({ provider: "demo", accessToken: "at-1" });
    const noRefresh = storeWith();
    noRefresh.save("alice", "demo", { accessToken: "at-1", expiresAt: new Date(T0 + 10_000).toISOString() });
    expect(await noRefresh.get("alice", "demo")).toEqual({ provider: "demo", accessToken: "at-1" });
  });
});
