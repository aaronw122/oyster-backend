// Types shared by the source fetcher and the builtin registry. Kept in a
// leaf module so builtins can import them without a runtime import cycle.

export type AuthCredential = { provider: string; accessToken: string };
export type AuthResolver = (provider: string) => Promise<AuthCredential | null>;
/**
 * The https origins (`https://host[:port]`) a sign-in provider's credential may
 * be sent to; undefined for a provider that isn't registered.
 */
export type ApiOriginsLookup = (provider: string) => readonly string[] | undefined;

/** Default cap on a URL source's or probe's response body (5 MiB); MAX_SOURCE_BYTES overrides it. */
export const DEFAULT_MAX_SOURCE_BYTES = 5_242_880;

export interface SourceCache {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown, ttlMs: number): void;
}

export type SourceErrorKind =
  | "template"
  | "forbidden_url"
  | "auth_missing"
  | "http"
  | "network"
  | "parse"
  | "unknown_builtin"
  | "invalid_params"
  | "too_large";

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
