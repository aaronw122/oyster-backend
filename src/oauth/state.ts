import type { Database } from "bun:sqlite";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Config } from "../config.ts";
import { isoNow } from "../contract/index.ts";
import type { OAuthErrorCode } from "./types.ts";

export const STATE_TTL_MS = 10 * 60 * 1000;

const StatePayloadSchema = z.strictObject({
  userId: z.string().min(1),
  provider: z.string().min(1),
  nonce: z.string().min(16),
  exp: z.number().int(),
});
export type StatePayload = z.infer<typeof StatePayloadSchema>;

export type VerifiedState =
  | { ok: true; payload: StatePayload }
  | { ok: false; code: Extract<OAuthErrorCode, "invalid_state" | "state_expired"> };

/** `base64url(json).base64url(hmac-sha256(secret, base64url(json)))`. */
export function signState(secret: string, payload: StatePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

/** Checks signature (constant time), shape and expiry. Nonce single-use is enforced by `OAuthNonceStore`. */
export function verifyState(secret: string, state: string, now: number = Date.now()): VerifiedState {
  const [body, signature, ...rest] = state.split(".");
  if (!body || !signature || rest.length > 0) return { ok: false, code: "invalid_state" };
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, code: "invalid_state" };

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, code: "invalid_state" };
  }
  const parsed = StatePayloadSchema.safeParse(json);
  if (!parsed.success) return { ok: false, code: "invalid_state" };
  if (parsed.data.exp <= now) return { ok: false, code: "state_expired" };
  return { ok: true, payload: parsed.data };
}

/** Signed start URL for `provider`: `${publicBaseUrl}/oauth/<provider>/start?state=<signed>`. */
export function createOAuthStartUrl(config: Config, userId: string, provider: string, now: number = Date.now()): string {
  const state = signState(config.oauthStateSecret, {
    userId,
    provider,
    nonce: randomBytes(18).toString("base64url"),
    exp: now + STATE_TTL_MS,
  });
  return `${config.publicBaseUrl}/oauth/${encodeURIComponent(provider)}/start?state=${encodeURIComponent(state)}`;
}

/** Redirect URI registered with every provider. */
export function oauthRedirectUri(config: Config, provider: string): string {
  return `${config.publicBaseUrl}/oauth/${encodeURIComponent(provider)}/callback`;
}

export type ConsumedNonce = { ok: true; userId: string; codeVerifier: string; flowData?: string };
export type NonceFailure = {
  ok: false;
  code: Extract<OAuthErrorCode, "invalid_state" | "state_expired" | "state_reused" | "provider_mismatch">;
};

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();

/**
 * Server-side half of the state. Each nonce is claimed once at /start, which
 * records who it's for, its PKCE verifier, and the hash of a browser-binding
 * secret (set as a cookie on the browser that ran /start). /callback consumes it
 * once, only from that same browser, getting the verifier back and erasing it.
 * The provider only ever sees the opaque nonce.
 */
export class OAuthNonceStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Records `payload.nonce`; returns the browser-binding secret, or null if the nonce was already claimed. */
  claim(payload: StatePayload, codeVerifier: string, now: number = Date.now()): string | null {
    this.#db.query("DELETE FROM oauth_state_nonces WHERE expires_at <= $now").run({ now: isoNow(new Date(now)) });
    const browserSecret = randomBytes(32).toString("base64url");
    const result = this.#db
      .query(
        `INSERT INTO oauth_state_nonces (nonce, user_id, provider, code_verifier, browser_binding_hash, expires_at, used)
         VALUES ($nonce, $userId, $provider, $codeVerifier, $bindingHash, $expiresAt, 0)
         ON CONFLICT (nonce) DO NOTHING`,
      )
      .run({
        nonce: payload.nonce,
        userId: payload.userId,
        provider: payload.provider,
        codeVerifier,
        bindingHash: sha256(browserSecret).toString("hex"),
        expiresAt: isoNow(new Date(payload.exp)),
      });
    return result.changes === 1 ? browserSecret : null;
  }

  /** Attaches the adapter's opaque flow data to an unused nonce (see `OAuthProviderAdapter.saveFlowData`). */
  saveFlowData(nonce: string, data: string): void {
    this.#db.query("UPDATE oauth_state_nonces SET flow_data = $data WHERE nonce = $nonce AND used = 0").run({ nonce, data });
  }

  /**
   * Marks `nonce` used and returns its user, PKCE verifier and flow data. Requires the
   * browser-binding secret from /start (constant-time compared) and a matching provider.
   */
  consume(
    nonce: string,
    provider: string,
    browserSecret: string | undefined,
    now: number = Date.now(),
  ): ConsumedNonce | NonceFailure {
    return this.#db.transaction((): ConsumedNonce | NonceFailure => {
      const row = this.#db
        .query<
          {
            user_id: string;
            provider: string;
            code_verifier: string | null;
            flow_data: string | null;
            browser_binding_hash: string;
            expires_at: string;
            used: number;
          },
          { nonce: string }
        >(
          "SELECT user_id, provider, code_verifier, flow_data, browser_binding_hash, expires_at, used FROM oauth_state_nonces WHERE nonce = $nonce",
        )
        .get({ nonce });
      // No row: /start never ran for this state (or it expired and was pruned).
      if (!row || !browserSecret) return { ok: false, code: "invalid_state" };
      const expected = Buffer.from(row.browser_binding_hash, "hex");
      if (!timingSafeEqual(sha256(browserSecret), expected)) return { ok: false, code: "invalid_state" };
      if (row.provider !== provider) return { ok: false, code: "provider_mismatch" };
      if (row.used || !row.code_verifier) return { ok: false, code: "state_reused" };
      if (row.expires_at <= isoNow(new Date(now))) return { ok: false, code: "state_expired" };
      this.#db
        .query("UPDATE oauth_state_nonces SET used = 1, code_verifier = NULL, flow_data = NULL WHERE nonce = $nonce")
        .run({ nonce });
      const consumed: ConsumedNonce = { ok: true, userId: row.user_id, codeVerifier: row.code_verifier };
      if (row.flow_data !== null) consumed.flowData = row.flow_data;
      return consumed;
    })();
  }
}
