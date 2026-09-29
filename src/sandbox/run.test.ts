import { describe, expect, test } from "bun:test";
import { runTransform, type TransformErrorKind, type TransformResult } from "./index.ts";

function expectError(result: TransformResult, kind: TransformErrorKind): string {
  if (result.ok) throw new Error(`expected ${kind} error, got output ${JSON.stringify(result.output)}`);
  expect(result.error.kind).toBe(kind);
  return result.error.message;
}

describe("runTransform", () => {
  test("runs a transform against sources and inputs", async () => {
    const transform = `(sources, inputs, std) => {
      const station = sources.stations.find((s) => s.id === inputs.stationId);
      return {
        value: station.name,
        subtitle: std.formatNumber(station.docks) + " docks",
        items: sources.stations.map((s) => ({ label: s.name, value: String(s.docks) })),
      };
    }`;
    const sources = { stations: [{ id: "a", name: "W 21 St", docks: 5 }, { id: "b", name: "Pier 62", docks: 1200 }] };
    const result = await runTransform(transform, sources, { stationId: "b" });
    expect(result).toEqual({
      ok: true,
      output: {
        value: "Pier 62",
        subtitle: "1,200 docks",
        items: [
          { label: "W 21 St", value: "5" },
          { label: "Pier 62", value: "1200" },
        ],
      },
    });
  });

  test("a transform ending in a line comment still parses", async () => {
    const result = await runTransform(`() => ({ value: "ok" }) // done`, {}, {});
    expect(result).toEqual({ ok: true, output: { value: "ok" } });
  });

  test("syntax errors are reported as syntax", async () => {
    const message = expectError(await runTransform(`(s) => { return {`, {}, {}), "syntax");
    expect(message).toContain("SyntaxError");
  });

  test("a transform that is not a function is rejected with a clear message", async () => {
    const message = expectError(await runTransform(`42`, {}, {}), "syntax");
    expect(message).toBe("transform must be a function expression, got number");
  });

  test("thrown errors are reported as runtime with the thrown message", async () => {
    const message = expectError(await runTransform(`() => { throw new TypeError("no station") }`, {}, {}), "runtime");
    expect(message).toBe("TypeError: no station");
  });

  test("throwing a non-Error value is still a runtime error", async () => {
    const message = expectError(await runTransform(`() => { throw null }`, {}, {}), "runtime");
    expect(message).toBe("uncaught exception: null");
  });

  test("runaway recursion is a runtime error, not a host crash", async () => {
    const message = expectError(await runTransform(`() => { const f = (n) => f(n + 1) + 1; return f(0); }`, {}, {}), "runtime");
    expect(message).toContain("stack overflow");
  });

  test("hitting QuickJS's string size cap is reported as memory", async () => {
    expectError(await runTransform(`() => { let s = "x"; for (;;) s = s + s; }`, {}, {}), "memory");
  });

  const deepObject = `let o = { value: "x" }, c = o; for (let i = 0; i < 3e4; i++) { c.n = {}; c = c.n; }`;

  test("returning deeply nested output is a shape error and the sandbox stays usable", async () => {
    const message = expectError(await runTransform(`() => { ${deepObject} return o; }`, {}, {}), "shape");
    expect(message).toContain("nested more than 32 levels");
    expect(await runTransform(`() => ({ value: "after" })`, {}, {})).toEqual({ ok: true, output: { value: "after" } });
  });

  test("a WASM abort during teardown resolves as a runtime failure, never a rejection", async () => {
    // Stack overflow inside the transform's own JSON.stringify leaks QuickJS objects; freeing the runtime aborts.
    const result = await runTransform(`() => { ${deepObject} JSON.stringify(o); return { value: "y" }; }`, {}, {});
    expectError(result, "runtime");
    expect(await runTransform(`() => ({ value: "after" })`, {}, {})).toEqual({ ok: true, output: { value: "after" } });
  });

  test("host-side marshalling failures resolve instead of rejecting", async () => {
    const message = expectError(await runTransform(`() => ({ value: "x" })`, { big: 1n }, {}), "runtime");
    expect(message).toContain("sandbox failure");
  });

  test("overwriting JSON/Array/InternalError globals cannot break output serialization", async () => {
    const transform = `() => {
      JSON.stringify = () => 42;
      Array.isArray = () => true;
      globalThis.InternalError = null;
      return { value: "still ok", items: [{ label: "a" }] };
    }`;
    expect(await runTransform(transform, {}, {})).toEqual({ ok: true, output: { value: "still ok", items: [{ label: "a" }] } });
  });

  test("an infinite loop times out near the budget", async () => {
    const started = performance.now();
    expectError(await runTransform(`() => { while (true) {} }`, {}, {}, { timeoutMs: 100 }), "timeout");
    // Generous upper bound: the interrupt handler must stop the loop, not merely eventually.
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("a transform cannot catch its way out of the timeout", async () => {
    const transform = `() => { for (;;) { try { while (true) {} } catch (e) {} } }`;
    expectError(await runTransform(transform, {}, {}, { timeoutMs: 100 }), "timeout");
  });

  test("allocating past the memory limit is reported as memory", async () => {
    const transform = `() => { const chunks = []; for (;;) chunks.push(new ArrayBuffer(1 << 20)); }`;
    const message = expectError(await runTransform(transform, {}, {}, { memoryBytes: 8 * 1024 * 1024 }), "memory");
    expect(message).toContain("8388608");
  });

  test("host capabilities and host names are absent inside the VM", async () => {
    const transform = `() => ({
      value: [typeof fetch, typeof require, typeof process, typeof Bun, typeof console, typeof setTimeout, typeof XMLHttpRequest, typeof WebAssembly].join(","),
      subtitle: Object.getOwnPropertyNames(globalThis).join(","),
    })`;
    const result = await runTransform(transform, {}, {});
    if (!result.ok) throw new Error(result.error.message);
    expect(result.output.value).toBe("undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined");
    const names = result.output.subtitle!.split(",");
    for (const hostName of ["fetch", "require", "process", "Bun", "console", "std", "sources", "inputs", "module", "exports"]) {
      expect(names).not.toContain(hostName);
    }
  });

  test("calling a host API fails as a runtime error", async () => {
    const message = expectError(await runTransform(`() => { fetch("https://example.com"); return { value: "x" }; }`, {}, {}), "runtime");
    expect(message).toContain("ReferenceError");
    expectError(await runTransform(`() => { globalThis.process.exit(1); }`, {}, {}), "runtime");
  });

  test("state does not leak between runs", async () => {
    await runTransform(`() => { globalThis.leaked = "yes"; Array.prototype.polluted = 1; return { value: "a" }; }`, {}, {});
    const result = await runTransform(`() => ({ value: typeof leaked + "/" + typeof [].polluted })`, {}, {});
    expect(result).toEqual({ ok: true, output: { value: "undefined/undefined" } });
  });

  test("mutating sources inside the VM does not touch the host object", async () => {
    const sources = { feed: { count: 1 } };
    await runTransform(`(s) => { s.feed.count = 99; return { value: "x" }; }`, sources, {});
    expect(sources.feed.count).toBe(1);
  });

  test.each([
    ["number", `() => 5`, "transform must return a plain object, got number"],
    ["array", `() => [{ value: "x" }]`, "transform must return a plain object, got array"],
    ["null", `() => null`, "transform must return a plain object, got null"],
    ["undefined", `() => {}`, "transform must return a plain object, got undefined"],
  ])("returning %s is a shape error", async (_label, transform, expected) => {
    expect(expectError(await runTransform(transform, {}, {}), "shape")).toBe(expected);
  });

  test("a non-JSON-serializable return is a shape error", async () => {
    const message = expectError(await runTransform(`() => { const o = { value: "x" }; o.self = o; return o; }`, {}, {}), "shape");
    expect(message).toContain("not JSON-serializable");
  });

  test("output failing WidgetOutputSchema lists each issue path", async () => {
    const message = expectError(await runTransform(`() => ({ value: 5, items: [{ value: "1" }] })`, {}, {}), "shape");
    expect(message).toContain("value:");
    expect(message).toContain("items.0.label:");
  });

  test("many sequential runs complete without leaking VM handles", async () => {
    const transform = `(s, i, std) => ({ value: std.formatMoney(s.n * i.k), items: [{ label: std.truncate("station " + s.n, 10) }] })`;
    for (let n = 0; n < 50; n++) {
      const result = await runTransform(transform, { n }, { k: 2 });
      expect(result.ok).toBe(true);
      // Interleave failures: error paths must dispose their handles too.
      expectError(await runTransform(`() => { throw new Error("x") }`, {}, {}), "runtime");
    }
  });
});
