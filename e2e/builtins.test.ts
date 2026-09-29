import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gbfsExample } from "../src/builtins/gbfs.example.ts";
import { BUILTINS } from "../src/builtins/index.ts";
import { marketsExample } from "../src/builtins/markets.example.ts";
import { mtaExample } from "../src/builtins/mta.example.ts";
import { recurseExample } from "../src/builtins/recurse.example.ts";
import { weatherExample } from "../src/builtins/weather.example.ts";
import { PearlDataSchema, type SavePearlRequest, SavePearlResponseSchema } from "../src/contract/index.ts";
import { fitToSize } from "../src/sandbox/index.ts";
import { LIVE, type LiveServer, SIZES, api, startServer } from "./harness.ts";

// ENSURE-2: every built-in's example Pearl saves through POST /pearls and refreshes
// through GET /pearls/:id/data at every size against live data. No LLM involved.
// Run: LIVE=1 bun test e2e

type Case = { example: SavePearlRequest; requiredEnv: string[] };

const CASES: Record<string, Case> = {
  gbfs: { example: gbfsExample, requiredEnv: [] },
  weather: { example: weatherExample, requiredEnv: [] },
  mta: { example: mtaExample, requiredEnv: [] },
  // The example quotes crypto via CoinGecko. Its keyless tier answers some networks with a
  // CloudFront 403 ("Request blocked"), so the live check requires the demo key to be meaningful.
  markets: { example: marketsExample, requiredEnv: ["COINGECKO_API_KEY"] },
  recurse: { example: recurseExample, requiredEnv: ["RC_PAT"] },
};

// Offline: a newly registered built-in must get a live case here.
test("every registered built-in has an example case in the live suite", () => {
  expect(BUILTINS.map((builtin) => builtin.name).sort()).toEqual(Object.keys(CASES).sort());
});

describe.skipIf(!LIVE)("ENSURE-2: every built-in refreshes through the data endpoint (live)", () => {
  let server: LiveServer;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server?.stop();
  });

  for (const [name, { example, requiredEnv }] of Object.entries(CASES)) {
    const missing = requiredEnv.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      test.skip(`${name}: skipped — server key ${missing.join(", ")} is not set`, () => {});
      continue;
    }
    test(
      `${name}: saves and returns fresh, fitting output at all four sizes`,
      async () => {
        const saved = await api(server, "POST", "/pearls", example);
        if (saved.status !== 201) throw new Error(`POST /pearls for ${name} → ${saved.status}: ${JSON.stringify(saved.body)}\n${server.logs()}`);
        const { id } = SavePearlResponseSchema.parse(saved.body);

        for (const size of SIZES) {
          const response = await api(server, "GET", `/pearls/${id}/data?size=${size}`);
          if (response.status !== 200) throw new Error(`${name} ${size} → ${response.status}: ${JSON.stringify(response.body)}`);
          const data = PearlDataSchema.parse(response.body);
          expect(data.pearlId).toBe(id);
          expect(data.size).toBe(size);
          expect(data.stale).toBe(false);
          expect(data.output.value.trim()).not.toBe("");
          const fit = fitToSize(data.output, size);
          expect(fit.ok ? [] : fit.errors).toEqual([]);
          // Sensitive built-ins (e.g. recurse: people's names) are checked, never logged.
          if (!BUILTINS.find((builtin) => builtin.name === name)?.sensitive) {
            console.log(`[e2e] ${name} ${size}: ${JSON.stringify(data.output)}`);
          }
        }
      },
      60_000,
    );
  }
});
