import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./index.ts";
import { MIGRATIONS } from "./migrations.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

test("reopening a file DB applies each migration once and keeps data", () => {
  dir = mkdtempSync(join(tmpdir(), "oyster-db-"));
  const path = join(dir, "nested", "oyster.db");

  const first = openDb(path);
  first.query("INSERT INTO users (id, created_at) VALUES ('u1', '2026-09-29T00:00:00Z')").run();
  first.close();

  const second = openDb(path);
  const versions = second.query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version").all();
  expect(versions.map((v) => v.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  expect(second.query("SELECT id FROM users").all()).toEqual([{ id: "u1" }]);
  expect(second.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
  second.close();
});

test("foreign keys are enforced", () => {
  const db = openDb(":memory:");
  expect(() =>
    db
      .query(
        `INSERT INTO pearls (id, user_id, name, inputs, sources, transform, version, status, created_at, updated_at)
         VALUES ('p1', 'nobody', 'n', '{}', '[]', 't', 1, 'ok', 'x', 'x')`,
      )
      .run(),
  ).toThrow(/FOREIGN KEY/);
});
