import { expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { MAX_HISTORY_CHARS, MAX_HISTORY_MESSAGES, trimHistory } from "./sessions.ts";

/** One user turn: user → assistant tool call → tool result → assistant text. */
function toolTurn(n: number, padding = ""): ModelMessage[] {
  return [
    { role: "user", content: `question ${n}${padding}` },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: `c${n}`, toolName: "find_builtin", input: {} }] },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: `c${n}`, toolName: "find_builtin", output: { type: "json", value: { ok: true } } }],
    },
    { role: "assistant", content: `answer ${n}` },
  ];
}

test("drops whole oldest turns until under the message cap, never splitting a tool call from its result", () => {
  const turns = Math.ceil(MAX_HISTORY_MESSAGES / 4) + 3;
  const history = Array.from({ length: turns }, (_, n) => toolTurn(n)).flat();
  const trimmed = trimHistory(history);
  expect(trimmed.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
  expect(trimmed[0]?.role).toBe("user");
  expect(trimmed.length % 4).toBe(0);
  expect(trimmed.at(-1)).toEqual({ role: "assistant", content: `answer ${turns - 1}` });
});

test("the character cap applies too, but the latest turn is always kept", () => {
  const big = "x".repeat(MAX_HISTORY_CHARS / 2);
  const trimmed = trimHistory([...toolTurn(1, big), ...toolTurn(2, big), ...toolTurn(3, big)]);
  expect(trimmed.map((message) => (message.role === "user" ? message.content : null)).filter(Boolean)).toEqual([
    `question 3${big}`,
  ]);
  const short = [...toolTurn(1), ...toolTurn(2)];
  expect(trimHistory(short)).toEqual(short);
});
