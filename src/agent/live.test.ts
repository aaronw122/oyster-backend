import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config.ts";
import type { ChatEvent } from "../contract/index.ts";
import { openDb } from "../db/index.ts";
import { createMemorySourceCache } from "../sources/index.ts";
import { PearlStore } from "../store/pearls.ts";
import { nullAuthResolverFor } from "../runtime/index.ts";
import { lintUserFacingText } from "./lint.ts";
import { runAgentTurn } from "./loop.ts";
import { createAgentModel } from "./model.ts";
import { CREATE_SYSTEM_PROMPT } from "./prompt.ts";
import { createWebSearch } from "./search.ts";

// Real OpenRouter model, real network. Opt in: LIVE=1 OPENROUTER_API_KEY=… bun test src/agent/live.test.ts
describe.skipIf(!process.env.LIVE || !process.env.OPENROUTER_API_KEY)("live agent", () => {
  test(
    "Citi Bike docks near an office ends in a question or a preview, in plain language",
    async () => {
      const config = loadConfig({ ...process.env, NODE_ENV: "test" });
      const model = createAgentModel(config);
      if (!model) throw new Error("OPENROUTER_API_KEY is required");
      const pearls = new PearlStore(openDb(":memory:"));
      const events: ChatEvent[] = [];
      const result = await runAgentTurn({
        userId: "live-user",
        sessionId: `live-${crypto.randomUUID()}`,
        system: CREATE_SYSTEM_PROMPT,
        history: [],
        userMessage: "Which Citi Bike station near my office at 11 W 19th St, New York has free docks? I need at least 3.",
        services: {
          runtime: { pearls, authResolverFor: nullAuthResolverFor, cache: createMemorySourceCache(), sandboxTimeoutMs: config.sandboxTimeoutMs },
          pearls,
          config,
          search: createWebSearch({ braveApiKey: config.braveApiKey }),
        },
        emit: (event) => events.push(event),
        model,
      });

      console.log(JSON.stringify({ endedBy: result.endedBy, events }, null, 2));
      expect(["ask_user", "text"]).toContain(result.endedBy);
      expect(events.some((event) => event.type === "question" || event.type === "preview")).toBe(true);
      const prose = events.flatMap((event) => (event.type === "text" ? [event.delta] : event.type === "question" ? [event.text] : []));
      expect(lintUserFacingText(prose.join(""))).toEqual([]);
    },
    180_000,
  );
});
