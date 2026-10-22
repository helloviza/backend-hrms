// apps/backend/scripts/dev-mongo.mjs
//
// Starts a LOCAL mongod for development, on 127.0.0.1:27017, with a
// PERSISTENT data directory at <repo>/.devdata/mongo (gitignored). Ctrl-C to
// stop; your seeded data survives the restart.
//
// WHY THIS EXISTS RATHER THAN "just install MongoDB": the repo already
// depends on mongodb-memory-server (the test suite uses it), which downloads
// and caches a REAL mongod binary. Reusing that binary means a working local
// database needs no separate install and no Docker — but pointed at a real
// dbPath instead of a temp one, so it behaves like an ordinary local server
// rather than a throwaway.
//
// If you already have your own mongod on 27017, don't run this — just use
// yours. The connection string in .env.development is the same either way.
//
// This NEVER touches a remote cluster. It binds the loopback interface only.
//
// It runs as a SINGLE-NODE REPLICA SET (rs0), initiated on first start, so
// multi-document transactions work locally exactly as on Atlas (invoice
// generation, PATCH /api/admin/invoices/:id). An existing standalone dbPath
// is reused as-is; the plain mongodb://127.0.0.1:27017/<db> URI still works.

import { MongoBinary } from "mongodb-memory-server";
import mongoose from "mongoose";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = 27017;
const REPL_SET = "rs0";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const dbPath = resolve(repoRoot, ".devdata/mongo");

mkdirSync(dbPath, { recursive: true });

console.log("[dev-mongo] resolving a mongod binary (first run may download one)…");
const binary = await MongoBinary.getPath({});
console.log(`[dev-mongo] binary: ${binary}`);
console.log(`[dev-mongo] dbPath: ${dbPath}`);

const child = spawn(
  binary,
  [
    "--dbpath", dbPath,
    "--port", String(PORT),
    // Loopback ONLY. A dev database should not be reachable from the network.
    "--bind_ip", HOST,
    "--replSet", REPL_SET,
  ],
  { stdio: "inherit" },
);

child.on("exit", (code) => {
  if (code === 48) {
    console.error(
      `\n[dev-mongo] port ${PORT} is already in use — you probably have a mongod running already.\n` +
        `           That is fine: use it. Nothing else to do.`,
    );
  }
  process.exit(code ?? 0);
});

const stop = () => child.kill("SIGINT");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// Initiate the replica set once (a no-op on every later start).
for (let attempt = 0; ; attempt++) {
  try {
    const conn = await mongoose.createConnection(`mongodb://${HOST}:${PORT}/admin`, { directConnection: true }).asPromise();
    try {
      await conn.db.admin().command({ replSetGetStatus: 1 });
    } catch (err) {
      if (err?.codeName !== "NotYetInitialized") throw err;
      await conn.db.admin().command({ replSetInitiate: { _id: REPL_SET, members: [{ _id: 0, host: `${HOST}:${PORT}` }] } });
      console.log(`[dev-mongo] initiated single-node replica set ${REPL_SET}`);
    }
    await conn.close();
    break;
  } catch (err) {
    if (attempt >= 30) throw err;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

console.log(`\n[dev-mongo] listening on mongodb://${HOST}:${PORT} (replica set ${REPL_SET}) — Ctrl-C to stop.\n`);
