import { loadConfig } from "./config.ts";
import { openDb } from "./db/index.ts";
import { loadProviders, OAuthTokenStore } from "./oauth/index.ts";
import { createApp } from "./server/app.ts";
import { PearlStore } from "./store/pearls.ts";
import { UserStore } from "./store/users.ts";

const config = loadConfig();
const db = openDb(config.dbPath);
const providers = loadProviders(process.env);
const oauth = { providers, tokens: new OAuthTokenStore(db, config.tokenEncryptionKey, providers) };
const app = createApp({ config, db, pearls: new PearlStore(db), users: new UserStore(db), oauth });
const server = Bun.serve({ port: config.port, fetch: app.fetch });
console.log(`oyster listening on ${server.url}`);
