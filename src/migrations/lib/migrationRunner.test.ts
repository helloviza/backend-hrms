// Unit coverage for the shared migration runner — the thing every
// retrofitted migration's main() goes through so the ledger (models/
// MigrationRun.ts) is a byproduct of running, not a separate step. Backed
// by a small in-memory collection (same convention as scripts/
// import-visa-checklist-rules.test.ts — mongodb-memory-server can't start
// in this environment).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";

const { runStore } = vi.hoisted(() => {
  type Doc = Record<string, any>;
  function makeCollection() {
    const store = new Map<string, Doc>();
    return {
      store,
      insert(doc: Doc): Doc {
        const id = doc._id ?? new mongoose.Types.ObjectId();
        const record: Doc = { ...doc, _id: id };
        store.set(String(id), record);
        return record;
      },
      findAll(filter: Doc): Doc[] {
        return Array.from(store.values()).filter((rec) =>
          Object.entries(filter).every(([k, v]) => String(rec[k]) === String(v)),
        );
      },
      clear() {
        store.clear();
      },
    };
  }
  return { runStore: makeCollection() };
});

function chainableSortLean(getResult: () => any[]) {
  return { sort: () => ({ lean: () => Promise.resolve(getResult()[0] ?? null) }) };
}

vi.mock("../../models/MigrationRun.js", () => ({
  default: {
    findOne: (filter: any) => chainableSortLean(() => runStore.findAll(filter)),
    create: async (doc: any) => runStore.insert(doc),
  },
}));

import { runMigration, findLastSuccessfulApply } from "./migrationRunner.js";

beforeEach(() => {
  runStore.clear();
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("runMigration", () => {
  it("records a DRY_RUN row and never blocks it, even when an APPLY/SUCCESS row already exists", async () => {
    runStore.insert({
      migrationName: "x",
      mode: "APPLY",
      outcome: "SUCCESS",
      completedAt: new Date(),
      runBy: "someone-else",
    });

    let ran = false;
    await runMigration({
      migrationName: "x",
      mode: "DRY_RUN",
      force: false,
      run: async () => {
        ran = true;
        return { outcome: "SUCCESS", summary: "would do nothing" };
      },
    });

    expect(ran).toBe(true);
    const rows = [...runStore.store.values()].filter((r) => r.mode === "DRY_RUN");
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("SUCCESS");
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses to APPLY when a prior APPLY/SUCCESS row exists, and never calls run()", async () => {
    runStore.insert({
      migrationName: "x",
      mode: "APPLY",
      outcome: "SUCCESS",
      completedAt: new Date("2026-08-02T00:00:00.000Z"),
      runBy: "someone-else",
    });

    let ran = false;
    await runMigration({
      migrationName: "x",
      mode: "APPLY",
      force: false,
      run: async () => {
        ran = true;
        return { outcome: "SUCCESS", summary: "should never get here" };
      },
    });

    expect(ran).toBe(false);
    expect(process.exitCode).toBe(1);
    // No new row was written — the store still has exactly the one from setup.
    expect(runStore.store.size).toBe(1);
  });

  it("--force bypasses the refusal and records a new APPLY row", async () => {
    runStore.insert({
      migrationName: "x",
      mode: "APPLY",
      outcome: "SUCCESS",
      completedAt: new Date("2026-08-02T00:00:00.000Z"),
      runBy: "someone-else",
    });

    let ran = false;
    await runMigration({
      migrationName: "x",
      mode: "APPLY",
      force: true,
      run: async () => {
        ran = true;
        return { outcome: "SUCCESS", summary: "re-applied" };
      },
    });

    expect(ran).toBe(true);
    expect(runStore.store.size).toBe(2);
  });

  it("allows APPLY when no prior successful APPLY exists, even if a FAILED or DRY_RUN row does", async () => {
    runStore.insert({ migrationName: "x", mode: "APPLY", outcome: "FAILED", completedAt: new Date(), runBy: "a" });
    runStore.insert({ migrationName: "x", mode: "DRY_RUN", outcome: "SUCCESS", completedAt: new Date(), runBy: "a" });

    let ran = false;
    await runMigration({
      migrationName: "x",
      mode: "APPLY",
      force: false,
      run: async () => {
        ran = true;
        return { outcome: "SUCCESS", summary: "first real success" };
      },
    });

    expect(ran).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("records outcome PARTIAL exactly as returned by run() — never silently upgraded to SUCCESS", async () => {
    await runMigration({
      migrationName: "y",
      mode: "APPLY",
      force: false,
      run: async () => ({ outcome: "PARTIAL", summary: "3 of 5 done" }),
    });

    const rows = [...runStore.store.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("PARTIAL");
  });

  it("writes a FAILED row (with the error message) and re-throws when run() throws", async () => {
    await expect(
      runMigration({
        migrationName: "z",
        mode: "APPLY",
        force: false,
        run: async () => {
          throw new Error("E11000 duplicate key");
        },
      }),
    ).rejects.toThrow("E11000 duplicate key");

    const rows = [...runStore.store.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("FAILED");
    expect(rows[0].error).toBe("E11000 duplicate key");
  });

  it("a FAILED row never counts as applied — a later APPLY attempt is still allowed", async () => {
    await runMigration({
      migrationName: "z",
      mode: "APPLY",
      force: false,
      run: async () => {
        throw new Error("boom");
      },
    }).catch(() => {});

    let ran = false;
    await runMigration({
      migrationName: "z",
      mode: "APPLY",
      force: false,
      run: async () => {
        ran = true;
        return { outcome: "SUCCESS", summary: "fixed and re-run" };
      },
    });

    expect(ran).toBe(true);
  });

  it("stamps every row with a non-empty runBy", async () => {
    await runMigration({
      migrationName: "w",
      mode: "APPLY",
      force: false,
      run: async () => ({ outcome: "SUCCESS", summary: "ok" }),
    });

    const row = [...runStore.store.values()][0];
    expect(typeof row.runBy).toBe("string");
    expect(row.runBy.length).toBeGreaterThan(0);
  });
});

describe("findLastSuccessfulApply", () => {
  it("returns null when nothing has ever successfully applied", async () => {
    runStore.insert({ migrationName: "x", mode: "APPLY", outcome: "FAILED", completedAt: new Date(), runBy: "a" });
    expect(await findLastSuccessfulApply("x")).toBeNull();
  });

  it("returns the row once an APPLY/SUCCESS exists", async () => {
    runStore.insert({ migrationName: "x", mode: "APPLY", outcome: "SUCCESS", completedAt: new Date(), runBy: "a" });
    const found = await findLastSuccessfulApply("x");
    expect(found).not.toBeNull();
    expect((found as any).outcome).toBe("SUCCESS");
  });
});
