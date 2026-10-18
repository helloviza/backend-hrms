// apps/backend/src/services/cstepTrainingModules.ts
//
// The CSTEP Training deck list, read from THE registry: the `PATHS` array in
// src/training/cstep/cstep-training-hub.html — the same pattern, and the same
// parser, as the HOUSE Learning Hub (services/trainingModules.ts). The server
// keeps no second list: the progress route accepts exactly the live decks
// here, and the Team Training report's columns come from here, so publishing
// a deck (one PATHS entry with status "live") needs no backend change.
// Read-only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePathsRegistry, type TrainingModule } from "./trainingModules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/training/cstep in dev, dist/training/cstep in prod (the build copies src/training).
export const CSTEP_TRAINING_DIR = path.join(__dirname, "../training/cstep");
export const CSTEP_HUB_FILE = path.join(CSTEP_TRAINING_DIR, "cstep-training-hub.html");

let cache: { mtimeMs: number; modules: TrainingModule[] } | null = null;

/** Every registry entry, re-read when the hub file changes. */
export function loadCstepTrainingModules(file = CSTEP_HUB_FILE): TrainingModule[] {
  const { mtimeMs } = fs.statSync(file);
  if (cache && cache.mtimeMs === mtimeMs && file === CSTEP_HUB_FILE) return cache.modules;
  const modules = parsePathsRegistry(fs.readFileSync(file, "utf8"));
  if (file === CSTEP_HUB_FILE) cache = { mtimeMs, modules };
  return modules;
}

/** The live decks, registry order. */
export function liveCstepTrainingModules(file = CSTEP_HUB_FILE): TrainingModule[] {
  return loadCstepTrainingModules(file).filter((m) => m.status === "live");
}
