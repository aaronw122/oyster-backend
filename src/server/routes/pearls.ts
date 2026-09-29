import { type Context, Hono } from "hono";
import type { z } from "zod";
import {
  type PearlsListResponse,
  type SavePearlRequest,
  SavePearlRequestSchema,
  type SavePearlResponse,
} from "../../contract/index.ts";
import { savePearl } from "../../runtime/index.ts";
import type { AppDeps, AppEnv } from "../app.ts";
import { apiError } from "../errors.ts";

/** `/pearls` routes. Mounted under an authenticated prefix, so `c.var.userId` is always set. */
export function pearlsRoutes({ pearls, runtime }: AppDeps): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .get("/", (c) => c.json({ pearls: pearls.list(c.var.userId) } satisfies PearlsListResponse))
    .post("/", async (c) => {
      const body = await parseSaveBody(c);
      if (body instanceof Response) return body;
      const result = await savePearl(c.var.userId, body, runtime);
      if (!result.ok) {
        if ("notFound" in result) throw new Error("savePearl reported not-found for a new Pearl");
        return apiError(c, 422, "pearl_failed", result.failure.message);
      }
      const { pearl } = result;
      return c.json({ id: pearl.id, name: pearl.name, version: pearl.version } satisfies SavePearlResponse, 201);
    })
    .put("/:id", async (c) => {
      const body = await parseSaveBody(c);
      if (body instanceof Response) return body;
      const result = await savePearl(c.var.userId, body, runtime, c.req.param("id"));
      if (!result.ok) {
        if ("notFound" in result) return apiError(c, 404, "not_found", "No Pearl with that id belongs to this account.");
        return apiError(c, 422, "pearl_failed", result.failure.message);
      }
      const { pearl } = result;
      return c.json({ id: pearl.id, name: pearl.name, version: pearl.version } satisfies SavePearlResponse);
    });
}

async function parseSaveBody(c: Context<AppEnv>): Promise<SavePearlRequest | Response> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return apiError(c, 400, "invalid_request", "Request body must be valid JSON.");
  }
  const parsed = SavePearlRequestSchema.safeParse(json);
  if (!parsed.success) return apiError(c, 400, "invalid_request", summarizeIssues(parsed.error));
  return parsed.data;
}

function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "body"}: ${issue.message}`)
    .join("; ");
}
