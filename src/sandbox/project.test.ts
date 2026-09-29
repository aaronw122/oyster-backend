import { describe, expect, test } from "bun:test";
import { SIZES, SIZE_BUDGETS, WidgetOutputSchema, type Size, type WidgetOutput } from "../contract/index.ts";
import { fitAllSizes, fitToSize, projectForSize } from "./index.ts";

const FIXTURE_DIR = new URL("../../fixtures/contract/", import.meta.url);

async function maxFixture(size: Size): Promise<WidgetOutput> {
  return WidgetOutputSchema.parse(await Bun.file(new URL(`widget-output.max.${size}.json`, FIXTURE_DIR)).json());
}

const full: WidgetOutput = {
  value: "W 21 St",
  subtitle: "5 docks",
  items: Array.from({ length: 7 }, (_, i) => ({ label: `Station ${i}`, value: `${i}` })),
};

describe("projectForSize", () => {
  test("inline keeps only value", () => {
    expect(projectForSize(full, "inline")).toEqual({ value: "W 21 St" });
  });

  test("rectangular drops items but keeps subtitle", () => {
    expect(projectForSize(full, "rectangular")).toEqual({ value: "W 21 St", subtitle: "5 docks" });
  });

  test("small and medium cut items to the first N", () => {
    expect(projectForSize(full, "small").items).toEqual(full.items!.slice(0, 2));
    expect(projectForSize(full, "medium").items).toEqual(full.items!.slice(0, 5));
  });

  test("does not mutate or alias the input", () => {
    const projected = projectForSize(full, "medium");
    projected.items![0]!.label = "changed";
    expect(full.items![0]!.label).toBe("Station 0");
    expect(full.items).toHaveLength(7);
  });
});

describe("fitToSize", () => {
  test("overflow beyond what projection drops is fine", () => {
    const longSubtitle = { value: "ok", subtitle: "x".repeat(100) };
    expect(fitToSize(longSubtitle, "inline")).toEqual({ ok: true, output: { value: "ok" } });
  });

  test("empty value is invalid at every size", () => {
    for (const result of Object.values(fitAllSizes({ value: "" }))) {
      expect(result.ok).toBe(false);
    }
    expect(fitToSize({ value: "" }, "small")).toEqual({ ok: false, errors: ["small: value is empty"] });
  });

  test("errors are human-readable and report every overflow", () => {
    const output: WidgetOutput = {
      value: "x".repeat(21),
      subtitle: "ok",
      items: [
        { label: "a", value: "b" },
        { label: "a", value: "b" },
        { label: "L".repeat(25), value: "V".repeat(11) },
      ],
    };
    expect(fitToSize(output, "medium")).toEqual({
      ok: false,
      errors: [
        "medium: value is 21 code points (max 20)",
        "medium: items[2].label is 25 code points (max 22)",
        "medium: items[2].value is 11 code points (max 10)",
      ],
    });
  });

  test("lengths are measured in code points, not UTF-16 units", () => {
    // 12 bikes = 12 code points but 24 UTF-16 units.
    expect(fitToSize({ value: "🚲".repeat(12) }, "inline").ok).toBe(true);
    expect(fitToSize({ value: "🚲".repeat(13) }, "inline")).toEqual({
      ok: false,
      errors: ["inline: value is 13 code points (max 12)"],
    });
  });
});

// ENSURE-3a: the canonical max-length fixtures fit exactly; one code point more does not.
describe("max-length fixtures (ENSURE-3a)", () => {
  for (const size of SIZES) {
    test(`${size} fixture fits exactly at its budget`, async () => {
      const fixture = await maxFixture(size);
      const budget = SIZE_BUDGETS[size];
      expect(fitToSize(fixture, size)).toEqual({ ok: true, output: fixture });
      expect([...fixture.value]).toHaveLength(budget.value);
      if (budget.subtitle !== null) expect([...fixture.subtitle!]).toHaveLength(budget.subtitle);
      if (budget.items !== null) expect(fixture.items).toHaveLength(budget.items.max);
    });

    test(`${size} fixture with one extra code point in any shown field fails`, async () => {
      const fixture = await maxFixture(size);
      const variants: Array<[string, WidgetOutput]> = [["value", { ...fixture, value: `${fixture.value}x` }]];
      if (fixture.subtitle !== undefined) variants.push(["subtitle", { ...fixture, subtitle: `${fixture.subtitle}x` }]);
      fixture.items?.forEach((item, i) => {
        const withItem = (patched: typeof item) => ({ ...fixture, items: fixture.items!.map((it, j) => (j === i ? patched : it)) });
        variants.push([`items[${i}].label`, withItem({ ...item, label: `${item.label}x` })]);
        if (item.value !== undefined) variants.push([`items[${i}].value`, withItem({ ...item, value: `${item.value}x` })]);
      });
      for (const [field, variant] of variants) {
        const result = fitToSize(variant, size);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.errors).toHaveLength(1);
          expect(result.errors[0]).toStartWith(`${size}: ${field} is `);
        }
      }
    });
  }

  test("fitAllSizes judges each size against its own budget", async () => {
    const medium = await maxFixture("medium");
    const results = fitAllSizes(medium);
    expect(results.medium.ok).toBe(true);
    // Medium's 20-code-point value exceeds the 12/16 budgets of the smaller sizes.
    expect(results.inline).toEqual({ ok: false, errors: ["inline: value is 20 code points (max 12)"] });
    expect(results.small.ok).toBe(false);
  });
});
