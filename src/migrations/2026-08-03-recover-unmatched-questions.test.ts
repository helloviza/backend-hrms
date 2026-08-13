// Unit coverage for the unmatched-questions recovery migration —
// discoverUnmatchedQuestions (pure) and recoverUnmatchedQuestions (mocked
// VisaRule, same in-memory-collection convention as this directory's other
// migration tests). Uses the REAL mergeSharedBaseChecklists/
// buildUnmatchedInlineQuestions from scripts/import-visa-checklist-rules.js
// — both are pure, so no mock needed there.
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
        const record: Doc = { ...doc, _id: id, additionalQuestions: doc.additionalQuestions ?? [] };
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
  const doc: any = { ...rec, additionalQuestions: [...(rec.additionalQuestions || [])] };
  Object.defineProperty(doc, "save", {
    enumerable: false,
    value: async () => {
      Object.assign(rec, doc);
      return doc;
    },
  });
  return doc;
}

vi.mock("../models/VisaRule.js", async () => {
  const actual: any = await vi.importActual("../models/VisaRule.js");
  return {
    ...actual,
    default: {
      findOne: (filter: any) => Promise.resolve(wrapRuleDoc(ruleStore.findOneRaw(filter))),
    },
  };
});

import { discoverUnmatchedQuestions, recoverUnmatchedQuestions } from "./2026-08-03-recover-unmatched-questions.js";
import type { ExtractedVisaChecklistFile } from "../scripts/extract-visa-checklists.js";

beforeEach(() => {
  ruleStore.clear();
});

function fixtureFile(overrides: Record<string, any> = {}): ExtractedVisaChecklistFile {
  return {
    sourceFile: "Testland-document-checklist.pdf",
    duplicateOfSourceFiles: [],
    destinationName: "Testland",
    destinationIso2: "TL",
    nationality: "IN",
    extractedAt: "2026-08-03T00:00:00Z",
    model: "gemini-2.5-flash",
    checklists: [
      {
        purposeLabel: "Tourist",
        purpose: "TOURIST",
        variantLabel: null,
        variantKey: "DEFAULT",
        applicability: null,
        visaCategory: null,
        productClass: "VISA",
        entryType: "UNSPECIFIED",
        serviceTier: "STANDARD",
        requirementGroups: [],
        questions: [
          { sourcePrompt: "What is your marital status?", detailsText: null, matchedQuestionCode: "MARITAL_STATUS", suggestions: [] },
          { sourcePrompt: "Have you been refused a visa before?", detailsText: null, matchedQuestionCode: null, suggestions: [] },
        ],
      },
    ],
    ...overrides,
  } as unknown as ExtractedVisaChecklistFile;
}

function draftRule(overrides: Record<string, any> = {}) {
  return ruleStore.insert({
    nationality: "IN",
    destinationIso2: "TL",
    destinationName: "Testland",
    purpose: "TOURIST",
    entryType: "UNSPECIFIED",
    serviceTier: "STANDARD",
    variantKey: "DEFAULT",
    status: "DRAFT",
    additionalQuestions: [],
    ...overrides,
  });
}

describe("discoverUnmatchedQuestions", () => {
  it("finds only the unmatched question, preserving its prompt and flag", () => {
    const { sites, totalUnmatched } = discoverUnmatchedQuestions([fixtureFile()]);
    expect(totalUnmatched).toBe(1);
    expect(sites).toHaveLength(1);
    expect(sites[0].question).toEqual({
      code: "HAVE_YOU_BEEN_REFUSED_A_VISA_BEFORE",
      prompt: "Have you been refused a visa before?",
      needsCatalogueMapping: true,
    });
  });

  it("counts totalQuestionsScanned across matched and unmatched", () => {
    const { totalQuestionsScanned } = discoverUnmatchedQuestions([fixtureFile()]);
    expect(totalQuestionsScanned).toBe(2);
  });

  it("tallies by destination, sorted most-affected first", () => {
    const { byCountry } = discoverUnmatchedQuestions([fixtureFile(), fixtureFile({ destinationIso2: "GB", sourceFile: "UK.json" })]);
    expect(byCountry).toEqual([
      { destinationIso2: "GB", count: 1 },
      { destinationIso2: "TL", count: 1 },
    ]);
  });

  it("excludes a checklist whose purpose never resolved", () => {
    const file = fixtureFile();
    (file.checklists[0] as any).purpose = null;
    const { totalUnmatched } = discoverUnmatchedQuestions([file]);
    expect(totalUnmatched).toBe(0);
  });
});

describe("recoverUnmatchedQuestions", () => {
  it("appends the unmatched question onto the matching DRAFT rule", async () => {
    const rule = draftRule();
    const summary = await recoverUnmatchedQuestions([fixtureFile()], false);
    expect(summary.recovered).toBe(1);
    const stored = ruleStore.store.get(String(rule._id));
    expect(stored.additionalQuestions).toHaveLength(1);
    expect(stored.additionalQuestions[0].prompt).toBe("Have you been refused a visa before?");
    expect(stored.additionalQuestions[0].needsCatalogueMapping).toBe(true);
    expect(stored.additionalQuestions[0].answerType).toBeUndefined();
  });

  it("dry run writes nothing", async () => {
    const rule = draftRule();
    const summary = await recoverUnmatchedQuestions([fixtureFile()], true);
    expect(summary.recovered).toBe(1);
    expect(ruleStore.store.get(String(rule._id)).additionalQuestions).toHaveLength(0);
  });

  it("is idempotent — a second apply reports alreadyPresent, never duplicates", async () => {
    const rule = draftRule();
    await recoverUnmatchedQuestions([fixtureFile()], false);
    const second = await recoverUnmatchedQuestions([fixtureFile()], false);
    expect(second.recovered).toBe(0);
    expect(second.alreadyPresent).toBe(1);
    expect(ruleStore.store.get(String(rule._id)).additionalQuestions).toHaveLength(1);
  });

  it("reports a checklist with no imported rule as ruleNotFound", async () => {
    const summary = await recoverUnmatchedQuestions([fixtureFile()], false);
    expect(summary.ruleNotFound).toHaveLength(1);
  });

  it("leaves a PUBLISHED rule untouched", async () => {
    const rule = draftRule({ status: "PUBLISHED" });
    const summary = await recoverUnmatchedQuestions([fixtureFile()], false);
    expect(summary.ruleNotDraft).toHaveLength(1);
    expect(ruleStore.store.get(String(rule._id)).additionalQuestions).toHaveLength(0);
  });
});
