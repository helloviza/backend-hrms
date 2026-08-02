// Unit coverage for the MigrationRun schema — schema-level only, no DB
// connection needed (same convention as models/VisaRule.test.ts).
import { describe, it, expect } from "vitest";
import MigrationRun from "./MigrationRun.js";

function minimalRunAttrs(overrides: Record<string, any> = {}) {
  return {
    migrationName: "2026-08-02-visa-checklist-model-v2",
    mode: "APPLY",
    outcome: "SUCCESS",
    startedAt: new Date("2026-08-02T10:00:00.000Z"),
    completedAt: new Date("2026-08-02T10:00:05.000Z"),
    summary: "33 created, 17 created, 12 updated, index widened.",
    runBy: "imran",
    ...overrides,
  };
}

describe("MigrationRun schema", () => {
  it("validates a well-formed row", () => {
    const doc = new MigrationRun(minimalRunAttrs());
    expect(doc.validateSync()).toBeUndefined();
  });

  it("rejects an unrecognised mode", () => {
    const doc = new MigrationRun(minimalRunAttrs({ mode: "LIVE_RUN" }));
    expect(doc.validateSync()).toBeDefined();
  });

  it("rejects an unrecognised outcome", () => {
    const doc = new MigrationRun(minimalRunAttrs({ outcome: "MOSTLY_FINE" }));
    expect(doc.validateSync()).toBeDefined();
  });

  it("accepts AUDIT mode with UNKNOWN outcome — the backfilled-audit shape", () => {
    const doc = new MigrationRun(minimalRunAttrs({ mode: "AUDIT", outcome: "UNKNOWN" }));
    expect(doc.validateSync()).toBeUndefined();
  });

  it("requires migrationName, mode, outcome, startedAt, completedAt, summary, runBy", () => {
    const doc = new MigrationRun({});
    const err = doc.validateSync();
    expect(err).toBeDefined();
    const missing = Object.keys(err!.errors);
    for (const field of ["migrationName", "mode", "outcome", "startedAt", "completedAt", "summary", "runBy"]) {
      expect(missing).toContain(field);
    }
  });

  it("leaves error undefined by default — only meaningful when outcome is FAILED", () => {
    const doc = new MigrationRun(minimalRunAttrs());
    expect(doc.error).toBeUndefined();
  });

  it("accepts a FAILED row with an error message", () => {
    const doc = new MigrationRun(minimalRunAttrs({ outcome: "FAILED", error: "E11000 duplicate key" }));
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.error).toBe("E11000 duplicate key");
  });
});
