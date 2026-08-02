// Unit coverage for flagUaeOverlap — mocked VisaRule, same
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
      findOneRaw(filter: Doc): Doc | null {
        for (const rec of store.values()) {
          if (Object.entries(filter).every(([k, v]) => String(rec[k]) === String(v))) return rec;
        }
        return null;
      },
      clear() {
        store.clear();
      },
    },
  };
});

function wrapRuleDoc(rec: Record<string, any> | null) {
  if (!rec) return null;
  const doc: any = { ...rec };
  Object.defineProperty(doc, "save", {
    enumerable: false,
    value: async () => {
      Object.assign(rec, doc);
      return doc;
    },
  });
  return doc;
}

vi.mock("../models/VisaRule.js", () => ({
  default: {
    findOne: (filter: any) => Promise.resolve(wrapRuleDoc(ruleStore.findOneRaw(filter))),
  },
}));

import { flagUaeOverlap, UAE_DRAFT_RULE_KEY, UAE_OVERLAP_NOTE } from "./2026-08-02-flag-uae-overlap.js";

beforeEach(() => {
  ruleStore.clear();
});

function uaeDraftRule(overrides: Record<string, any> = {}) {
  return ruleStore.insert({ ...UAE_DRAFT_RULE_KEY, status: "DRAFT", opsNotes: "", ...overrides });
}

describe("flagUaeOverlap", () => {
  it("reports no rule found when the draft UAE key doesn't exist", async () => {
    const summary = await flagUaeOverlap(false);
    expect(summary).toEqual({ ruleFound: false, ruleId: null, status: null, alreadyFlagged: false, applied: false });
  });

  it("appends the overlap note to an empty opsNotes", async () => {
    const rule = uaeDraftRule();
    const summary = await flagUaeOverlap(false);
    expect(summary.applied).toBe(true);
    expect(summary.alreadyFlagged).toBe(false);
    expect(ruleStore.store.get(String(rule._id))!.opsNotes).toBe(UAE_OVERLAP_NOTE);
  });

  it("appends onto an existing unrelated note rather than overwriting it", async () => {
    const rule = uaeDraftRule({ opsNotes: "Some pre-existing ops note." });
    await flagUaeOverlap(false);
    const stored = ruleStore.store.get(String(rule._id))!;
    expect(stored.opsNotes).toBe(`Some pre-existing ops note.\n\n${UAE_OVERLAP_NOTE}`);
  });

  it("dry run writes nothing", async () => {
    const rule = uaeDraftRule();
    const summary = await flagUaeOverlap(true);
    expect(summary.applied).toBe(true);
    expect(ruleStore.store.get(String(rule._id))!.opsNotes).toBe("");
  });

  it("is idempotent — a second apply reports alreadyFlagged and doesn't duplicate the note", async () => {
    const rule = uaeDraftRule();
    await flagUaeOverlap(false);
    const second = await flagUaeOverlap(false);
    expect(second.alreadyFlagged).toBe(true);
    expect(second.applied).toBe(false);
    expect(ruleStore.store.get(String(rule._id))!.opsNotes).toBe(UAE_OVERLAP_NOTE);
  });
});
