import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isoNow } from "../contract/index.ts";
import { MIGRATIONS, type Migration } from "./migrations.ts";

export { Database };

/** Opens (creating if needed) the SQLite database at `path` and applies pending migrations. `":memory:"` for tests. */
export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db, MIGRATIONS);
  return db;
}

function migrate(db: Database, migrations: readonly Migration[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    db.query<{ version: number }, []>("SELECT version FROM schema_migrations").all().map((row) => row.version),
  );
  const record = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES ($version, $name, $appliedAt)");
  migrations.forEach((migration, index) => {
    const version = index + 1;
    if (applied.has(version)) return;
    db.transaction(() => {
      db.exec(migration.sql);
      record.run({ version, name: migration.name, appliedAt: isoNow() });
    })();
  });
}
