import type { Pearl, PearlSource } from "../contract/index.ts";
import { type Builtin, type BuiltinContext, getBuiltin } from "./builtins.ts";
import { fillInputs, fillTemplate } from "./template.ts";
import { assertPublicUrl, type HostResolver, resolveHostWithDns } from "./url-guard.ts";
import {
  type ApiOriginsLookup,
  type AuthCredential,
  type AuthResolver,
  DEFAULT_MAX_SOURCE_BYTES,
  type SourceCache,
  SourceError,
  type SourceErrorKind,
} from "./types.ts";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;

export type FetchSourcesResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: { sourceId: string; kind: SourceErrorKind; message: string } };

export type FetchSourcesDeps = {
  resolveAuth: AuthResolver;
  fetch?: typeof fetch;
  cache?: SourceCache;
  defaultTtlMs?: number;
  /** Per-request timeout for URL sources; default 8s. */
  timeoutMs?: number;
  /** Response body cap in bytes for URL sources; default `DEFAULT_MAX_SOURCE_BYTES`. */
  maxBytes?: number;
  /** DNS resolver for the URL-source SSRF guard; defaults to system DNS. */
  resolveHost?: HostResolver;
  /** Where each sign-in provider's credential may go; without it every signed-in URL source is refused. */
  apiOrigins?: ApiOriginsLookup;
  /** Builtin lookup override (tests); defaults to the shared registry. */
  builtins?: readonly Builtin[];
  /** Env passed to builtins; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
};

type SourceOutcome = { ok: true; value: unknown } | { ok: false; kind: SourceErrorKind; message: string };

/**
 * Fetches every source of a Pearl concurrently. On success `data` is keyed by
 * source id. On failure the first failing source (in declaration order) is
 * reported; error messages never contain credentials.
 */
export async function fetchSources(
  pearl: Pick<Pearl, "sources" | "inputs">,
  deps: FetchSourcesDeps,
): Promise<FetchSourcesResult> {
  const outcomes = await Promise.all(pearl.sources.map((source) => fetchSource(source, pearl.inputs, deps)));
  const data: Record<string, unknown> = {};
  for (const [index, outcome] of outcomes.entries()) {
    const sourceId = pearl.sources[index]!.id;
    if (!outcome.ok) return { ok: false, error: { sourceId, kind: outcome.kind, message: outcome.message } };
    data[sourceId] = outcome.value;
  }
  return { ok: true, data };
}

async function fetchSource(
  source: PearlSource,
  inputs: Record<string, unknown>,
  deps: FetchSourcesDeps,
): Promise<SourceOutcome> {
  let auth: AuthCredential | null = null;
  try {
    const builtin = source.builtin === undefined ? undefined : lookupBuiltin(source.builtin, deps);
    const url = builtin || source.url === undefined ? undefined : fillTemplate(source.url, inputs);
    const provider = builtin ? builtin.auth?.provider : source.auth?.provider;
    if (provider !== undefined) {
      // A model-chosen URL never gets a credential its provider's API doesn't own.
      if (url !== undefined) assertCredentialTarget(url, provider, deps.apiOrigins);
      auth = await deps.resolveAuth(provider);
      if (!auth) throw new SourceError("auth_missing", `no ${provider} credential; the user must connect ${provider}`);
    }

    let target: string;
    let load: () => Promise<unknown>;
    if (builtin) {
      const params = resolveBuiltinParams(builtin, source.params ?? {}, inputs);
      const ctx = { fetch: deps.fetch ?? fetch, auth, cache: deps.cache, env: deps.env ?? process.env };
      target = `builtin:${builtin.name}:${JSON.stringify(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)))}`;
      load = () => runBuiltin(builtin, params, ctx);
    } else if (url !== undefined) {
      target = `url:${url}`;
      load = () => getJson(url, auth, deps);
    } else {
      throw new SourceError("template", "source has neither `url` nor `builtin`");
    }

    // Cache identity includes a token fingerprint so two users of one provider
    // never share cached data; the token itself never enters the key.
    const identity = auth
      ? `${auth.provider}:${new Bun.CryptoHasher("sha256").update(auth.accessToken).digest("hex").slice(0, 16)}`
      : "none";
    const key = `${target}|auth:${identity}`;
    const cached = deps.cache?.get(key);
    if (cached !== undefined) return { ok: true, value: cached };
    const value = await load();
    deps.cache?.set(key, value, builtin?.ttlMs ?? deps.defaultTtlMs ?? DEFAULT_TTL_MS);
    return { ok: true, value };
  } catch (error) {
    const kind = error instanceof SourceError ? error.kind : "network";
    const raw = error instanceof Error ? error.message : String(error);
    const message = auth?.accessToken ? raw.split(auth.accessToken).join("[redacted]") : raw;
    return { ok: false, kind, message };
  }
}

function lookupBuiltin(name: string, deps: FetchSourcesDeps): Builtin {
  const builtin = deps.builtins ? deps.builtins.find((candidate) => candidate.name === name) : getBuiltin(name);
  if (!builtin) throw new SourceError("unknown_builtin", `no builtin named "${name}"`);
  return builtin;
}

function resolveBuiltinParams(
  builtin: Builtin,
  rawParams: Record<string, string>,
  inputs: Record<string, unknown>,
): Record<string, string> {
  const filled: Record<string, string> = {};
  for (const [name, template] of Object.entries(rawParams)) {
    filled[name] = fillInputs(template, inputs, (value) => value);
  }
  const parsed = builtin.params.safeParse(filled);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`);
    throw new SourceError("invalid_params", `invalid params for builtin "${builtin.name}": ${problems.join("; ")}`);
  }
  return parsed.data;
}

async function runBuiltin(
  builtin: Builtin,
  params: Record<string, string>,
  ctx: BuiltinContext,
): Promise<unknown> {
  try {
    return await builtin.fetch(params, ctx);
  } catch (error) {
    if (error instanceof SourceError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new SourceError("network", `builtin "${builtin.name}" failed: ${message}`);
  }
}

async function getJson(url: string, auth: AuthCredential | null, deps: FetchSourcesDeps): Promise<unknown> {
  const { text } = await guardedGet(url, auth, deps);
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError("parse", `GET ${url} did not return valid JSON`);
  }
}

export type GuardedGetDeps = Pick<FetchSourcesDeps, "fetch" | "timeoutMs" | "resolveHost" | "maxBytes">;

/**
 * Throws `forbidden_url` unless `url` is https on one of `provider`'s API
 * origins. Call it before resolving the credential, so a token is never even
 * loaded for a host its provider doesn't own.
 */
export function assertCredentialTarget(url: string, provider: string, apiOrigins: ApiOriginsLookup | undefined): void {
  const origins = apiOrigins?.(provider);
  if (!origins) throw new SourceError("forbidden_url", `"${provider}" is not a sign-in provider, so no sign-in can be sent`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SourceError("forbidden_url", `"${url}" is not a valid URL`);
  }
  if (parsed.protocol !== "https:" || !origins.includes(parsed.origin)) {
    throw new SourceError("forbidden_url", `the ${provider} sign-in is only sent over https to ${origins.join(", ")}`);
  }
}

/**
 * SSRF-guarded GET (every redirect hop must be a public host) with one deadline
 * for all hops and the body, and a body cap (`maxBytes`). `auth` is sent only to
 * the original origin; a 401/403 to a request that carried it is `auth_missing`.
 * Throws `SourceError`; messages never contain the credential.
 */
export async function guardedGet(
  url: string,
  auth: AuthCredential | null,
  deps: GuardedGetDeps,
  accept = "application/json",
): Promise<{ text: string; contentType: string }> {
  const resolveHost = deps.resolveHost ?? resolveHostWithDns;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Explicit controller + ref'd timer: one deadline covers every redirect hop
  // and the body, and fires even when nothing else keeps the event loop alive.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let target = await assertPublicUrl(url, resolveHost);
    const authOrigin = target.origin;
    let response: Response;
    /** The credential on the latest request (null once a redirect leaves the original origin). */
    let sentAuth: AuthCredential | null;
    for (let redirects = 0; ; redirects++) {
      const headers: Record<string, string> = { Accept: accept };
      // Like browsers, never forward the credential to a different origin.
      sentAuth = target.origin === authOrigin ? auth : null;
      if (sentAuth) headers.Authorization = `Bearer ${sentAuth.accessToken}`;
      response = await (deps.fetch ?? fetch)(target.href, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (location === null) break;
      await response.body?.cancel();
      if (redirects === MAX_REDIRECTS) throw new SourceError("http", `GET ${url} redirected more than ${MAX_REDIRECTS} times`);
      target = await assertPublicUrl(new URL(location, target).href, resolveHost);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (sentAuth && (response.status === 401 || response.status === 403)) {
        throw new SourceError("auth_missing", `GET ${url} returned HTTP ${response.status}: the ${sentAuth.provider} sign-in was refused`);
      }
      throw new SourceError("http", `GET ${url} returned HTTP ${response.status}`);
    }
    const text = await readCapped(response, deps.maxBytes ?? DEFAULT_MAX_SOURCE_BYTES, url);
    return { text, contentType: response.headers.get("content-type") ?? "" };
  } catch (error) {
    if (error instanceof SourceError) throw error;
    if (controller.signal.aborted) throw new SourceError("network", `GET ${url} timed out after ${timeoutMs}ms`);
    const message = error instanceof Error ? error.message : String(error);
    throw new SourceError("network", `GET ${url} failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** The body as UTF-8 text, refusing a declared or streamed size over `maxBytes` without buffering past it. */
async function readCapped(response: Response, maxBytes: number, url: string): Promise<string> {
  const tooLarge = () => new SourceError("too_large", `GET ${url} returned more than the ${maxBytes}-byte limit`);
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks, total));
}
