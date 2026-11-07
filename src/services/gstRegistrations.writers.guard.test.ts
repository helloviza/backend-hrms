// apps/backend/src/services/gstRegistrations.writers.guard.test.ts
//
// R2 guard: services/gstRegistrations.ts is the only writer of a company's
// GST registrations and of the fields that mirror the default one
// (gstNumber, gstRegisteredState, gstRegisteredStateCode, gstRegistrations).
//
// A source-text ratchet. Every backend source line that has the SHAPE of a
// write to one of those fields — `field: …` (not a `: 1` projection) or
// `.field = …` — outside the service and the models is listed below with the
// reason it is not a Customer/CustomerWorkspace GST write. A new such line
// fails this test until someone routes it through the service or adds it here
// with its reason. Counts are per file, so moving a line is fine; adding one
// is a decision.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "..");
const WRITE_SHAPE =
  /\b(gstNumber|gstRegisteredState|gstRegisteredStateCode|gstRegistrations)\b\s*:(?!\s*1\b)|\.(gstNumber|gstRegisteredState|gstRegisteredStateCode|gstRegistrations)\s*=(?!=)/;

// file (relative to src/) → [count, why it is allowed]
const ALLOWED: Record<string, [number, string]> = {
  "config/levelTemplates.ts": [9, "the Access Console permission key gstRegistrations (type + NONE in each template), not the Customer field"],
  "routes/admin.loyalty.ts": [1, "query filter (search by GSTIN)"],
  "routes/customerUsers.ts": [3, "response mapping (reads)"],
  "routes/customers.ts": [3, "response mapping; request-body normalisation before applyLegacyGstFields; onboarding-form copy of the service's default GSTIN"],
  "routes/directCustomers.ts": [5, "response mapping; checkGstin input; state of a GSTIN-less customer (refused when it contradicts a GSTIN)"],
  "routes/gstRegistrations.ts": [2, "checkGstin input"],
  "routes/manualBookings.ts": [1, "query filter (bulk import lookup by GSTIN)"],
  "routes/masterData.ts": [5, "Onboarding.formPayload copies (vendor + form); state of a company with NO registrations (adapter removed it otherwise); promote's local form object"],
  "routes/signup.ts": [1, "SaaS signup: CustomerWorkspace with no Customer (no registrations possible)"],
  "routes/workspace.settings.ts": [4, "applyLegacyGstFields input; SaaS workspace with no Customer (validated); response mapping"],
  "scripts/backfill-gst-states.ts": [3, "fills state only where none is set; a company with registrations always has one"],
  "scripts/backfillCustomerBilling.ts": [1, "query filter (selection unchanged; no longer writes the GSTIN)"],
  "scripts/importZohoContacts.ts": [1, "query filter (match an existing customer by GSTIN)"],
  "scripts/seed-d2c-house-identities.ts": [3, "dev seed: HOUSE customer's state, no GSTIN"],
  "services/loyalty.ts": [1, "query filter (same-PAN suggestions)"],
};

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
  });
}

describe("only the registration service writes client GST fields", () => {
  const found: Record<string, string[]> = {};
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).replace(/\\/g, "/");
    if (rel === "services/gstRegistrations.ts" || rel.startsWith("models/")) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const hits = lines.map((l, i) => [l, i] as const).filter(([l]) => !/^\s*(\/\/|\*)/.test(l) && WRITE_SHAPE.test(l));
    if (hits.length) found[rel] = hits.map(([l, i]) => `${rel}:${i + 1}: ${l.trim()}`);
  }

  it("no unreviewed write-shaped line outside the service", () => {
    const unexpected: string[] = [];
    for (const [rel, lines] of Object.entries(found)) {
      const allowed = ALLOWED[rel]?.[0] ?? 0;
      if (lines.length > allowed) unexpected.push(`${rel}: ${lines.length} (allowed ${allowed})\n    ${lines.join("\n    ")}`);
    }
    expect(unexpected, `Route these through services/gstRegistrations.ts, or add them to ALLOWED with a reason:\n${unexpected.join("\n")}`).toEqual([]);
  });

  it("the allowlist has no stale entries (counts only shrink by editing it)", () => {
    const stale = Object.entries(ALLOWED)
      .filter(([rel, [n]]) => (found[rel]?.length ?? 0) < n)
      .map(([rel, [n]]) => `${rel}: allowed ${n}, found ${found[rel]?.length ?? 0}`);
    expect(stale).toEqual([]);
  });

  it("the service is still the one place that sets the mirrors", () => {
    const svc = fs.readFileSync(path.join(SRC, "services/gstRegistrations.ts"), "utf8");
    expect(svc).toMatch(/gstNumber: def\.gstin, gstRegisteredState: def\.state, gstRegisteredStateCode: def\.stateCode/);
    expect(svc).toMatch(/CustomerWorkspace\.updateOne\(\{ customerId: String\(customerId\) \}, \{ \$set: \{ gstNumber \} \}\)/);
  });
});
