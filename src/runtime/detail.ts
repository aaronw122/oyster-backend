import type { RunFailure } from "./run.ts";

/**
 * QuickJS messages (after `mask`) that carry no data: the engine's own wording
 * with any identifier or value quoted, and so masked. A transform can construct,
 * mutate or rethrow errors with any text, so a sensitive run shows an error
 * message only when it matches one of these exactly; everything else is hidden.
 */
const ENGINE_MESSAGES: readonly RegExp[] = [
  /^TypeError: cannot (?:read|set) property(?: "…")? of (?:null|undefined)$/,
  /^TypeError: not a function$/,
  /^TypeError: not an object$/,
  /^TypeError: cannot convert to object$/,
  /^TypeError: value is not iterable$/,
  /^TypeError: invalid "…" operand$/,
  /^TypeError: empty array$/,
  /^ReferenceError: "…" is not defined$/,
  /^RangeError: invalid array length$/,
  /^InternalError: stack overflow$/,
  /^SyntaxError: unexpected token: "…"$/,
  /^SyntaxError: Unexpected end of JSON input$/,
  /^SyntaxError: expecting (?:property name|field name|"…")$/,
  /^SyntaxError: invalid (?:property name|bigint literal)$/,
  /^SyntaxError: variable name expected$/,
  // Host-generated (sandbox/run.ts): typeof of the transform expression.
  /^transform must be a function expression, got \w+$/,
];
const ERROR_NAMES: Record<string, true> = {
  Error: true,
  TypeError: true,
  RangeError: true,
  SyntaxError: true,
  ReferenceError: true,
  EvalError: true,
  URIError: true,
  InternalError: true,
};

/** Masks quoted strings and numbers. */
function mask(text: string): string {
  return text.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"…"').replace(/\d+(?:[.,]\d+)*/g, "#");
}

/**
 * The one rule for what an LLM (agent or repair) may see of a failure.
 * Non-sensitive failures and fit details (lengths only) are shown as they are.
 * For sensitive data only shapes and types may reach the model:
 * - a transform's syntax/runtime error is shown (masked) only when it is a known
 *   engine message (`ENGINE_MESSAGES`); otherwise only its error name, since the
 *   transform controls the text of anything it throws;
 * - other kinds (fetch, timeout, memory, shape) are masked, and a shape error's
 *   serializer message (which a `toJSON` throw controls) is hidden.
 */
export function modelSafeDetail(failure: RunFailure, sensitive: boolean): string {
  if (!sensitive || failure.stage === "fit") return failure.detail;
  const match = failure.stage === "transform" ? /^(transform failed \((?:runtime|syntax)\): )([\s\S]*)$/.exec(failure.detail) : null;
  if (!match) return mask(failure.detail.replace(/(not JSON-serializable): [\s\S]*$/, "$1 (message hidden)"));
  const prefix = match[1] ?? "";
  const message = match[2] ?? "";
  const masked = mask(message);
  if (ENGINE_MESSAGES.some((template) => template.test(masked))) return prefix + masked;
  const name = /^(\w+): /.exec(message)?.[1];
  const label = name && ERROR_NAMES[name] ? name : message.startsWith("uncaught exception: ") ? "uncaught exception" : "Error";
  return `${prefix}${label} (message hidden)`;
}
