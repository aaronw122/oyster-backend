import { beforeEach, describe, expect, test } from "bun:test";
import type { DraftPearl } from "../runtime/index.ts";
import { runAgentTurn } from "./loop.ts";
import { CREATE_SYSTEM_PROMPT } from "./prompt.ts";
import { createTestEnv, modelVisible, type Script, scriptedModel, type TestEnv, toolResultsSeen } from "./testing.ts";

const weatherDraft: DraftPearl = {
  sources: [{ id: "w", url: "https://api.weather.test/now?lat={inputs.lat}", method: "GET" }],
  inputs: { lat: "40.7" },
  transform: `(s) => ({ value: s.w.temp + "°", subtitle: "Now" })`,
};

const bankDraft: DraftPearl = {
  sources: [{ id: "b", builtin: "bank", method: "GET" }],
  inputs: {},
  transform: `(s, inputs, std) => ({ value: std.formatMoney(s.b.accounts[0].current), subtitle: s.b.accounts[0].name })`,
};

let env: TestEnv;
beforeEach(() => {
  env = createTestEnv();
  env.users.issueToken("alice");
});

async function turn(script: Script, message = "Show me something", limits?: Parameters<typeof runAgentTurn>[0]["limits"]) {
  const model = scriptedModel(script);
  const result = await runAgentTurn({
    userId: "alice",
    sessionId: "s1",
    system: CREATE_SYSTEM_PROMPT,
    history: [],
    userMessage: message,
    services: env.services,
    emit: env.emit,
    model,
    limits,
  });
  return { ...result, model };
}

describe("turn-ending tools", () => {
  test("ask_user emits a question and ends the turn", async () => {
    const { endedBy, model } = await turn([
      { calls: [{ tool: "ask_user", input: { question: "Where is your office?", options: ["Midtown", "Downtown"] } }] },
      { text: "should never run" },
    ]);
    expect(endedBy).toBe("ask_user");
    expect(model.doStreamCalls).toHaveLength(1);
    expect(env.events).toEqual([
      { type: "question", id: expect.any(String), text: "Where is your office?", options: ["Midtown", "Downtown"] },
    ]);
  });

  test("ask_user with code or URLs is bounced back to the model instead of shown", async () => {
    const { model } = await turn([
      { calls: [{ tool: "ask_user", input: { question: "Use https://api.test/v2/stations?" } }] },
      { text: "Okay." },
    ]);
    expect(env.events.some((event) => event.type === "question")).toBe(false);
    expect(JSON.stringify(toolResultsSeen(model, "ask_user"))).toContain("URL");
  });

  test("start_oauth sends the sign-in URL to the app only", async () => {
    const { endedBy, model, messages } = await turn([{ calls: [{ tool: "start_oauth", input: { provider: "bank" } }] }]);
    expect(endedBy).toBe("oauth");
    const oauth = env.events.find((event) => event.type === "oauth");
    if (oauth?.type !== "oauth") throw new Error("no oauth event");
    expect(oauth.provider).toBe("bank");
    expect(oauth.url).toStartWith("https://oyster.test/oauth/bank/start?state=");
    const state = new URL(oauth.url).searchParams.get("state") ?? "";
    expect(state.length).toBeGreaterThan(10);
    for (const visible of [modelVisible(model), JSON.stringify(messages)]) {
      expect(visible).not.toContain(state);
      expect(visible).not.toContain("/oauth/bank/start");
    }
  });

  test("start_oauth refuses providers that aren't pre-registered", async () => {
    const { model } = await turn([{ calls: [{ tool: "start_oauth", input: { provider: "myspace" } }] }, { text: "Sorry." }]);
    expect(env.events.some((event) => event.type === "oauth")).toBe(false);
    expect(JSON.stringify(toolResultsSeen(model, "start_oauth"))).toContain("not a pre-registered");
  });
});

describe("preview and save", () => {
  test("preview_pearl sends real values to the app", async () => {
    const { model } = await turn([{ calls: [{ tool: "preview_pearl", input: weatherDraft }] }, { text: "Here it is." }]);
    const preview = env.events.find((event) => event.type === "preview");
    if (preview?.type !== "preview") throw new Error("no preview event");
    expect(preview.previews.inline).toEqual({ value: "72°" });
    expect(preview.previews.small).toEqual({ value: "72°", subtitle: "Now" });
    expect(env.fetched).toEqual(["https://api.weather.test/now?lat=40.7"]);
    expect(JSON.stringify(toolResultsSeen(model, "preview_pearl"))).toContain("72°");
  });

  test("a question asked alongside a preview reaches the app after the preview", async () => {
    await turn([
      {
        calls: [
          { tool: "preview_pearl", input: weatherDraft },
          { tool: "ask_user", input: { question: "Save this?", options: ["Save it", "Change something"] } },
        ],
      },
    ]);
    expect(env.events.filter((event) => event.type !== "status").map((event) => event.type)).toEqual(["preview", "question"]);
  });

  test("sensitive data: the model sees only shapes while the app preview has real values", async () => {
    env.services.oauth?.tokens.save("alice", "bank", { accessToken: "tok-secret-123" });
    env.payload.current = { accounts: [{ name: "Everyday Checking", current: 4821.37 }] };
    const { model } = await turn([
      { calls: [{ tool: "fetch_json", input: { url: "https://api.bank.test/balances", auth: "bank" } }] },
      { calls: [{ tool: "test_pearl", input: bankDraft }] },
      { calls: [{ tool: "preview_pearl", input: bankDraft }] },
      { text: "Here's your balance widget." },
    ]);

    const preview = env.events.find((event) => event.type === "preview");
    if (preview?.type !== "preview") throw new Error("no preview event");
    expect(preview.previews.small).toEqual({ value: "$4,821.37", subtitle: "Everyday Checking" });

    const seen = modelVisible(model);
    for (const secret of ["4821", "4,821", "Everyday", "Checking", "tok-secret-123"]) expect(seen).not.toContain(secret);
    // Shapes still reach the model so it can write the transform.
    expect(JSON.stringify(toolResultsSeen(model, "fetch_json"))).toContain("accounts[].current: number");
    expect(JSON.stringify(toolResultsSeen(model, "test_pearl"))).toContain("value: string");
  });

  test("a URL source signed in with a sensitive provider is redacted like a sensitive builtin; plain URLs are not", async () => {
    env.services.oauth?.tokens.save("alice", "bank", { accessToken: "tok-secret-123" });
    env.payload.current = { balance: 4821.37, owner: "Jane Quinn" };
    const transform = `(s) => ({ value: String(s.b.balance), subtitle: s.b.owner })`;
    const signedIn: DraftPearl = {
      sources: [{ id: "b", url: "https://api.bank.test/balance", method: "GET", auth: { provider: "bank" } }],
      inputs: {},
      transform,
    };
    const { model } = await turn([
      { calls: [{ tool: "test_pearl", input: signedIn }] },
      { calls: [{ tool: "preview_pearl", input: signedIn }] },
      { text: "Done." },
    ]);
    const seen = modelVisible(model);
    for (const secret of ["4821", "Jane", "Quinn", "tok-secret-123"]) expect(seen).not.toContain(secret);
    expect(JSON.stringify(toolResultsSeen(model, "test_pearl"))).toContain("value: string");
    expect(JSON.stringify(toolResultsSeen(model, "preview_pearl"))).toContain("value: string");

    const plain: DraftPearl = { ...signedIn, sources: [{ id: "b", url: "https://api.public.test/balance", method: "GET" }] };
    const open = await turn([
      { calls: [{ tool: "test_pearl", input: plain }] },
      { calls: [{ tool: "preview_pearl", input: plain }] },
      { text: "Done." },
    ]);
    expect(JSON.stringify(toolResultsSeen(open.model, "test_pearl"))).toContain("Jane Quinn");
    expect(JSON.stringify(toolResultsSeen(open.model, "preview_pearl"))).toContain("Jane Quinn");
  });

  test("test_pearl reports which sizes overflow along with the raw output", async () => {
    env.payload.current = { temp: 72 };
    const { model } = await turn([
      { calls: [{ tool: "test_pearl", input: { ...weatherDraft, transform: `(s) => ({ value: "x".repeat(200) + s.w.temp })` } }] },
      { text: "Done." },
    ]);
    const seen = JSON.stringify(toolResultsSeen(model, "test_pearl"));
    expect(seen).toContain('"fitsAllSizes":false');
    expect(seen).toMatch(/"tooLongFor":\[[^\]]*"inline"/);
    expect(seen).toContain('72"');
  });

  test("save_pearl persists via savePearl and emits saved", async () => {
    const { endedBy } = await turn([
      { calls: [{ tool: "preview_pearl", input: weatherDraft }] },
      { calls: [{ tool: "save_pearl", input: { ...weatherDraft, name: "Temp now" } }] },
      { text: "should never run" },
    ]);
    expect(endedBy).toBe("saved");
    const saved = env.events.find((event) => event.type === "saved");
    if (saved?.type !== "saved") throw new Error("no saved event");
    expect(saved.pearl.name).toBe("Temp now");
    const pearl = env.pearls.get("alice", saved.pearl.id);
    expect(pearl?.transform).toBe(weatherDraft.transform);
    expect(pearl?.lastGood?.small?.output).toEqual({ value: "72°", subtitle: "Now" });
  });

  test("a preview shown in an earlier turn lets the user approve the save in the next one", async () => {
    const first = await turn([
      { calls: [{ tool: "preview_pearl", input: weatherDraft }] },
      { calls: [{ tool: "ask_user", input: { question: "Save this as Temp now?", options: ["Save", "Change it"] } }] },
    ]);
    expect(first.endedBy).toBe("ask_user");
    const second = await runAgentTurn({
      userId: "alice",
      sessionId: "s1",
      system: CREATE_SYSTEM_PROMPT,
      history: first.messages,
      userMessage: "Save",
      services: env.services,
      emit: env.emit,
      model: scriptedModel([{ calls: [{ tool: "save_pearl", input: { ...weatherDraft, name: "Temp now" } }] }]),
    });
    expect(second.endedBy).toBe("saved");
    expect(env.pearls.list("alice").map((pearl) => pearl.name)).toEqual(["Temp now"]);
  });

  test("save_pearl refuses a definition the user hasn't previewed", async () => {
    const { model } = await turn([
      { calls: [{ tool: "save_pearl", input: { ...weatherDraft, name: "Temp now" } }] },
      { text: "Let me show you first." },
    ]);
    expect(env.events.some((event) => event.type === "saved")).toBe(false);
    expect(env.pearls.list("alice")).toEqual([]);
    expect(JSON.stringify(toolResultsSeen(model, "save_pearl"))).toContain("preview_pearl");
  });

  test("a save whose live run fails reports the technical detail to the model", async () => {
    const failing: DraftPearl = { ...weatherDraft, transform: `(s) => { if (s.w.broken) throw new Error("feed broke"); return { value: "ok" }; }` };
    const { model } = await turn((index) => {
      if (index === 0) return { calls: [{ tool: "preview_pearl", input: failing }] };
      if (index === 1) {
        env.payload.current = { broken: true };
        return { calls: [{ tool: "save_pearl", input: { ...failing, name: "Fragile" } }] };
      }
      return { text: "The data source is having trouble." };
    });
    expect(env.events.some((event) => event.type === "saved")).toBe(false);
    expect(env.pearls.list("alice")).toEqual([]);
    const result = JSON.stringify(toolResultsSeen(model, "save_pearl"));
    expect(result).toContain("transform");
    expect(result).toContain("feed broke");
  });
});

describe("limits", () => {
  test("running out of tool calls forces report_unavailable", async () => {
    const { endedBy, model } = await turn(
      (_index, options) =>
        options.toolChoice?.type === "tool"
          ? { calls: [{ tool: "report_unavailable", input: { message: "I couldn't find that data." } }] }
          : { calls: [{ tool: "find_builtin", input: {} }] },
      "Show me something",
      { maxToolCalls: 2 },
    );
    expect(endedBy).toBe("limit");
    expect(model.doStreamCalls.at(-1)?.toolChoice).toEqual({ type: "tool", toolName: "report_unavailable" });
    expect(env.events.filter((event) => event.type === "unavailable")).toEqual([
      { type: "unavailable", text: "I couldn't find that data." },
    ]);
  });

  test("hitting the step cap still tells the user plainly when the model won't comply", async () => {
    const { endedBy, model } = await turn([{ calls: [{ tool: "web_search", input: { query: "bike api" } }] }], "x", {
      maxSteps: 3,
    });
    expect(endedBy).toBe("limit");
    expect(model.doStreamCalls).toHaveLength(3);
    const unavailable = env.events.filter((event) => event.type === "unavailable");
    expect(unavailable).toHaveLength(1);
  });

  test("fetch probes are capped", async () => {
    const { endedBy } = await turn(
      (_index, options) =>
        options.toolChoice?.type === "tool"
          ? { calls: [{ tool: "report_unavailable", input: { message: "No usable source." } }] }
          : { calls: [{ tool: "fetch_json", input: { url: "https://api.test/x" } }] },
      "x",
      { maxFetchProbes: 2 },
    );
    expect(endedBy).toBe("limit");
    expect(env.fetched).toHaveLength(2);
  });
});

describe("fetch_json", () => {
  test("private addresses are refused without a request", async () => {
    const { model } = await turn([{ calls: [{ tool: "fetch_json", input: { url: "http://127.0.0.1/admin" } }] }, { text: "Hmm." }]);
    expect(env.fetched).toEqual([]);
    expect(JSON.stringify(toolResultsSeen(model, "fetch_json"))).toContain("forbidden_url");
  });

  test("public JSON comes back as a summary with samples", async () => {
    env.payload.current = { data: { stations: [{ station_id: "72", num_docks_available: 5 }] } };
    const { model } = await turn([{ calls: [{ tool: "fetch_json", input: { url: "https://gbfs.test/status.json" } }] }, { text: "ok" }]);
    const result = JSON.stringify(toolResultsSeen(model, "fetch_json"));
    expect(result).toContain("data.stations[].num_docks_available: number = 5");
  });
});

describe("prose", () => {
  test("text streams to the app, and code/JSON/URLs are withheld", async () => {
    const { endedBy } = await turn([
      {
        text: "Found it. Here is the data: {\"docks\": 5}\n```js\nconst x = 1;\n```\nThe nearest station has 5 docks. See https://citibikenyc.com/map for more.",
      },
    ]);
    expect(endedBy).toBe("text");
    const text = env.events.flatMap((event) => (event.type === "text" ? [event.delta] : [])).join("");
    expect(text).toContain("Found it.");
    expect(text).toContain("The nearest station has 5 docks.");
    for (const leaked of ["docks\"", "```", "const x", "https://"]) expect(text).not.toContain(leaked);
  });

  test("a model failure emits a plain error", async () => {
    const result = await turn(() => {
      throw new Error("upstream 500 at https://openrouter.ai/api");
    }, "hi");
    expect(result.endedBy).toBe("error");
    expect(env.events).toEqual([{ type: "error", text: expect.not.stringContaining("openrouter") }]);
    expect(result.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});
