// Unit coverage for normalizeDestinationNames — mocked VisaRule, same
// in-memory-collection convention as this directory's other migration
// tests.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const { ruleStore } = vi.hoisted(() => {
  type Doc = Record<string, any>;
  const store = new Map<string, Doc>();
  return {
    ruleStore: {
      store,
      insert(doc: Doc): Doc {
        const id = doc._id ?? new mongoose.Types.ObjectId();
        const record: Doc = { ...doc, _id: id };
        store.set(String(id), record);
        return record;
      },
      clear() {
        store.clear();
      },
    },
  };
});

vi.mock("../models/VisaRule.js", () => ({
  default: {
    find: (_filter: any) => ({
      select: () => ({
        lean: () => Promise.resolve([...ruleStore.store.values()].map((r) => ({ ...r }))),
      }),
    }),
    updateOne: async (filter: any, update: any) => {
      const rec = ruleStore.store.get(String(filter._id));
      if (!rec) return { matchedCount: 0 };
      if (filter.destinationName !== undefined && rec.destinationName !== filter.destinationName) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      if (update.$set) Object.assign(rec, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  },
}));

import { normalizeDestinationNames } from "./2026-08-02-normalize-destination-names.js";

beforeEach(() => {
  ruleStore.clear();
});

describe("normalizeDestinationNames", () => {
  it("corrects a destinationName that diverges from countryCodes.ts's canonical name", async () => {
    const rule = ruleStore.insert({ destinationIso2: "US", destinationName: "United States of America" });
    const summary = await normalizeDestinationNames(false);
    expect(summary.updated).toBe(1);
    expect(summary.changes).toEqual([
      { ruleId: String(rule._id), destinationIso2: "US", from: "United States of America", to: "United States" },
    ]);
    expect(ruleStore.store.get(String(rule._id))!.destinationName).toBe("United States");
  });

  it("leaves an already-canonical destinationName unchanged", async () => {
    ruleStore.insert({ destinationIso2: "US", destinationName: "United States" });
    const summary = await normalizeDestinationNames(false);
    expect(summary.updated).toBe(0);
    expect(summary.unchanged).toBe(1);
  });

  it("dry run reports the change but writes nothing", async () => {
    const rule = ruleStore.insert({ destinationIso2: "US", destinationName: "United States of America" });
    const summary = await normalizeDestinationNames(true);
    expect(summary.updated).toBe(1);
    expect(ruleStore.store.get(String(rule._id))!.destinationName).toBe("United States of America");
  });

  it("skips and reports an ISO2 countryCodes.ts doesn't recognise, rather than blanking it", async () => {
    const rule = ruleStore.insert({ destinationIso2: "ZZ", destinationName: "Nowhereland" });
    const summary = await normalizeDestinationNames(false);
    expect(summary.updated).toBe(0);
    expect(summary.skippedNoCanonicalName).toEqual([
      { ruleId: String(rule._id), destinationIso2: "ZZ", destinationName: "Nowhereland" },
    ]);
    expect(ruleStore.store.get(String(rule._id))!.destinationName).toBe("Nowhereland");
  });

  it("reports every ISO2 currently carrying more than one distinct name, computed from pre-run state", async () => {
    ruleStore.insert({ destinationIso2: "US", destinationName: "United States" });
    ruleStore.insert({ destinationIso2: "US", destinationName: "United States of America" });
    ruleStore.insert({ destinationIso2: "GB", destinationName: "United Kingdom" });
    const summary = await normalizeDestinationNames(true);
    expect(summary.divergentIso2sBeforeRun).toEqual([
      { destinationIso2: "US", names: ["United States", "United States of America"] },
    ]);
  });

  it("scans every rule regardless of seedSource — this is a data-integrity fix, not scoped to one import batch", async () => {
    ruleStore.insert({ destinationIso2: "US", destinationName: "United States of America", seedSource: "seed-visa-rules" });
    ruleStore.insert({ destinationIso2: "US", destinationName: "United States of America", seedSource: "visa-checklist-extraction@2026-08" });
    const summary = await normalizeDestinationNames(false);
    expect(summary.scanned).toBe(2);
    expect(summary.updated).toBe(2);
  });
});
