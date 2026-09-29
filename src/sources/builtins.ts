import type { z } from "zod";
import { BUILTINS } from "../builtins/index.ts";
import type { AuthCredential, SourceCache } from "./types.ts";

export type BuiltinContext = {
  fetch: typeof fetch;
  auth: AuthCredential | null;
  cache: SourceCache | undefined;
  env: Record<string, string | undefined>;
};

export type Builtin = {
  /** "gbfs" | "weather" | "mta" | "plaid" | "markets" */
  name: string;
  /** Plain language; used by the agent's find_builtin tool. */
  description: string;
  params: z.ZodType<Record<string, string>>;
  /** Set when the builtin needs a provider token. */
  auth?: { provider: string };
  /** plaid → true */
  sensitive?: boolean;
  /**
   * How long fetchSources caches this builtin's NORMALIZED result per params
   * (default 30s); it is the only cache for results. A builtin may also keep a
   * raw upstream cache in `ctx.cache` when one upstream payload serves many
   * params (GBFS feeds across stations, MTA feeds across stops); set `ttlMs`
   * explicitly then, no longer than the raw cache's (expected) lifetime.
   */
  ttlMs?: number;
  /** Returns NORMALIZED plain JSON. */
  fetch(params: Record<string, string>, ctx: BuiltinContext): Promise<unknown>;
  /**
   * Optional plain-language search (e.g. station name → ids) the agent's
   * find_builtin tool calls to fill this builtin's params. Returns plain JSON.
   */
  lookup?: (query: string) => Promise<unknown> | unknown;
};

export function getBuiltin(name: string): Builtin | undefined {
  return BUILTINS.find((builtin) => builtin.name === name);
}

export function listBuiltins(): Builtin[] {
  return [...BUILTINS];
}
