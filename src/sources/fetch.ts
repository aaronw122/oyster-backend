import type { Pearl, PearlSource } from "../contract/index.ts";
import { type Builtin, type BuiltinContext, getBuiltin } from "./builtins.ts";
import { fillInputs, fillTemplate } from "./template.ts";
import { assertPublicUrl, type HostResolver, resolveHostWithDns } from "./url-guard.ts";
import { type AuthCredential, type AuthResolver, type SourceCache, SourceError, type SourceErrorKind } from "./types.ts";

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
  /** DNS resolver for the URL-source SSRF guard; defaults to system DNS. */
  resolveHost?: HostResolver;
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
    const provider = builtin ? builtin.auth?.provider : source.auth?.provider;
    if (provider !== undefined) {
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
    } else if (source.url !== undefined) {
      const url = fillTemplate(source.url, inputs);
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
    deps.cache?.set(key, value, deps.defaultTtlMs ?? DEFAULT_TTL_MS);
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
  const resolveHost = deps.resolveHost ?? resolveHostWithDns;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Explicit controller + ref'd timer: one deadline covers every redirect hop
  // and the body, and fires even when nothing else keeps the event loop alive.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text: string;
  try {
    let target = await assertPublicUrl(url, resolveHost);
    const authOrigin = target.origin;
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      const headers: Record<string, string> = { Accept: "application/json" };
      // Like browsers, never forward the credential to a different origin.
      if (auth && target.origin === authOrigin) headers.Authorization = `Bearer ${auth.accessToken}`;
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
      throw new SourceError("http", `GET ${url} returned HTTP ${response.status}`);
    }
    text = await response.text();
  } catch (error) {
    if (error instanceof SourceError) throw error;
    if (controller.signal.aborted) throw new SourceError("network", `GET ${url} timed out after ${timeoutMs}ms`);
    const message = error instanceof Error ? error.message : String(error);
    throw new SourceError("network", `GET ${url} failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError("parse", `GET ${url} did not return valid JSON`);
  }
}
