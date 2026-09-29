import { createHash, randomBytes } from "node:crypto";
import { OAuthError, type OAuthProviderAdapter, type StoredToken } from "./types.ts";

export type OAuth2Config = {
  id: string;
  displayName: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  /** Read-only scopes only (DON'T: no write/post/transact). */
  scopes: string[];
  extraAuthorizeParams?: Record<string, string>;
  /** Send an S256 PKCE challenge/verifier. Default true; disable for providers that reject it. */
  pkce?: boolean;
  /** How the client authenticates to the token endpoint. Default `"body"` (client_secret_post). */
  clientAuth?: "body" | "basic";
  /** Joiner for `scope`. Default `" "`. */
  scopeSeparator?: string;
  fetch?: typeof fetch;
  now?: () => number;
};

/** Generates a PKCE code verifier (RFC 7636 §4.1: 43 chars of base64url). */
export function createCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** S256 code challenge for `verifier`. */
export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Authorization-code adapter for a standard OAuth 2.0 provider. */
export function oauth2Adapter(cfg: OAuth2Config): OAuthProviderAdapter {
  const doFetch = cfg.fetch ?? fetch;
  const now = cfg.now ?? Date.now;
  const pkce = cfg.pkce ?? true;
  const clientAuth = cfg.clientAuth ?? "body";

  async function requestToken(grant: Record<string, string>, failure: OAuthError): Promise<StoredToken> {
    const body = new URLSearchParams(grant);
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    if (clientAuth === "basic") {
      headers.Authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`;
    } else {
      body.set("client_id", cfg.clientId);
      body.set("client_secret", cfg.clientSecret);
    }

    let json: unknown;
    try {
      const res = await doFetch(cfg.tokenEndpoint, { method: "POST", headers, body });
      if (!res.ok) throw failure;
      json = await res.json();
    } catch {
      // Network errors, non-2xx and unparseable bodies all collapse to the same
      // code-only failure: provider responses may echo credentials.
      throw failure;
    }
    return parseTokenResponse(json, now(), failure);
  }

  return {
    id: cfg.id,
    displayName: cfg.displayName,

    async authorizeUrl({ state, redirectUri, codeVerifier }) {
      const url = new URL(cfg.authorizeEndpoint);
      const params = url.searchParams;
      params.set("response_type", "code");
      params.set("client_id", cfg.clientId);
      params.set("redirect_uri", redirectUri);
      params.set("scope", cfg.scopes.join(cfg.scopeSeparator ?? " "));
      params.set("state", state);
      if (pkce && codeVerifier) {
        params.set("code_challenge", codeChallenge(codeVerifier));
        params.set("code_challenge_method", "S256");
      }
      for (const [key, value] of Object.entries(cfg.extraAuthorizeParams ?? {})) params.set(key, value);
      return url.toString();
    },

    async exchange({ query, redirectUri, codeVerifier }) {
      const error = query.get("error");
      if (error === "access_denied") throw new OAuthError("access_denied", `${cfg.displayName} sign-in was cancelled.`);
      if (error) throw new OAuthError("provider_error", `${cfg.displayName} couldn't complete the sign-in.`);
      const code = query.get("code");
      if (!code) throw new OAuthError("missing_code", `${cfg.displayName} didn't return a sign-in code.`);

      const grant: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: redirectUri };
      if (pkce && codeVerifier) grant.code_verifier = codeVerifier;
      return requestToken(grant, new OAuthError("exchange_failed", `Couldn't finish signing in to ${cfg.displayName}.`));
    },

    async refresh(token) {
      const failure = new OAuthError("refresh_failed", `Couldn't renew the ${cfg.displayName} connection.`);
      if (!token.refreshToken) throw failure;
      const fresh = await requestToken({ grant_type: "refresh_token", refresh_token: token.refreshToken }, failure);
      // Providers may omit the refresh token on refresh, meaning "keep using the old one".
      return { ...fresh, refreshToken: fresh.refreshToken ?? token.refreshToken };
    },
  };
}

function parseTokenResponse(json: unknown, nowMs: number, failure: OAuthError): StoredToken {
  if (typeof json !== "object" || json === null) throw failure;
  const record = json as Record<string, unknown>;
  const accessToken = record.access_token;
  if (typeof accessToken !== "string" || accessToken === "") throw failure;

  const token: StoredToken = { accessToken };
  if (typeof record.refresh_token === "string" && record.refresh_token !== "") token.refreshToken = record.refresh_token;
  const expiresIn = typeof record.expires_in === "string" ? Number(record.expires_in) : record.expires_in;
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    token.expiresAt = new Date(nowMs + expiresIn * 1000).toISOString();
  }
  return token;
}
