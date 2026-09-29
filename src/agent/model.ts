import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import type { Config } from "../config.ts";

/**
 * The production agent model: OpenRouter, pinned to `config.openrouterModel`
 * (an Anthropic Claude model). `cache_control` turns on Anthropic automatic
 * prompt caching, whose breakpoint advances with the growing conversation; the
 * system prompt carries its own explicit breakpoint (see `runAgentTurn`), and
 * the per-request `session_id` keeps a chat on the provider holding its cache.
 * Null when OPENROUTER_API_KEY is not configured.
 */
export function createAgentModel(config: Config): LanguageModel | null {
  if (!config.openrouterApiKey) return null;
  const openrouter = createOpenRouter({ apiKey: config.openrouterApiKey, appName: "Oyster", compatibility: "strict" });
  return openrouter.chat(config.openrouterModel, { cache_control: { type: "ephemeral" } });
}
