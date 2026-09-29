import type { Database } from "bun:sqlite";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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

/**
 * Server-side half of the state: each nonce is claimed once at /start (where its
 * PKCE verifier is recorded) and consumed once at /callback (which hands the
 * verifier back and erases it).
 */
export class OAuthNonceStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Records `payload.nonce` with its PKCE verifier. False if the nonce was already claimed. */
  claim(payload: StatePayload, codeVerifier: string, now: number = Date.now()): boolean {
    this.#db.query("DELETE FROM oauth_state_nonces WHERE expires_at <= $now").run({ now: isoNow(new Date(now)) });
    const result = this.#db
      .query(
        `INSERT INTO oauth_state_nonces (nonce, user_id, provider, code_verifier, expires_at, used)
         VALUES ($nonce, $userId, $provider, $codeVerifier, $expiresAt, 0)
         ON CONFLICT (nonce) DO NOTHING`,
      )
      .run({
        nonce: payload.nonce,
        userId: payload.userId,
        provider: payload.provider,
        codeVerifier,
        expiresAt: isoNow(new Date(payload.exp)),
      });
    return result.changes === 1;
  }

  /** Marks the nonce used and returns its PKCE verifier, or the reason it can't be consumed. */
  consume(
    payload: StatePayload,
    now: number = Date.now(),
  ): { ok: true; codeVerifier: string } | { ok: false; code: Extract<OAuthErrorCode, "invalid_state" | "state_expired" | "state_reused"> } {
    return this.#db.transaction(() => {
      const row = this.#db
        .query<{ user_id: string; provider: string; code_verifier: string | null; expires_at: string; used: number }, { nonce: string }>(
          "SELECT user_id, provider, code_verifier, expires_at, used FROM oauth_state_nonces WHERE nonce = $nonce",
        )
        .get({ nonce: payload.nonce });
      // No row: /start never ran for this state (or it expired and was pruned).
      if (!row || row.user_id !== payload.userId || row.provider !== payload.provider) {
        return { ok: false as const, code: "invalid_state" as const };
      }
      if (row.used || !row.code_verifier) return { ok: false as const, code: "state_reused" as const };
      if (row.expires_at <= isoNow(new Date(now))) return { ok: false as const, code: "state_expired" as const };
      this.#db
        .query("UPDATE oauth_state_nonces SET used = 1, code_verifier = NULL WHERE nonce = $nonce")
        .run({ nonce: payload.nonce });
      return { ok: true as const, codeVerifier: row.code_verifier };
    })();
  }
}
