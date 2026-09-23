// apps/backend/src/services/trainingModules.ts
//
// The Learning Hub's module list, read from THE registry: the `PATHS` array in
// src/training/learning-hub.html (see the "PATHS REGISTRY" comment there).
// The server keeps no second list — the progress report's columns come from
// here, so publishing a new deck (one PATHS entry with status "live") makes it
// appear in the report with no backend change, and "soon" placeholders never
// show up as an everyone-Not-Started column.
//
// The array is a plain object literal inside our own shipped file. It is
// evaluated in an empty vm context (no require, no process, no globals) with
// a short timeout — only the literal, never the rest of the page script.
// Read-only: nothing here writes the registry or the progress collection.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Same resolution as routes/training.ts: src/training in dev, dist/training in prod.
export const HUB_FILE = path.join(__dirname, "../training/learning-hub.html");

export interface TrainingModule {
  id: string;
  title: string;
  status: "live" | "soon";
  /** Slide count from the registry (`slides`, else the "63 slides" in `meta`), 0 if unknown. */
  total: number;
}

/** Parse the PATHS registry out of the hub's HTML. Pure; exported for tests. */
export function parsePathsRegistry(html: string): TrainingModule[] {
  const start = html.indexOf("var PATHS=");
  if (start < 0) throw new Error("PATHS registry not found in learning-hub.html");
  const open = html.indexOf("[", start);
  const close = html.indexOf("\n];", open);
  if (open < 0 || close < 0) throw new Error("PATHS registry is not a closed array literal");
  const literal = html.slice(open, close + 2).replace(/\r\n/g, "\n");
  const raw = vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 100 });
  if (!Array.isArray(raw)) throw new Error("PATHS registry did not evaluate to an array");
  return raw
    .filter((p: any) => p && typeof p.id === "string" && p.id.trim())
    .map((p: any) => {
      const slides = Number(p.slides);
      const fromMeta = /(\d+)\s*slides/i.exec(String(p.meta || ""));
      return {
        id: p.id.trim(),
        title: String(p.title || p.id).trim(),
        status: p.status === "live" ? "live" : "soon",
        total: Number.isFinite(slides) && slides > 0 ? slides : fromMeta ? Number(fromMeta[1]) : 0,
      } as TrainingModule;
    });
}

let cache: { mtimeMs: number; modules: TrainingModule[] } | null = null;

/** Every registry entry, re-read when the hub file changes. */
export function loadTrainingModules(file = HUB_FILE): TrainingModule[] {
  const { mtimeMs } = fs.statSync(file);
  if (cache && cache.mtimeMs === mtimeMs && file === HUB_FILE) return cache.modules;
  const modules = parsePathsRegistry(fs.readFileSync(file, "utf8"));
  if (file === HUB_FILE) cache = { mtimeMs, modules };
  return modules;
}

/** The modules a report should show: live ones only, registry order. */
export function liveTrainingModules(file = HUB_FILE): TrainingModule[] {
  return loadTrainingModules(file).filter((m) => m.status === "live");
}
