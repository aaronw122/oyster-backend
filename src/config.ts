export type Config = {
  port: number;
  dbPath: string;
  publicBaseUrl: string;
  openrouterApiKey?: string;
  oauthStateSecret: string;
  tokenEncryptionKey: string;
};

type Env = Record<string, string | undefined>;

// Fixed, obviously-fake values used only when NODE_ENV=test so tests need no secrets.
const TEST_SECRETS = {
  OAUTH_STATE_SECRET: "test-oauth-state-secret",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
} as const;

/** Reads configuration from `env` (defaults to `process.env`). Throws on missing/invalid values. */
export function loadConfig(env: Env = process.env): Config {
  const isTest = env.NODE_ENV === "test";
  const port = parsePort(env.PORT);
  const secret = (name: keyof typeof TEST_SECRETS): string => {
    const value = nonEmpty(env[name]);
    if (value !== undefined) return value;
    if (isTest) return TEST_SECRETS[name];
    throw new Error(`Missing required environment variable ${name} (see .env.example).`);
  };

  return {
    port,
    dbPath: nonEmpty(env.DB_PATH) ?? (isTest ? ":memory:" : "data/oyster.db"),
    publicBaseUrl: (nonEmpty(env.PUBLIC_BASE_URL) ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    openrouterApiKey: nonEmpty(env.OPENROUTER_API_KEY),
    oauthStateSecret: secret("OAUTH_STATE_SECRET"),
    tokenEncryptionKey: parseEncryptionKey(secret("TOKEN_ENCRYPTION_KEY")),
  };
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** TOKEN_ENCRYPTION_KEY must be standard base64 of exactly 32 bytes (an AES-256 key). */
function parseEncryptionKey(value: string): string {
  if (!BASE64.test(value) || Buffer.from(value, "base64").length !== 32) {
    throw new Error(
      "Invalid TOKEN_ENCRYPTION_KEY: expected base64 of exactly 32 bytes. Generate one with `openssl rand -base64 32`.",
    );
  }
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePort(raw: string | undefined): number {
  const value = nonEmpty(raw);
  if (value === undefined) return 8787;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT "${value}": expected an integer between 0 and 65535.`);
  }
  return port;
}
