// apps/backend/src/services/sbtManualLink.pricingWriters.guard.test.ts
//
// Price-lock ratchet (docs/specs/sbt-to-manual-booking-spec.md §3.3, §8.2).
//
// A linked SBT booking's price is locked. The model refuses a change on
// .save() and on query writes (models/ManualBooking.ts — the real guard), and
// PUT /:id answers 400 PRICE_LOCKED. This test is the ratchet on top: every
// backend source line that has the SHAPE of a write to ManualBooking pricing,
// in a file that touches ManualBooking, is listed below with the reason it is
// safe. A new such line fails here until someone checks it cannot reach a
// locked booking (or opts in through $locals / the allowLockedPricingWrite
// query option and records why) and adds it with its reason. Counts are per
// file, so moving a line is fine; adding one is a decision.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "..");
const WRITE_SHAPE = /\bpricing\s*:(?!\s*1\b)|["'`]pricing\.\w+["'`]\s*:(?!\s*1\b)|\.pricing(\.\w+)?\s*=(?!=)/;
const TOUCHES_MANUAL_BOOKING = /ManualBooking\b|["']manualbookings["']/;

// file (relative to src/) → [count, why it can't move a locked price]
const ALLOWED: Record<string, [number, string]> = {
  "routes/manualBookings.ts": [4, "body pick of pricing inputs (PUT is checked by lockedPricingChanges + the model guard); response masking; a query filter; bulk import INSERT (new rows are never locked)"],
  "scripts/seed-demo-inteletek.ts": [1, "demo seed: creates its own demo bookings"],
  "scripts/seedTestBookings.ts": [4, "local seed: creates new bookings"],
  "services/d2cInvoicing.ts": [1, "creates the D2C visa ManualBooking (never SBT-linked)"],
  "services/travelIntake.create.ts": [1, "creates the intake ManualBooking (never SBT-linked)"],
  "services/visaBillingSync.ts": [2, "visa billing ManualBookings (never SBT-linked)"],
};

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
  });
}

describe("ManualBooking pricing writers are reviewed against the SBT price lock", () => {
  const found: Record<string, string[]> = {};
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).replace(/\\/g, "/");
    if (rel.startsWith("models/") || rel === "services/sbtManualLink.ts") continue;
    const text = fs.readFileSync(file, "utf8");
    if (!TOUCHES_MANUAL_BOOKING.test(text)) continue;
    const hits = text.split(/\r?\n/)
      .map((l, i) => [l, i] as const)
      .filter(([l]) => !/^\s*(\/\/|\*)/.test(l) && WRITE_SHAPE.test(l));
    if (hits.length) found[rel] = hits.map(([l, i]) => `${rel}:${i + 1}: ${l.trim()}`);
  }

  it("no unreviewed pricing write outside the link service and the model", () => {
    const unexpected: string[] = [];
    for (const [rel, lines] of Object.entries(found)) {
      const allowed = ALLOWED[rel]?.[0] ?? 0;
      if (lines.length > allowed) unexpected.push(...lines);
    }
    expect(unexpected).toEqual([]);
  });

  it("the allow-list has no stale entries", () => {
    const stale = Object.entries(ALLOWED)
      .filter(([rel, [n]]) => (found[rel]?.length ?? 0) < n)
      .map(([rel, [n]]) => `${rel}: allowed ${n}, found ${found[rel]?.length ?? 0}`);
    expect(stale).toEqual([]);
  });
});
