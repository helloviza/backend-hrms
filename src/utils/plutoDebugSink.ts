// apps/backend/src/utils/plutoDebugSink.ts

import type { PlutoDebugSnapshot } from "../types/plutoDebug.js";

const DEBUG_ENABLED = process.env.PLUTO_DEBUG === "true";

export function emitPlutoDebug(snapshot: PlutoDebugSnapshot) {
  if (!DEBUG_ENABLED) return;

  console.log("🧠 PLUTO DEBUG SNAPSHOT");
  console.log(JSON.stringify(snapshot, null, 2));
}