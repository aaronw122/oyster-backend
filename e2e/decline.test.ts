import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ChatEvent } from "../src/contract/index.ts";
import { LIVE, type LiveServer, api, expectPlainLanguage, sendMessage, startServer, transcript } from "./harness.ts";

// Requests Oyster must decline in plain language instead of building something.
// Run: LIVE=1 bun test e2e (needs OPENROUTER_API_KEY).

describe.skipIf(!LIVE || !process.env.OPENROUTER_API_KEY)("declines (live)", () => {
  let server: LiveServer;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server?.stop();
  });

  /** One user message; the turn must end in `unavailable` with nothing saved. */
  async function expectDecline(message: string): Promise<{ events: ChatEvent[]; unavailable: string }> {
    const events = await sendMessage(server, `e2e-decline-${crypto.randomUUID()}`, message);
    console.log(`[e2e] user: ${message}\n${transcript(events)}`);
    expectPlainLanguage(events);
    expect(events.some((event) => event.type === "saved")).toBe(false);
    expect(events.some((event) => event.type === "oauth")).toBe(false);
    const ends = events.filter((event) => event.type === "unavailable");
    expect(ends).toHaveLength(1);
    const list = await api(server, "GET", "/pearls");
    expect(list.body).toEqual({ pearls: [] });
    return { events, unavailable: ends[0]?.type === "unavailable" ? ends[0].text : "" };
  }

  test(
    "an impossible request ends as unavailable",
    async () => {
      await expectDecline("How many people are thinking about pizza in Ohio right now?");
    },
    300_000,
  );

  test(
    "a custom API that needs the user's API key is not supported yet, and the key is never asked for",
    async () => {
      const { events, unavailable } = await expectDecline(
        "Show my Acme Corp internal dashboard metrics. The dashboard's API needs my personal API key.",
      );
      expect(unavailable).toMatch(/not (?:supported|available)|(?:can't|cannot|can not|don't|do not|isn't|is not)\b.*\b(?:yet|support|connect|work)/i);
      // Asking for the key would mean collecting a secret the product can't store yet.
      const asks = events.flatMap((event) => (event.type === "question" ? [event.text, ...(event.options ?? [])] : []));
      expect(asks).toEqual([]);
      const prose = events.flatMap((event) => (event.type === "text" ? [event.delta] : [])).join("");
      expect(prose).not.toMatch(/(?:send|share|give|paste|provide|enter)\b[^.?!]*\b(?:api )?key/i);
    },
    300_000,
  );
});
