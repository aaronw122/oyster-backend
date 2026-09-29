import type { LanguageModel } from "ai";
import { type AgentLimits, type AgentServices, type RepairFix, runAgentTurn } from "../agent/index.ts";
import { isoNow, type Pearl, SIZES } from "../contract/index.ts";
import type { RunFailure } from "../runtime/index.ts";
import { fetchSources } from "../sources/index.ts";
import { buildRepairMessage, REPAIR_SYSTEM_PROMPT } from "./prompt.ts";

export type RepairOutcome =
  | { kind: "repaired"; pearl: Pearl }
  | { kind: "failed"; reason: string }
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
 * Anything else records a failed "repair" run and leaves the Pearl's version and
 * last-good untouched. Fetch failures aren't sent to the model (a transform can't
 * fix a source that is down or gone).
 */
export function createRepairer(services: AgentServices, opts: { model?: LanguageModel; limits?: Partial<AgentLimits> } = {}): Repairer {
  const { pearls, runtime } = services;
  const failed = (pearl: Pearl, reason: string): RepairOutcome => {
    pearls.recordRun(pearl.id, { size: null, ok: false, error: reason, kind: "repair" });
    return { kind: "failed", reason };
  };

  return async (pearl, failure, { sensitive }) => {
    if (failure.stage === "fetch") return failed(pearl, `not attempted, a source failed: ${failure.detail}`);
    const probe = await fetchSources(pearl, {
      resolveAuth: runtime.authResolverFor(pearl.userId),
      fetch: runtime.fetch,
      cache: runtime.cache,
      resolveHost: runtime.resolveHost,
      builtins: runtime.builtins,
    });
    if (!probe.ok) return failed(pearl, `not attempted, source "${probe.error.sourceId}" failed (${probe.error.kind})`);

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
    if (!fix) return failed(pearl, `no passing fix (turn ended: ${endedBy})`);

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
