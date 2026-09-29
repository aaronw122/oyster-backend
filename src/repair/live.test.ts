import { describe, expect, test } from "bun:test";
import { createAgentModel } from "../agent/index.ts";
import { weatherExample } from "../builtins/weather.example.ts";
import { loadConfig } from "../config.ts";
import { openDb } from "../db/index.ts";
import { getPearlData, nullAuthResolverFor, type RuntimeDeps, savePearl } from "../runtime/index.ts";
import { createMemorySourceCache } from "../sources/index.ts";
import { PearlStore } from "../store/pearls.ts";
import { UserStore } from "../store/users.ts";
import { RepairQueue } from "./queue.ts";
import { createRepairer } from "./worker.ts";

// Real OpenRouter model, real weather data. Opt in: LIVE=1 OPENROUTER_API_KEY=… bun test src/repair/live.test.ts
describe.skipIf(!process.env.LIVE || !process.env.OPENROUTER_API_KEY)("live repair", () => {
  test(
    "a weather Pearl whose transform reads a wrong field path is repaired from live data",
    async () => {
      const config = loadConfig({ ...process.env, NODE_ENV: "test" });
      const model = createAgentModel(config);
      if (!model) throw new Error("OPENROUTER_API_KEY is required");
      const db = openDb(":memory:");
      const pearls = new PearlStore(db);
      new UserStore(db).issueToken("live-user");
      const runtime: RuntimeDeps = {
        pearls,
        authResolverFor: nullAuthResolverFor,
        cache: createMemorySourceCache(),
        sandboxTimeoutMs: config.sandboxTimeoutMs,
      };
      const saved = await savePearl("live-user", weatherExample, runtime);
      if (!saved.ok) throw new Error(`save failed: ${JSON.stringify(saved)}`);
      const broken = weatherExample.transform.replaceAll("w.current.", "w.now.");
      const corrupted = pearls.replaceTransform(saved.pearl.id, broken, "test: corrupt field path");

      const queue = new RepairQueue({ pearls, repair: createRepairer({ runtime, pearls, config, model }) });
      runtime.onRefreshFailure = (pearl, failure, ctx) => queue.enqueue(pearl, failure, ctx);
      const stale = await getPearlData("live-user", saved.pearl.id, "small", runtime);
      expect(stale).toMatchObject({ status: 200, body: { stale: true } });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await queue.idle();

      const repaired = pearls.getById(saved.pearl.id);
      const runs = db.query("SELECT kind, ok, error FROM runs WHERE pearl_id = ? AND kind = 'repair'").all(saved.pearl.id);
      console.log(JSON.stringify({ runs, versions: pearls.listVersions(saved.pearl.id).map((v) => v.reason), transform: repaired?.transform }, null, 2));
      expect(repaired).toMatchObject({ version: corrupted.version + 1, status: "ok" });
      expect(repaired?.transform).not.toBe(broken);
      const fresh = await getPearlData("live-user", saved.pearl.id, "small", runtime);
      expect(fresh).toMatchObject({ status: 200, body: { stale: false, version: corrupted.version + 1 } });
    },
    240_000,
  );
});
