import { beforeEach, expect, test } from "bun:test";
import type { Hono } from "hono";
import { z } from "zod";
import saveFixture from "../../fixtures/contract/save-pearl-request.json";
import {
  ApiErrorSchema,
  HealthResponseSchema,
  PearlsListResponseSchema,
  SavePearlResponseSchema,
} from "../contract/index.ts";
import { loadConfig } from "../config.ts";
import { openDb } from "../db/index.ts";
import { nullAuthResolverFor } from "../runtime/index.ts";
import type { Builtin } from "../sources/builtins.ts";
import { createMemorySourceCache } from "../sources/index.ts";
import { PearlStore } from "../store/pearls.ts";
import { UserStore } from "../store/users.ts";
import { type AppEnv, createApp } from "./app.ts";

let app: Hono<AppEnv>;
let pearls: PearlStore;
let alice: string;
let bob: string;

// Offline stand-in for the fixture's `gbfs` builtin (normalized shape the fixture transform reads).
const fakeGbfs: Builtin = {
  name: "gbfs",
  description: "test gbfs",
  params: z.record(z.string(), z.string()),
  fetch: async () => ({
    stations: { "6140.05": { name: "W 21 St & 6 Ave", docksAvailable: 5, isReturning: true } },
  }),
};

beforeEach(() => {
  const db = openDb(":memory:");
  pearls = new PearlStore(db);
  const users = new UserStore(db);
  alice = users.issueToken("alice");
  bob = users.issueToken("bob");
  const runtime = { pearls, authResolverFor: nullAuthResolverFor, cache: createMemorySourceCache(), builtins: [fakeGbfs] };
  app = createApp({ config: loadConfig({ NODE_ENV: "test" }), db, pearls, users, runtime });
});

const send = (method: string, path: string, token?: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const parsed = ApiErrorSchema.parse(await res.json());
  expect(parsed.error.code).toBe(code);
  return parsed.error.message;
}

test("GET /health is unauthenticated", async () => {
  const res = await send("GET", "/health");
  expect(res.status).toBe(200);
  expect(HealthResponseSchema.parse(await res.json())).toEqual({ ok: true });
});

test("/pearls routes reject missing and invalid tokens", async () => {
  await expectError(await send("GET", "/pearls"), 401, "unauthorized");
  await expectError(await send("GET", "/pearls", "not-a-token"), 401, "unauthorized");
  await expectError(await send("POST", "/pearls", undefined, saveFixture), 401, "unauthorized");
  await expectError(await send("PUT", "/pearls/x", "nope", saveFixture), 401, "unauthorized");
  await expectError(await send("POST", "/messages", undefined, {}), 401, "unauthorized");
  const res = await app.request("/pearls", { headers: { Authorization: `Basic ${alice}` } });
  await expectError(res, 401, "unauthorized");
});

test("save → version 1, update → version 2, list shows only the caller's Pearls", async () => {
  const created = await send("POST", "/pearls", alice, saveFixture);
  expect(created.status).toBe(201);
  const saved = SavePearlResponseSchema.parse(await created.json());
  expect(saved).toMatchObject({ name: saveFixture.name, version: 1 });

  const updated = await send("PUT", `/pearls/${saved.id}`, alice, { ...saveFixture, name: "Docks v2" });
  expect(updated.status).toBe(200);
  expect(SavePearlResponseSchema.parse(await updated.json())).toEqual({ id: saved.id, name: "Docks v2", version: 2 });
  expect(pearls.listVersions(saved.id).map((v) => v.reason)).toEqual(["create", "update"]);

  await send("POST", "/pearls", bob, { ...saveFixture, name: "Bob's" });
  const aliceList = PearlsListResponseSchema.parse(await (await send("GET", "/pearls", alice)).json());
  expect(aliceList).toEqual({ pearls: [{ id: saved.id, name: "Docks v2" }] });
  const bobList = PearlsListResponseSchema.parse(await (await send("GET", "/pearls", bob)).json());
  expect(bobList.pearls.map((p) => p.name)).toEqual(["Bob's"]);
});

test("PUT on another user's or an unknown Pearl is 404 and changes nothing", async () => {
  const { id } = SavePearlResponseSchema.parse(await (await send("POST", "/pearls", alice, saveFixture)).json());
  await expectError(await send("PUT", `/pearls/${id}`, bob, { ...saveFixture, name: "stolen" }), 404, "not_found");
  await expectError(await send("PUT", "/pearls/does-not-exist", alice, saveFixture), 404, "not_found");
  expect(pearls.get("alice", id)).toMatchObject({ name: saveFixture.name, version: 1 });
});

test("invalid save bodies are 400 invalid_request, including server-owned fields", async () => {
  const serverOwned = await expectError(await send("POST", "/pearls", alice, { ...saveFixture, version: 7 }), 400, "invalid_request");
  expect(serverOwned).toContain("version");

  const missing = await expectError(await send("POST", "/pearls", alice, { name: "x" }), 400, "invalid_request");
  expect(missing).toContain("transform");

  const dupSources = { ...saveFixture, sources: [saveFixture.sources[0], saveFixture.sources[0]] };
  await expectError(await send("POST", "/pearls", alice, dupSources), 400, "invalid_request");
  await expectError(await send("POST", "/pearls", alice, "{not json"), 400, "invalid_request");
  const { id } = SavePearlResponseSchema.parse(await (await send("POST", "/pearls", alice, saveFixture)).json());
  await expectError(await send("PUT", `/pearls/${id}`, alice, { ...saveFixture, status: "ok" }), 400, "invalid_request");
  expect(pearls.list("alice")).toHaveLength(1);
});

test("unknown routes are JSON 404; thrown errors are JSON 500 without a stack", async () => {
  await expectError(await send("GET", "/nope"), 404, "not_found");
  await expectError(await send("GET", "/pearls/abc/unknown", alice), 404, "not_found");

  pearls.list = () => {
    throw new Error("disk on fire");
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = await send("GET", "/pearls", alice);
    const text = await res.clone().text();
    await expectError(res, 500, "internal_error");
    expect(text).not.toContain("disk on fire");
  } finally {
    console.error = originalError;
  }
});
