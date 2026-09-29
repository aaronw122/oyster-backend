import { beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import saveFixture from "../../fixtures/contract/save-pearl-request.json";
import { PearlSchema, type SavePearlRequest, SavePearlRequestSchema } from "../contract/index.ts";
import { openDb } from "../db/index.ts";
import { PearlNotFoundError, PearlStore } from "./pearls.ts";
import { UserStore } from "./users.ts";

const body: SavePearlRequest = SavePearlRequestSchema.parse(saveFixture);

let db: Database;
let pearls: PearlStore;
let users: UserStore;
beforeEach(() => {
  db = openDb(":memory:");
  pearls = new PearlStore(db);
  users = new UserStore(db);
  users.issueToken("alice");
  users.issueToken("bob");
});

test("tokens resolve to their user; only the hash is stored", () => {
  const token = users.issueToken("carol");
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(users.resolveToken(token)).toBe("carol");
  expect(users.resolveToken(`${token}x`)).toBeNull();
  const stored = db.query<{ token_hash: string }, []>("SELECT token_hash FROM api_tokens").all();
  expect(stored.some((row) => row.token_hash === token)).toBe(false);
});

test("create returns a valid version-1 Pearl scoped to its owner", () => {
  const pearl = pearls.create("alice", body);
  expect(PearlSchema.parse(pearl)).toEqual(pearl);
  expect(pearl).toMatchObject({ userId: "alice", version: 1, status: "ok", name: body.name, transform: body.transform });
  expect(pearl.lastGood).toBeUndefined();
  expect(pearls.get("alice", pearl.id)).toEqual(pearl);
  expect(pearls.get("bob", pearl.id)).toBeNull();
  expect(pearls.list("bob")).toEqual([]);
  expect(pearls.list("alice")).toEqual([{ id: pearl.id, name: pearl.name }]);
});

test("update bumps the version and appends history; other users cannot update", () => {
  const { id } = pearls.create("alice", body);
  expect(pearls.update("bob", id, { ...body, name: "hijack" })).toBeNull();
  const updated = pearls.update("alice", id, { ...body, name: "Renamed", transform: "() => ({ value: 'x' })" });
  expect(updated).toMatchObject({ version: 2, name: "Renamed", transform: "() => ({ value: 'x' })" });
  expect(pearls.listVersions(id).map((v) => [v.version, v.reason])).toEqual([
    [1, "create"],
    [2, "update"],
  ]);
});

test("replaceTransform and rollback create new versions with the right transform", () => {
  const { id } = pearls.create("alice", body);
  const repaired = pearls.replaceTransform(id, "() => ({ value: 'fixed' })", "repair: feed renamed field");
  expect(repaired).toMatchObject({ version: 2, transform: "() => ({ value: 'fixed' })" });

  const rolledBack = pearls.rollback(id, 1);
  expect(rolledBack).toMatchObject({ version: 3, transform: body.transform });
  expect(pearls.listVersions(id).map((v) => [v.version, v.transform, v.reason])).toEqual([
    [1, body.transform, "create"],
    [2, "() => ({ value: 'fixed' })", "repair: feed renamed field"],
    [3, body.transform, "rollback to v1"],
  ]);
  expect(() => pearls.rollback(id, 9)).toThrow();
  expect(() => pearls.replaceTransform("missing", "x", "r")).toThrow(PearlNotFoundError);
});

test("setLastGood is reflected in get() per size and upserts", () => {
  const { id } = pearls.create("alice", body);
  pearls.setLastGood(id, "small", { output: { value: "old" }, version: 1, updatedAt: "2026-09-29T12:00:00Z" });
  pearls.setLastGood(id, "small", { output: { value: "new" }, version: 1, updatedAt: "2026-09-29T12:05:00Z" });
  pearls.setLastGood(id, "inline", { output: { value: "W 21st" }, version: 1, updatedAt: "2026-09-29T12:05:00Z" });

  const pearl = pearls.get("alice", id);
  expect(PearlSchema.safeParse(pearl).success).toBe(true);
  expect(pearl?.lastGood).toEqual({
    small: { output: { value: "new" }, version: 1, updatedAt: "2026-09-29T12:05:00Z" },
    inline: { output: { value: "W 21st" }, version: 1, updatedAt: "2026-09-29T12:05:00Z" },
  });
});

test("setStatus and recordRun require an existing Pearl", () => {
  const { id } = pearls.create("alice", body);
  pearls.setStatus(id, "broken");
  expect(pearls.getById(id)?.status).toBe("broken");
  pearls.recordRun(id, { kind: "refresh", size: "small", ok: false, error: "http 500" });
  pearls.recordRun(id, { kind: "save", size: null, ok: true });
  expect(db.query("SELECT kind, size, ok, error FROM runs ORDER BY id").all()).toEqual([
    { kind: "refresh", size: "small", ok: 0, error: "http 500" },
    { kind: "save", size: null, ok: 1, error: null },
  ]);
  expect(() => pearls.setStatus("missing", "ok")).toThrow(PearlNotFoundError);
  expect(() => pearls.recordRun("missing", { kind: "refresh", size: null, ok: true })).toThrow(PearlNotFoundError);
});
