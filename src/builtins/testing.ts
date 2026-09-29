// Test-only helpers shared by the builtin suites: a recording fake network, a
// builtin context, SourceError capture, and the example-Pearl pipeline
// (fetchSources → runTransform → every size must fit).
import { expect } from "bun:test";
import { type Pearl, SIZES, type WidgetOutput } from "../contract/index.ts";
import { fitAllSizes, runTransform } from "../sandbox/index.ts";
import type { Builtin, BuiltinContext } from "../sources/builtins.ts";
import { fetchSources, SourceError } from "../sources/index.ts";

export type FetchCall = { url: URL; headers: Headers };

/** A fake `fetch` that records every request and answers with `respond`. */
export function recordingFetch(respond: (url: URL) => Response | Promise<Response>): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, headers: new Headers(init?.headers) });
    return respond(url);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export const json = (body: unknown, status = 200) => Response.json(body, { status });

/** A fetch that always fails the way an unreachable host does. */
export const offlineFetch = (async () => {
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch;

export function builtinContext(fetchFn: typeof fetch, overrides: Partial<BuiltinContext> = {}): BuiltinContext {
  return { fetch: fetchFn, auth: null, cache: undefined, env: {}, ...overrides };
}

/** Awaits `promise`, which must reject with a SourceError (of `kind`, when given). */
export async function sourceError(promise: Promise<unknown>, kind?: SourceError["kind"]): Promise<SourceError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof SourceError)) throw new Error(`expected SourceError, got ${String(error)}`);
  if (kind !== undefined) expect(error.kind).toBe(kind);
  return error;
}

export function expectFitsAllSizes(output: WidgetOutput): void {
  const fits = fitAllSizes(output);
  for (const size of SIZES) expect({ size, ok: fits[size].ok }).toEqual({ size, ok: true });
}

type Example = Pick<Pearl, "sources" | "inputs" | "transform">;
type ExampleDeps = { fetch: typeof fetch; builtins?: readonly Builtin[]; env?: Record<string, string | undefined> };

/** Runs an example Pearl end to end against a fake network and asserts it fits every size. */
export async function renderExample(example: Example, deps: ExampleDeps, inputs: Record<string, unknown> = example.inputs) {
  const fetched = await fetchSources({ sources: example.sources, inputs }, { resolveAuth: async () => null, env: {}, ...deps });
  if (!fetched.ok) throw new Error(fetched.error.message);
  const run = await runTransform(example.transform, fetched.data, inputs);
  if (!run.ok) throw new Error(run.error.message);
  expectFitsAllSizes(run.output);
  return run.output;
}
