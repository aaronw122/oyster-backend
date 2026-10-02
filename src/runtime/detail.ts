import type { RunFailure } from "./run.ts";

/**
 * The one rule for what an LLM (agent or repair) may see of a failure. For
 * sensitive data only shapes and types reach the model: fit details are lengths
 * only and pass through; a message the transform threw itself is hidden (it is
 * free text that can quote any value); anything else (engine errors, fetch
 * failures) has quoted text and numbers masked. Non-sensitive failures are shown
 * as they are.
 */
export function modelSafeDetail(failure: RunFailure, sensitive: boolean): string {
  if (!sensitive || failure.stage === "fit") return failure.detail;
  if (failure.thrown !== undefined) return `transform failed: it threw ${failure.thrown} (message hidden)`;
  return failure.detail.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"…"').replace(/\d+(?:[.,]\d+)*/g, "#");
}
