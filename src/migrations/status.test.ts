// Unit coverage for migrations/status.ts's classification logic — the
// pure function that turns a migration's MigrationRun rows into one of the
// three statuses the task brief asked for (APPLIED / DRY_RUN_ONLY /
// NEVER_SEEN), plus UNKNOWN for a backfilled audit finding. No DB
// connection needed — classifyMigrationRuns takes plain objects.
import { describe, it, expect } from "vitest";
import { classifyMigrationRuns } from "./status.js";

describe("classifyMigrationRuns", () => {
  it("NEVER_SEEN — no rows at all", () => {
    expect(classifyMigrationRuns([])).toBe("NEVER_SEEN");
  });

  it("DRY_RUN_ONLY — only dry-run rows exist", () => {
    expect(classifyMigrationRuns([{ mode: "DRY_RUN", outcome: "SUCCESS" }])).toBe("DRY_RUN_ONLY");
  });

  it("DRY_RUN_ONLY — an APPLY row exists but never succeeded", () => {
    expect(classifyMigrationRuns([{ mode: "APPLY", outcome: "FAILED" }])).toBe("DRY_RUN_ONLY");
    expect(classifyMigrationRuns([{ mode: "APPLY", outcome: "PARTIAL" }])).toBe("DRY_RUN_ONLY");
  });

  it("APPLIED — an APPLY/SUCCESS row exists", () => {
    expect(classifyMigrationRuns([{ mode: "APPLY", outcome: "SUCCESS" }])).toBe("APPLIED");
  });

  it("APPLIED — even when a later dry-run or failure also exists", () => {
    expect(
      classifyMigrationRuns([
        { mode: "APPLY", outcome: "SUCCESS" },
        { mode: "DRY_RUN", outcome: "SUCCESS" },
        { mode: "APPLY", outcome: "FAILED" },
      ]),
    ).toBe("APPLIED");
  });

  it("UNKNOWN — a backfilled AUDIT/UNKNOWN row exists and nothing ever succeeded", () => {
    expect(classifyMigrationRuns([{ mode: "AUDIT", outcome: "UNKNOWN" }])).toBe("UNKNOWN");
  });

  it("APPLIED wins over UNKNOWN — a real success outranks a prior audit finding", () => {
    expect(
      classifyMigrationRuns([
        { mode: "AUDIT", outcome: "UNKNOWN" },
        { mode: "APPLY", outcome: "SUCCESS" },
      ]),
    ).toBe("APPLIED");
  });
});
