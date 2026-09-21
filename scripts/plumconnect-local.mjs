// apps/backend/scripts/plumconnect-local.mjs
//
// ONE command for the PlumConnect local stack — docs/plumconnect/LOCAL_RUN.md.
//
//   pnpm plumconnect:local              (repo root)   = pnpm -C apps/backend plumconnect:local
//   pnpm plumconnect:local -- --reseed  rebuild the seeded threads even if present
//   pnpm plumconnect:local -- --clean   remove everything the seed made, then exit
//   PORT=8098 FRONTEND_PORT=5175 …      when :8099 / :5173 are taken by another checkout
//
// In order: build @plumtrips/shared → make sure a local mongod is listening →
// seed the inbox (skipped when the dev threads are already there) → backend
// with PLUMCONNECT_ENABLED=true → frontend with VITE_PLUMCONNECT_UI=true (set
// in the child's environment BEFORE Vite starts — it is inlined at start-up).
// Ctrl-C stops everything it started; a mongod it found already running is
// left alone.
//
// Same shape as scripts/dev-mongo.mjs: plain Node, node:child_process, no
// process manager — the repo uses none. Windows-safe: every flag is passed
// through the child's `env`, never as POSIX `VAR=value cmd` syntax, and pnpm
// is spawned through the shell so `pnpm.cmd` resolves.
//
// Dev-only: the seed's own prod-guard (src/seed/plumconnectDevGuard.ts) runs
// FIRST, against the same .env.development the backend will boot with; a
// prod-looking target aborts before a single child is spawned. Run with
// `node --env-file=.env.development --import tsx` (the package script does)
// so the guard sees the dev env and the TypeScript import resolves.

import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { plumconnectDevTargetProblem, maskUri } from "../src/seed/plumconnectDevGuard.js";

const here = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(here, "..");
const repoRoot = resolve(backendDir, "../..");
const frontendDir = resolve(repoRoot, "apps/frontend");

const args = new Set(process.argv.slice(2));
const CLEAN = args.has("--clean");
const RESEED = args.has("--reseed");

const MONGO_URI = String(process.env.MONGO_URI || "");
const BACKEND_PORT = Number(process.env.PORT || 8099);
// Vite is pinned to 5173 (vite.config.ts); FRONTEND_PORT=<n> moves THIS run to another port (passed as --port --strictPort).
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT || 5173);
const MONGO_PORT = 27017;
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const children = [];
let shuttingDown = false;
const log = (tag, msg) => console.log(`[plumconnect-local${tag ? ":" + tag : ""}] ${msg}`);
const fail = (msg, code = 2) => {
  console.error(`\n[plumconnect-local] ABORT: ${msg}\n`);
  shutdown(code); // never leave a half-started stack behind
};

/* ───────────────────────────── 0. the guard ───────────────────────────── */

{
  const problem = plumconnectDevTargetProblem(MONGO_URI, process.env.NODE_ENV);
  if (problem) fail(`REFUSING TO RUN — ${problem}`);
  log("", `target ${maskUri(MONGO_URI)} (NODE_ENV=${process.env.NODE_ENV || "unset"})`);
}

/* ───────────────────────────── helpers ───────────────────────────── */

function portOpen(port, host = "127.0.0.1") {
  return new Promise((done) => {
    const s = createConnection({ port, host });
    s.once("connect", () => { s.destroy(); done(true); });
    s.once("error", () => done(false));
    s.setTimeout(800, () => { s.destroy(); done(false); });
  });
}

async function waitForPort(port, what, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`${what} did not start listening on :${port} within ${timeoutMs / 1000}s — see its output above.`);
}

/** Run to completion, inherit output; abort on a non-zero exit. */
function runStep(tag, cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (r.status !== 0) fail(`${tag} failed (exit ${r.status ?? r.signal}).`);
}

/** Start a long-running child, prefix its output, remember it for Ctrl-C. */
function startChild(tag, cmd, cmdArgs, opts = {}) {
  const child = spawn(cmd, cmdArgs, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", ...opts });
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        out.write(`[${tag}] ${buf.slice(0, i)}\n`);
        buf = buf.slice(i + 1);
      }
    });
    stream.on("end", () => { if (buf) out.write(`[${tag}] ${buf}\n`); });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      log(tag, `exited (${code ?? signal}) — stopping the rest.`);
      shutdown(1);
    }
  });
  children.push({ tag, child });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { tag, child } of children.reverse()) {
    log(tag, "stopping…");
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGINT");
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

/* ───────────────────────────── 1. @plumtrips/shared ───────────────────────────── */

log("shared", "building @plumtrips/shared (the frontend resolves its dist/)…");
runStep("shared build", PNPM, ["--filter", "@plumtrips/shared", "build"], { cwd: repoRoot });

/* ───────────────────────────── 2. local mongod ───────────────────────────── */

if (await portOpen(MONGO_PORT)) {
  log("mongo", `a mongod is already listening on :${MONGO_PORT} — using it.`);
} else {
  log("mongo", `nothing on :${MONGO_PORT} — starting scripts/dev-mongo.mjs (data in .devdata/mongo)…`);
  startChild("mongo", process.execPath, [resolve(backendDir, "scripts/dev-mongo.mjs")], { cwd: backendDir, shell: false });
  await waitForPort(MONGO_PORT, "dev-mongo", 120_000);
}

/* ───────────────────────────── 3. seed ───────────────────────────── */

const seedCmd = [
  "--env-file=.env.development",
  "--import", "tsx",
  resolve(backendDir, "src/scripts/plumconnect-seed-dev.ts"),
];

if (CLEAN) {
  log("seed", "--clean: removing everything the seed made, then exiting.");
  runStep("seed --clean", process.execPath, [...seedCmd, "--clean"], { cwd: backendDir, shell: false });
  shutdown(0);
}

async function alreadySeeded() {
  // The seed's own fixed dev set: five contacts on the 91990000010x block.
  const { default: mongoose } = await import("mongoose");
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    const n = await mongoose.connection.db.collection("plumconnectcontacts").countDocuments({ phone: /^91990000010[1-5]$/ });
    return n === 5;
  } finally {
    await mongoose.disconnect();
  }
}

if (!RESEED && (await alreadySeeded())) {
  log("seed", "the five dev threads are already there — skipping (pass --reseed to rebuild them).");
} else {
  log("seed", RESEED ? "--reseed: rebuilding the dev threads…" : "seeding the inbox…");
  runStep("seed", process.execPath, seedCmd, { cwd: backendDir, shell: false });
}

/* ───────────────────────────── 4. backend ───────────────────────────── */

if (await portOpen(BACKEND_PORT)) {
  fail(
    `something is already listening on :${BACKEND_PORT} (another backend?). Stop it, or run with PORT=<free port> — ` +
      `the frontend proxy is then pointed at it automatically.`,
  );
}
log("backend", `starting on :${BACKEND_PORT} with PLUMCONNECT_ENABLED=true…`);
startChild(
  "backend",
  process.execPath,
  ["--env-file=.env.development", "--import", "tsx", resolve(backendDir, "src/server.ts")],
  { cwd: backendDir, shell: false, env: { ...process.env, PORT: String(BACKEND_PORT), PLUMCONNECT_ENABLED: "true" } },
);
await waitForPort(BACKEND_PORT, "backend", 120_000);

/* ───────────────────────────── 5. frontend ───────────────────────────── */

if (await portOpen(FRONTEND_PORT)) {
  fail(`something is already listening on :${FRONTEND_PORT} (another Vite?). Stop it, or run with FRONTEND_PORT=<free port>.`);
}
const frontendEnv = { ...process.env, VITE_PLUMCONNECT_UI: "true" };
// A non-default backend port: point the dev proxy at it (vite.config.ts reads
// VITE_BACKEND_ORIGIN through loadEnv, which includes process.env).
if (BACKEND_PORT !== 8099 && !frontendEnv.VITE_BACKEND_ORIGIN) frontendEnv.VITE_BACKEND_ORIGIN = `http://127.0.0.1:${BACKEND_PORT}`;
log("frontend", `starting Vite on :${FRONTEND_PORT} with VITE_PLUMCONNECT_UI=true (inlined at start)…`);
const viteArgs = FRONTEND_PORT === 5173 ? ["dev"] : ["dev", "--port", String(FRONTEND_PORT), "--strictPort"];
startChild("frontend", PNPM, viteArgs, { cwd: frontendDir, env: frontendEnv });
await waitForPort(FRONTEND_PORT, "frontend", 120_000);

/* ───────────────────────────── ready ───────────────────────────── */

console.log(`
──────────────────────────────────────────────────────────────────────
  PlumConnect local stack is UP  (Ctrl-C stops everything it started)

  Open:    http://localhost:${FRONTEND_PORT}/crm/plumconnect
  Login:   plumconnect-dev@plumtrips.test  /  Passw0rd!      (SUPERADMIN — sees every thread)
           plumconnect-rep@plumtrips.test  /  Passw0rd!      (no grant → 403 until granted in /admin/access)
  Rail:    CRM  →  "WhatsApp"  (left rail, pages/crm/CRMLayout.tsx)  — or the header's CRM group → "WhatsApp Inbox"
  Backend: http://127.0.0.1:${BACKEND_PORT}   PLUMCONNECT_ENABLED=true
  Mongo:   ${maskUri(MONGO_URI)}

  Sends (reply / bot / menu) are logged no-ops unless WA_ACCESS_TOKEN and
  WA_PHONE_NUMBER_ID are set in apps/backend/.env.development.
──────────────────────────────────────────────────────────────────────
`);
