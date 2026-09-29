import { type AgentServices, createAgentModel, createWebSearch } from "./agent/index.ts";
import { loadConfig } from "./config.ts";
import { openDb } from "./db/index.ts";
import { loadProviders, OAuthTokenStore } from "./oauth/index.ts";
import type { RuntimeDeps } from "./runtime/index.ts";
import { createApp } from "./server/app.ts";
import { createMemorySourceCache } from "./sources/index.ts";
import { PearlStore } from "./store/pearls.ts";
import { UserStore } from "./store/users.ts";

const config = loadConfig();
const db = openDb(config.dbPath);
const pearls = new PearlStore(db);
const providers = loadProviders(process.env);
const oauth = { providers, tokens: new OAuthTokenStore(db, config.tokenEncryptionKey, providers) };
const runtime: RuntimeDeps = {
  pearls,
  authResolverFor: (userId) => oauth.tokens.resolverFor(userId),
  cache: createMemorySourceCache(),
  sandboxTimeoutMs: config.sandboxTimeoutMs,
};
const agent: AgentServices = {
  runtime,
  pearls,
  oauth,
  config,
  search: createWebSearch({ braveApiKey: config.braveApiKey }),
  model: createAgentModel(config) ?? undefined,
};
if (!agent.model) console.warn("OPENROUTER_API_KEY is not set; POST /messages will report that the assistant is unavailable.");
const app = createApp({ config, db, pearls, users: new UserStore(db), runtime, oauth, agent });
const server = Bun.serve({ port: config.port, fetch: app.fetch });
console.log(`oyster listening on ${server.url}`);
