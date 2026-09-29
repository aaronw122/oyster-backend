import { beforeEach, expect, test } from "bun:test";
import type { Hono } from "hono";
import {
  ApiErrorSchema,
  PearlDataSchema,
  PreviewResponseSchema,
  type SavePearlRequest,
  SavePearlResponseSchema,
} from "../contract/index.ts";
import { loadConfig } from "../config.ts";
import { openDb } from "../db/index.ts";
import { nullAuthResolverFor } from "../runtime/index.ts";
import { createMemorySourceCache } from "../sources/index.ts";
import { PearlStore } from "../store/pearls.ts";
import { UserStore } from "../store/users.ts";
import { type AppEnv, createApp } from "./app.ts";

let app: Hono<AppEnv>;
let pearls: PearlStore;
let alice: string;
let bob: string;
let now: number;
let payload: { value: string; fail?: boolean };

const body: SavePearlRequest = {
  name: "Temp",
  inputs: {},
  sources: [{ id: "w", url: "https://api.test/now", method: "GET" }],
  transform: `(s) => { if (s.w.fail) throw new Error("bad feed"); return { value: s.w.value, subtitle: "Now", items: [{ label: "A", value: "1" }, { label: "B", value: "2" }, { label: "C", value: "3" }] }; }`,
};

beforeEach(() => {
  const db = openDb(":memory:");
  pearls = new PearlStore(db);
  const users = new UserStore(db);
  alice = users.issueToken("alice");
  bob = users.issueToken("bob");
  now = 0;
  payload = { value: "72°" };
  const runtime = {
    pearls,
    authResolverFor: nullAuthResolverFor,
    cache: createMemorySourceCache(() => now),
    fetch: (async () => Response.json(payload)) as unknown as typeof fetch,
    resolveHost: async () => ["203.0.113.10"],
  };
  app = createApp({ config: loadConfig({ NODE_ENV: "test" }), db, pearls, users, runtime });
});

const send = (method: string, path: string, token: string, json?: unknown) =>
  app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(json !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: json === undefined ? undefined : JSON.stringify(json),
  });

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const parsed = ApiErrorSchema.parse(await res.json());
  expect(parsed.error.code).toBe(code);
  return parsed.error.message;
}

async function create(): Promise<string> {
  const res = await send("POST", "/pearls", alice, body);
  expect(res.status).toBe(201);
  return SavePearlResponseSchema.parse(await res.json()).id;
}

test("GET /pearls/:id/data returns contract PearlData for the requested size", async () => {
  const id = await create();
  const res = await send("GET", `/pearls/${id}/data?size=rectangular`, alice);
  expect(res.status).toBe(200);
  expect(PearlDataSchema.parse(await res.json())).toMatchObject({
    pearlId: id,
    size: "rectangular",
    stale: false,
    output: { value: "72°", subtitle: "Now" },
  });
});

test("GET data: missing or invalid size is 400; other user's or unknown Pearl is 404", async () => {
  const id = await create();
  await expectError(await send("GET", `/pearls/${id}/data`, alice), 400, "invalid_request");
  await expectError(await send("GET", `/pearls/${id}/data?size=large`, alice), 400, "invalid_request");
  await expectError(await send("GET", `/pearls/${id}/data?size=small`, bob), 404, "not_found");
  await expectError(await send("GET", "/pearls/nope/data?size=small", alice), 404, "not_found");
});

test("GET data: failed run with no last-good is 503 unavailable", async () => {
  const pearl = pearls.create("alice", body); // no save-time run → no lastGood
  payload.fail = true;
  await expectError(await send("GET", `/pearls/${pearl.id}/data?size=small`, alice), 503, "unavailable");
});

test("POST /pearls/:id/preview returns live previews at all four sizes", async () => {
  const id = await create();
  payload.value = "65°";
  now += 60_000;
  const res = await send("POST", `/pearls/${id}/preview`, alice);
  expect(res.status).toBe(200);
  const { previews } = PreviewResponseSchema.parse(await res.json());
  expect(previews).toEqual({
    inline: { value: "65°" },
    rectangular: { value: "65°", subtitle: "Now" },
    small: { value: "65°", subtitle: "Now", items: [{ label: "A", value: "1" }, { label: "B", value: "2" }] },
    medium: { value: "65°", subtitle: "Now", items: [{ label: "A", value: "1" }, { label: "B", value: "2" }, { label: "C", value: "3" }] },
  });
  await expectError(await send("POST", `/pearls/${id}/preview`, bob), 404, "not_found");
});

test("POST preview is 422 pearl_failed when the live run fails", async () => {
  const id = await create();
  payload.fail = true;
  now += 60_000;
  const message = await expectError(await send("POST", `/pearls/${id}/preview`, alice), 422, "pearl_failed");
  expect(message).not.toContain("bad feed");
});

test("save is 422 pearl_failed with a plain message when the output doesn't fit, and persists nothing", async () => {
  payload.value = "Partly cloudy skies"; // too long for the lock screen sizes
  const message = await expectError(await send("POST", "/pearls", alice, body), 422, "pearl_failed");
  expect(message).toContain("lock screen");
  expect(message).not.toMatch(/[{}]|https?:|code points/);
  expect(pearls.list("alice")).toEqual([]);

  payload.value = "72°";
  now += 60_000;
  const id = await create();
  payload.fail = true;
  now += 60_000;
  await expectError(await send("PUT", `/pearls/${id}`, alice, { ...body, name: "v2" }), 422, "pearl_failed");
  expect(pearls.get("alice", id)).toMatchObject({ name: "Temp", version: 1 });
});
