// Oyster §2 contract (owner-approved 2026-09-29). Field names, routes, and
// event types are frozen; changes need owner sign-off.
import { z } from "zod";

// ── §2a Size ────────────────────────────────────────────────────────────────
// inline/rectangular = lock screen (.accessoryInline / .accessoryRectangular)
export const SIZES = ["inline", "rectangular", "small", "medium"] as const;
export const SizeSchema = z.enum(SIZES);
export type Size = z.infer<typeof SizeSchema>;

const IsoDateTime = z.iso.datetime({ offset: true });
const Version = z.number().int().positive();

// ── §2b Widget output ───────────────────────────────────────────────────────
// Structural shape only. Per-size projection and length budgets are enforced by
// the sandbox validator (see SIZE_BUDGETS).
export const WidgetOutputSchema = z.object({
  value: z.string(),
  subtitle: z.string().optional(),
  items: z
    .array(
      z.object({
        label: z.string(),
        value: z.string().optional(),
      }),
    )
    .optional(),
});
export type WidgetOutput = z.infer<typeof WidgetOutputSchema>;

/** `Partial<Record<Size, WidgetOutput>>`; keys outside `Size` are rejected. */
export const PreviewsSchema = z.partialRecord(SizeSchema, WidgetOutputSchema);
export type Previews = z.infer<typeof PreviewsSchema>;

export const PearlDataSchema = z.object({
  pearlId: z.string(),
  version: Version,
  size: SizeSchema,
  output: WidgetOutputSchema,
  updatedAt: IsoDateTime,
  stale: z.boolean(),
});
export type PearlData = z.infer<typeof PearlDataSchema>;

// ── §2a Pearl definition (stored) ───────────────────────────────────────────
export const PearlSourceSchema = z
  .object({
    id: z.string().min(1),
    builtin: z.string().min(1).optional(),
    params: z.record(z.string(), z.string()).optional(),
    url: z.string().min(1).optional(),
    method: z.literal("GET"),
    auth: z.object({ provider: z.string().min(1) }).optional(),
    sensitive: z.boolean().optional(),
  })
  .refine((source) => (source.builtin === undefined) !== (source.url === undefined), {
    message: "source must set exactly one of `builtin` or `url`",
  });
export type PearlSource = z.infer<typeof PearlSourceSchema>;

export const LastGoodSchema = z.object({
  output: WidgetOutputSchema,
  version: Version,
  updatedAt: IsoDateTime,
});
export type LastGood = z.infer<typeof LastGoodSchema>;

export const PearlStatusSchema = z.enum(["ok", "broken", "repairing"]);
export type PearlStatus = z.infer<typeof PearlStatusSchema>;

export const PearlSchema = z.object({
  id: z.string(),
  name: z.string(),
  userId: z.string(),
  inputs: z.record(z.string(), z.unknown()),
  sources: z.array(PearlSourceSchema),
  transform: z.string(),
  version: Version,
  lastGood: z.partialRecord(SizeSchema, LastGoodSchema).optional(),
  status: PearlStatusSchema,
});
export type Pearl = z.infer<typeof PearlSchema>;

// ── §2c HTTP contract ───────────────────────────────────────────────────────
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** `GET /health` */
export const HealthResponseSchema = z.object({ ok: z.literal(true) });
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** `POST /messages` body */
export const MessagesRequestSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string(),
});
export type MessagesRequest = z.infer<typeof MessagesRequestSchema>;

/** `POST /messages` SSE payload: each event is `data: <ChatEvent JSON>\n\n`. */
export const ChatEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), delta: z.string() }),
  z.object({
    type: z.literal("question"),
    id: z.string(),
    text: z.string(),
    options: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal("status"), text: z.string() }),
  z.object({ type: z.literal("oauth"), provider: z.string(), url: z.string() }),
  z.object({ type: z.literal("preview"), previews: PreviewsSchema }),
  z.object({
    type: z.literal("saved"),
    pearl: z.object({ id: z.string(), name: z.string() }),
  }),
  z.object({ type: z.literal("unavailable"), text: z.string() }),
  z.object({ type: z.literal("error"), text: z.string() }),
  z.object({ type: z.literal("done") }),
]);
export type ChatEvent = z.infer<typeof ChatEventSchema>;
export type ChatEventType = ChatEvent["type"];

export const PearlSummarySchema = z.object({ id: z.string(), name: z.string() });
export type PearlSummary = z.infer<typeof PearlSummarySchema>;

/** `GET /pearls` */
export const PearlsListResponseSchema = z.object({
  pearls: z.array(PearlSummarySchema),
});
export type PearlsListResponse = z.infer<typeof PearlsListResponseSchema>;

/** `POST /pearls` / `PUT /pearls/:id` body: Pearl minus server-owned fields. */
export const SavePearlRequestSchema = PearlSchema.omit({
  id: true,
  userId: true,
  version: true,
  lastGood: true,
  status: true,
});
export type SavePearlRequest = z.infer<typeof SavePearlRequestSchema>;

/** `POST /pearls` / `PUT /pearls/:id` response */
export const SavePearlResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: Version,
});
export type SavePearlResponse = z.infer<typeof SavePearlResponseSchema>;

/** `POST /pearls/:id/preview` */
export const PreviewResponseSchema = z.object({ previews: PreviewsSchema });
export type PreviewResponse = z.infer<typeof PreviewResponseSchema>;

// ── §2b Per-size length budgets (Unicode code points; null = not shown) ──────
export type SizeBudget = {
  value: number;
  subtitle: number | null;
  items: { max: number; label: number; value: number } | null;
};

// [INFERENCE] §2b gives only the item count (2) for `small`; label/value caps
// reuse the medium limits (22/10).
export const SIZE_BUDGETS: Record<Size, SizeBudget> = {
  inline: { value: 12, subtitle: null, items: null },
  rectangular: { value: 12, subtitle: 24, items: null },
  small: { value: 16, subtitle: 28, items: { max: 2, label: 22, value: 10 } },
  medium: { value: 20, subtitle: 40, items: { max: 5, label: 22, value: 10 } },
};
