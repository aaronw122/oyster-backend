import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { isoNow } from "../contract/index.ts";

/** Users and their opaque bearer tokens. Only the sha256 of a token is stored. */
export class UserStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Creates `userId` if absent, then issues and returns a new bearer token for it. */
  issueToken(userId: string): string {
    const token = randomBytes(32).toString("base64url");
    const now = isoNow();
    this.#db.transaction(() => {
      this.#db.query("INSERT OR IGNORE INTO users (id, created_at) VALUES ($id, $now)").run({ id: userId, now });
      this.#db
        .query("INSERT INTO api_tokens (token_hash, user_id, created_at) VALUES ($hash, $userId, $now)")
        .run({ hash: hashToken(token), userId, now });
    })();
    return token;
  }

  /** Returns the owning userId for a valid token, else null. */
  resolveToken(token: string): string | null {
    const row = this.#db
      .query<{ user_id: string }, { hash: string }>("SELECT user_id FROM api_tokens WHERE token_hash = $hash")
      .get({ hash: hashToken(token) });
    return row?.user_id ?? null;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
