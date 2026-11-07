// apps/backend/vitest.config.ts
//
// The backend had no vitest config until now — it ran entirely on
// defaults, and it still does. This file adds ONE thing and deliberately
// declares nothing else, so test discovery, the node environment, pooling
// and timeouts all stay exactly as they were: whatever vitest's defaults
// say, not a snapshot of them frozen here.
//
// globalSetup runs once in the vitest main process before any worker is
// spawned, which is precisely what the temp redirect needs — workers
// inherit the environment they are forked with. See vitest.globalSetup.ts
// for what it does and the three gates that make it a no-op on CI, macOS,
// Linux, and any checkout already on the system drive.
//
// setupFiles re-runs the database guard (vitest.dbGuard.ts) inside every
// worker before the test file's imports, so dotenv / the secrets bundle can
// never fill MONGO_URI with a real cluster mid-run.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./vitest.globalSetup.ts"],
    setupFiles: ["./vitest.dbGuard.ts"],
  },
});
