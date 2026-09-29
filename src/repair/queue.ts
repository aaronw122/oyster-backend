import type { Pearl } from "../contract/index.ts";
import type { RunFailure } from "../runtime/index.ts";
import type { PearlStore } from "../store/pearls.ts";
import type { Repairer } from "./worker.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type RepairQueueOptions = {
  pearls: PearlStore;
  repair: Repairer;
  /** Clock (ms); injectable for tests. */
  now?: () => number;
  /** Wait after the 1st, 2nd, 3rd… consecutive failed attempt (the last entry repeats). */
  backoffMs?: readonly number[];
  /** Attempts per Pearl in any rolling 24h; once reached, the Pearl stays "broken" until the oldest ages out. */
  maxAttemptsPerDay?: number;
  /** Repairs running at once across all Pearls; failures beyond this wait for a later refresh failure. */
  maxConcurrent?: number;
};

export const DEFAULT_REPAIR_BACKOFF_MS = [5 * MINUTE, HOUR, 6 * HOUR] as const;

type Attempts = { startedAt: number[]; consecutiveFailures: number; nextAttemptAt: number };

/**
 * In-process background repair (§5, B7), fed by the runtime's refresh-failure
 * hook. At most one repair per Pearl is in flight, so a widget burst (all four
 * sizes failing together) triggers one repair. Retries ride on later refresh
 * failures, so a Pearl nobody is looking at never spends model calls: each failed
 * attempt pushes the next one out (5m → 1h → 6h by default). Every attempt that
 * reaches the model counts toward `maxAttemptsPerDay`, successful or not, so a
 * source that keeps flipping shape can't buy unlimited repairs. Failing sources
 * (fetch failures) never reach the model and cost nothing. Status: "repairing"
 * while an attempt runs, "ok" once a fix ships, "broken" while failing without one.
 */
export class RepairQueue {
  readonly #pearls: PearlStore;
  readonly #repair: Repairer;
  readonly #now: () => number;
  readonly #backoffMs: readonly number[];
  readonly #maxAttemptsPerDay: number;
  readonly #maxConcurrent: number;
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #attempts = new Map<string, Attempts>();

  constructor(opts: RepairQueueOptions) {
    this.#pearls = opts.pearls;
    this.#repair = opts.repair;
    this.#now = opts.now ?? Date.now;
    this.#backoffMs = opts.backoffMs ?? DEFAULT_REPAIR_BACKOFF_MS;
    this.#maxAttemptsPerDay = opts.maxAttemptsPerDay ?? 4;
    this.#maxConcurrent = opts.maxConcurrent ?? 2;
    if (this.#backoffMs.length === 0) throw new Error("RepairQueue: backoffMs needs at least one entry");
  }

  /** Handles one failed refresh of `pearl`'s current version. True when it started a repair. */
  enqueue(pearl: Pearl, failure: RunFailure, ctx: { sensitive: boolean }): boolean {
    if (this.#inFlight.has(pearl.id)) return false;
    if (failure.stage === "fetch") {
      if (pearl.status !== "broken") this.#pearls.setStatus(pearl.id, "broken");
      return false;
    }
    const now = this.#now();
    const attempts = this.#attempts.get(pearl.id) ?? { startedAt: [], consecutiveFailures: 0, nextAttemptAt: 0 };
    attempts.startedAt = attempts.startedAt.filter((startedAt) => now - startedAt < DAY);
    const allowed =
      now >= attempts.nextAttemptAt &&
      attempts.startedAt.length < this.#maxAttemptsPerDay &&
      this.#inFlight.size < this.#maxConcurrent;
    if (!allowed) {
      if (pearl.status !== "broken") this.#pearls.setStatus(pearl.id, "broken");
      return false;
    }

    attempts.startedAt.push(now);
    this.#attempts.set(pearl.id, attempts);
    this.#pearls.setStatus(pearl.id, "repairing");
    const job = this.#run(pearl, failure, ctx, attempts, now).finally(() => this.#inFlight.delete(pearl.id));
    this.#inFlight.set(pearl.id, job);
    return true;
  }

  /** Resolves once every repair in flight has settled (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.all(this.#inFlight.values());
  }

  async #run(pearl: Pearl, failure: RunFailure, ctx: { sensitive: boolean }, attempts: Attempts, startedAt: number): Promise<void> {
    try {
      const outcome = await this.#repair(pearl, failure, ctx).catch((error: unknown) => {
        console.error(`[repair] attempt crashed for Pearl ${pearl.id}`, error);
        this.#pearls.recordRun(pearl.id, { size: null, ok: false, error: "repair attempt crashed", kind: "repair" });
        return { kind: "failed" as const, reason: "crashed" };
      });
      if (outcome.kind === "skipped") {
        // No model call was made: refund the attempt and leave the backoff alone.
        const index = attempts.startedAt.lastIndexOf(startedAt);
        if (index >= 0) attempts.startedAt.splice(index, 1);
        this.#pearls.setStatus(pearl.id, "broken");
        return;
      }
      if (outcome.kind === "repaired" || outcome.kind === "superseded") {
        // The daily cap still counts this attempt; only the failure backoff resets.
        attempts.consecutiveFailures = 0;
        attempts.nextAttemptAt = 0;
        // A superseding definition (save, rollback) hasn't failed yet.
        if (outcome.kind === "superseded" && this.#pearls.getById(pearl.id)?.status === "repairing") {
          this.#pearls.setStatus(pearl.id, "ok");
        }
        return;
      }
      attempts.consecutiveFailures += 1;
      const backoff = this.#backoffMs[Math.min(attempts.consecutiveFailures, this.#backoffMs.length) - 1] ?? 0;
      attempts.nextAttemptAt = this.#now() + backoff;
      this.#pearls.setStatus(pearl.id, "broken");
    } catch (error) {
      console.error(`[repair] bookkeeping failed for Pearl ${pearl.id}`, error);
    }
  }
}
