import type { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isoNow } from "../contract/index.ts";
import type { AuthCredential, AuthResolver } from "../sources/index.ts";
import type { OAuthProviderAdapter, StoredToken } from "./types.ts";

// Refresh slightly early so a token doesn't expire between `get` and its use.
const EXPIRY_SKEW_MS = 60_000;

type TokenRow = { ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array };

/**
 * Per-user provider tokens, AES-256-GCM encrypted at rest. The row's
 * `userId:provider` is bound as associated data, so a ciphertext copied onto
 * another user's row fails to decrypt.
 */
export class OAuthTokenStore {
  readonly #db: Database;
  readonly #key: Buffer;
  readonly #adapters: Map<string, OAuthProviderAdapter>;
  readonly #now: () => number;
  readonly #refreshing = new Map<string, Promise<AuthCredential | null>>();

  constructor(
    db: Database,
    encryptionKeyBase64: string,
    adapters: Map<string, OAuthProviderAdapter> = new Map(),
    opts: { now?: () => number } = {},
  ) {
    const key = Buffer.from(encryptionKeyBase64, "base64");
    if (key.length !== 32) throw new Error("OAuth token encryption key must be 32 bytes.");
    this.#db = db;
    this.#key = key;
    this.#adapters = adapters;
    this.#now = opts.now ?? Date.now;
  }

  save(userId: string, provider: string, token: StoredToken): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(`${userId}:${provider}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(token), "utf8"), cipher.final()]);
    this.#db
      .query(
        `INSERT INTO oauth_tokens (user_id, provider, ciphertext, iv, tag, updated_at)
         VALUES ($userId, $provider, $ciphertext, $iv, $tag, $now)
         ON CONFLICT (user_id, provider) DO UPDATE SET
           ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at`,
      )
      .run({ userId, provider, ciphertext, iv, tag: cipher.getAuthTag(), now: isoNow(new Date(this.#now())) });
  }

  has(userId: string, provider: string): boolean {
    return (
      this.#db
        .query("SELECT 1 FROM oauth_tokens WHERE user_id = $userId AND provider = $provider")
        .get({ userId, provider }) !== null
    );
  }

  /**
   * A usable credential, refreshing (and persisting) a token that is expired or
   * about to expire when the provider supports it. If that refresh isn't possible
   * or fails, a not-yet-expired token is still returned. Null when absent,
   * undecryptable, or expired and not refreshable.
   */
  async get(userId: string, provider: string): Promise<AuthCredential | null> {
    const token = this.#read(userId, provider);
    if (!token) return null;
    const current = { provider, accessToken: token.accessToken };
    if (!token.expiresAt) return current;
    const expiresAt = Date.parse(token.expiresAt);
    if (expiresAt - EXPIRY_SKEW_MS > this.#now()) return current;
    const fallback = (): AuthCredential | null => (expiresAt > this.#now() ? current : null);

    const adapter = this.#adapters.get(provider);
    if (!adapter?.refresh || !token.refreshToken) return fallback();
    // Concurrent refreshes of the same token would race and may invalidate each other's refresh token.
    const key = `${userId}\u0000${provider}`;
    const inflight = this.#refreshing.get(key);
    if (inflight) return inflight;
    // Promise callbacks run asynchronously, so the map entry is set before `finally` can clear it.
    const pending = adapter
      .refresh(token)
      .then((fresh) => {
        this.save(userId, provider, fresh);
        return { provider, accessToken: fresh.accessToken };
      })
      .catch(fallback)
      .finally(() => this.#refreshing.delete(key));
    this.#refreshing.set(key, pending);
    return pending;
  }

  resolverFor(userId: string): AuthResolver {
    return (provider) => this.get(userId, provider);
  }

  #read(userId: string, provider: string): StoredToken | null {
    const row = this.#db
      .query<TokenRow, { userId: string; provider: string }>(
        "SELECT ciphertext, iv, tag FROM oauth_tokens WHERE user_id = $userId AND provider = $provider",
      )
      .get({ userId, provider });
    if (!row) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, row.iv);
      decipher.setAAD(Buffer.from(`${userId}:${provider}`));
      decipher.setAuthTag(row.tag);
      const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
      return JSON.parse(plaintext) as StoredToken;
    } catch {
      // Wrong key or tampered row: treat as not connected rather than surfacing crypto details.
      return null;
    }
  }
}
