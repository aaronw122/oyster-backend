import { describe, expect, test } from "bun:test";
import { summarizeJson } from "./index.ts";

const station = (n: number) => ({
  station_id: String(n),
  name: "W 52 St & 6 Ave",
  lat: 40.76,
  num_docks_available: 5,
  is_renting: true,
  rental_uris: null,
});

const gbfs = {
  last_updated: 1727600000,
  data: { stations: Array.from({ length: 1834 }, (_, i) => station(i + 72)) },
};

describe("summarizeJson", () => {
  test("GBFS payload collapses arrays to first-element shape with length", () => {
    expect(summarizeJson(gbfs, { redact: false })).toBe(
      [
        "last_updated: number = 1727600000",
        "data.stations[]: array(1834)",
        'data.stations[].station_id: string = "72"',
        'data.stations[].name: string = "W 52 St & 6 Ave"',
        "data.stations[].lat: number = 40.76",
        "data.stations[].num_docks_available: number = 5",
        "data.stations[].is_renting: boolean = true",
        "data.stations[].rental_uris: null",
      ].join("\n"),
    );
  });

  test("redact keeps shape and types but no samples", () => {
    const summary = summarizeJson(
      { accounts: [{ name: "Checking", balance: 1234.56 }], tags: ["private"], owner: "Aaron" },
      { redact: true },
    );
    expect(summary).toBe(
      ["accounts[]: array(1)", "accounts[].name: string", "accounts[].balance: number", "tags[]: array(1) of string", "owner: string"].join(
        "\n",
      ),
    );
    for (const secret of ["Checking", "1234", "private", "Aaron"]) expect(summary).not.toContain(secret);
  });

  test("caps lines with a trailing count of omitted lines", () => {
    const wide = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
    const lines = summarizeJson(wide, { redact: false, maxLines: 4 }).split("\n");
    expect(lines).toEqual(["k0: number = 0", "k1: number = 1", "k2: number = 2", "k3: number = 3", "… (6 more)"]);
  });

  test("truncates long string samples by code point", () => {
    const summary = summarizeJson({ s: "😀".repeat(100) }, { redact: false });
    expect(summary).toBe(`s: string = "${"😀".repeat(40)}…"`);
  });

  test("edge shapes: root scalars/arrays, empties, odd keys, nested arrays", () => {
    expect(summarizeJson(42, { redact: false })).toBe("$: number = 42");
    expect(summarizeJson([], { redact: false })).toBe("[]: array(0)");
    expect(summarizeJson({}, { redact: false })).toBe("$: object(0)");
    expect(summarizeJson({ "a.b": { "x y": 1 }, m: [[1, 2]], e: {} }, { redact: false })).toBe(
      ['["a.b"]["x y"]: number = 1', "m[]: array(1)", "m[][]: array(2) of number = 1", "e: object(0)"].join("\n"),
    );
  });
});
