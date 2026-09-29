import { z } from "zod";
import type { Builtin, BuiltinContext } from "../sources/builtins.ts";
import { SourceError } from "../sources/types.ts";

// Recurse Center hub check-ins: `GET /api/v1/hub_visits?date=YYYY-MM-DD`, authed
// with a server-held personal access token (RC_PAT) as a Bearer header. The API
// pages with `per_page` (1–200) and `page`; an unknown or revoked token answers
// 401/403 or even 404 `{"message":"not_found"}`.

const HUB_VISITS_URL = "https://www.recurse.com/api/v1/hub_visits";
const TIMEOUT_MS = 8_000;
const PER_PAGE = 200;
/** 10 pages × 200 is far beyond any real day at the hub; stops a misbehaving API from looping. */
const MAX_PAGES = 10;
const HUB_TIME_ZONE = "America/New_York";
const NOT_SET_UP = "Recurse Center isn't set up on this server yet.";

export type RecurseVisitor = { id: number; name: string; notes: string | null };
export type RecurseHubData = { date: string; count: number; visitors: RecurseVisitor[] };

type HubVisitRow = { person?: { id?: unknown; name?: unknown } | null; notes?: unknown };

const paramsSchema = z.object({
  date: z
    .string()
    .trim()
    .regex(/^(today|\d{4}-\d{2}-\d{2})$/, 'use "today" or a date like 2026-09-29')
    .default("today"),
});

export const recurse: Builtin = {
  name: "recurse",
  description: [
    "Who is checked in, or planning to be, at the Recurse Center hub in New York on a given day.",
    'Params: date (optional; "today" by default, meaning today in New York, or a date like 2026-09-29).',
    "Returns { date, count, visitors: [{ id, name, notes }] } with visitors sorted by name;",
    "notes is the visitor's short check-in note, or null when they left none.",
  ].join(" "),
  params: paramsSchema,
  sensitive: true,
  ttlMs: 2 * 60_000,
  async fetch(rawParams, ctx) {
    const token = ctx.env.RC_PAT;
    // A server setting, not a user connection: never `auth_missing` (that asks the user to connect).
    if (!token) throw new SourceError("invalid_params", NOT_SET_UP);
    const date = resolveDate(paramsSchema.parse(rawParams).date, new Date());

    const byId = new Map<number, RecurseVisitor>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const rows = await fetchPage(date, page, token, ctx);
      for (const visitor of rows.map(normalizeVisit)) {
        if (visitor) byId.set(visitor.id, visitor);
      }
      if (rows.length < PER_PAGE) break;
    }
    const visitors = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
    return { date, count: visitors.length, visitors } satisfies RecurseHubData;
  },
};

/** The calendar date (YYYY-MM-DD) at the hub, in New York, at `now`. */
export function hubDate(now: Date): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: HUB_TIME_ZONE }).format(now);
}

function resolveDate(param: string, now: Date): string {
  if (param === "today") return hubDate(now);
  const parsed = new Date(`${param}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== param) {
    throw new SourceError("invalid_params", `"${param}" isn't a real date. Use one like 2026-09-29.`);
  }
  return param;
}

async function fetchPage(date: string, page: number, token: string, ctx: BuiltinContext): Promise<HubVisitRow[]> {
  const url = new URL(HUB_VISITS_URL);
  url.searchParams.set("date", date);
  url.searchParams.set("per_page", String(PER_PAGE));
  url.searchParams.set("page", String(page));
  let response: Response;
  let text: string;
  try {
    response = await ctx.fetch(url, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await response.text();
  } catch {
    throw new SourceError("network", "Couldn't reach Recurse Center.");
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new SourceError("invalid_params", NOT_SET_UP);
  }
  if (response.status === 429) throw new SourceError("http", "Recurse Center is busy right now. Try again in a minute.");
  if (!response.ok) {
    throw new SourceError("http", `Recurse Center isn't responding right now (status ${response.status}).`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!Array.isArray(body)) throw new SourceError("parse", "Recurse Center sent something unexpected.");
  return body as HubVisitRow[];
}

function normalizeVisit(row: HubVisitRow): RecurseVisitor | null {
  const id = row?.person?.id;
  const name = row?.person?.name;
  if (typeof id !== "number" || typeof name !== "string" || name.trim() === "") return null;
  const notes = typeof row.notes === "string" ? row.notes.trim() : "";
  return { id, name: name.trim(), notes: notes === "" ? null : notes };
}
