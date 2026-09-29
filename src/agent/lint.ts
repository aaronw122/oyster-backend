// UX invariant (DON'T): the user never sees JSON, endpoints, or code — only
// names, questions, and previews. Everything the agent says to the user passes
// through here before it reaches the app.

const RULES: ReadonlyArray<{ violation: string; pattern: RegExp }> = [
  { violation: "code fence", pattern: /```|~~~/ },
  { violation: "URL", pattern: /\b(?:https?|wss?|ftp):\/\/|\bwww\.[a-z0-9-]+\.[a-z]|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[^\s]*/i },
  { violation: "JSON", pattern: /[{[]\s*"[^"\n]*"\s*:|"[A-Za-z_][\w-]*"\s*:\s*["{[\d]|^\s*[{[]\s*$/m },
  { violation: "endpoint path", pattern: /(?:^|[\s(])\/(?:[\w.-]+\/)*[\w.-]*[a-z_][\w.-]*(?:\?[\w=&%-]*)?(?=[\s).,;:!?]|$)/im },
  { violation: "template placeholder", pattern: /\{\s*inputs\.|\{\{/ },
  {
    violation: "stack trace",
    pattern: /^\s*at\s+\S+.*:\d+(?::\d+)?\)?\s*$|\b(?:TypeError|ReferenceError|SyntaxError|RangeError|Traceback)\b/m,
  },
  { violation: "code", pattern: /=>|\bfunction\s*\(|\b(?:const|let|var)\s+\w+\s*=|\breturn\s*\{|`[^`\n]+`/ },
];

/** Violations of the "no JSON, endpoints, or code" rule in `text`; empty when it is plain prose. */
export function lintUserFacingText(text: string): string[] {
  return RULES.filter(({ pattern }) => pattern.test(text)).map(({ violation }) => violation);
}

/**
 * Streams model prose to the user one sentence/line at a time, dropping any
 * segment that fails `lintUserFacingText` (and everything inside code fences).
 * `push` buffers deltas; `flush` releases the tail at the end of a text block.
 */
export function createProseFilter(emit: (text: string) => void, onViolation: (violations: string[]) => void) {
  let buffer = "";
  let inFence = false;

  const release = (segment: string) => {
    if (/^\s*(?:```|~~~)/.test(segment)) {
      inFence = !inFence;
      onViolation(["code fence"]);
      return;
    }
    if (inFence) return;
    const violations = lintUserFacingText(segment);
    if (violations.length > 0) {
      onViolation(violations);
      return;
    }
    emit(segment);
  };

  return {
    push(delta: string) {
      buffer += delta;
      // A segment ends at a newline or after sentence punctuation followed by whitespace.
      for (let match = /\n|[.!?](?=\s)/.exec(buffer); match; match = /\n|[.!?](?=\s)/.exec(buffer)) {
        const end = match.index + match[0].length;
        // Keep the whitespace after a sentence with the sentence so spacing survives.
        const withSpace = match[0] === "\n" ? end : end + (/^[ \t]+/.exec(buffer.slice(end))?.[0].length ?? 0);
        release(buffer.slice(0, withSpace));
        buffer = buffer.slice(withSpace);
      }
    },
    flush() {
      if (buffer !== "") release(buffer);
      buffer = "";
      inFence = false;
    },
  };
}
