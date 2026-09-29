import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
  type VmCallResult,
} from "quickjs-emscripten";
import { WidgetOutputSchema, type WidgetOutput } from "../contract/index.ts";
import { STD_SOURCE } from "./std.ts";

export type TransformErrorKind = "syntax" | "runtime" | "timeout" | "memory" | "shape";
export type TransformResult =
  | { ok: true; output: WidgetOutput }
  | { ok: false; error: { kind: TransformErrorKind; message: string } };

const DEFAULT_TIMEOUT_MS = 250;
const DEFAULT_MEMORY_BYTES = 32 * 1024 * 1024;
const MAX_STACK_BYTES = 512 * 1024;

// Evaluated before the transform runs, so it closes over the pristine
// `JSON.stringify` / `Array.isArray` / `InternalError` even if the transform
// overwrites the globals. Returns the JSON text on success or `{ error }` for a
// shape problem. Nesting is capped via the replacer: QuickJS leaks objects
// (and then aborts on runtime teardown) when JSON.stringify overflows the stack.
// Resource errors (InternalError) are rethrown so they keep their real kind.
const SERIALIZE_SOURCE = `(function (stringify, isArray, InternalErrorCtor) {
  "use strict";
  var MAX_DEPTH = 32;
  var TOO_DEEP = {};
  return function (value) {
    if (value === null || typeof value !== "object" || isArray(value)) {
      var got = value === null ? "null" : isArray(value) ? "array" : typeof value;
      return { error: "transform must return a plain object, got " + got };
    }
    // JSON.stringify walks depth-first, so the holder (this) is always on the
    // ancestor stack; only index access here, no overridable methods.
    var ancestors = [];
    function limitDepth(key, child) {
      var i = ancestors.length - 1;
      while (i >= 0 && ancestors[i] !== this) i--;
      ancestors.length = i + 1;
      if (child !== null && typeof child === "object") {
        if (ancestors.length >= MAX_DEPTH) throw TOO_DEEP;
        ancestors[ancestors.length] = child;
      }
      return child;
    }
    try {
      return stringify(value, limitDepth);
    } catch (e) {
      if (e === TOO_DEEP) return { error: "transform output is nested more than " + MAX_DEPTH + " levels deep" };
      if (e instanceof InternalErrorCtor) throw e;
      return { error: "transform output is not JSON-serializable: " + (e && e.message ? e.message : String(e)) };
    }
  };
})(JSON.stringify, Array.isArray, InternalError)`;

class TransformFailure extends Error {
  constructor(
    readonly kind: TransformErrorKind,
    message: string,
  ) {
    super(message);
  }
}

// One WASM module is shared; each run gets its own runtime + context (fresh
// heap, globals, limits). A wasm-level abort poisons the module, so drop it.
let modulePromise: Promise<QuickJSWASMModule> | undefined;

/**
 * Evaluates `(<transform>)(sources, inputs, std)` in a fresh QuickJS VM and
 * validates the result against `WidgetOutputSchema` (not size-projected).
 * Never rejects: host/WASM faults come back as a `runtime` "sandbox failure".
 */
export async function runTransform(
  transform: string,
  sources: Record<string, unknown>,
  inputs: Record<string, unknown>,
  opts?: { timeoutMs?: number; memoryBytes?: number },
): Promise<TransformResult> {
  try {
    return await runInFreshVm(transform, sources, inputs, opts);
  } catch (error) {
    // Anything escaping runInFreshVm is a host/WASM fault (including an abort
    // while tearing the runtime down); the shared module may be corrupt.
    modulePromise = undefined;
    const message = error instanceof Error ? error.message : String(error);
    return fail("runtime", `sandbox failure: ${message}`);
  }
}

async function runInFreshVm(
  transform: string,
  sources: Record<string, unknown>,
  inputs: Record<string, unknown>,
  opts?: { timeoutMs?: number; memoryBytes?: number },
): Promise<TransformResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const memoryBytes = opts?.memoryBytes ?? DEFAULT_MEMORY_BYTES;
  // Marshal on the host first: the VM only ever receives JSON text.
  const sourcesJson = JSON.stringify(sources);
  const inputsJson = JSON.stringify(inputs);

  modulePromise ??= getQuickJS();
  const quickjs = await modulePromise;
  const runtime = quickjs.newRuntime();
  let context: QuickJSContext | undefined;
  const handles: QuickJSHandle[] = [];
  try {
    runtime.setMemoryLimit(memoryBytes);
    runtime.setMaxStackSize(MAX_STACK_BYTES);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
    const ctx = runtime.newContext();
    context = ctx;

    // Keeps successful handles for disposal; turns VM exceptions into a classified TransformFailure.
    const unwrap = (result: VmCallResult<QuickJSHandle>): QuickJSHandle => {
      if (!result.error) {
        handles.push(result.value);
        return result.value;
      }
      const thrown: unknown = ctx.dump(result.error);
      result.error.dispose();
      const isError = thrown !== null && typeof thrown === "object" && "message" in thrown;
      const name = isError ? ("name" in thrown ? String(thrown.name) : "Error") : undefined;
      const message = isError ? String(thrown.message) : (JSON.stringify(thrown) ?? String(thrown));
      if (name === "InternalError" && message === "interrupted") {
        throw new TransformFailure("timeout", `transform exceeded ${timeoutMs}ms time limit`);
      }
      // "string too long" is QuickJS's hard string-size cap (e.g. `s += s` doubling): an allocation failure.
      if (name === "InternalError" && (message === "out of memory" || message === "string too long")) {
        throw new TransformFailure("memory", `transform exceeded ${memoryBytes} byte memory limit (${message})`);
      }
      const kind = name === "SyntaxError" ? "syntax" : "runtime";
      throw new TransformFailure(kind, name ? `${name}: ${message}` : `uncaught exception: ${message}`);
    };

    const std = unwrap(ctx.evalCode(STD_SOURCE, "std.js"));
    const serialize = unwrap(ctx.evalCode(SERIALIZE_SOURCE, "serialize.js"));
    const parse = unwrap(ctx.evalCode("JSON.parse", "parse.js"));
    const [sourcesHandle, inputsHandle] = [sourcesJson, inputsJson].map((json) => {
      const text = ctx.newString(json);
      handles.push(text);
      return unwrap(ctx.callFunction(parse, ctx.undefined, text));
    }) as [QuickJSHandle, QuickJSHandle];

    // Trailing newline so a transform ending in a `//` comment can't swallow the paren.
    const fn = unwrap(ctx.evalCode(`(${transform}\n)`, "transform.js"));
    const fnType = ctx.typeof(fn);
    if (fnType !== "function") {
      throw new TransformFailure("syntax", `transform must be a function expression, got ${fnType}`);
    }

    const returned = unwrap(ctx.callFunction(fn, ctx.undefined, sourcesHandle, inputsHandle, std));
    const serialized = unwrap(ctx.callFunction(serialize, ctx.undefined, returned));
    if (ctx.typeof(serialized) !== "string") {
      const problem: unknown = ctx.dump(serialized);
      const message =
        problem !== null && typeof problem === "object" && "error" in problem
          ? String(problem.error)
          : "transform returned a non-serializable value";
      throw new TransformFailure("shape", message);
    }
    const json = ctx.getString(serialized);

    const checked = WidgetOutputSchema.safeParse(JSON.parse(json));
    if (!checked.success) {
      const issues = checked.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
        return `${path}: ${issue.message}`;
      });
      return fail("shape", `transform output does not match WidgetOutput: ${issues.join("; ")}`);
    }
    return { ok: true, output: checked.data };
  } catch (error) {
    if (error instanceof TransformFailure) return fail(error.kind, error.message);
    throw error;
  } finally {
    // May throw (WASM abort on leaked objects); runTransform turns that into a failure result.
    for (const handle of handles.reverse()) if (handle.alive) handle.dispose();
    context?.dispose();
    runtime.dispose();
  }
}

function fail(kind: TransformErrorKind, message: string): TransformResult {
  return { ok: false, error: { kind, message } };
}
