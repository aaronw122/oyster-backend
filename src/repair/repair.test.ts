import { beforeEach, describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { createTestEnv, modelVisible, type Script, scriptedModel, type TestEnv, toolResultsSeen } from "../agent/testing.ts";
import { type Pearl, type SavePearlRequest, SIZES, type Size } from "../contract/index.ts";
import { getPearlData, savePearl } from "../runtime/index.ts";
import { RepairQueue } from "./queue.ts";
import { createRepairer, type Repairer } from "./worker.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const weather: SavePearlRequest = {
  name: "Temp now",
  inputs: {},
  sources: [{ id: "w", url: "https://api.weather.test/now", method: "GET" }],
  transform: `(s) => ({ value: s.w.current.temp + "°", subtitle: s.w.current.cond })`,
};
const FIXED = `(s) => ({ value: s.w.now.temp + "°", subtitle: s.w.now.cond })`;
const STILL_BROKEN = `(s) => ({ value: s.w.current.temp + "°" })`;

let env: TestEnv;
let clock: number;
let attempts: number;

beforeEach(() => {
  env = createTestEnv();
  env.users.issueToken("alice");
  clock = 1_000_000;
  attempts = 0;
});

/** Wires a queue with a scripted repair model into the runtime's refresh-failure hook. */
function wire(model: MockLanguageModelV4, limits?: { maxToolCalls?: number }) {
  const repairer = createRepairer(env.services, { model, limits });
  const counted: Repairer = (...args) => {
    attempts += 1;
    return repairer(...args);
  };
  const queue = new RepairQueue({ pearls: env.pearls, repair: counted, now: () => clock });
  env.services.runtime.onRefreshFailure = (pearl, failure, ctx) => queue.enqueue(pearl, failure, ctx);
  return queue;
}

async function save(body: SavePearlRequest): Promise<Pearl> {
  const result = await savePearl("alice", body, env.services.runtime);
  if (!result.ok) throw new Error(`save failed: ${JSON.stringify(result)}`);
  return result.pearl;
}

/** Refreshes `sizes`, then waits for the deferred hook and any repair it started. */
async function refresh(queue: RepairQueue, pearl: Pearl, sizes: readonly Size[] = SIZES) {
  const results = await Promise.all(sizes.map((size) => getPearlData("alice", pearl.id, size, env.services.runtime)));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await queue.idle();
  return results;
}

const repairRuns = (pearlId: string) =>
  env.db
    .query<{ ok: number; error: string | null }, [string]>("SELECT ok, error FROM runs WHERE pearl_id = ? AND kind = 'repair' ORDER BY id")
    .all(pearlId);

const submit = (transform: string): Script => [{ calls: [{ tool: "submit_repair", input: { transform, reason: "feed renamed current to now" } }] }];

describe("repair", () => {
  test("a four-size failure burst runs one repair; the passing fix ships as a new version", async () => {
    env.payload.current = { current: { temp: 72, cond: "Sunny" } };
    const pearl = await save(weather);
    env.payload.current = { now: { temp: 68, cond: "Cloudy" } };
    const model = scriptedModel(submit(FIXED));
    const queue = wire(model);

    const burst = await refresh(queue, pearl);
    expect(burst.map((result) => result.status === 200 && result.body.stale)).toEqual([true, true, true, true]);
    expect(attempts).toBe(1);
    expect(model.doStreamCalls).toHaveLength(1);
    const told = modelVisible(model);
    expect(told).toContain("s.w.current.temp");
    expect(told).toContain("now.temp: number = 68");

    const repaired = env.pearls.getById(pearl.id);
    expect(repaired).toMatchObject({ version: 2, status: "ok", transform: FIXED });
    for (const size of SIZES) expect(repaired?.lastGood?.[size]).toMatchObject({ version: 2, output: { value: "68°" } });
    expect(repairRuns(pearl.id)).toEqual([{ ok: 1, error: null }]);
    expect(env.pearls.listVersions(pearl.id).map((v) => [v.version, v.transform, v.reason])).toEqual([
      [1, weather.transform, "create"],
      [2, FIXED, "repair: feed renamed current to now"],
    ]);

    const fresh = await getPearlData("alice", pearl.id, "small", env.services.runtime);
    expect(fresh).toMatchObject({ status: 200, body: { stale: false, version: 2, output: { value: "68°" } } });
    expect(env.pearls.rollback(pearl.id, 1)).toMatchObject({ version: 3, transform: weather.transform });
  });

  test("a fix that fails its live run is rejected, and attempts back off and then give up", async () => {
    env.payload.current = { current: { temp: 72, cond: "Sunny" } };
    const pearl = await save(weather);
    env.payload.current = { now: { temp: 68, cond: "Cloudy" } };
    const model = scriptedModel(submit(STILL_BROKEN));
    const queue = wire(model, { maxToolCalls: 2 });

    await refresh(queue, pearl);
    expect(attempts).toBe(1);
    expect(toolResultsSeen(model, "submit_repair")).toContainEqual({ type: "json", value: expect.objectContaining({ ok: false, stage: "transform" }) });
    const afterFirst = env.pearls.getById(pearl.id);
    expect(afterFirst).toMatchObject({ version: 1, status: "broken", transform: weather.transform });
    expect(afterFirst?.lastGood?.small).toMatchObject({ version: 1, output: { value: "72°" } });
    expect(repairRuns(pearl.id)).toEqual([{ ok: 0, error: expect.stringContaining("no passing fix") }]);

    // Within the backoff window: still broken, still stale last-good, no new attempt.
    clock += 4 * MINUTE;
    const [stale] = await refresh(queue, pearl, ["small"]);
    expect(stale).toMatchObject({ status: 200, body: { stale: true, output: { value: "72°" } } });
    expect(attempts).toBe(1);

    // 5m → 1h → 6h between attempts, then no more than four in a day.
    for (const wait of [MINUTE, HOUR, 6 * HOUR]) {
      clock += wait;
      await refresh(queue, pearl, ["small"]);
    }
    expect(attempts).toBe(4);
    clock += 6 * HOUR;
    await refresh(queue, pearl, ["small"]);
    expect(attempts).toBe(4);
    expect(env.pearls.getById(pearl.id)).toMatchObject({ version: 1, status: "broken" });
    expect(env.pearls.listVersions(pearl.id)).toHaveLength(1);

    // Once the first attempt is a day old, one more is allowed.
    clock += 11 * HOUR;
    await refresh(queue, pearl, ["small"]);
    expect(attempts).toBe(5);

    // The data comes back in the old shape: a clean refresh at every size clears "broken".
    env.payload.current = { current: { temp: 70, cond: "Clear" } };
    await refresh(queue, pearl, ["small"]);
    expect(env.pearls.getById(pearl.id)?.status).toBe("ok");
  });

  test("a sensitive Pearl's values never reach the repair model", async () => {
    const bank: SavePearlRequest = {
      name: "Checking",
      inputs: { accountMask: "6789" },
      sources: [{ id: "b", url: "https://bank.test/balance", method: "GET", sensitive: true }],
      transform: `(s, inputs, std) => {
        if (!s.b.account) throw new Error("no account in " + JSON.stringify(s.b));
        return { value: std.formatMoney(s.b.account.balance), subtitle: s.b.account.owner };
      }`,
    };
    env.payload.current = { account: { balance: 4821.37, owner: "Jane Quinn" } };
    const pearl = await save(bank);
    env.payload.current = { acct: { balance: 5310.02, owner: "Jane Quinn" } };
    const model = scriptedModel([
      { calls: [{ tool: "test_pearl", input: { transform: `(s) => ({ value: String(s.b.acct.balance), subtitle: s.b.acct.owner })` } }] },
      {
        calls: [
          {
            tool: "submit_repair",
            input: { transform: `(s, inputs, std) => ({ value: std.formatMoney(s.b.acct.balance), subtitle: s.b.acct.owner })`, reason: "account renamed to acct" },
          },
        ],
      },
    ]);
    const queue = wire(model);

    await refresh(queue, pearl);
    expect(env.pearls.getById(pearl.id)).toMatchObject({ version: 2, status: "ok", lastGood: { small: { output: { value: "$5,310.02" } } } });
    const told = modelVisible(model);
    expect(told).toContain("acct.balance: number");
    for (const value of ["4821", "4,821", "5310", "5,310", "Jane", "Quinn", "6789"]) expect(told).not.toContain(value);
  });

  test("repair redacts a sensitive-provider source even when the hook says it isn't sensitive", async () => {
    env.services.oauth?.tokens.save("alice", "bank", { accessToken: "tok-secret-123" });
    const body: SavePearlRequest = {
      name: "Checking",
      inputs: {},
      sources: [{ id: "b", url: "https://api.bank.test/balance", method: "GET", auth: { provider: "bank" } }],
      transform: `(s, inputs, std) => ({ value: std.formatMoney(s.b.account.balance), subtitle: s.b.account.owner })`,
    };
    env.payload.current = { account: { balance: 4821.37, owner: "Jane Quinn" } };
    const pearl = await save(body);
    env.payload.current = { acct: { balance: 5310.02, owner: "Jane Quinn" } };
    const model = scriptedModel([{ text: "Giving up." }]);
    const failure = { stage: "transform" as const, message: "broken", detail: "transform failed (runtime): no account" };
    await createRepairer(env.services, { model })(pearl, failure, { sensitive: false });
    const told = modelVisible(model);
    expect(told).toContain("acct.balance: number");
    for (const value of ["5310", "5,310", "Jane", "Quinn", "tok-secret-123"]) expect(told).not.toContain(value);
  });

  test("a value a sensitive transform puts in its own error never reaches the repair model", async () => {
    const hub: SavePearlRequest = {
      name: "Hub notes",
      inputs: {},
      sources: [{ id: "hub", url: "https://hub.test/visitors", method: "GET", sensitive: true }],
      transform: `(s) => { const v = s.hub.visitors[0]; if (!v.notes) throw new Error("no note for " + v.name); return { value: v.notes }; }`,
    };
    env.payload.current = { visitors: [{ id: 1, name: "Ada Lovelace", notes: "Hi" }] };
    const pearl = await save(hub);
    env.payload.current = { visitors: [{ id: 1, name: "Ada Lovelace", notes: null }] };
    const model = scriptedModel([{ calls: [{ tool: "test_pearl", input: { transform: hub.transform } }] }, { text: "Giving up." }]);
    const queue = wire(model);

    await refresh(queue, pearl, ["small"]);
    const told = modelVisible(model);
    // The repair message and the test_pearl result both name the error but hide its text.
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain("Error (message hidden)");
    expect(JSON.stringify(toolResultsSeen(model, "test_pearl"))).toContain("Error (message hidden)");
    for (const value of ["Ada", "Lovelace"]) expect(told).not.toContain(value);
  });

  test("while a repair runs the Pearl is 'repairing' and refreshes still serve last-good", async () => {
    env.payload.current = { current: { temp: 72, cond: "Sunny" } };
    const pearl = await save(weather);
    env.payload.current = { now: { temp: 68, cond: "Cloudy" } };
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = scriptedModel(submit(FIXED));
    const gated = new MockLanguageModelV4({
      doStream: async (options) => {
        await gate;
        return inner.doStream(options);
      },
    });
    const queue = wire(gated);

    await getPearlData("alice", pearl.id, "small", env.services.runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(env.pearls.getById(pearl.id)?.status).toBe("repairing");
    const during = await getPearlData("alice", pearl.id, "medium", env.services.runtime);
    expect(during).toMatchObject({ status: 200, body: { stale: true, version: 1, output: { value: "72°" } } });
    expect(attempts).toBe(1);

    release();
    await queue.idle();
    expect(env.pearls.getById(pearl.id)).toMatchObject({ version: 2, status: "ok" });
  });

  test("a source that is down never reaches the model and costs no attempts", async () => {
    env.payload.current = { current: { temp: 72, cond: "Sunny" } };
    const pearl = await save(weather);
    const model = scriptedModel(submit(FIXED));
    const queue = wire(model);
    const up = env.services.runtime.fetch;
    env.services.runtime.fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;

    for (let i = 0; i < 6; i++) {
      await refresh(queue, pearl, ["small"]);
      clock += 15 * MINUTE;
    }
    expect(model.doStreamCalls).toHaveLength(0);
    expect(env.pearls.getById(pearl.id)).toMatchObject({ version: 1, status: "broken" });
    expect(repairRuns(pearl.id)).toEqual([]);

    // The source comes back in a new shape: repair runs right away, with no backoff or used-up budget.
    env.services.runtime.fetch = up;
    env.payload.current = { now: { temp: 68, cond: "Cloudy" } };
    await refresh(queue, pearl, ["small"]);
    expect(attempts).toBe(1);
    expect(env.pearls.getById(pearl.id)).toMatchObject({ version: 2, status: "ok" });
  });

  test("a source that keeps flipping shape gets at most four repairs a day, even when each succeeds", async () => {
    const shapes = [{ now: { temp: 68, cond: "Cloudy" } }, { current: { temp: 72, cond: "Sunny" } }];
    env.payload.current = shapes[1];
    const pearl = await save(weather);
    const model = scriptedModel((_index, options) => {
      const transform = JSON.stringify(options.prompt).includes("now.temp: number") ? FIXED : weather.transform;
      return { calls: [{ tool: "submit_repair", input: { transform, reason: "feed shape flipped" } }] };
    });
    const queue = wire(model);

    for (let i = 0; i < 96; i++) {
      env.payload.current = shapes[i % 2];
      await refresh(queue, pearl, ["small"]);
      clock += 15 * MINUTE;
    }
    expect(attempts).toBe(4);
    expect(model.doStreamCalls).toHaveLength(4);
    expect(env.pearls.getById(pearl.id)?.version).toBe(5);
  });

  test("a Pearl left 'repairing' by a restart recovers on a clean refresh", async () => {
    env.payload.current = { current: { temp: 72, cond: "Sunny" } };
    const pearl = await save(weather);
    const queue = wire(scriptedModel(submit(FIXED)));
    env.pearls.setStatus(pearl.id, "repairing");

    await refresh(queue, pearl, ["small"]);
    expect(env.pearls.getById(pearl.id)?.status).toBe("ok");
    expect(attempts).toBe(0);
  });
});
