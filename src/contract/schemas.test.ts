import { describe, expect, test } from "bun:test";
import {
  ChatEventSchema,
  PearlDataSchema,
  PearlSchema,
  PearlSourceSchema,
  PreviewResponseSchema,
  SavePearlRequestSchema,
  SizeSchema,
  WidgetOutputSchema,
} from "./index.ts";

const pearl = await Bun.file(new URL("../../fixtures/contract/pearl.citibike.json", import.meta.url)).json();
const pearlData = await Bun.file(
  new URL("../../fixtures/contract/pearl-data.small.json", import.meta.url),
).json();
const gbfs = { id: "citibike", builtin: "gbfs", method: "GET" };

describe("Size", () => {
  test("rejects sizes outside the four widget families", () => {
    expect(SizeSchema.safeParse("large").success).toBe(false);
    expect(PearlDataSchema.safeParse({ ...pearlData, size: "large" }).success).toBe(false);
  });

  test("rejects unknown size keys in previews and lastGood", () => {
    const output = { value: "W 21st & 6th" };
    expect(PreviewResponseSchema.safeParse({ previews: { large: output } }).success).toBe(false);
    expect(
      PearlSchema.safeParse({ ...pearl, lastGood: { extraLarge: pearl.lastGood.small } }).success,
    ).toBe(false);
  });
});

describe("PearlSource", () => {
  test("accepts a builtin source or a URL source", () => {
    expect(PearlSourceSchema.safeParse(gbfs).success).toBe(true);
    expect(
      PearlSourceSchema.safeParse({
        id: "weather",
        url: "https://api.open-meteo.com/v1/forecast?latitude={inputs.lat}&longitude={inputs.lon}",
        method: "GET",
      }).success,
    ).toBe(true);
  });

  test("rejects non-GET methods", () => {
    expect(PearlSourceSchema.safeParse({ ...gbfs, method: "POST" }).success).toBe(false);
    expect(PearlSourceSchema.safeParse({ id: "citibike", builtin: "gbfs" }).success).toBe(false);
  });

  test("requires exactly one of builtin or url", () => {
    const both = { ...gbfs, url: "https://gbfs.citibikenyc.com/gbfs/en/station_status.json" };
    const neither = { id: "citibike", method: "GET" };
    expect(PearlSourceSchema.safeParse(both).success).toBe(false);
    expect(PearlSourceSchema.safeParse(neither).success).toBe(false);
    // The rule also holds when the source is nested in a Pearl or save body.
    expect(PearlSchema.safeParse({ ...pearl, sources: [both] }).success).toBe(false);
    const { id, userId, version, lastGood, status, ...save } = pearl;
    expect(SavePearlRequestSchema.safeParse({ ...save, sources: [neither] }).success).toBe(false);
  });
});

describe("Pearl", () => {
  test("rejects unknown status", () => {
    expect(PearlSchema.safeParse({ ...pearl, status: "stale" }).success).toBe(false);
  });

  test("rejects non-ISO lastGood timestamps", () => {
    const small = { ...pearl.lastGood.small, updatedAt: "Sep 29 2026 12:42" };
    expect(PearlSchema.safeParse({ ...pearl, lastGood: { small } }).success).toBe(false);
  });
});

describe("WidgetOutput", () => {
  test("requires value", () => {
    expect(WidgetOutputSchema.safeParse({ subtitle: "5 docks" }).success).toBe(false);
    expect(PearlDataSchema.safeParse({ ...pearlData, output: { subtitle: "5 docks" } }).success).toBe(
      false,
    );
  });

  test("requires item labels", () => {
    expect(WidgetOutputSchema.safeParse({ value: "x", items: [{ value: "5 docks" }] }).success).toBe(
      false,
    );
  });
});

describe("ChatEvent", () => {
  test("rejects unknown event types", () => {
    expect(ChatEventSchema.safeParse({ type: "tool_call", name: "fetch_json" }).success).toBe(false);
  });

  test("rejects a known type missing its payload", () => {
    expect(ChatEventSchema.safeParse({ type: "text" }).success).toBe(false);
    expect(ChatEventSchema.safeParse({ type: "saved", pearl: { id: "p" } }).success).toBe(false);
  });
});
