import type { Database } from "bun:sqlite";
import { isoNow, type LastGood, type Pearl, type SavePearlRequest, type Size, type WidgetOutput } from "../contract/index.ts";

export type LastGoodEntry = { output: WidgetOutput; version: number; updatedAt: string };

type PearlRow = {
  id: string;
  user_id: string;
  name: string;
  inputs: string;
  sources: string;
  transform: string;
  version: number;
  status: Pearl["status"];
};

type LastGoodRow = { size: Size; output: string; version: number; updated_at: string };

const PEARL_COLUMNS = "id, user_id, name, inputs, sources, transform, version, status";

/**
 * Pearl definitions, their full version history (for audit + rollback), per-size
 * last-good outputs, and a run audit log. Every definition change bumps `version`
 * and appends a `pearl_versions` row.
 */
export class PearlStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Creates a Pearl at version 1 with status "ok". */
  create(userId: string, body: SavePearlRequest): Pearl {
    const id = crypto.randomUUID();
    const now = isoNow();
    this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT INTO pearls (id, user_id, name, inputs, sources, transform, version, status, created_at, updated_at)
           VALUES ($id, $userId, $name, $inputs, $sources, $transform, 1, 'ok', $now, $now)`,
        )
        .run({
          id,
          userId,
          name: body.name,
          inputs: JSON.stringify(body.inputs),
          sources: JSON.stringify(body.sources),
          transform: body.transform,
          now,
        });
      this.#appendVersion(id, "create", now);
    })();
    return this.#require(id);
  }

  /** Replaces the owner's Pearl definition as a new version. Null if absent or owned by someone else. */
  update(userId: string, id: string, body: SavePearlRequest): Pearl | null {
    const updated = this.#db.transaction(() => {
      const now = isoNow();
      const result = this.#db
        .query(
          `UPDATE pearls
           SET name = $name, inputs = $inputs, sources = $sources, transform = $transform,
               version = version + 1, updated_at = $now
           WHERE id = $id AND user_id = $userId`,
        )
        .run({
          id,
          userId,
          name: body.name,
          inputs: JSON.stringify(body.inputs),
          sources: JSON.stringify(body.sources),
          transform: body.transform,
          now,
        });
      if (result.changes === 0) return false;
      this.#appendVersion(id, "update", now);
      return true;
    })();
    return updated ? this.#require(id) : null;
  }

  /** The Pearl if it exists and belongs to `userId`, else null. */
  get(userId: string, id: string): Pearl | null {
    const row = this.#db
      .query<PearlRow, { id: string; userId: string }>(
        `SELECT ${PEARL_COLUMNS} FROM pearls WHERE id = $id AND user_id = $userId`,
      )
      .get({ id, userId });
    return row ? this.#toPearl(row) : null;
  }

  /** Unscoped lookup for internal callers (runtime, repair). */
  getById(id: string): Pearl | null {
    const row = this.#db
      .query<PearlRow, { id: string }>(`SELECT ${PEARL_COLUMNS} FROM pearls WHERE id = $id`)
      .get({ id });
    return row ? this.#toPearl(row) : null;
  }

  /** The owner's Pearls, oldest first. */
  list(userId: string): Array<{ id: string; name: string }> {
    return this.#db
      .query<{ id: string; name: string }, { userId: string }>(
        "SELECT id, name FROM pearls WHERE user_id = $userId ORDER BY created_at, rowid",
      )
      .all({ userId });
  }

  setLastGood(id: string, size: Size, entry: LastGoodEntry): void {
    this.#assertExists(id);
    this.#db
      .query(
        `INSERT INTO last_good (pearl_id, size, output, version, updated_at)
         VALUES ($id, $size, $output, $version, $updatedAt)
         ON CONFLICT (pearl_id, size) DO UPDATE
         SET output = excluded.output, version = excluded.version, updated_at = excluded.updated_at`,
      )
      .run({ id, size, output: JSON.stringify(entry.output), version: entry.version, updatedAt: entry.updatedAt });
  }

  setStatus(id: string, status: Pearl["status"]): void {
    const result = this.#db
      .query("UPDATE pearls SET status = $status, updated_at = $now WHERE id = $id")
      .run({ id, status, now: isoNow() });
    if (result.changes === 0) throw new PearlNotFoundError(id);
  }

  /** Swaps in a new transform as a new version (used by repair). */
  replaceTransform(id: string, transform: string, reason: string): Pearl {
    this.#db.transaction(() => {
      const now = isoNow();
      const result = this.#db
        .query("UPDATE pearls SET transform = $transform, version = version + 1, updated_at = $now WHERE id = $id")
        .run({ id, transform, now });
      if (result.changes === 0) throw new PearlNotFoundError(id);
      this.#appendVersion(id, reason, now);
    })();
    return this.#require(id);
  }

  /** Every recorded version, oldest first. */
  listVersions(id: string): Array<{ version: number; transform: string; createdAt: string; reason: string }> {
    return this.#db
      .query<{ version: number; transform: string; createdAt: string; reason: string }, { id: string }>(
        `SELECT version, transform, created_at AS createdAt, reason
         FROM pearl_versions WHERE pearl_id = $id ORDER BY version`,
      )
      .all({ id });
  }

  /** Restores `version`'s transform as a NEW version; history is never rewritten. */
  rollback(id: string, version: number): Pearl {
    const target = this.#db
      .query<{ transform: string }, { id: string; version: number }>(
        "SELECT transform FROM pearl_versions WHERE pearl_id = $id AND version = $version",
      )
      .get({ id, version });
    if (!target) throw new Error(`Pearl ${id} has no version ${version}`);
    return this.replaceTransform(id, target.transform, `rollback to v${version}`);
  }

  recordRun(
    id: string,
    run: { size: Size | null; ok: boolean; error?: string; kind: "refresh" | "preview" | "repair" | "save" },
  ): void {
    this.#assertExists(id);
    this.#db
      .query(
        `INSERT INTO runs (pearl_id, kind, size, ok, error, created_at)
         VALUES ($id, $kind, $size, $ok, $error, $now)`,
      )
      .run({ id, kind: run.kind, size: run.size, ok: run.ok ? 1 : 0, error: run.error ?? null, now: isoNow() });
  }

  #appendVersion(id: string, reason: string, now: string): void {
    this.#db
      .query(
        `INSERT INTO pearl_versions (pearl_id, version, transform, sources, inputs, reason, created_at)
         SELECT id, version, transform, sources, inputs, $reason, $now FROM pearls WHERE id = $id`,
      )
      .run({ id, reason, now });
  }

  #assertExists(id: string): void {
    const row = this.#db.query<{ found: number }, { id: string }>("SELECT 1 AS found FROM pearls WHERE id = $id").get({ id });
    if (!row) throw new PearlNotFoundError(id);
  }

  #require(id: string): Pearl {
    const pearl = this.getById(id);
    if (!pearl) throw new PearlNotFoundError(id);
    return pearl;
  }

  #toPearl(row: PearlRow): Pearl {
    const lastGoodRows = this.#db
      .query<LastGoodRow, { id: string }>("SELECT size, output, version, updated_at FROM last_good WHERE pearl_id = $id")
      .all({ id: row.id });
    const pearl: Pearl = {
      id: row.id,
      name: row.name,
      userId: row.user_id,
      inputs: JSON.parse(row.inputs),
      sources: JSON.parse(row.sources),
      transform: row.transform,
      version: row.version,
      status: row.status,
    };
    if (lastGoodRows.length > 0) {
      const lastGood: Partial<Record<Size, LastGood>> = {};
      for (const entry of lastGoodRows) {
        lastGood[entry.size] = { output: JSON.parse(entry.output), version: entry.version, updatedAt: entry.updated_at };
      }
      pearl.lastGood = lastGood;
    }
    return pearl;
  }
}

/** Thrown by internal (unscoped) mutations when the Pearl id does not exist. */
export class PearlNotFoundError extends Error {
  constructor(readonly pearlId: string) {
    super(`Pearl ${pearlId} not found`);
    this.name = "PearlNotFoundError";
  }
}
