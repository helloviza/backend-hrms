// CSTEP Training decks carry the SAME shared progress block (the `PT` helper)
// as the HOUSE Learning Hub — the block routes/trainingProgress.sharedBlock
// .test.ts pins and runs. These pin that the CSTEP hub, every CSTEP deck and
// the CSTEP deck generator hold a byte-identical copy of it, and that each
// deck records progress under its PATHS id and routes back to /cstep/training
// (pages/cstep/training/CstepTrainingHub.tsx → PUT /api/cstep/training/progress/:module).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOUSE_HUB = path.join(backend, "src/training/learning-hub.html");
const CSTEP_DIR = path.join(backend, "src/training/cstep");
const DECKS = fs.readdirSync(CSTEP_DIR).filter((f) => f.endsWith(".html") && f !== "cstep-training-hub.html");
const COPIES = [
  path.join(CSTEP_DIR, "cstep-training-hub.html"),
  ...DECKS.map((f) => path.join(CSTEP_DIR, f)),
  // The generator lives in the monorepo's docs/ — absent from the backend
  // subtree App Runner builds, so a missing copy there is skipped, not failed.
  ...[path.resolve(backend, "../../docs/training/cstep/tools/build-deck.mjs")].filter((p) => fs.existsSync(p)),
];

function block(file: string): string {
  const rel = path.relative(backend, file);
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const start = text.indexOf("/* ── Plumtrips Learning · shared progress storage");
  expect(start, `${rel} has the shared block`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n})();", start);
  expect(end, `${rel} block terminator`).toBeGreaterThan(start);
  return text.slice(start, end + "\n})();".length);
}

describe("CSTEP Training — shared PT block", () => {
  it("there is at least one deck", () => {
    expect(DECKS.length).toBeGreaterThan(0);
  });

  it("the CSTEP hub, every CSTEP deck and the generator hold the Learning Hub's block, byte for byte", () => {
    const house = block(HOUSE_HUB);
    for (const f of COPIES) expect(block(f), path.relative(backend, f)).toBe(house);
  });

  it("each deck writes progress under a PATHS id of the CSTEP hub and routes home to /cstep/training", () => {
    const hub = fs.readFileSync(path.join(CSTEP_DIR, "cstep-training-hub.html"), "utf8");
    for (const f of DECKS) {
      const html = fs.readFileSync(path.join(CSTEP_DIR, f), "utf8");
      const mod = /var MODULE='([a-z0-9-]+)'/.exec(html)?.[1];
      expect(mod, f).toBeTruthy();
      expect(hub, `${f}: PATHS entry for ${mod}`).toContain(`id:"${mod}"`);
      expect(hub, `${f}: PATHS href`).toContain(`href:"${f}"`);
      expect(html, f).toContain("PT.nav('/cstep/training')");
      expect(html, f).not.toContain("PT.nav('/learning')");
    }
  });
});
