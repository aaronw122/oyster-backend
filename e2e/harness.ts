import { expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lintUserFacingText } from "../src/agent/lint.ts";
import { type ChatEvent, ChatEventSchema, SIZES } from "../src/contract/index.ts";
import { type Database, openDb } from "../src/db/index.ts";
import { PearlStore } from "../src/store/pearls.ts";
import { UserStore } from "../src/store/users.ts";

/** Live end-to-end suites run only with `LIVE=1` (real network, and for chat suites a real model). */
export const LIVE = Boolean(process.env.LIVE);
export { SIZES };

const REPO_ROOT = resolve(import.meta.dir, "..");
const BOOT_TIMEOUT_MS = 20_000;

export type LiveServer = {
  baseUrl: string;
  token: string;
  /** The server's SQLite file, opened alongside it, for asserting what was stored. */
  db: Database;
  pearls: PearlStore;
  /** Everything the server printed so far (stdout + stderr). */
  logs: () => string;
  stop: () => Promise<void>;
};

/**
 * Boots the real server (`bun run src/index.ts`) on an ephemeral port with a
 * throwaway SQLite file and fresh secrets, then issues a bearer token for `userId`.
 * The child inherits this process's env, so OPENROUTER_API_KEY / RC_PAT / … apply.
 */
export async function startServer(userId = "e2e-user"): Promise<LiveServer> {
  const dir = mkdtempSync(join(tmpdir(), "oyster-e2e-"));
  const dbPath = join(dir, "oyster.db");
  const child = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: "0",
      DB_PATH: dbPath,
      OAUTH_STATE_SECRET: randomBytes(32).toString("hex"),
      TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  let output = "";
  let onOutput = () => {};
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });
      onOutput();
    }
  };
  void drain(child.stdout);
  void drain(child.stderr);

  const baseUrl = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start within ${BOOT_TIMEOUT_MS}ms:\n${output}`)), BOOT_TIMEOUT_MS);
    onOutput = () => {
      const match = /oyster listening on (\S+)/.exec(output);
      if (!match?.[1]) return;
      clearTimeout(timer);
      resolveUrl(match[1].replace(/\/+$/, ""));
    };
    void child.exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code} before listening:\n${output}`));
    });
  });

  // The server has applied migrations; this second connection only reads/writes rows.
  const db = openDb(dbPath);
  const token = new UserStore(db).issueToken(userId);
  return {
    baseUrl,
    token,
    db,
    pearls: new PearlStore(db),
    logs: () => output,
    stop: async () => {
      child.kill();
      await child.exited;
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Authenticated JSON request; returns the status and parsed body. */
export async function api(server: LiveServer, method: "GET" | "POST", path: string, body?: unknown) {
  const response = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${server.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

/**
 * Sends one chat message and returns every event of the turn. The stream is
 * parsed as SSE (`: ping` comments ignored); each `data:` payload must satisfy
 * `ChatEventSchema`, and the stream must end with exactly one `done`.
 */
export async function sendMessage(server: LiveServer, sessionId: string, message: string): Promise<ChatEvent[]> {
  const response = await fetch(`${server.baseUrl}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");
  if (!response.body) throw new Error("POST /messages returned no body");

  const events: ChatEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const takeBlock = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data === "") return; // keepalive comment
    events.push(ChatEventSchema.parse(JSON.parse(data)));
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.search(/\r?\n\r?\n/); end !== -1; end = buffer.search(/\r?\n\r?\n/)) {
      takeBlock(buffer.slice(0, end));
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
    }
  }
  if (buffer.trim() !== "") takeBlock(buffer);

  expect(events.at(-1)?.type).toBe("done");
  expect(events.filter((event) => event.type === "done")).toHaveLength(1);
  return events;
}

/** Everything the user reads in a conversation, as separate pieces for linting. */
export function userFacingProse(events: readonly ChatEvent[]): string[] {
  const pieces = [
    events.flatMap((event) => (event.type === "text" ? [event.delta] : [])).join(""),
  ];
  for (const event of events) {
    if (event.type === "question") pieces.push(event.text, ...(event.options ?? []));
    if (event.type === "unavailable" || event.type === "status" || event.type === "error") pieces.push(event.text);
  }
  return pieces.filter((piece) => piece.trim() !== "");
}

/** Asserts no user-facing piece contains URLs, JSON, endpoints, or code; reports the offending piece. */
export function expectPlainLanguage(events: readonly ChatEvent[]): void {
  const violations = userFacingProse(events).flatMap((piece) => {
    const found = lintUserFacingText(piece);
    return found.length === 0 ? [] : [{ piece, violations: found }];
  });
  expect(violations).toEqual([]);
}

/** Compact transcript for test logs (previews summarized, never secrets). */
export function transcript(events: readonly ChatEvent[]): string {
  const lines: string[] = [];
  let text = "";
  const flushText = () => {
    if (text.trim() !== "") lines.push(`  text: ${text.trim()}`);
    text = "";
  };
  for (const event of events) {
    if (event.type === "text") {
      text += event.delta;
      continue;
    }
    flushText();
    if (event.type === "question") lines.push(`  question: ${event.text}${event.options ? ` [${event.options.join(" | ")}]` : ""}`);
    else if (event.type === "preview") lines.push(`  preview: ${JSON.stringify(event.previews.small ?? event.previews)}`);
    else if (event.type === "saved") lines.push(`  saved: ${event.pearl.name} (${event.pearl.id})`);
    else if (event.type === "oauth") lines.push(`  oauth: ${event.provider}`);
    else if (event.type !== "done") lines.push(`  ${event.type}: ${event.text}`);
  }
  flushText();
  return lines.join("\n");
}
