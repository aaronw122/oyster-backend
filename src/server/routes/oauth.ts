import { Hono } from "hono";
import {
  createCodeVerifier,
  OAuthError,
  type OAuthDeps,
  type OAuthErrorCode,
  OAuthNonceStore,
  oauthRedirectUri,
  verifyState,
} from "../../oauth/index.ts";
import type { AppDeps, AppEnv } from "../app.ts";
import { apiError } from "../errors.ts";

/**
 * `/oauth/:provider/start` and `/oauth/:provider/callback`. Unauthenticated: the
 * browser opens them without a bearer token, so identity comes from the signed,
 * single-use `state`. Every outcome after provider lookup ends in a redirect back
 * to the app, so `ASWebAuthenticationSession` always completes.
 */
export function oauthRoutes({ config, db, oauth }: AppDeps & { oauth: OAuthDeps }): Hono<AppEnv> {
  const nonces = new OAuthNonceStore(db);
  const now = oauth.now ?? Date.now;
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

      const state = c.req.query("state") ?? "";
      const verified = verifyState(config.oauthStateSecret, state, now());
      if (!verified.ok) return c.redirect(complete(provider, verified), 302);
      if (verified.payload.provider !== provider) return c.redirect(complete(provider, { ok: false, code: "provider_mismatch" }), 302);

      const codeVerifier = createCodeVerifier();
      if (!nonces.claim(verified.payload, codeVerifier, now())) {
        return c.redirect(complete(provider, { ok: false, code: "state_reused" }), 302);
      }
      const redirectUri = oauthRedirectUri(config, provider);
      return c.redirect(await adapter.authorizeUrl({ state, redirectUri, codeVerifier }), 302);
    })
    .get("/:provider/callback", async (c) => {
      const provider = c.req.param("provider");
      const adapter = oauth.providers.get(provider);
      if (!adapter) return apiError(c, 404, "unknown_provider", "That sign-in option isn't available.");

      const verified = verifyState(config.oauthStateSecret, c.req.query("state") ?? "", now());
      if (!verified.ok) return c.redirect(complete(provider, verified), 302);
      const { payload } = verified;
      if (payload.provider !== provider) return c.redirect(complete(provider, { ok: false, code: "provider_mismatch" }), 302);
      const consumed = nonces.consume(payload, now());
      if (!consumed.ok) return c.redirect(complete(provider, consumed), 302);

      try {
        const query = new URL(c.req.url).searchParams;
        const token = await adapter.exchange({
          query,
          redirectUri: oauthRedirectUri(config, provider),
          codeVerifier: consumed.codeVerifier,
        });
        oauth.tokens.save(payload.userId, provider, token);
      } catch (err) {
        const code: OAuthErrorCode = err instanceof OAuthError ? err.code : "exchange_failed";
        // Only the code: provider errors can carry request/response material.
        console.error(`[oauth ${provider}] callback failed: ${code}`);
        return c.redirect(complete(provider, { ok: false, code }), 302);
      }
      return c.redirect(complete(provider, { ok: true }), 302);
    });
}
