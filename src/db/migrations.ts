// Ordered, append-only. A migration's version is its 1-based index in this array.
// NEVER edit or reorder an existing entry — append a new one instead.
export type Migration = { name: string; sql: string };

export const MIGRATIONS: readonly Migration[] = [
  {
    name: "initial_schema",
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      CREATE TABLE api_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX api_tokens_user_id ON api_tokens(user_id);

      CREATE TABLE pearls (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        inputs TEXT NOT NULL,
        sources TEXT NOT NULL,
        transform TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        status TEXT NOT NULL CHECK (status IN ('ok', 'broken', 'repairing')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX pearls_user_id ON pearls(user_id);

      CREATE TABLE pearl_versions (
        pearl_id TEXT NOT NULL REFERENCES pearls(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        transform TEXT NOT NULL,
        sources TEXT NOT NULL,
        inputs TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (pearl_id, version)
      );

      CREATE TABLE last_good (
        pearl_id TEXT NOT NULL REFERENCES pearls(id) ON DELETE CASCADE,
        size TEXT NOT NULL CHECK (size IN ('inline', 'rectangular', 'small', 'medium')),
        output TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (pearl_id, size)
      );

      CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pearl_id TEXT NOT NULL REFERENCES pearls(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('refresh', 'preview', 'repair', 'save')),
        size TEXT CHECK (size IS NULL OR size IN ('inline', 'rectangular', 'small', 'medium')),
        ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX runs_pearl_id ON runs(pearl_id, id);
    `,
  },
  {
    name: "oauth_tokens",
    sql: `
      CREATE TABLE oauth_tokens (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        tag BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, provider)
      );

      CREATE TABLE oauth_state_nonces (
        nonce TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        code_verifier TEXT,
        browser_binding_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1))
      );
      CREATE INDEX oauth_state_nonces_expires_at ON oauth_state_nonces(expires_at);
    `,
  },
  {
    name: "chat_sessions",
    sql: `
      CREATE TABLE chat_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        messages TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX chat_sessions_user_id ON chat_sessions(user_id);
    `,
  },
];
