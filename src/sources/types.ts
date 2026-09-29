// Types shared by the source fetcher and the builtin registry. Kept in a
// leaf module so builtins can import them without a runtime import cycle.

export type AuthCredential = { provider: string; accessToken: string };
export type AuthResolver = (provider: string) => Promise<AuthCredential | null>;

export interface SourceCache {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown, ttlMs: number): void;
}

export type SourceErrorKind =
  | "template"
  | "auth_missing"
  | "http"
  | "network"
  | "parse"
  | "unknown_builtin"
  | "invalid_params";

/**
 * Typed failure a source (or a builtin's `fetch`) can throw to report a
 * specific kind. Anything else a builtin throws is reported as `network`.
 */
export class SourceError extends Error {
  constructor(
    readonly kind: SourceErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "SourceError";
  }
}
