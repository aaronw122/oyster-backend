import { Hono } from "hono";
import type { HealthResponse } from "../../contract/index.ts";
import type { AppDeps, AppEnv } from "../app.ts";

export function healthRoutes(_deps: AppDeps): Hono<AppEnv> {
  return new Hono<AppEnv>().get("/health", (c) => c.json({ ok: true } satisfies HealthResponse));
}
