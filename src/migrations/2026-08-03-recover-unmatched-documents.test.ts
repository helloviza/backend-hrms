// Unit coverage for the partial-match backfill migration —
// discoverPartialMatches (pure) and recoverPartialMatches (mocked VisaRule,
// same in-memory-collection convention as this directory's other migration
// tests). Uses the REAL mergeSharedBaseChecklists/
// buildDocumentGroupFromExtracted from scripts/import-visa-checklist-rules.js
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

vi.mock("../models/VisaRule.js", async () => {
  const actual: any = await vi.importActual("../models/VisaRule.js");
  return {
    ...actual,
    default: {
      findOne: (filter: any) => Promise.resolve(wrapRuleDoc(ruleStore.findOneRaw(filter))),
    },
  };
});

import { discoverPartialMatches, recoverPartialMatches } from "./2026-08-03-recover-unmatched-documents.js";
import type { ExtractedVisaChecklistFile } from "../scripts/extract-visa-checklists.js";

beforeEach(() => {
  ruleStore.clear();
});

function fullyMatchedDoc(name: string, code: string) {
  return { sourceName: name, sourceDescription: null, matchedCode: code, matchConfidence: "HIGH", matchReasoning: null, stringMatchCode: code, matchesAgree: true, suggestions: [] };
}
function unmatchedDoc(name: string) {
  return { sourceName: name, sourceDescription: null, matchedCode: null, matchConfidence: null, matchReasoning: null, stringMatchCode: null, matchesAgree: false, suggestions: [] };
}

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
        requirementGroups: [
          {
            key: "PROOF_OF_FUNDS",
            label: "Proof of funds",
            requirement: "REQUIRED",
            conditionText: null,
            appliesWhen: null,
            specification: null,
            templateReference: null,
            matchedTemplateCode: null,
            documents: [fullyMatchedDoc("Bank Statement", "BANK_STATEMENT"), unmatchedDoc("Salary Slip")],
            allDocumentsMatched: false,
          },
          {
            key: "PASSPORT",
            label: "Passport",
            requirement: "REQUIRED",
            conditionText: null,
            appliesWhen: null,
            specification: null,
            templateReference: null,
            matchedTemplateCode: null,
            documents: [fullyMatchedDoc("Passport", "PASSPORT_ORIGINAL")],
            allDocumentsMatched: true,
          },
        ],
        questions: [],
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
    documentGroups: [
      { key: "PROOF_OF_FUNDS", label: "Proof of funds", requirement: "REQUIRED", docTypeCodes: ["BANK_STATEMENT"] },
      { key: "PASSPORT", label: "Passport", requirement: "REQUIRED", docTypeCodes: ["PASSPORT_ORIGINAL"] },
    ],
    ...overrides,
  });
}

describe("discoverPartialMatches", () => {
  it("finds only the partially-matched group, not the fully-matched one", () => {
    const { sites, totalPartial } = discoverPartialMatches([fixtureFile()]);
    expect(totalPartial).toBe(1);
    expect(sites).toHaveLength(1);
    expect(sites[0].groupKey).toBe("PROOF_OF_FUNDS");
    expect(sites[0].unmatchedDocumentNames).toEqual(["Salary Slip"]);
  });

  it("counts totalGroupsScanned across every group, matched or not", () => {
    const { totalGroupsScanned } = discoverPartialMatches([fixtureFile()]);
    expect(totalGroupsScanned).toBe(2);
  });

  it("tallies by destination, sorted most-affected first", () => {
    const { byCountry } = discoverPartialMatches([fixtureFile(), fixtureFile({ destinationIso2: "GB", sourceFile: "UK.json" })]);
    expect(byCountry).toEqual([
      { destinationIso2: "GB", count: 1 },
      { destinationIso2: "TL", count: 1 },
    ]);
  });
});

describe("recoverPartialMatches", () => {
  it("backfills needsCatalogueMapping + unmatchedDocumentNames without touching docTypeCodes", () => {
    const rule = draftRule();
    return recoverPartialMatches([fixtureFile()], false).then((summary) => {
      expect(summary.recovered).toBe(1);
      const stored = ruleStore.store.get(String(rule._id));
      const group = stored.documentGroups.find((g: any) => g.key === "PROOF_OF_FUNDS");
      expect(group.docTypeCodes).toEqual(["BANK_STATEMENT"]);
      expect(group.needsCatalogueMapping).toBe(true);
      expect(group.unmatchedDocumentNames).toEqual(["Salary Slip"]);
    });
  });

  it("dry run writes nothing", async () => {
    const rule = draftRule();
    const summary = await recoverPartialMatches([fixtureFile()], true);
    expect(summary.recovered).toBe(1);
    const stored = ruleStore.store.get(String(rule._id));
    expect(stored.documentGroups.find((g: any) => g.key === "PROOF_OF_FUNDS").unmatchedDocumentNames).toBeUndefined();
  });

  it("is idempotent — a second run reports alreadySet, never overwrites", async () => {
    const rule = draftRule();
    await recoverPartialMatches([fixtureFile()], false);
    const second = await recoverPartialMatches([fixtureFile()], false);
    expect(second.recovered).toBe(0);
    expect(second.alreadySet).toBe(1);
    expect(ruleStore.store.get(String(rule._id)).documentGroups.find((g: any) => g.key === "PROOF_OF_FUNDS").unmatchedDocumentNames).toEqual(["Salary Slip"]);
  });

  it("never overwrites unmatchedDocumentNames an ops edit already set to something else", async () => {
    const rule = draftRule({
      documentGroups: [
        { key: "PROOF_OF_FUNDS", label: "Proof of funds", requirement: "REQUIRED", docTypeCodes: ["BANK_STATEMENT"], needsCatalogueMapping: true, unmatchedDocumentNames: ["Ops-reviewed name"] },
        { key: "PASSPORT", label: "Passport", requirement: "REQUIRED", docTypeCodes: ["PASSPORT_ORIGINAL"] },
      ],
    });
    const summary = await recoverPartialMatches([fixtureFile()], false);
    expect(summary.alreadySet).toBe(1);
    expect(ruleStore.store.get(String(rule._id)).documentGroups[0].unmatchedDocumentNames).toEqual(["Ops-reviewed name"]);
  });

  it("leaves a PUBLISHED rule untouched", async () => {
    const rule = draftRule({ status: "PUBLISHED" });
    const summary = await recoverPartialMatches([fixtureFile()], false);
    expect(summary.ruleNotDraft).toHaveLength(1);
    expect(ruleStore.store.get(String(rule._id)).documentGroups.find((g: any) => g.key === "PROOF_OF_FUNDS").unmatchedDocumentNames).toBeUndefined();
  });

  it("reports groupNotFound when the rule exists but this group key has since been removed", async () => {
    draftRule({ documentGroups: [{ key: "PASSPORT", label: "Passport", requirement: "REQUIRED", docTypeCodes: ["PASSPORT_ORIGINAL"] }] });
    const summary = await recoverPartialMatches([fixtureFile()], false);
    expect(summary.groupNotFound).toHaveLength(1);
    expect(summary.groupNotFound[0].groupKey).toBe("PROOF_OF_FUNDS");
  });
});
