import type { Database } from "bun:sqlite";
import { type ModelMessage, modelMessageSchema } from "ai";
import { z } from "zod";
import { isoNow } from "../contract/index.ts";

/** Stored history caps: whole user turns are dropped from the front until both fit. */
export const MAX_HISTORY_MESSAGES = 120;
export const MAX_HISTORY_CHARS = 200_000;

const StoredMessagesSchema = z.array(modelMessageSchema);

/** Chat histories per `(sessionId, userId)`; a session id belongs to the user who created it. */
export class ChatSessionStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** The session's history, `[]` for a new session, or null when the id belongs to another user. */
  load(userId: string, sessionId: string): ModelMessage[] | null {
    const row = this.#db
      .query<{ user_id: string; messages: string }, { id: string }>("SELECT user_id, messages FROM chat_sessions WHERE id = $id")
      .get({ id: sessionId });
    if (!row) return [];
    if (row.user_id !== userId) return null;
    const parsed = StoredMessagesSchema.safeParse(JSON.parse(row.messages));
    if (!parsed.success) {
      console.warn(`[agent] discarding unreadable history for session ${sessionId}`);
      return [];
    }
    return parsed.data;
  }

  /** Stores `messages` (trimmed to the caps). Never takes over another user's session. */
  save(userId: string, sessionId: string, messages: readonly ModelMessage[]): void {
    const now = isoNow();
    this.#db
      .query(
        `INSERT INTO chat_sessions (id, user_id, messages, created_at, updated_at)
         VALUES ($id, $userId, $messages, $now, $now)
         ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at
         WHERE chat_sessions.user_id = excluded.user_id`,
      )
      .run({ id: sessionId, userId, messages: JSON.stringify(trimHistory(messages)), now });
  }
}

/**
 * Drops the oldest whole turns until the history fits both caps. Cuts only at
 * a user message so a tool result is never separated from its tool call. The
 * latest turn is always kept.
 */
export function trimHistory(messages: readonly ModelMessage[]): ModelMessage[] {
  const sizes = messages.map((message) => JSON.stringify(message).length);
  let chars = sizes.reduce((sum, size) => sum + size, 0);
  let start = 0;
  while (messages.length - start > MAX_HISTORY_MESSAGES || chars > MAX_HISTORY_CHARS) {
    let next = start + 1;
    while (next < messages.length && messages[next]?.role !== "user") next += 1;
    if (next >= messages.length) break;
    for (let index = start; index < next; index += 1) chars -= sizes[index] ?? 0;
    start = next;
  }
  return messages.slice(start);
}
