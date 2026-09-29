// Test-only helpers: a scripted mock language model and an in-memory agent
// environment (no network, no real LLM).
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { loadConfig } from "../config.ts";
import type { ChatEvent } from "../contract/index.ts";
import { type Database, openDb } from "../db/index.ts";
import { OAuthTokenStore, type OAuthProviderAdapter } from "../oauth/index.ts";
import type { RuntimeDeps } from "../runtime/index.ts";
import type { Builtin } from "../sources/builtins.ts";
import { PearlStore } from "../store/pearls.ts";
import { UserStore } from "../store/users.ts";
import type { AgentServices } from "./tools.ts";

/** One model step: optional prose, then optional tool calls. */
export type ScriptStep = { text?: string; calls?: Array<{ tool: string; input: unknown }> };
export type Script = ScriptStep[] | ((index: number, options: LanguageModelV4CallOptions) => ScriptStep);

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

/** A mock model that plays `script` one step per model call (the last array entry repeats). */
export function scriptedModel(script: Script): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async (options) => {
      const step = typeof script === "function" ? script(index, options) : (script[Math.min(index, script.length - 1)] ?? {});
      index += 1;
      const chunks: LanguageModelV4StreamPart[] = [];
      if (step.text !== undefined) {
        chunks.push({ type: "text-start", id: `t${index}` });
        // Split into small deltas so streaming/filtering is exercised.
        for (const piece of step.text.match(/[\s\S]{1,7}/g) ?? []) chunks.push({ type: "text-delta", id: `t${index}`, delta: piece });
        chunks.push({ type: "text-end", id: `t${index}` });
      }
      for (const [callIndex, call] of (step.calls ?? []).entries()) {
        chunks.push({
          type: "tool-call",
          toolCallId: `call-${index}-${callIndex}`,
          toolName: call.tool,
          input: JSON.stringify(call.input),
        });
      }
      chunks.push({
        type: "finish",
        finishReason: { unified: step.calls?.length ? "tool-calls" : "stop", raw: undefined },
        usage: USAGE,
      });
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

/** Everything the model was sent across all calls, serialized — for "the model never saw X" assertions. */
export function modelVisible(model: MockLanguageModelV4): string {
  return JSON.stringify(model.doStreamCalls.map((call) => call.prompt));
}

/** Tool results (by tool name) that were sent back to the model. */
export function toolResultsSeen(model: MockLanguageModelV4, toolName: string): unknown[] {
  const last = model.doStreamCalls.at(-1)?.prompt ?? [];
  return last.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) => (part.type === "tool-result" && part.toolName === toolName ? [part.output] : []))
      : [],
  );
}

export const TEST_CONFIG = loadConfig({ NODE_ENV: "test", PUBLIC_BASE_URL: "https://oyster.test" });

/** A sensitive, sign-in-backed builtin (Plaid-like) whose real values must never reach the model. */
export const bankBuiltin: Builtin = {
  name: "bank",
  description: "Bank balances. Params: none. Returns { accounts: [{ name, current }] }.",
  params: z.object({}),
  auth: { provider: "bank" },
  sensitive: true,
  fetch: async () => ({ accounts: [{ name: "Everyday Checking", current: 4821.37 }] }),
};

export const bankAdapter: OAuthProviderAdapter = {
  id: "bank",
  displayName: "your bank",
  authorizeUrl: async () => "https://bank.example/authorize",
  exchange: async () => ({ accessToken: "unused" }),
};

export type TestEnv = {
  services: AgentServices;
  users: UserStore;
  pearls: PearlStore;
  db: Database;
  /** JSON the fake network returns for any URL; mutate between steps. */
  payload: { current: unknown };
  fetched: string[];
  events: ChatEvent[];
  emit: (event: ChatEvent) => void;
};

/** In-memory DB + stores, fake network (every public host resolves; every GET returns `payload`), the bank builtin. */
export function createTestEnv(): TestEnv {
  const db = openDb(":memory:");
  const pearls = new PearlStore(db);
  const users = new UserStore(db);
  const payload = { current: { temp: 72 } as unknown };
  const fetched: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    return Response.json(payload.current);
  }) as unknown as typeof fetch;
  const providers = new Map([[bankAdapter.id, bankAdapter]]);
  const tokens = new OAuthTokenStore(db, TEST_CONFIG.tokenEncryptionKey, providers);
  const runtime: RuntimeDeps = {
    pearls,
    authResolverFor: (userId) => tokens.resolverFor(userId),
    // No caching: tests change `payload` between steps and expect the next run to see it.
    cache: { get: () => undefined, set: () => undefined },
    fetch: fakeFetch,
    resolveHost: async () => ["203.0.113.10"],
    builtins: [bankBuiltin],
  };
  const events: ChatEvent[] = [];
  return {
    services: {
      runtime,
      pearls,
      oauth: { providers, tokens },
      config: TEST_CONFIG,
      search: async () => [],
    },
    users,
    pearls,
    db,
    payload,
    fetched,
    events,
    emit: (event) => events.push(event),
  };
}
