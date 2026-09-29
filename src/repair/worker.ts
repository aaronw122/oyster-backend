import type { LanguageModel } from "ai";
import { type AgentLimits, type AgentServices, type RepairFix, runAgentTurn } from "../agent/index.ts";
import { isoNow, type Pearl, SIZES } from "../contract/index.ts";
import { isSensitive, type RunFailure } from "../runtime/index.ts";
import { fetchSources } from "../sources/index.ts";
import { buildRepairMessage, REPAIR_SYSTEM_PROMPT } from "./prompt.ts";

export type RepairOutcome =
  | { kind: "repaired"; pearl: Pearl }
  | { kind: "failed"; reason: string }
  /** Not attempted: a source is failing, which a transform can't fix. No model call was made. */
  | { kind: "skipped"; reason: string }
  /** The Pearl got a newer version (save, rollback) while this repair ran; nothing was changed. */
  | { kind: "superseded" };

/** One repair attempt for the version of `pearl` whose refresh failed. */
export type Repairer = (pearl: Pearl, failure: RunFailure, ctx: { sensitive: boolean }) => Promise<RepairOutcome>;

/** Tighter than chat (§3): one focused fix, no discovery. */
export const REPAIR_LIMITS: AgentLimits = { maxSteps: 8, maxToolCalls: 10, maxFetchProbes: 0 };

const MAX_REASON_CHARS = 160;

/**
 * The §5 repair worker: gives the repair agent the failure, the current
 * transform, and a fresh probe of the sources (shape-only when sensitive); the
 * agent can only change the transform, and its fix is accepted only after a live
 * run where all four sizes fit. Acceptance atomically ships a new version, seeds
 * last-good for every size, marks the Pearl "ok", and records a "repair" run.
 * A turn without an accepted fix records a failed "repair" run and leaves the
 * Pearl's version and last-good untouched. A failing source is "skipped" before
 * any model call (a transform can't fix a source that is down or gone).
 */
export function createRepairer(services: AgentServices, opts: { model?: LanguageModel; limits?: Partial<AgentLimits> } = {}): Repairer {
  const { pearls, runtime } = services;

  return async (pearl, failure, ctx) => {
    if (failure.stage === "fetch") return { kind: "skipped", reason: `a source failed: ${failure.detail}` };
    // Never trust the hook's flag alone: runtime's rule decides, and either verdict redacts.
    const sensitive = ctx.sensitive || isSensitive(pearl, runtime);
    const probe = await fetchSources(pearl, {
      resolveAuth: runtime.authResolverFor(pearl.userId),
      fetch: runtime.fetch,
      cache: runtime.cache,
      resolveHost: runtime.resolveHost,
      builtins: runtime.builtins,
    });
    if (!probe.ok) return { kind: "skipped", reason: `source "${probe.error.sourceId}" failed (${probe.error.kind})` };

    const submitted: { fix?: RepairFix } = {};
    const { endedBy } = await runAgentTurn({
      userId: pearl.userId,
      sessionId: `repair:${pearl.id}`,
      system: REPAIR_SYSTEM_PROMPT,
      history: [],
      userMessage: buildRepairMessage({ pearl, failure, probe: probe.data, sensitive }),
      services,
      emit: () => undefined,
      limits: { ...REPAIR_LIMITS, ...opts.limits },
      model: opts.model,
      mode: "repair",
      repair: {
        draft: { sources: pearl.sources, inputs: pearl.inputs, transform: pearl.transform },
        sensitive,
        submit: (fix) => {
          submitted.fix = fix;
        },
      },
    });
    const { fix } = submitted;
    if (!fix) {
      const reason = `no passing fix (turn ended: ${endedBy})`;
      pearls.recordRun(pearl.id, { size: null, ok: false, error: reason, kind: "repair" });
      return { kind: "failed", reason };
    }

    const repaired = pearls.transaction(() => {
      const current = pearls.getById(pearl.id);
      if (!current || current.version !== pearl.version) return null;
      const next = pearls.replaceTransform(pearl.id, fix.transform, `repair: ${fix.reason.slice(0, MAX_REASON_CHARS)}`);
      const updatedAt = isoNow();
      for (const size of SIZES) pearls.setLastGood(next.id, size, { output: fix.previews[size], version: next.version, updatedAt });
      pearls.setStatus(next.id, "ok");
      pearls.recordRun(next.id, { size: null, ok: true, kind: "repair" });
      return pearls.getById(next.id) ?? next;
    });
    return repaired ? { kind: "repaired", pearl: repaired } : { kind: "superseded" };
  };
}
