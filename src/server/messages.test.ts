import { beforeEach, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { MockLanguageModelV4 } from "ai/test";
import { createTestEnv, type Script, scriptedModel, TEST_CONFIG, type TestEnv } from "../agent/testing.ts";
import { ApiErrorSchema, type ChatEvent, ChatEventSchema } from "../contract/index.ts";
import { type AppEnv, createApp } from "./app.ts";

let env: TestEnv;
let alice: string;
let bob: string;

beforeEach(() => {
  env = createTestEnv();
  alice = env.users.issueToken("alice");
  bob = env.users.issueToken("bob");
});

function appWith(model: MockLanguageModelV4 | undefined, config = TEST_CONFIG): Hono<AppEnv> {
  return createApp({
    config,
    db: env.db,
    pearls: env.pearls,
    users: env.users,
    runtime: env.services.runtime,
    oauth: env.services.oauth,
    agent: { ...env.services, config, model },
  });
}

const post = (app: Hono<AppEnv>, token: string | null, body: unknown) =>
  app.request("/messages", {
    method: "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** Parses an SSE body strictly: every frame is exactly `data: <ChatEvent JSON>`. */
async function events(res: Response): Promise<ChatEvent[]> {
  const body = await res.text();
  expect(body.endsWith("\n\n")).toBe(true);
  return body
    .slice(0, -2)
    .split("\n\n")
    .map((frame) => {
      expect(frame.startsWith("data: ")).toBe(true);
      expect(frame).not.toContain("\n");
      return ChatEventSchema.parse(JSON.parse(frame.slice("data: ".length)));
    });
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(ApiErrorSchema.parse(await res.json()).error.code).toBe(code);
}

describe("POST /messages", () => {
  test("requires a bearer token and a valid body", async () => {
    const app = appWith(scriptedModel([{ text: "Hi." }]));
    await expectError(await post(app, null, { sessionId: "s", message: "hi" }), 401, "unauthorized");
    await expectError(await post(app, alice, "{nope"), 400, "invalid_request");
    await expectError(await post(app, alice, { sessionId: "s" }), 400, "invalid_request");
    await expectError(await post(app, alice, { sessionId: "", message: "hi" }), 400, "invalid_request");
    await expectError(await post(app, alice, { sessionId: "s", message: "   " }), 400, "invalid_request");
  });

  test("streams ChatEvents as SSE and always ends with done", async () => {
    const script: Script = [
      { text: "Let me check.", calls: [{ tool: "ask_user", input: { question: "Where is your office?" } }] },
    ];
    const res = await post(appWith(scriptedModel(script)), alice, { sessionId: "s1", message: "Citi Bike docks near my office" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/event-stream");
    const stream = await events(res);
    expect(stream.at(-1)).toEqual({ type: "done" });
    expect(stream.filter((event) => event.type === "done")).toHaveLength(1);
    expect(stream.flatMap((event) => (event.type === "text" ? [event.delta] : [])).join("")).toBe("Let me check.");
    expect(stream).toContainEqual({ type: "question", id: expect.any(String), text: "Where is your office?" });
  });

  test("a model failure mid-stream becomes an error event followed by done", async () => {
    const model = scriptedModel(() => {
      throw new Error("upstream exploded");
    });
    const stream = await events(await post(appWith(model), alice, { sessionId: "s1", message: "hi" }));
    expect(stream.map((event) => event.type)).toEqual(["error", "done"]);
    expect(JSON.stringify(stream)).not.toContain("upstream");
  });

  test("without a configured model the stream says so plainly", async () => {
    const stream = await events(await post(appWith(undefined), alice, { sessionId: "s1", message: "hi" }));
    expect(stream.map((event) => event.type)).toEqual(["error", "done"]);
  });

  test("history persists across messages in a session", async () => {
    const model = scriptedModel([
      { calls: [{ tool: "ask_user", input: { question: "Where is your office?" } }] },
      { text: "Got it." },
    ]);
    const app = appWith(model);

    await events(await post(app, alice, { sessionId: "s1", message: "Citi Bike docks near my office" }));
    await events(await post(app, alice, { sessionId: "s1", message: "Union Square" }));

    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(secondPrompt).toContain("Citi Bike docks near my office");
    expect(secondPrompt).toContain("Where is your office?");
    expect(secondPrompt).toContain("Union Square");
  });

  test("a session belongs to one user", async () => {
    const model = scriptedModel([{ text: "Secret plans for the office." }]);
    const app = appWith(model);
    await events(await post(app, alice, { sessionId: "shared", message: "alice's private request" }));

    await expectError(await post(app, bob, { sessionId: "shared", message: "hi" }), 404, "not_found");
    expect(model.doStreamCalls).toHaveLength(1);

    // Bob's own session never sees Alice's history.
    await events(await post(app, bob, { sessionId: "bobs", message: "hi" }));
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).not.toContain("alice's private request");
  });

  test("a client disconnect aborts the model call", async () => {
    let modelSignal: AbortSignal | undefined;
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        modelSignal = options.abortSignal;
        started();
        // A model that never finishes on its own.
        return { stream: new ReadableStream({ start: (controller) => controller.enqueue({ type: "text-start", id: "t" }) }) };
      },
    });
    const client = new AbortController();
    const res = await appWith(model).request("/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${alice}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", message: "hi" }),
      signal: client.signal,
    });
    const reader = res.body?.getReader();
    await modelStarted;
    client.abort();
    await reader?.cancel();
    const signal = modelSignal;
    if (!signal) throw new Error("model was not called");
    if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    expect(signal.aborted).toBe(true);
  });
});

describe("POST /messages over a real server", () => {
  test("a turn that stays silent past the idle timeout keeps its stream open, pings, and ends with done", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        // Real delay on purpose: the behavior under test is Bun.serve's wall-clock idle timeout,
        // which fires about 4s after the last write even with idleTimeout: 1.
        await Bun.sleep(5_000);
        return scriptedModel([{ text: "Still here." }]).doStream({ prompt: [] });
      },
    });
    const app = createApp({
      config: TEST_CONFIG,
      db: env.db,
      pearls: env.pearls,
      users: env.users,
      runtime: env.services.runtime,
      agent: { ...env.services, model },
      ssePingIntervalMs: 200,
    });
    const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 1 });
    try {
      const res = await fetch(new URL("/messages", server.url), {
        method: "POST",
        headers: { Authorization: `Bearer ${alice}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "s1", message: "hi" }),
      });
      const body = await res.text();
      expect(body).toContain(": ping\n\n");
      const frames = body.split("\n\n").filter((frame) => frame.startsWith("data: "));
      const stream = frames.map((frame) => ChatEventSchema.parse(JSON.parse(frame.slice("data: ".length))));
      expect(stream.flatMap((event) => (event.type === "text" ? [event.delta] : [])).join("")).toBe("Still here.");
      expect(stream.at(-1)).toEqual({ type: "done" });
    } finally {
      server.stop(true);
    }
  }, 15_000);
});
