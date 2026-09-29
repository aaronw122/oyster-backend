import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { Config } from "../config.ts";
import type { PearlStore } from "../store/pearls.ts";
import type { UserStore } from "../store/users.ts";
import { requireAuth } from "./auth.ts";
import { apiError } from "./errors.ts";
import { healthRoutes } from "./routes/health.ts";
import { pearlsRoutes } from "./routes/pearls.ts";

export type AppDeps = { config: Config; db: Database; pearls: PearlStore; users: UserStore };
export type AppEnv = { Variables: { userId: string } };

// §2c: every app route under these prefixes requires a bearer token. Route modules
// mounted beneath them (e.g. /pearls/:id/data, /messages) inherit auth automatically.
const AUTHENTICATED_PREFIXES = ["/pearls", "/messages"] as const;

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const auth = requireAuth(deps.users);
  for (const prefix of AUTHENTICATED_PREFIXES) app.use(`${prefix}/*`, auth);

  app.route("/", healthRoutes(deps));
  app.route("/pearls", pearlsRoutes(deps));

  app.notFound((c) => apiError(c, 404, "not_found", "Route not found."));
  app.onError((err, c) => {
    console.error(`[${c.req.method} ${c.req.path}]`, err);
    return apiError(c, 500, "internal_error", "Internal server error.");
  });
  return app;
}
