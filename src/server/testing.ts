// Test-only helpers for the HTTP suites: an in-memory app with two users, a
// request shorthand, and the contract error assertion.
import { expect } from "bun:test";
import type { Hono } from "hono";
import { loadConfig } from "../config.ts";
import { ApiErrorSchema } from "../contract/index.ts";
import { openDb } from "../db/index.ts";
import { nullAuthResolverFor, type RuntimeDeps } from "../runtime/index.ts";
import { createMemorySourceCache } from "../sources/index.ts";
import { PearlStore } from "../store/pearls.ts";
import { UserStore } from "../store/users.ts";
import { type AppEnv, createApp } from "./app.ts";

/** Asserts a contract `ApiError` response and returns its message. */
export async function expectApiError(res: Response, status: number, code: string): Promise<string> {
  expect(res.status).toBe(status);
  const parsed = ApiErrorSchema.parse(await res.json());
  expect(parsed.error.code).toBe(code);
  return parsed.error.message;
}

/**
 * An app over an in-memory DB with users `alice` and `bob` (tokens returned),
 * no auth providers, and a memory source cache; `runtime` overrides the rest.
 */
export function createTestServer(runtime: Partial<Omit<RuntimeDeps, "pearls">> = {}) {
  const db = openDb(":memory:");
  const pearls = new PearlStore(db);
  const users = new UserStore(db);
  const alice = users.issueToken("alice");
  const bob = users.issueToken("bob");
  const app: Hono<AppEnv> = createApp({
    config: loadConfig({ NODE_ENV: "test" }),
    db,
    pearls,
    users,
    runtime: { authResolverFor: nullAuthResolverFor, cache: createMemorySourceCache(), ...runtime, pearls },
  });

  /** Sends `body` as JSON (strings are sent raw, for malformed-body cases); `token` becomes a bearer header. */
  const send = (method: string, path: string, token?: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });

  return { app, db, pearls, users, alice, bob, send };
}

export type TestServer = ReturnType<typeof createTestServer>;
