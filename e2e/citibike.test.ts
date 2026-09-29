import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChatEvent, PearlDataSchema, PearlsListResponseSchema } from "../src/contract/index.ts";
import { LIVE, type LiveServer, SIZES, api, expectPlainLanguage, sendMessage, startServer, transcript } from "./harness.ts";

// ENSURE-1: the Citi Bike flow end to end over HTTP with the real model, answering the
// agent like a user would (plain facts, never code), until the Pearl is saved.
// Run: LIVE=1 bun test e2e (needs OPENROUTER_API_KEY).

const OPENING = "Show open docks at the Citi Bike stations near my office at 11 W 19th St, Manhattan; I need at least 3.";
const MAX_TURNS = 6;

/** What a user would answer, keyed by what the question is about. First match wins. */
const FACTS: ReadonlyArray<[RegExp, string]> = [
  [/address|office|where|located|location|cross street/i, "My office is at 11 W 19th St, Manhattan, New York, NY 10011."],
  [/how many|threshold|at least|minimum|number of/i, "At least 3 open docks."],
  [/name|call/i, "Call it Office docks."],
  [/station|which|nearby|closest|nearest/i, "The few stations closest to the office are fine."],
];
const CONFIRM = "Yes, that looks right. Please save it.";

/** Scripted user: pick a "save" option when offered, otherwise answer with a plain fact. */
function answer(turn: readonly ChatEvent[]): string {
  const question = turn.findLast((event) => event.type === "question");
  if (!question) return CONFIRM;
  const save = question.options?.find((option) => /save/i.test(option));
  if (save) return save;
  return FACTS.find(([pattern]) => pattern.test(question.text))?.[1] ?? CONFIRM;
}

describe.skipIf(!LIVE || !process.env.OPENROUTER_API_KEY)("ENSURE-1: Citi Bike Pearl from chat (live)", () => {
  let server: LiveServer;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server?.stop();
  });

  test(
    "chat → preview → saved Pearl that refreshes at every size, in plain language",
    async () => {
      const sessionId = `e2e-citibike-${crypto.randomUUID()}`;
      const events: ChatEvent[] = [];
      let message = OPENING;
      for (let turn = 1; turn <= MAX_TURNS; turn++) {
        const turnEvents = await sendMessage(server, sessionId, message);
        events.push(...turnEvents);
        console.log(`[e2e] turn ${turn} — user: ${message}\n${transcript(turnEvents)}`);
        if (turnEvents.some((event) => event.type === "saved")) break;
        const ended = turnEvents.find((event) => event.type === "unavailable" || event.type === "error" || event.type === "oauth");
        if (ended) throw new Error(`conversation ended without a Pearl (${ended.type})\n${server.logs()}`);
        message = answer(turnEvents);
      }

      expectPlainLanguage(events);

      const savedIndex = events.findIndex((event) => event.type === "saved");
      expect(savedIndex).toBeGreaterThan(-1);
      const previewIndex = events.findIndex((event) => event.type === "preview");
      expect(previewIndex).toBeGreaterThan(-1);
      expect(previewIndex).toBeLessThan(savedIndex);
      const saved = events[savedIndex];
      if (saved?.type !== "saved") throw new Error("unreachable");
      const pearlId = saved.pearl.id;

      const list = await api(server, "GET", "/pearls");
      expect(list.status).toBe(200);
      expect(PearlsListResponseSchema.parse(list.body).pearls.map((pearl) => pearl.id)).toContain(pearlId);

      for (const size of SIZES) {
        const response = await api(server, "GET", `/pearls/${pearlId}/data?size=${size}`);
        expect(response.status).toBe(200);
        const data = PearlDataSchema.parse(response.body);
        expect(data.stale).toBe(false);
        expect(data.output.value.trim()).not.toBe("");
        console.log(`[e2e] citibike ${size}: ${JSON.stringify(data.output)}`);
      }

      // §2a: creation resolves the office into a candidate station list; the office itself is discarded.
      const pearl = server.pearls.getById(pearlId);
      if (!pearl) throw new Error(`saved Pearl ${pearlId} is not in the store`);
      console.log(`[e2e] citibike stored inputs: ${JSON.stringify(pearl.inputs)}`);
      expect(pearl.sources.some((source) => source.builtin === "gbfs")).toBe(true);
      expect(Object.values(pearl.inputs).some(isCandidateList)).toBe(true);
      const stored = JSON.stringify(pearl.inputs);
      expect(stored).not.toMatch(/\b11\s+W(?:est)?\.?\s+19(?:th)?\b/i);
      expect(stored).not.toMatch(/\b10011\b/);
    },
    600_000,
  );
});

/** A list of stations: a non-empty array, or a comma-separated string of at least two ids. */
function isCandidateList(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "string" && value.split(",").filter((part) => part.trim() !== "").length >= 2;
}
