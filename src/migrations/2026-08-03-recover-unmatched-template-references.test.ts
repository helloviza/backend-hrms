// Unit coverage for the unmatched-template-reference recovery migration —
// discoverTemplateReferenceSites (pure) and recoverUnmatchedTemplateReferences
// (mocked VisaRule, same in-memory-collection convention as this directory's
// other migration tests). Uses the REAL mergeSharedBaseChecklists from
// scripts/import-visa-checklist-rules.js — pure, so no mock needed there.
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

import {
  discoverTemplateReferenceSites,
  recoverUnmatchedTemplateReferences,
} from "./2026-08-03-recover-unmatched-template-references.js";
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
        requirementGroups: [
          {
            key: "COVER_LETTER",
            label: "Cover Letter",
            requirement: "REQUIRED",
            conditionText: null,
            appliesWhen: null,
            specification: null,
            templateReference: "Cover Letter Template",
            matchedTemplateCode: null,
            documents: [{ sourceName: "Cover Letter", sourceDescription: null, matchedCode: "COVER_LETTER", matchConfidence: "HIGH", matchReasoning: null, stringMatchCode: "COVER_LETTER", matchesAgree: true, suggestions: [] }],
            allDocumentsMatched: true,
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
            documents: [{ sourceName: "Passport", sourceDescription: null, matchedCode: "PASSPORT_ORIGINAL", matchConfidence: "HIGH", matchReasoning: null, stringMatchCode: "PASSPORT_ORIGINAL", matchesAgree: true, suggestions: [] }],
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
      { key: "COVER_LETTER", label: "Cover Letter", requirement: "REQUIRED", docTypeCodes: ["COVER_LETTER"] },
      { key: "PASSPORT", label: "Passport", requirement: "REQUIRED", docTypeCodes: ["PASSPORT_ORIGINAL"] },
    ],
    ...overrides,
  });
}

describe("discoverTemplateReferenceSites", () => {
  it("finds only the group carrying a templateReference", () => {
    const { sites, totalWithReference } = discoverTemplateReferenceSites([fixtureFile()]);
    expect(totalWithReference).toBe(1);
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ groupKey: "COVER_LETTER", templateReference: "Cover Letter Template" });
  });

  it("counts totalGroupsScanned across every group, referenced or not", () => {
    const { totalGroupsScanned } = discoverTemplateReferenceSites([fixtureFile()]);
    expect(totalGroupsScanned).toBe(2);
  });

  it("tallies by destination, sorted most-affected first", () => {
    const { byCountry } = discoverTemplateReferenceSites([fixtureFile(), fixtureFile({ destinationIso2: "GB", sourceFile: "UK.json" })]);
    expect(byCountry).toEqual([
      { destinationIso2: "GB", count: 1 },
      { destinationIso2: "TL", count: 1 },
    ]);
  });
});

describe("recoverUnmatchedTemplateReferences", () => {
  it("flags the group with unmatchedTemplateReference when templateCode is still absent", async () => {
    const rule = draftRule();
    const summary = await recoverUnmatchedTemplateReferences([fixtureFile()], false);
    expect(summary.recovered).toBe(1);
    const stored = ruleStore.store.get(String(rule._id));
    const group = stored.documentGroups.find((g: any) => g.key === "COVER_LETTER");
    expect(group.needsCatalogueMapping).toBe(true);
    expect(group.unmatchedTemplateReference).toBe("Cover Letter Template");
    expect(group.docTypeCodes).toEqual(["COVER_LETTER"]); // untouched
  });

  it("leaves a group whose templateCode is already resolved (e.g. via the 2026-08-02 relink) completely alone", async () => {
    const rule = draftRule({
      documentGroups: [
        { key: "COVER_LETTER", label: "Cover Letter", requirement: "REQUIRED", docTypeCodes: ["COVER_LETTER"], templateCode: "COVER_LETTER_TEMPLATE" },
        { key: "PASSPORT", label: "Passport", requirement: "REQUIRED", docTypeCodes: ["PASSPORT_ORIGINAL"] },
      ],
    });
    const summary = await recoverUnmatchedTemplateReferences([fixtureFile()], false);
    expect(summary.resolvedElsewhere).toBe(1);
    expect(summary.recovered).toBe(0);
    const stored = ruleStore.store.get(String(rule._id));
    expect(stored.documentGroups[0].unmatchedTemplateReference).toBeUndefined();
  });

  it("dry run writes nothing", async () => {
    const rule = draftRule();
    const summary = await recoverUnmatchedTemplateReferences([fixtureFile()], true);
    expect(summary.recovered).toBe(1);
    const stored = ruleStore.store.get(String(rule._id));
    expect(stored.documentGroups.find((g: any) => g.key === "COVER_LETTER").unmatchedTemplateReference).toBeUndefined();
  });

  it("is idempotent — a second run reports alreadySet, never overwrites", async () => {
    const rule = draftRule();
    await recoverUnmatchedTemplateReferences([fixtureFile()], false);
    const second = await recoverUnmatchedTemplateReferences([fixtureFile()], false);
    expect(second.recovered).toBe(0);
    expect(second.alreadySet).toBe(1);
    expect(ruleStore.store.get(String(rule._id)).documentGroups.find((g: any) => g.key === "COVER_LETTER").unmatchedTemplateReference).toBe(
      "Cover Letter Template",
    );
  });

  it("leaves a PUBLISHED rule untouched", async () => {
    const rule = draftRule({ status: "PUBLISHED" });
    const summary = await recoverUnmatchedTemplateReferences([fixtureFile()], false);
    expect(summary.ruleNotDraft).toHaveLength(1);
    expect(ruleStore.store.get(String(rule._id)).documentGroups.find((g: any) => g.key === "COVER_LETTER").unmatchedTemplateReference).toBeUndefined();
  });

  it("reports a checklist with no imported rule as ruleNotFound", async () => {
    const summary = await recoverUnmatchedTemplateReferences([fixtureFile()], false);
    expect(summary.ruleNotFound).toHaveLength(1);
  });
});
