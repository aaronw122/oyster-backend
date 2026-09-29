import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiError } from "../contract/index.ts";

/** The §2c error response: `{ error: { code, message } }`. */
export function apiError(c: Context, status: number, code: string, message: string): Response {
  const body: ApiError = { error: { code, message } };
  return c.json(body, status as ContentfulStatusCode);
}
