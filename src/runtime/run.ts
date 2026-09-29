import { type Pearl, SIZES, type Size, type WidgetOutput } from "../contract/index.ts";
import { fitAllSizes, type FitResult, runTransform } from "../sandbox/index.ts";
import { type Builtin, getBuiltin, listBuiltins } from "../sources/builtins.ts";
import {
  type AuthResolver,
  fetchSources,
  type HostResolver,
  type SourceCache,
  type SourceErrorKind,
} from "../sources/index.ts";
import type { PearlStore } from "../store/pearls.ts";

export type DraftPearl = Pick<Pearl, "sources" | "inputs" | "transform">;

/**
 * Why a run failed. `message` is plain language for people (no JSON, endpoints,
 * or code). `detail` is the technical cause for the agent/repair LLM and logs;
 * it never contains credentials (fetchSources redacts tokens).
 */
export type RunFailure = { stage: "fetch" | "transform" | "fit"; message: string; detail: string; sizes?: Size[] };

/** A failed run. `output` is the raw transform output when only the fit stage failed, so the agent can see what overflowed. */
export type DraftRun =
  | { ok: true; output: WidgetOutput; previews: Record<Size, WidgetOutput>; sensitive: boolean }
  | { ok: false; failure: RunFailure; sensitive: boolean; output?: WidgetOutput };

export type RuntimeDeps = {
  pearls: PearlStore;
  /** OAuth token lookup per user; `nullAuthResolverFor` until OAuth is wired. */
  authResolverFor: (userId: string) => AuthResolver;
  /** Shared across requests so a widget burst doesn't refetch every source. */
  cache: SourceCache;
  fetch?: typeof fetch;
  /**
   * Repair hook: called (asynchronously, errors swallowed) for each failed refresh
   * of the Pearl's current version. `sensitive` tells repair to redact source data.
   */
  onRefreshFailure?: (pearl: Pearl, failure: RunFailure, ctx: { sensitive: boolean }) => void;
  /** Transform time limit per run; the sandbox default (250ms) is too tight under load. */
  sandboxTimeoutMs?: number;
  /** SSRF-guard DNS override (tests); defaults to system DNS. */
  resolveHost?: HostResolver;
  /** Builtin registry override (tests); defaults to the shared registry. */
  builtins?: readonly Builtin[];
};

export const nullAuthResolverFor = (_userId: string): AuthResolver => async () => null;

/** Result of fetch + transform, before a size is chosen. Fit is computed for every size. */
export type Execution =
  | { ok: true; output: WidgetOutput; fits: Record<Size, FitResult> }
  | { ok: false; failure: RunFailure };

/** Runs a Pearl definition (no LLM): fetch sources → sandbox transform → per-size fit. */
export async function execute(userId: string, draft: DraftPearl, deps: RuntimeDeps): Promise<Execution> {
  const fetched = await fetchSources(draft, {
    resolveAuth: deps.authResolverFor(userId),
    fetch: deps.fetch,
    cache: deps.cache,
    resolveHost: deps.resolveHost,
    builtins: deps.builtins,
  });
  if (!fetched.ok) {
    const { sourceId, kind, message } = fetched.error;
    return {
      ok: false,
      failure: { stage: "fetch", message: fetchMessage(kind), detail: `source "${sourceId}" failed (${kind}): ${message}` },
    };
  }

  const transformed = await runTransform(draft.transform, fetched.data, draft.inputs, { timeoutMs: deps.sandboxTimeoutMs });
  if (!transformed.ok) {
    const { kind, message } = transformed.error;
    return {
      ok: false,
      failure: {
        stage: "transform",
        message: "The widget couldn't make sense of the latest data.",
        detail: `transform failed (${kind}): ${message}`,
      },
    };
  }
  return { ok: true, output: transformed.output, fits: fitAllSizes(transformed.output) };
}

/** Failure for sizes whose output doesn't fit, or null if every listed size fits. */
export function fitFailure(fits: Record<Size, FitResult>, sizes: readonly Size[]): RunFailure | null {
  const failed = sizes.filter((size) => !fits[size].ok);
  if (failed.length === 0) return null;
  const errors = failed.flatMap((size) => {
    const fit = fits[size];
    return fit.ok ? [] : fit.errors;
  });
  const names = failed.map((size) => SIZE_NAMES[size]).join(", ");
  return {
    stage: "fit",
    message: `The result is too long to fit the ${names} widget${failed.length > 1 ? " sizes" : " size"}.`,
    detail: `output does not fit: ${errors.join("; ")}`,
    sizes: failed,
  };
}

/** Test-runs a draft; succeeds only when all four sizes fit (previews are the projected outputs). */
export async function runDraft(userId: string, draft: DraftPearl, deps: RuntimeDeps): Promise<DraftRun> {
  const sensitive = isSensitive(draft, deps);
  const run = await execute(userId, draft, deps);
  if (!run.ok) return { ok: false, failure: run.failure, sensitive };
  const failure = fitFailure(run.fits, SIZES);
  if (failure) return { ok: false, failure, output: run.output, sensitive };
  const previews = Object.fromEntries(
    SIZES.map((size) => {
      const fit = run.fits[size];
      if (!fit.ok) throw new Error("unreachable: every size fits");
      return [size, fit.output];
    }),
  ) as Record<Size, WidgetOutput>;
  return { ok: true, output: run.output, previews, sensitive };
}

/**
 * The single sensitivity rule: a source is sensitive when it is marked
 * sensitive, uses a builtin marked sensitive (e.g. Plaid), or authenticates with
 * a sensitive sign-in provider.
 */
export function isSensitive(draft: Pick<DraftPearl, "sources">, deps: Pick<RuntimeDeps, "builtins">): boolean {
  return draft.sources.some((source) => {
    if (source.sensitive === true) return true;
    if (source.builtin !== undefined) {
      const builtin = deps.builtins
        ? deps.builtins.find((candidate) => candidate.name === source.builtin)
        : getBuiltin(source.builtin);
      if (builtin?.sensitive === true) return true;
    }
    return isSensitiveProvider(source.auth?.provider, deps);
  });
}

/** True for sign-in providers whose data is sensitive: some builtin using that provider is marked sensitive. */
export function isSensitiveProvider(provider: string | undefined, deps: Pick<RuntimeDeps, "builtins">): boolean {
  if (provider === undefined) return false;
  return (deps.builtins ?? listBuiltins()).some((builtin) => builtin.auth?.provider === provider && builtin.sensitive === true);
}

const SIZE_NAMES: Record<Size, string> = {
  inline: "lock screen (one line)",
  rectangular: "lock screen",
  small: "small",
  medium: "medium",
};

function fetchMessage(kind: SourceErrorKind): string {
  switch (kind) {
    case "auth_missing":
      return "This widget needs you to connect (or reconnect) the account it reads from.";
    case "http":
    case "network":
      return "Couldn't reach the service this widget gets its data from.";
    case "parse":
      return "The service this widget reads from sent back something unexpected.";
    case "template":
    case "forbidden_url":
    case "unknown_builtin":
    case "invalid_params":
      return "This widget's data source isn't set up correctly.";
  }
}
