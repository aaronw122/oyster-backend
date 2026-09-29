import { describe, expect, test } from "bun:test";
import { runTransform } from "./index.ts";

// Evaluates `expression` inside the VM (with `std` in scope) and returns its JSON value.
async function evalStd(expression: string): Promise<unknown> {
  const result = await runTransform(`(sources, inputs, std) => ({ value: JSON.stringify(${expression}) })`, {}, {});
  if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.message}`);
  return JSON.parse(result.output.value);
}

describe("std (inside the VM)", () => {
  test("distance: NYC to LA is ~2,445 miles (±1%)", async () => {
    const miles = await evalStd(`std.distance(40.7128, -74.006, 34.0522, -118.2437)`);
    expect(typeof miles).toBe("number");
    expect(Math.abs((miles as number) - 2445) / 2445).toBeLessThan(0.01);
  });

  test("distance: same point is zero", async () => {
    expect(await evalStd(`std.distance(40.74, -73.99, 40.74, -73.99)`)).toBe(0);
  });

  test("formatNumber groups thousands and honours decimals", async () => {
    expect(
      await evalStd(`[
        std.formatNumber(1234567),
        std.formatNumber(1234.5678, { decimals: 2 }),
        std.formatNumber(-9876543.21, { decimals: 0 }),
        std.formatNumber(999),
        std.formatNumber(-0.001, { decimals: 2 }),
        std.formatNumber(1e21),
      ]`),
    ).toEqual(["1,234,567", "1,234.57", "-9,876,543", "999", "0.00", "1,000,000,000,000,000,000,000"]);
  });

  test("formatMoney uses the currency, two decimals, and a leading minus", async () => {
    expect(
      await evalStd(`[
        std.formatMoney(1234.5),
        std.formatMoney(-1234.567, "USD"),
        std.formatMoney(0.1 + 0.2, "eur"),
        std.formatMoney(1e6, "CHF"),
        std.formatMoney(-0.001),
      ]`),
    ).toEqual(["$1,234.50", "-$1,234.57", "€0.30", "CHF 1,000,000.00", "$0.00"]);
  });

  test("truncate counts code points and includes the ellipsis in n", async () => {
    expect(
      await evalStd(`[
        std.truncate("short", 5),
        std.truncate("toolong", 5),
        std.truncate("🚲🚲🚲🚲🚲🚲", 4),
        std.truncate("ab cdef", 4),
        std.truncate("abc", 0),
      ]`),
    ).toEqual(["short", "tool…", "🚲🚲🚲…", "ab…", ""]);
  });

  test("nearest returns the closest item by lat/lon, custom fields, or accessor", async () => {
    const list = `[{ id: "far", lat: 34.05, lon: -118.24 }, { id: "near", lat: 40.75, lon: -73.99 }, { id: "bad", lat: null, lon: null }]`;
    const point = `{ lat: 40.7128, lon: -74.006 }`;
    expect(
      await evalStd(`[
        std.nearest(${list}, ${point}).id,
        std.nearest([{ n: "a", y: 0, x: 0 }, { n: "b", y: 40.7, x: -74 }], ${point}, { lat: "y", lon: "x" }).n,
        std.nearest([{ n: "a", c: [0, 0] }, { n: "b", c: [40.7, -74] }], ${point}, (it) => ({ lat: it.c[0], lon: it.c[1] })).n,
        std.nearest([], ${point}),
      ]`),
    ).toEqual(["near", "b", "b", null]);
  });

  test("round uses half-away-from-zero and defaults to 0 digits", async () => {
    expect(await evalStd(`[std.round(2.5), std.round(-2.5), std.round(1.005, 2), std.round(1234.5678, 1), std.round(-0.4)]`)).toEqual([
      3, -3, 1.01, 1234.6, 0,
    ]);
  });

  test("std is frozen and pure", async () => {
    expect(await evalStd(`Object.isFrozen(std)`)).toBe(true);
  });
});
