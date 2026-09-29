// Usage: bun run scripts/issue-token.ts <userId>
// Creates the user if absent and prints a new bearer token (shown once; only its hash is stored).
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { UserStore } from "../src/store/users.ts";

const userId = process.argv[2]?.trim();
if (!userId) {
  console.error("Usage: bun run scripts/issue-token.ts <userId>");
  process.exit(1);
}

const db = openDb(loadConfig().dbPath);
console.log(new UserStore(db).issueToken(userId));
db.close();
