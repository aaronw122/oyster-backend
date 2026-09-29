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
  /** How long fetchSources caches this builtin's result (e.g. GBFS `ttl`); default 30s. */
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
