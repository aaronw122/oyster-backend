import { expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

const KEY_32 = Buffer.alloc(32, 1).toString("base64");
const SECRETS = { OAUTH_STATE_SECRET: "s", TOKEN_ENCRYPTION_KEY: KEY_32 };

test("required secrets throw outside NODE_ENV=test", () => {
  expect(() => loadConfig({})).toThrow(/OAUTH_STATE_SECRET/);
  expect(() => loadConfig({ NODE_ENV: "production", OAUTH_STATE_SECRET: "s" })).toThrow(/TOKEN_ENCRYPTION_KEY/);
  expect(() => loadConfig({ NODE_ENV: "production", ...SECRETS, OAUTH_STATE_SECRET: "  " })).toThrow(/OAUTH_STATE_SECRET/);
});

test("TOKEN_ENCRYPTION_KEY must be base64 of exactly 32 bytes", () => {
  const withKey = (key: string) => () => loadConfig({ ...SECRETS, TOKEN_ENCRYPTION_KEY: key });
  expect(withKey(Buffer.alloc(31).toString("base64"))).toThrow(/TOKEN_ENCRYPTION_KEY.*32 bytes/);
  expect(withKey(Buffer.alloc(33).toString("base64"))).toThrow(/TOKEN_ENCRYPTION_KEY/);
  expect(withKey("k")).toThrow(/TOKEN_ENCRYPTION_KEY/);
  expect(withKey(`${KEY_32.slice(0, -2)}!=`)).toThrow(/TOKEN_ENCRYPTION_KEY/);
  expect(() => loadConfig({ NODE_ENV: "test", TOKEN_ENCRYPTION_KEY: "short" })).toThrow(/TOKEN_ENCRYPTION_KEY/);
  expect(loadConfig(SECRETS).tokenEncryptionKey).toBe(KEY_32);
});

test("NODE_ENV=test supplies secret defaults; explicit env wins", () => {
  const testConfig = loadConfig({ NODE_ENV: "test" });
  expect(testConfig.oauthStateSecret.length).toBeGreaterThan(0);
  expect(Buffer.from(testConfig.tokenEncryptionKey, "base64")).toHaveLength(32);
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

test("SANDBOX_TIMEOUT_MS defaults to 1000 and rejects non-positive values", () => {
  expect(loadConfig(SECRETS).sandboxTimeoutMs).toBe(1000);
  expect(loadConfig({ ...SECRETS, SANDBOX_TIMEOUT_MS: "2500" }).sandboxTimeoutMs).toBe(2500);
  expect(() => loadConfig({ ...SECRETS, SANDBOX_TIMEOUT_MS: "0" })).toThrow(/SANDBOX_TIMEOUT_MS/);
  expect(() => loadConfig({ ...SECRETS, SANDBOX_TIMEOUT_MS: "fast" })).toThrow(/SANDBOX_TIMEOUT_MS/);
});
