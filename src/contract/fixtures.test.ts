import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import {
  ApiErrorSchema,
  ChatEventSchema,
  HealthResponseSchema,
  MessagesRequestSchema,
  PearlDataSchema,
  PearlSchema,
  PearlsListResponseSchema,
  PreviewResponseSchema,
  SavePearlRequestSchema,
  SavePearlResponseSchema,
  SIZE_BUDGETS,
  SIZES,
  WidgetOutputSchema,
  type ChatEvent,
  type WidgetOutput,
} from "./index.ts";

const FIXTURES = new URL("../../fixtures/contract/", import.meta.url);
const fixtureText = (name: string) => Bun.file(new URL(name, FIXTURES)).text();
const fixture = async (name: string): Promise<unknown> => JSON.parse(await fixtureText(name));
const codePoints = (s: string) => [...s].length;

const FIXTURE_SCHEMAS: Record<string, z.ZodType> = {
  "pearl.citibike.json": PearlSchema,
  "pearl-data.inline.json": PearlDataSchema,
  "pearl-data.rectangular.json": PearlDataSchema,
  "pearl-data.small.json": PearlDataSchema,
  "pearl-data.medium.json": PearlDataSchema,
  "pearl-data.stale.json": PearlDataSchema,
  "widget-output.max.inline.json": WidgetOutputSchema,
  "widget-output.max.rectangular.json": WidgetOutputSchema,
  "widget-output.max.small.json": WidgetOutputSchema,
  "widget-output.max.medium.json": WidgetOutputSchema,
  "chat-events.json": ChatEventSchema.array(),
  "pearls-list.json": PearlsListResponseSchema,
  "save-pearl-request.json": SavePearlRequestSchema,
  "save-pearl-response.json": SavePearlResponseSchema,
  "preview-response.json": PreviewResponseSchema,
  "messages-request.json": MessagesRequestSchema,
  "error.json": ApiErrorSchema,
  "health.json": HealthResponseSchema,
};

describe("contract fixtures", () => {
  test("every JSON fixture on disk has a schema", async () => {
    const onDisk = await Array.fromAsync(new Bun.Glob("*.json").scan(FIXTURES.pathname));
    const covered = [...Object.keys(FIXTURE_SCHEMAS), "size-budgets.json"];
    expect(onDisk.sort()).toEqual(covered.sort());
  });

  for (const [name, schema] of Object.entries(FIXTURE_SCHEMAS)) {
    test(`${name} parses without dropping fields`, async () => {
      const raw = await fixture(name);
      // Deep equality after parse proves no unknown keys were silently stripped.
      expect(schema.parse(raw)).toEqual(raw);
    });
  }

  test("chat-events.json contains every ChatEvent variant", async () => {
    const events = ChatEventSchema.array().parse(await fixture("chat-events.json"));
    const variants = ChatEventSchema.options.map((option) => option.shape.type.value);
    expect(variants).toHaveLength(9);
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(variants));
  });

  test("chat-stream.sse.txt is a well-formed SSE stream ending in done", async () => {
    const text = await fixtureText("chat-stream.sse.txt");
    expect(text.endsWith("\n\n")).toBe(true);
    const frames = text.slice(0, -2).split("\n\n");
    const events: ChatEvent[] = frames.map((frame) => {
      expect(frame.startsWith("data: ")).toBe(true);
      expect(frame.includes("\n")).toBe(false);
      return ChatEventSchema.parse(JSON.parse(frame.slice("data: ".length)));
    });
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  test("pearl-data fixtures carry the pearl's last-good projected output", async () => {
    const pearl = PearlSchema.parse(await fixture("pearl.citibike.json"));
    for (const size of SIZES) {
      const data = PearlDataSchema.parse(await fixture(`pearl-data.${size}.json`));
      expect(data.size).toBe(size);
      expect(data.pearlId).toBe(pearl.id);
      expect(data.stale).toBe(false);
      expect(data.output).toEqual(pearl.lastGood?.[size]?.output as WidgetOutput);
    }
    expect(PearlDataSchema.parse(await fixture("pearl-data.stale.json")).stale).toBe(true);
  });

  test("save-pearl-request.json is the stored pearl minus server-owned fields", async () => {
    const { id, userId, version, lastGood, status, ...clientOwned } = PearlSchema.parse(
      await fixture("pearl.citibike.json"),
    );
    expect(await fixture("save-pearl-request.json")).toEqual(clientOwned);
  });
});

describe("size budgets", () => {
  test("size-budgets.json matches SIZE_BUDGETS", async () => {
    expect(await fixture("size-budgets.json")).toEqual(SIZE_BUDGETS);
  });

  for (const size of SIZES) {
    test(`widget-output.max.${size}.json fills every ${size} budget exactly`, async () => {
      const output = WidgetOutputSchema.parse(await fixture(`widget-output.max.${size}.json`));
      const budget = SIZE_BUDGETS[size];

      expect(codePoints(output.value)).toBe(budget.value);

      if (budget.subtitle === null) expect(output.subtitle).toBeUndefined();
      else expect(codePoints(output.subtitle ?? "")).toBe(budget.subtitle);

      if (budget.items === null) {
        expect(output.items).toBeUndefined();
      } else {
        const items = output.items ?? [];
        expect(items).toHaveLength(budget.items.max);
        for (const item of items) {
          expect(codePoints(item.label)).toBe(budget.items.label);
          expect(codePoints(item.value ?? "")).toBe(budget.items.value);
        }
      }
    });
  }

  test("max fixtures exercise multi-code-unit characters", async () => {
    // Code points != UTF-16 units: a budget checked with `.length` would fail these.
    for (const size of SIZES) {
      const text = await fixtureText(`widget-output.max.${size}.json`);
      const strings = JSON.stringify(JSON.parse(text));
      expect(strings.length).toBeGreaterThan(codePoints(strings));
    }
  });
});
