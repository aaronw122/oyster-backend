// Compressed JSON shape summary for the agent (`fetch_json`, `test_pearl`).
// Reimplements fmeval Summary.swift semantics: one `path: type = sample` line
// per leaf, arrays collapsed to their first element's shape plus a length.
//
//   data.stations[]: array(1834)
//   data.stations[].station_id: string = "72"
//   data.stations[].num_docks_available: number = 5
//   data.tags[]: array(3) of string = "a"
//
// `redact` drops every ` = sample` so only shape + types reach the LLM (§3).

const DEFAULT_MAX_LINES = 80;
const MAX_SAMPLE_CODE_POINTS = 40;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export function summarizeJson(value: unknown, opts: { redact: boolean; maxLines?: number }): string {
  const maxLines = Math.max(1, opts.maxLines ?? DEFAULT_MAX_LINES);
  const lines: string[] = [];
  walk(value, "", lines, opts.redact);
  if (lines.length <= maxLines) return lines.join("\n");
  const kept = lines.slice(0, maxLines);
  kept.push(`… (${lines.length - maxLines} more)`);
  return kept.join("\n");
}

function walk(value: unknown, path: string, lines: string[], redact: boolean): void {
  if (Array.isArray(value)) {
    const arrayPath = `${path}[]`;
    const header = `${arrayPath}: array(${value.length})`;
    const first: unknown = value[0];
    if (value.length === 0) {
      lines.push(header);
    } else if (first !== null && typeof first === "object") {
      lines.push(header);
      walk(first, arrayPath, lines, redact);
    } else {
      lines.push(`${header} of ${scalar(first, redact)}`);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      lines.push(`${path || "$"}: object(0)`);
      return;
    }
    for (const key of keys) {
      const segment = IDENTIFIER.test(key) ? key : `[${JSON.stringify(key)}]`;
      const childPath = path === "" || segment.startsWith("[") ? `${path}${segment}` : `${path}.${segment}`;
      walk((value as Record<string, unknown>)[key], childPath, lines, redact);
    }
    return;
  }
  lines.push(`${path || "$"}: ${scalar(value, redact)}`);
}

/** `type` or `type = sample` for a JSON scalar (null has no sample). */
function scalar(value: unknown, redact: boolean): string {
  if (value === null || value === undefined) return "null";
  const type = typeof value;
  if (redact) return type;
  if (typeof value === "string") {
    const codePoints = [...value];
    const sample =
      codePoints.length > MAX_SAMPLE_CODE_POINTS ? `${codePoints.slice(0, MAX_SAMPLE_CODE_POINTS).join("")}…` : value;
    return `string = ${JSON.stringify(sample)}`;
  }
  return `${type} = ${String(value)}`;
}
