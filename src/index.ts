import { loadConfig } from "./config.ts";
import { openDb } from "./db/index.ts";
import { nullAuthResolverFor } from "./runtime/index.ts";
import { createApp } from "./server/app.ts";
import { createMemorySourceCache } from "./sources/index.ts";
import { PearlStore } from "./store/pearls.ts";
import { UserStore } from "./store/users.ts";

const config = loadConfig();
const db = openDb(config.dbPath);
const pearls = new PearlStore(db);
const runtime = {
  pearls,
  authResolverFor: nullAuthResolverFor,
  cache: createMemorySourceCache(),
  sandboxTimeoutMs: config.sandboxTimeoutMs,
};
const app = createApp({ config, db, pearls, users: new UserStore(db), runtime });
const server = Bun.serve({ port: config.port, fetch: app.fetch });
console.log(`oyster listening on ${server.url}`);
