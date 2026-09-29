import { expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

const SECRETS = { OAUTH_STATE_SECRET: "s", TOKEN_ENCRYPTION_KEY: "k" };

test("required secrets throw outside NODE_ENV=test", () => {
  expect(() => loadConfig({})).toThrow(/OAUTH_STATE_SECRET/);
  expect(() => loadConfig({ NODE_ENV: "production", OAUTH_STATE_SECRET: "s" })).toThrow(/TOKEN_ENCRYPTION_KEY/);
  expect(() => loadConfig({ NODE_ENV: "production", ...SECRETS, OAUTH_STATE_SECRET: "  " })).toThrow(/OAUTH_STATE_SECRET/);
});

test("NODE_ENV=test supplies secret defaults; explicit env wins", () => {
  const testConfig = loadConfig({ NODE_ENV: "test" });
  expect(testConfig.oauthStateSecret.length).toBeGreaterThan(0);
  expect(testConfig.dbPath).toBe(":memory:");
  expect(loadConfig({ NODE_ENV: "test", OAUTH_STATE_SECRET: "real" }).oauthStateSecret).toBe("real");
});

test("port and base URL parsing", () => {
  expect(loadConfig(SECRETS)).toMatchObject({ port: 8787, publicBaseUrl: "http://localhost:8787", dbPath: "data/oyster.db" });
  expect(loadConfig({ ...SECRETS, PORT: "9000", PUBLIC_BASE_URL: "https://oyster.example/" })).toMatchObject({
    port: 9000,
    publicBaseUrl: "https://oyster.example",
  });
  expect(() => loadConfig({ ...SECRETS, PORT: "abc" })).toThrow(/PORT/);
});
