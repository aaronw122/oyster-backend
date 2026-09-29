import { isStepCount, type LanguageModel, type ModelMessage, streamText } from "ai";
import type { ChatEvent } from "../contract/index.ts";
import { createProseFilter } from "./lint.ts";
import { createAgentModel } from "./model.ts";
import {
  type AgentLimits,
  type AgentServices,
  createTools,
  createTurnState,
  DEFAULT_LIMITS,
  type EndReason,
  previewedDrafts,
} from "./tools.ts";

export type TurnEnd = EndReason | "text" | "limit" | "error";

const LIMIT_TEXT = "Sorry — I couldn't find a way to get that data within my limits. Try asking for something more specific.";
const ERROR_TEXT = "Something went wrong on my side. Please try again.";
const NO_MODEL_TEXT = "The assistant isn't set up on this server yet.";
// OpenRouter caps session_id at 256 characters.
const MAX_SESSION_ID = 256;

/**
 * Runs one user message through the agent loop, streaming `ChatEvent`s via
 * `emit` (prose as filtered `text` deltas, plus tool events). Returns the full
 * conversation to persist (history + this message + completed steps) and why the
 * turn ended. Never throws: model/transport failures emit an `error` event.
 * Budgets (steps, tool calls, fetch probes) that run out force report_unavailable.
 */
export async function runAgentTurn(opts: {
  userId: string;
  sessionId: string;
  system: string;
  history: ModelMessage[];
  userMessage: string;
  services: AgentServices;
  emit: (e: ChatEvent) => void;
  limits?: Partial<AgentLimits>;
  model?: LanguageModel;
  mode?: "create" | "repair";
  abortSignal?: AbortSignal;
}): Promise<{ messages: ModelMessage[]; endedBy: TurnEnd }> {
  const { emit } = opts;
  const limits: AgentLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const input: ModelMessage[] = [...opts.history, { role: "user", content: opts.userMessage }];
  const produced: ModelMessage[] = [];
  const messages = () => [...input, ...produced];

  const model = opts.model ?? opts.services.model ?? createAgentModel(opts.services.config);
  if (!model) {
    emit({ type: "error", text: NO_MODEL_TEXT });
    return { messages: input, endedBy: "error" };
  }

  const state = createTurnState(previewedDrafts(opts.history));
  const tools = createTools({ userId: opts.userId, services: opts.services, emit, limits, mode: opts.mode ?? "create", state });
  let forced = false;
  const prose = createProseFilter(
    (text) => emit({ type: "text", delta: text }),
    (violations) => console.warn(`[agent] withheld model prose (${violations.join(", ")}) in session ${opts.sessionId}`),
  );

  try {
    const result = streamText({
      model,
      // Explicit Anthropic cache breakpoint at the end of the static prefix (tools + system prompt).
      instructions: {
        role: "system",
        content: opts.system,
        providerOptions: { openrouter: { cacheControl: { type: "ephemeral" } } },
      },
      messages: input,
      tools,
      // Sticky provider routing for this chat, so its prompt cache stays warm.
      providerOptions: { openrouter: { session_id: opts.sessionId.slice(0, MAX_SESSION_ID) } },
      stopWhen: [isStepCount(limits.maxSteps), () => state.ended !== null],
      prepareStep: ({ stepNumber }) => {
        if (!state.exhausted && stepNumber < limits.maxSteps - 1) return {};
        forced = true;
        return { activeTools: ["report_unavailable"], toolChoice: { type: "tool", toolName: "report_unavailable" } };
      },
      onStepEnd: (step) => {
        produced.push(...step.response.messages);
      },
      abortSignal: opts.abortSignal,
    });

    for await (const part of result.stream) {
      if (part.type === "text-delta") prose.push(part.text);
      else if (part.type === "text-end") prose.flush();
      else if (part.type === "error") throw part.error;
      else if (part.type === "abort") return { messages: messages(), endedBy: "error" };
    }
    prose.flush();
  } catch (error) {
    if (opts.abortSignal?.aborted) return { messages: messages(), endedBy: "error" };
    if (forced && state.ended === null) {
      // The forced report_unavailable step failed (e.g. the model ignored the required tool):
      // the budget is still spent, so end the turn plainly rather than as an error.
      console.warn(`[agent] forced report_unavailable failed in session ${opts.sessionId}`, error);
      emit({ type: "unavailable", text: LIMIT_TEXT });
      return { messages: messages(), endedBy: "limit" };
    }
    console.error(`[agent] turn failed in session ${opts.sessionId}`, error);
    emit({ type: "error", text: ERROR_TEXT });
    return { messages: messages(), endedBy: "error" };
  }

  // A budget ran out and the turn didn't otherwise end (question, sign-in, save).
  if ((forced || state.exhausted) && (state.ended === null || state.ended === "unavailable")) {
    if (state.ended === null) emit({ type: "unavailable", text: LIMIT_TEXT });
    return { messages: messages(), endedBy: "limit" };
  }
  return { messages: messages(), endedBy: state.ended ?? "text" };
}
