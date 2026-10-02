import { TRANSFORM_GUIDE } from "../agent/index.ts";
import type { Pearl, WidgetOutput } from "../contract/index.ts";
import { modelSafeDetail, type RunFailure } from "../runtime/index.ts";
import { summarizeJson } from "../sources/index.ts";

/**
 * System prompt for the background repair agent (§5). Static text so it stays a
 * cacheable prefix; the broken Pearl arrives in the user message.
 */
export const REPAIR_SYSTEM_PROMPT = `You are Oyster's repair worker. A saved Pearl (a widget definition: read-only data sources, stored inputs, and a JavaScript transform) stopped working when its widget refreshed. No person is watching: there is nobody to ask and nothing you write is shown to anyone. Your only job is to fix the transform so the Pearl works again with its existing sources and inputs.

# Scope
- Fix the transform only. The sources and inputs are fixed; you cannot change them. If a source is gone, has moved, or now returns data that no longer contains what the Pearl shows, you cannot repair it: stop and reply with one short line saying why.
- Keep what the Pearl shows. The fixed transform must display the same information in the same way (same headline, subtitle, and items, same units and formatting) as the current one did; only adapt how it reads the data (renamed fields, moved paths, changed types, missing or empty values, lengths that no longer fit). Never add, drop, or reinterpret information, and never widen what it reads.
- Read-only: Pearls only ever read data. No secrets appear anywhere and none are needed.
- Sensitive data (bank balances and similar): you only ever see its shape and types, never real values. Don't try to get them; write the fix from the shape.

# Tools
- test_pearl runs a transform against the Pearl's live data and tells you the raw output (shape only for sensitive data) and any size problems. Use it to inspect the data (a throwaway transform can return parts of it) and to check a candidate.
- find_builtin describes a built-in source's current output shape.
- submit_repair submits the fixed transform with a one-line reason. The server runs it live; it is accepted only if it succeeds and fits every widget size. Submit as soon as a candidate passes test_pearl.
You have a small budget of tool calls. Be direct: read the failure, compare the current transform with the data's shape, write the smallest fix, test it, submit it.

${TRANSFORM_GUIDE}`;

/** What the repair model is told about the broken Pearl. */
export type RepairRequest = {
  pearl: Pick<Pearl, "name" | "sources" | "inputs" | "transform" | "lastGood">;
  failure: RunFailure;
  /** Fresh fetch of every source, keyed by source id. */
  probe: Record<string, unknown>;
  sensitive: boolean;
};

/**
 * The repair turn's user message: failure, current transform, sources, inputs,
 * what the widget last showed, and the probe. For sensitive Pearls every value is
 * dropped: inputs, last output, and probe become shape-only summaries and the
 * failure detail follows `modelSafeDetail`.
 */
export function buildRepairMessage({ pearl, failure, probe, sensitive }: RepairRequest): string {
  const lastShown: WidgetOutput | undefined = pearl.lastGood?.medium?.output ?? pearl.lastGood?.small?.output;
  const detail = modelSafeDetail(failure, sensitive);
  const sections = [
    `Pearl "${pearl.name}" failed to refresh${sensitive ? " (sensitive data: shapes and types only)" : ""}.`,
    `## Failure (${failure.stage})\n${detail}${failure.sizes ? `\nSizes that don't fit: ${failure.sizes.join(", ")}` : ""}`,
    `## Current transform\n${pearl.transform}`,
    `## Sources (fixed)\n${JSON.stringify(pearl.sources, null, 2)}`,
    `## Inputs (fixed)\n${sensitive ? summarizeJson(pearl.inputs, { redact: true }) || "(none)" : JSON.stringify(pearl.inputs, null, 2)}`,
    ...(lastShown
      ? [
          `## What the widget last showed (medium size; keep showing this)\n${
            sensitive ? summarizeJson(lastShown, { redact: true }) : JSON.stringify(lastShown, null, 2)
          }`,
        ]
      : []),
    `## Live data now (shape summary: \`path: type${sensitive ? "" : " = sample"}\`)\n${Object.entries(probe)
      .map(([id, data]) => `sources.${id}:\n${summarizeJson(data, { redact: sensitive })}`)
      .join("\n\n")}`,
    "Fix the transform and submit it with submit_repair.",
  ];
  return sections.join("\n\n");
}
