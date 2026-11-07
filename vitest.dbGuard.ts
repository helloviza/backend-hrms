// apps/backend/vitest.dbGuard.ts
//
// Tests never touch a real database.
//
// Every backend suite runs on mongodb-memory-server, but importing
// src/config/env.ts runs dotenv and the APP_SECRETS back-fill, and both fill
// MONGO_URI only when it is UNSET. On a machine whose apps/backend/.env (or
// .env.test, or the shell) holds the production Atlas URI, an unset MONGO_URI
// silently becomes production inside the test worker.
//
// So, in the main process (globalSetup) AND again in every worker (setupFiles,
// before the test file's own imports run):
//   - MONGO_URI unset/empty → pin a local placeholder that can never connect
//     (port 1), so neither dotenv nor the secrets bundle can fill it later;
//   - MONGO_URI set to anything that is not a plain mongodb:// URI on a local
//     host (mongodb+srv://, *.mongodb.net, any remote host) → refuse to run.
import { isLocalMongoUri } from "./src/seed/assertLocalDatabase.js";

export const TEST_MONGO_PLACEHOLDER = "mongodb://127.0.0.1:1/vitest-never-connected";

export function guardTestDatabase(): void {
  const uri = process.env.MONGO_URI;
  if (uri === undefined || uri.trim() === "") {
    process.env.MONGO_URI = TEST_MONGO_PLACEHOLDER;
    return;
  }
  if (!isLocalMongoUri(uri)) {
    const shown = uri.replace(/\/\/[^@/]*@/, "//***@").replace(/\?.*$/, "");
    throw new Error(
      `REFUSING TO RUN TESTS: MONGO_URI points at a non-local database (${shown}).\n` +
        "Backend tests run on mongodb-memory-server and never need a real cluster.\n" +
        "Unset MONGO_URI (or point it at mongodb://127.0.0.1/...) and run again.",
    );
  }
}

// ── S3 ────────────────────────────────────────────────────────────────
// Same trap, same fix: apps/backend/.env names the production bucket, and
// dotenv only fills S3_BUCKET / S3_BASE_URL when they are unset. Tests mock
// S3 and never need a real bucket, so:
//   - unset/empty → pin a bucket name that does not exist (any accidental
//     real call fails with NoSuchBucket instead of writing to production);
//   - a name or URL that looks like production → refuse to run.
export const TEST_S3_BUCKET_PLACEHOLDER = "plumbox-test-no-such-bucket";

const PROD_BUCKET_RE = /(^|[^a-z])prod(uction)?([^a-z]|$)/i;

export function isProdBucket(value: string): boolean {
  return PROD_BUCKET_RE.test(value.trim());
}

export function guardTestStorage(): void {
  const bucket = process.env.S3_BUCKET;
  if (bucket === undefined || bucket.trim() === "") process.env.S3_BUCKET = TEST_S3_BUCKET_PLACEHOLDER;
  const baseUrl = process.env.S3_BASE_URL;
  if (baseUrl === undefined || baseUrl.trim() === "") process.env.S3_BASE_URL = `https://${TEST_S3_BUCKET_PLACEHOLDER}.invalid`;

  for (const key of ["S3_BUCKET", "S3_BASE_URL", "AWS_S3_PUBLIC_BASE_URL"] as const) {
    const v = process.env[key];
    if (v && isProdBucket(v)) {
      throw new Error(
        `REFUSING TO RUN TESTS: ${key} names a production bucket (${v}).\n` +
          "Backend tests mock S3 and never need a real bucket.\n" +
          `Unset ${key} (or set it to a non-production name) and run again.`,
      );
    }
  }
}

// setupFiles entry: runs in each worker before the test file.
guardTestDatabase();
guardTestStorage();
