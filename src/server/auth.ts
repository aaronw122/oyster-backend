import type { MiddlewareHandler } from "hono";
import type { UserStore } from "../store/users.ts";
import type { AppEnv } from "./app.ts";
import { apiError } from "./errors.ts";

const BEARER = /^Bearer\s+(\S+)\s*$/i;

/** Resolves `Authorization: Bearer <token>` to `c.var.userId`; 401 `unauthorized` otherwise. */
export function requireAuth(users: UserStore): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = BEARER.exec(c.req.header("Authorization") ?? "")?.[1];
    if (!token) return apiError(c, 401, "unauthorized", "Missing bearer token.");
    const userId = users.resolveToken(token);
    if (!userId) return apiError(c, 401, "unauthorized", "Invalid bearer token.");
    c.set("userId", userId);
    await next();
  };
}
