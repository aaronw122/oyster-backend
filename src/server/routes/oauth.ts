import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  createCodeVerifier,
  OAuthError,
  type OAuthDeps,
  type OAuthErrorCode,
  OAuthNonceStore,
  oauthRedirectUri,
  STATE_TTL_MS,
  verifyState,
} from "../../oauth/index.ts";
import type { AppDeps, AppEnv } from "../app.ts";
import { apiError } from "../errors.ts";

const COOKIE_PATH = "/oauth";

/**
 * `/oauth/:provider/start` and `/oauth/:provider/callback`. Unauthenticated: the
 * browser opens them without a bearer token. /start trusts the app-issued signed
 * `state`, then hands the provider only an opaque nonce and binds the flow to this
 * browser with an HttpOnly cookie; /callback requires that same cookie. Every
 * outcome after provider lookup redirects back to the app, so
 * `ASWebAuthenticationSession` always completes.
 */
export function oauthRoutes({ config, db, oauth }: AppDeps & { oauth: OAuthDeps }): Hono<AppEnv> {
  const nonces = new OAuthNonceStore(db);
  const now = oauth.now ?? Date.now;
  // Plain-http cookies only for local development.
  const secureCookie = !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(config.publicBaseUrl);
  const complete = (provider: string, result: { ok: true } | { ok: false; code: OAuthErrorCode }): string => {
    const params = new URLSearchParams({ provider, status: result.ok ? "ok" : "error" });
    if (!result.ok) params.set("code", result.code);
    return `oyster://oauth/complete?${params}`;
  };

  return new Hono<AppEnv>()
    .get("/:provider/start", async (c) => {
      const provider = c.req.param("provider");
      const adapter = oauth.providers.get(provider);
      if (!adapter) return apiError(c, 404, "unknown_provider", "That sign-in option isn't available.");

      const verified = verifyState(config.oauthStateSecret, c.req.query("state") ?? "", now());
      if (!verified.ok) return c.redirect(complete(provider, verified), 302);
      const { payload } = verified;
      if (payload.provider !== provider) return c.redirect(complete(provider, { ok: false, code: "provider_mismatch" }), 302);

      const codeVerifier = createCodeVerifier();
      const browserSecret = nonces.claim(payload, codeVerifier, now());
      if (!browserSecret) return c.redirect(complete(provider, { ok: false, code: "state_reused" }), 302);
      setCookie(c, `oyster_oauth_${payload.nonce}`, browserSecret, {
        httpOnly: true,
        secure: secureCookie,
        sameSite: "Lax",
        path: COOKIE_PATH,
        maxAge: STATE_TTL_MS / 1000,
      });
      const redirectUri = oauthRedirectUri(config, provider);
      try {
        const authorizeUrl = await adapter.authorizeUrl({
          state: payload.nonce,
          redirectUri,
          codeVerifier,
          userId: payload.userId,
          saveFlowData: (data) => nonces.saveFlowData(payload.nonce, data),
        });
        return c.redirect(authorizeUrl, 302);
      } catch (err) {
        // Providers that call an API to start (Plaid) can fail here; still return to the app.
        const code: OAuthErrorCode = err instanceof OAuthError ? err.code : "provider_error";
        console.error(`[oauth ${provider}] start failed: ${code}`);
        return c.redirect(complete(provider, { ok: false, code }), 302);
      }
    })
    .get("/:provider/callback", async (c) => {
      const provider = c.req.param("provider");
      const adapter = oauth.providers.get(provider);
      if (!adapter) return apiError(c, 404, "unknown_provider", "That sign-in option isn't available.");

      const nonce = c.req.query("state") ?? "";
      // Nonces are base64url; anything else can't be ours and isn't a valid cookie name.
      if (!/^[A-Za-z0-9_-]{16,}$/.test(nonce)) return c.redirect(complete(provider, { ok: false, code: "invalid_state" }), 302);
      const cookieName = `oyster_oauth_${nonce}`;
      const consumed = nonces.consume(nonce, provider, getCookie(c, cookieName), now());
      if (!consumed.ok) return c.redirect(complete(provider, consumed), 302);
      deleteCookie(c, cookieName, { path: COOKIE_PATH, secure: secureCookie });

      try {
        const token = await adapter.exchange({
          query: new URL(c.req.url).searchParams,
          redirectUri: oauthRedirectUri(config, provider),
          codeVerifier: consumed.codeVerifier,
          flowData: consumed.flowData,
        });
        oauth.tokens.save(consumed.userId, provider, token);
      } catch (err) {
        const code: OAuthErrorCode = err instanceof OAuthError ? err.code : "exchange_failed";
        // Only the code: provider errors can carry request/response material.
        console.error(`[oauth ${provider}] callback failed: ${code}`);
        return c.redirect(complete(provider, { ok: false, code }), 302);
      }
      return c.redirect(complete(provider, { ok: true }), 302);
    });
}
