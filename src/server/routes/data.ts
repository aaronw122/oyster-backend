import { Hono } from "hono";
import { type PreviewResponse, SizeSchema } from "../../contract/index.ts";
import { getPearlData, previewPearl } from "../../runtime/index.ts";
import type { AppDeps, AppEnv } from "../app.ts";
import { apiError } from "../errors.ts";

/** `/pearls/:id/data` (widget refresh) and `/pearls/:id/preview`. Mounted under the authenticated `/pearls` prefix. */
export function dataRoutes({ runtime }: AppDeps): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .get("/:id/data", async (c) => {
      const size = SizeSchema.safeParse(c.req.query("size"));
      if (!size.success) {
        return apiError(c, 400, "invalid_request", "size must be one of inline, rectangular, small, medium.");
      }
      const result = await getPearlData(c.var.userId, c.req.param("id"), size.data, runtime);
      if (result.status !== 200) return apiError(c, result.status, result.error.code, result.error.message);
      return c.json(result.body);
    })
    .post("/:id/preview", async (c) => {
      const result = await previewPearl(c.var.userId, c.req.param("id"), runtime);
      if (result.ok) return c.json({ previews: result.previews } satisfies PreviewResponse);
      if ("notFound" in result) return apiError(c, 404, "not_found", "No Pearl with that id belongs to this account.");
      return apiError(c, 422, "pearl_failed", result.failure.message);
    });
}
