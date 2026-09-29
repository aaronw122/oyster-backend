import { createHash, randomUUID } from "node:crypto";
import { type LanguageModel, type ModelMessage, type ToolSet, tool } from "ai";
import { z } from "zod";
import type { Config } from "../config.ts";
import { type ChatEvent, PearlSourceSchema, SIZES } from "../contract/index.ts";
import { createOAuthStartUrl, type OAuthDeps } from "../oauth/index.ts";
import { type DraftPearl, execute, isSensitive, type RunFailure, runDraft, type RuntimeDeps, savePearl } from "../runtime/index.ts";
import { type Builtin, listBuiltins } from "../sources/builtins.ts";
import { guardedGet, type HostResolver, SourceError, summarizeJson } from "../sources/index.ts";
import type { PearlStore } from "../store/pearls.ts";
import { lintUserFacingText } from "./lint.ts";
import { createWebSearch, type WebSearch } from "./search.ts";

export type AgentEvent = ChatEvent;

/** Everything the tools need; built in `src/index.ts` from `AppDeps`. */
export type AgentServices = {
  runtime: RuntimeDeps;
  pearls: PearlStore;
  oauth?: OAuthDeps;
  config: Config;
  /** Network for fetch_json and web_search; defaults to `runtime.fetch`, then global fetch. */
  fetch?: typeof fetch;
  /** DNS override for the fetch_json SSRF guard; defaults to `runtime.resolveHost`, then system DNS. */
  resolveHost?: HostResolver;
  search?: WebSearch;
  /** Agent model; defaults to the OpenRouter model from `config` (tests inject a mock). */
  model?: LanguageModel;
};

export type AgentLimits = { maxSteps: number; maxToolCalls: number; maxFetchProbes: number };
export const DEFAULT_LIMITS: AgentLimits = { maxSteps: 12, maxToolCalls: 24, maxFetchProbes: 4 };

export type EndReason = "ask_user" | "oauth" | "saved" | "unavailable";

/** Mutable per-turn bookkeeping shared by the tools and the loop. */
export type TurnState = {
  toolCalls: number;
  fetchProbes: number;
  /** A tool-call or fetch budget ran out; the loop forces report_unavailable next. */
  exhausted: boolean;
  /** Set by a turn-ending tool; stops the loop after the current step. */
  ended: EndReason | null;
  /** Hashes of drafts the user has seen via preview_pearl (save requires one). */
  previewed: Set<string>;
  /** Previews running in this step; a question asked alongside waits so the user sees the preview first. */
  previewsInFlight: Set<Promise<unknown>>;
};

export function createTurnState(previewed: Iterable<string> = []): TurnState {
  return { toolCalls: 0, fetchProbes: 0, exhausted: false, ended: null, previewed: new Set(previewed), previewsInFlight: new Set() };
}

export type ToolContext = {
  userId: string;
  services: AgentServices;
  emit: (e: ChatEvent) => void;
  limits: AgentLimits;
  mode: "create" | "repair";
  /** Shared with `runAgentTurn`; a fresh one is created when omitted. */
  state?: TurnState;
};

const MAX_DOC_CHARS = 6_000;
const MAX_LOOKUP_CHARS = 6_000;
const LIMIT_REACHED = {
  ok: false,
  error: "Budget for this turn is used up. Call report_unavailable now with a short, plain explanation.",
} as const;

const DraftSchema = z.object({
  sources: z.array(PearlSourceSchema).min(1).describe("Data sources; each sets exactly one of `builtin` or `url`."),
  inputs: z
    .record(z.string(), z.unknown())
    .describe("Values refreshes need (resolved candidate sets, thresholds). Never addresses or search results."),
  transform: z.string().min(1).describe("JS function expression `(sources, inputs, std) => ({ value, subtitle?, items? })`."),
});

const SucceededSchema = z.object({ ok: z.literal(true) });

/** Stable identity of a draft (key order independent) so save can require a matching preview. */
export function draftHash(draft: DraftPearl): string {
  return createHash("sha256")
    .update(stableStringify({ sources: draft.sources, inputs: draft.inputs, transform: draft.transform }))
    .digest("hex");
}

/** Drafts that a successful preview_pearl showed the user earlier in this conversation. */
export function previewedDrafts(history: readonly ModelMessage[]): string[] {
  const previewedCallIds = new Set<string>();
  for (const message of history) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolName !== "preview_pearl") continue;
      if (part.output.type === "json" && SucceededSchema.safeParse(part.output.value).success) {
        previewedCallIds.add(part.toolCallId);
      }
    }
  }
  const hashes: string[] = [];
  for (const message of history) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type !== "tool-call" || !previewedCallIds.has(part.toolCallId)) continue;
      const draft = DraftSchema.safeParse(part.input);
      if (draft.success) hashes.push(draftHash(draft.data));
    }
  }
  return hashes;
}

/**
 * The §3 tool set. Every tool result is what the model sees; values from
 * sensitive sources never appear in it (only shapes, types, and errors). Real
 * preview values reach the app only through the `preview` event.
 * `repair` mode omits the user-facing tools (questions, sign-in, preview, save).
 */
export function createTools(ctx: ToolContext): ToolSet {
  const { userId, services, emit, limits } = ctx;
  const state = ctx.state ?? createTurnState();
  const runtime = services.runtime;
  const builtins = (): readonly Builtin[] => runtime.builtins ?? listBuiltins();
  const doFetch = services.fetch ?? runtime.fetch;
  const search = services.search ?? createWebSearch({ braveApiKey: services.config.braveApiKey, fetch: doFetch });

  /** True for providers whose data is sensitive: any builtin using that provider is marked sensitive. */
  const providerSensitive = (provider: string | undefined) =>
    provider !== undefined && builtins().some((builtin) => builtin.auth?.provider === provider && builtin.sensitive === true);
  const draftSensitive = (draft: DraftPearl) =>
    isSensitive(draft, runtime) || draft.sources.some((source) => providerSensitive(source.auth?.provider));

  /** Counts the call against the tool budget, emits its status, and turns thrown errors into results. */
  const guarded =
    <I, O>(status: string | null, run: (input: I) => Promise<O>) =>
    async (input: I): Promise<O | typeof LIMIT_REACHED | { ok: false; error: string }> => {
      if (state.exhausted) return LIMIT_REACHED;
      state.toolCalls += 1;
      if (state.toolCalls > limits.maxToolCalls) {
        state.exhausted = true;
        return LIMIT_REACHED;
      }
      if (status) emit({ type: "status", text: status });
      try {
        return await run(input);
      } catch (error) {
        console.error("[agent] tool failed", error);
        return { ok: false, error: "Internal error while running this tool." };
      }
    };

  const plainTextProblem = (texts: string[]) => {
    const violations = [...new Set(texts.flatMap(lintUserFacingText))];
    return violations.length === 0
      ? null
      : { ok: false as const, error: `The user must not see ${violations.join(", ")}. Rephrase in plain language.` };
  };

  const failureResult = (failure: RunFailure, sensitive: boolean) => ({
    ok: false as const,
    stage: failure.stage,
    error: sensitive && failure.stage !== "fit" ? maskValues(failure.detail) : failure.detail,
    ...(failure.sizes ? { sizes: failure.sizes } : {}),
  });

  /** Runs the draft and, on success, sends the real previews to the app (never to the model when sensitive). */
  const showPreview = async (draft: DraftPearl) => {
    const sensitive = draftSensitive(draft);
    const run = await runDraft(userId, draft, runtime);
    if (!run.ok) return failureResult(run.failure, sensitive || run.sensitive);
    emit({ type: "preview", previews: run.previews });
    state.previewed.add(draftHash(draft));
    if (sensitive || run.sensitive) {
      return { ok: true, shownToUser: true, sensitive: true, outputShape: summarizeJson(run.output, { redact: true }) };
    }
    return { ok: true, shownToUser: true, previews: run.previews };
  };

  const signInStatus = (provider: string) => ({
    provider,
    available: services.oauth?.providers.has(provider) ?? false,
    connected: services.oauth?.tokens.has(userId, provider) ?? false,
  });

  const discovery: ToolSet = {
    find_builtin: tool({
      description:
        "List Oyster's built-in integrations (purpose, params, output shape, sign-in needs) and the pre-registered sign-in providers. With `builtin` + `query`, search that builtin's catalog (e.g. a station name → stop ids) when it supports lookup.",
      inputSchema: z.object({
        builtin: z.string().optional().describe("Builtin name to describe or search."),
        query: z.string().optional().describe("Plain-language search within `builtin`'s catalog."),
      }),
      execute: guarded(
        "Checking Oyster's built-in sources",
        async ({ builtin: name, query }: { builtin?: string; query?: string }) => {
          const all = builtins();
          const selected = name === undefined ? all : all.filter((builtin) => builtin.name === name);
          if (name !== undefined && selected.length === 0) {
            return { ok: false, error: `No builtin named "${name}". Builtins: ${all.map((b) => b.name).join(", ")}.` };
          }
          if (query !== undefined && name !== undefined) {
            const builtin = selected[0] as Builtin;
            if (!builtin.lookup) return { ok: false, error: `The ${builtin.name} builtin has no lookup.` };
            const results = await builtin.lookup(query);
            return { ok: true, builtin: builtin.name, query, results: capJson(results, MAX_LOOKUP_CHARS) };
          }
          return {
            ok: true,
            builtins: selected.map((builtin) => ({
              name: builtin.name,
              description: builtin.description,
              params: paramsJsonSchema(builtin),
              lookup: builtin.lookup !== undefined,
              ...(builtin.sensitive ? { sensitive: true } : {}),
              ...(builtin.auth ? { signIn: signInStatus(builtin.auth.provider) } : {}),
            })),
            signInProviders: [...(services.oauth?.providers.values() ?? [])].map((adapter) => ({
              id: adapter.id,
              name: adapter.displayName,
              connected: services.oauth?.tokens.has(userId, adapter.id) ?? false,
            })),
          };
        },
      ),
    }),

    web_search: tool({
      description: "Search the web for public APIs and their documentation. Returns titles, URLs, and snippets.",
      inputSchema: z.object({ query: z.string().min(1) }),
      execute: guarded("Searching for a data source", async ({ query }: { query: string }) => {
        try {
          return { ok: true, results: await search(query) };
        } catch (error) {
          return { ok: false, error: `Search failed: ${error instanceof Error ? error.message : String(error)}` };
        }
      }),
    }),

    fetch_json: tool({
      description: `GET a public URL. JSON responses come back as a compressed shape summary (\`path: type = sample\`; samples omitted for sensitive data); HTML/text (e.g. API docs) as readable text. At most ${limits.maxFetchProbes} calls per turn.`,
      inputSchema: z.object({
        url: z.string().min(1).describe("Absolute http(s) URL of a public host."),
        auth: z.string().optional().describe("Sign-in provider id whose token the server should attach."),
        sensitive: z.boolean().optional().describe("True for the user's personal financial data; hides sample values."),
      }),
      execute: guarded(
        "Looking at the data",
        async ({ url, auth: provider, sensitive }: { url: string; auth?: string; sensitive?: boolean }) => {
          state.fetchProbes += 1;
          if (state.fetchProbes > limits.maxFetchProbes) {
            state.exhausted = true;
            return LIMIT_REACHED;
          }
          const credential = provider === undefined ? null : await runtime.authResolverFor(userId)(provider);
          if (provider !== undefined && !credential) {
            return { ok: false, error: `The user hasn't connected ${provider}. Call start_oauth first.` };
          }
          const redact = sensitive === true || providerSensitive(provider);
          const scrub = (text: string) => (credential ? text.split(credential.accessToken).join("[redacted]") : text);
          let body: { text: string; contentType: string };
          try {
            body = await guardedGet(url, credential, { fetch: doFetch, resolveHost: services.resolveHost ?? runtime.resolveHost }, "application/json, text/html;q=0.8, text/plain;q=0.5");
          } catch (error) {
            if (!(error instanceof SourceError)) throw error;
            return { ok: false, kind: error.kind, error: scrub(error.message) };
          }
          let json: unknown;
          try {
            json = JSON.parse(body.text);
          } catch {
            if (redact) return { ok: false, error: "The response was not JSON." };
            return { ok: true, format: "text", contentType: body.contentType, text: readableText(scrub(body.text)) };
          }
          return { ok: true, format: "json", redacted: redact, summary: scrub(summarizeJson(json, { redact })) };
        },
      ),
    }),

    test_pearl: tool({
      description:
        "Run a draft Pearl against live data: fetch sources, run the transform, and check every widget size. Returns the raw output (shape and types only for sensitive data) and any size problems. Nothing is shown to the user.",
      inputSchema: DraftSchema,
      execute: guarded("Testing with live data", async (draft: DraftPearl) => {
        const sensitive = draftSensitive(draft);
        const run = await execute(userId, draft, runtime);
        if (!run.ok) return failureResult(run.failure, sensitive);
        const sizeProblems = SIZES.flatMap((size) => {
          const fit = run.fits[size];
          return fit.ok ? [] : fit.errors;
        });
        return {
          ok: true,
          fitsAllSizes: sizeProblems.length === 0,
          sizeProblems,
          ...(sensitive
            ? { sensitive: true, outputShape: summarizeJson(run.output, { redact: true }) }
            : { output: run.output }),
        };
      }),
    }),

    report_unavailable: tool({
      description:
        "Tell the user plainly that this data isn't available (no built-in, no free keyless public API, key-gated or paid API, not a pre-registered sign-in provider, or out of budget). Ends the turn.",
      inputSchema: z.object({ message: z.string().min(1).describe("One or two plain sentences for the user.") }),
      // Exempt from the tool budget: it is how an exhausted turn ends.
      execute: async ({ message }: { message: string }) => {
        const problem = plainTextProblem([message]);
        if (problem && !state.exhausted) return problem;
        emit({ type: "unavailable", text: problem ? FALLBACK_UNAVAILABLE : message });
        state.ended = "unavailable";
        return { ok: true, shownToUser: true };
      },
    }),
  };

  if (ctx.mode === "repair") return discovery;

  return {
    ask_user: tool({
      description:
        "Ask the user one short follow-up question (location, threshold, which candidate, save or change). Offer 2–6 short options when there are natural choices; the user can always type their own answer. Ends the turn.",
      inputSchema: z.object({
        question: z.string().min(1),
        options: z.array(z.string().min(1)).max(6).optional(),
      }),
      execute: guarded(null, async ({ question, options }: { question: string; options?: string[] }) => {
        const problem = plainTextProblem([question, ...(options ?? [])]);
        if (problem) return problem;
        await Promise.allSettled(state.previewsInFlight);
        emit({ type: "question", id: randomUUID(), text: question, ...(options?.length ? { options } : {}) });
        state.ended = "ask_user";
        return { ok: true, shownToUser: true, note: "Wait for the user's answer." };
      }),
    }),

    ...discovery,

    start_oauth: tool({
      description:
        "Ask the user to sign in with a pre-registered provider so the server can read their data. Only providers listed by find_builtin are possible. Ends the turn; the user will say when they've signed in.",
      inputSchema: z.object({ provider: z.string().min(1).describe("Provider id, e.g. from find_builtin's signInProviders.") }),
      execute: guarded(null, async ({ provider }: { provider: string }) => {
        const adapter = services.oauth?.providers.get(provider);
        if (!services.oauth || !adapter) {
          const available = [...(services.oauth?.providers.keys() ?? [])];
          return {
            ok: false,
            error: `"${provider}" is not a pre-registered sign-in provider. Available: ${available.length ? available.join(", ") : "none"}.`,
          };
        }
        if (services.oauth.tokens.has(userId, provider)) return { ok: true, alreadyConnected: true };
        // The signed start URL goes only to the app; the model never sees it.
        emit({ type: "oauth", provider, url: createOAuthStartUrl(services.config, userId, provider) });
        state.ended = "oauth";
        return { ok: true, shownToUser: true, note: `Sign-in to ${adapter.displayName} offered. Wait for the user.` };
      }),
    }),

    preview_pearl: tool({
      description:
        "Show the user a live preview of the draft at every widget size. Call after test_pearl passes and before save_pearl. Real values go only to the user (you see them only when the data isn't sensitive).",
      inputSchema: DraftSchema,
      execute: guarded("Building a preview", (draft: DraftPearl) => {
        const preview = showPreview(draft);
        state.previewsInFlight.add(preview);
        return preview.finally(() => state.previewsInFlight.delete(preview));
      }),
    }),

    save_pearl: tool({
      description:
        "Save the Pearl under a short name once the user has seen its preview and agreed. The definition must be exactly the one previewed. Pass `pearlId` to update an existing Pearl.",
      inputSchema: DraftSchema.extend({
        name: z.string().min(1).max(60).describe("Short name for the Pearl picker, e.g. \"Office Citi Bike\"."),
        pearlId: z.string().optional(),
      }),
      execute: guarded(
        "Saving your Pearl",
        async ({ name, pearlId, ...draft }: DraftPearl & { name: string; pearlId?: string }) => {
          const problem = plainTextProblem([name]);
          if (problem) return problem;
          if (!state.previewed.has(draftHash(draft))) {
            return {
              ok: false,
              error: "Show the user this exact definition with preview_pearl and get their OK before saving.",
            };
          }
          const result = await savePearl(userId, { name, ...draft }, runtime, pearlId);
          if (!result.ok) {
            if ("notFound" in result) return { ok: false, error: "No saved Pearl with that id belongs to this user." };
            return failureResult(result.failure, draftSensitive(draft));
          }
          emit({ type: "saved", pearl: { id: result.pearl.id, name: result.pearl.name } });
          state.ended = "saved";
          return { ok: true, id: result.pearl.id, name: result.pearl.name, version: result.pearl.version };
        },
      ),
    }),
  };
}

const FALLBACK_UNAVAILABLE = "Sorry — I couldn't find a way to get that data right now.";

/** Masks quoted strings and numbers so an error from a sensitive run can't carry values. */
function maskValues(text: string): string {
  return text.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"…"').replace(/\d+(?:[.,]\d+)*/g, "#");
}

function paramsJsonSchema(builtin: Builtin): unknown {
  try {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(builtin.params, { io: "input", unrepresentable: "any" });
    return schema;
  } catch {
    return "see description";
  }
}

function capJson(value: unknown, maxChars: number): unknown {
  const text = JSON.stringify(value) ?? "null";
  return text.length <= maxChars ? value : `${text.slice(0, maxChars)}… (truncated; narrow the query)`;
}

/** Visible text of an HTML/text document, whitespace-collapsed and capped. */
function readableText(raw: string): string {
  const text = raw
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|pre|br)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return text.length <= MAX_DOC_CHARS ? text : `${text.slice(0, MAX_DOC_CHARS)}… (truncated)`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
