import { isoNow, type Pearl, type PearlData, type SavePearlRequest, SIZES, type Size, type WidgetOutput } from "../contract/index.ts";
import { type Execution, execute, fitFailure, type RunFailure, runDraft, type RuntimeDeps } from "./run.ts";

export type RuntimeError = { code: string; message: string };

const NOT_FOUND: RuntimeError = { code: "not_found", message: "No Pearl with that id belongs to this account." };

/**
 * Saves (creates, or updates `existingId`) only after a passing run where ALL
 * four sizes fit (ENSURE-3). Seeds `lastGood` for every size from that run,
 * marks the Pearl "ok", and records a "save" run. Nothing is persisted on failure.
 */
export async function savePearl(
  userId: string,
  body: SavePearlRequest,
  deps: RuntimeDeps,
  existingId?: string,
): Promise<{ ok: true; pearl: Pearl } | { ok: false; failure: RunFailure } | { ok: false; notFound: true }> {
  if (existingId !== undefined && !deps.pearls.get(userId, existingId)) return { ok: false, notFound: true };
  const run = await runDraft(userId, body, deps);
  if (!run.ok) return { ok: false, failure: run.failure };

  const saved = existingId === undefined ? deps.pearls.create(userId, body) : deps.pearls.update(userId, existingId, body);
  if (!saved) return { ok: false, notFound: true };
  const updatedAt = isoNow();
  for (const size of SIZES) {
    deps.pearls.setLastGood(saved.id, size, { output: run.previews[size], version: saved.version, updatedAt });
  }
  deps.pearls.setStatus(saved.id, "ok");
  deps.pearls.recordRun(saved.id, { size: null, ok: true, kind: "save" });
  return { ok: true, pearl: deps.pearls.getById(saved.id) ?? saved };
}

/**
 * Widget refresh (no LLM): runs the saved Pearl and returns the output for
 * `size`. Success persists `lastGood[size]`; failure (including this size not
 * fitting) returns `lastGood[size]` as stale, or 503 when there is none.
 */
export async function getPearlData(
  userId: string,
  pearlId: string,
  size: Size,
  deps: RuntimeDeps,
): Promise<{ status: 200; body: PearlData } | { status: 404 | 503; error: RuntimeError }> {
  const pearl = deps.pearls.get(userId, pearlId);
  if (!pearl) return { status: 404, error: NOT_FOUND };

  const run = await executeShared(userId, pearl, deps);
  const fit = run.ok ? run.fits[size] : null;
  if (fit?.ok) {
    const updatedAt = isoNow();
    deps.pearls.setLastGood(pearl.id, size, { output: fit.output, version: pearl.version, updatedAt });
    deps.pearls.recordRun(pearl.id, { size, ok: true, kind: "refresh" });
    return { status: 200, body: { pearlId: pearl.id, version: pearl.version, size, output: fit.output, updatedAt, stale: false } };
  }

  const failure = run.ok ? fitFailure(run.fits, [size]) : run.failure;
  if (!failure) throw new Error("unreachable: a size that doesn't fit always has a fit failure");
  deps.pearls.recordRun(pearl.id, { size, ok: false, error: failure.detail, kind: "refresh" });
  deps.onRefreshFailure?.(pearl, failure);

  const lastGood = pearl.lastGood?.[size];
  if (!lastGood) return { status: 503, error: { code: "unavailable", message: failure.message } };
  return {
    status: 200,
    body: { pearlId: pearl.id, version: lastGood.version, size, output: lastGood.output, updatedAt: lastGood.updatedAt, stale: true },
  };
}

/** Live run of the saved Pearl at all sizes for the owner (real values, even for sensitive sources). */
export async function previewPearl(
  userId: string,
  pearlId: string,
  deps: RuntimeDeps,
): Promise<{ ok: true; previews: Record<Size, WidgetOutput> } | { ok: false; failure: RunFailure } | { ok: false; notFound: true }> {
  const pearl = deps.pearls.get(userId, pearlId);
  if (!pearl) return { ok: false, notFound: true };
  const run = await runDraft(userId, pearl, deps);
  deps.pearls.recordRun(pearl.id, run.ok ? { size: null, ok: true, kind: "preview" } : { size: null, ok: false, error: run.failure.detail, kind: "preview" });
  return run.ok ? { ok: true, previews: run.previews } : { ok: false, failure: run.failure };
}

// In-flight refreshes per runtime, keyed by Pearl id + version: a widget burst
// across sizes (or several widgets on one Pearl) shares a single run.
const inFlight = new WeakMap<RuntimeDeps, Map<string, Promise<Execution>>>();

function executeShared(userId: string, pearl: Pearl, deps: RuntimeDeps): Promise<Execution> {
  let runs = inFlight.get(deps);
  if (!runs) {
    runs = new Map();
    inFlight.set(deps, runs);
  }
  const key = `${pearl.id}@${pearl.version}`;
  const existing = runs.get(key);
  if (existing) return existing;
  const started = execute(userId, pearl, deps).finally(() => runs.delete(key));
  runs.set(key, started);
  return started;
}
