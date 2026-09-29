import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { CREATE_SYSTEM_PROMPT } from "../../agent/prompt.ts";
import { runAgentTurn } from "../../agent/loop.ts";
import { ChatSessionStore } from "../../agent/sessions.ts";
import type { AgentServices } from "../../agent/tools.ts";
import { type ChatEvent, MessagesRequestSchema } from "../../contract/index.ts";
import type { AppDeps, AppEnv } from "../app.ts";
import { apiError } from "../errors.ts";

const MAX_MESSAGE_CHARS = 8_000;

/**
 * `POST /messages` (§2c): one user message in, a `text/event-stream` of
 * `data: <ChatEvent>\n\n` out, always ending with `{ type: "done" }`. Mounted
 * under the authenticated `/messages` prefix. Closing the connection aborts
 * the model call.
 */
export function messagesRoutes(deps: AppDeps): Hono<AppEnv> {
  const sessions = new ChatSessionStore(deps.db);
  const services: AgentServices = deps.agent ?? {
    runtime: deps.runtime,
    pearls: deps.pearls,
    oauth: deps.oauth,
    config: deps.config,
  };
  // One turn at a time per session: concurrent turns would interleave and overwrite history.
  const active = new Set<string>();

  return new Hono<AppEnv>().post("/", async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "invalid_request", "Request body must be valid JSON.");
    }
    const parsed = MessagesRequestSchema.safeParse(json);
    if (!parsed.success) return apiError(c, 400, "invalid_request", "Body must be { sessionId: string, message: string }.");
    const { sessionId, message } = parsed.data;
    if (message.trim() === "") return apiError(c, 400, "invalid_request", "message must not be empty.");
    if (message.length > MAX_MESSAGE_CHARS) {
      return apiError(c, 400, "invalid_request", `message must be at most ${MAX_MESSAGE_CHARS} characters.`);
    }

    const userId = c.var.userId;
    const history = sessions.load(userId, sessionId);
    if (history === null) return apiError(c, 404, "not_found", "No chat session with that id belongs to this account.");
    if (active.has(sessionId)) return apiError(c, 409, "session_busy", "This chat is still answering the previous message.");
    active.add(sessionId);

    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      // Tool events are emitted synchronously; writes are chained to keep order.
      let writes = Promise.resolve();
      const emit = (event: ChatEvent) => {
        writes = writes.then(() => stream.writeSSE({ data: JSON.stringify(event) }));
      };
      try {
        const turn = await runAgentTurn({
          userId,
          sessionId,
          system: CREATE_SYSTEM_PROMPT,
          history,
          userMessage: message,
          services,
          emit,
          abortSignal: abort.signal,
        });
        sessions.save(userId, sessionId, turn.messages);
      } catch (error) {
        console.error(`[POST /messages] session ${sessionId}`, error);
        emit({ type: "error", text: "Something went wrong on my side. Please try again." });
      } finally {
        active.delete(sessionId);
        emit({ type: "done" });
        await writes.catch(() => undefined);
      }
    });
  });
}
