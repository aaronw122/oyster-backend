import { SourceError } from "./types.ts";

// `{inputs.a}` or `{inputs.a.b}`; segments are plain keys (no braces, dots, whitespace).
const PLACEHOLDER = /\{([^{}]*)\}/g;
const INPUT_REF = /^inputs((?:\.[^.\s{}]+)+)$/;

/**
 * Replaces `{inputs.*}` references with URL-encoded input values. Any other
 * `{...}` reference, a missing value, or a non-scalar value throws a
 * `SourceError` of kind `template`.
 */
export function fillTemplate(template: string, inputs: Record<string, unknown>): string {
  return fillInputs(template, inputs, encodeURIComponent);
}

/** `fillTemplate` semantics with a caller-chosen value encoding (identity for builtin params). */
export function fillInputs(
  template: string,
  inputs: Record<string, unknown>,
  encode: (value: string) => string,
): string {
  return template.replace(PLACEHOLDER, (placeholder, ref: string) => {
    const match = INPUT_REF.exec(ref.trim());
    if (!match?.[1]) {
      throw new SourceError("template", `unsupported template reference ${placeholder}; only {inputs.*} is allowed`);
    }
    let value: unknown = inputs;
    for (const key of match[1].slice(1).split(".")) {
      value =
        value !== null && typeof value === "object" && Object.hasOwn(value, key)
          ? (value as Record<string, unknown>)[key]
          : undefined;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return encode(String(value));
    }
    if (value === undefined || value === null) {
      throw new SourceError("template", `template reference ${placeholder} has no input value`);
    }
    throw new SourceError("template", `template reference ${placeholder} is not a string, number, or boolean`);
  });
}
