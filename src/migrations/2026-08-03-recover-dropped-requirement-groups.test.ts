// Unit coverage for the dropped-requirement-group recovery migration —
// discoverDroppedGroups (pure) and recoverDroppedRequirementGroups (mocked
// VisaRule, same in-memory-collection convention as this directory's other
// migration tests). Uses the REAL mergeSharedBaseChecklists/
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

import {
  discoverDroppedGroups,
  recoverDroppedRequirementGroups,
} from "./2026-08-03-recover-dropped-requirement-groups.js";
import type { ExtractedVisaChecklistFile } from "../scripts/extract-visa-checklists.js";

beforeEach(() => {
  ruleStore.clear();
});

function requirementGroup(overrides: Record<string, any> = {}) {
  return {
    key: "GROUP_KEY",
    label: "Some Group",
    requirement: "REQUIRED",
    conditionText: null,
    appliesWhen: null,
    specification: null,
    templateReference: null,
    matchedTemplateCode: null,
    documents: [{ sourceName: "Doc", sourceDescription: null, matchedCode: "PASSPORT_ORIGINAL", suggestions: [] }],
    allDocumentsMatched: true,
    ...overrides,
  };
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
          requirementGroup({ key: "PASSPORT", documents: [{ sourceName: "Passport", sourceDescription: null, matchedCode: "PASSPORT_ORIGINAL", suggestions: [] }] }),
          requirementGroup({
            key: "AUTHORISATION_LETTER",
            label: "Authorisation letter",
            documents: [{ sourceName: "Authorisation Letter", sourceDescription: null, matchedCode: null, suggestions: [] }],
          }),
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
      { key: "PASSPORT", label: "Some Group", requirement: "REQUIRED", docTypeCodes: ["PASSPORT_ORIGINAL"] },
    ],
    ...overrides,
  });
}

describe("discoverDroppedGroups", () => {
  it("finds only the zero-matched-document group, not the matched one", () => {
    const { sites, totalDropped } = discoverDroppedGroups([fixtureFile()]);
    expect(totalDropped).toBe(1);
    expect(sites).toHaveLength(1);
    expect(sites[0].group.key).toBe("AUTHORISATION_LETTER");
    expect(sites[0].group.needsCatalogueMapping).toBe(true);
    expect(sites[0].group.unmatchedDocumentNames).toEqual(["Authorisation Letter"]);
  });

  it("counts totalGroupsScanned across every group in a resolved checklist, matched or not", () => {
    const { totalGroupsScanned } = discoverDroppedGroups([fixtureFile()]);
    expect(totalGroupsScanned).toBe(2);
  });

  it("tallies dropped groups by destination, sorted most-affected first", () => {
    const { droppedByCountry } = discoverDroppedGroups([
      fixtureFile(),
      fixtureFile({ destinationIso2: "GB", sourceFile: "UK.json" }),
      fixtureFile({
        destinationIso2: "GB",
        sourceFile: "UK2.json",
        checklists: [
          {
            purposeLabel: "Business",
            purpose: "BUSINESS",
            variantLabel: null,
            variantKey: "DEFAULT",
            applicability: null,
            visaCategory: null,
            productClass: "VISA",
            entryType: "UNSPECIFIED",
            serviceTier: "STANDARD",
            requirementGroups: [
              requirementGroup({
                key: "AUTHORISATION_LETTER",
                documents: [{ sourceName: "Authorisation Letter", sourceDescription: null, matchedCode: null, suggestions: [] }],
              }),
            ],
            questions: [],
          },
        ],
      }),
    ]);
    expect(droppedByCountry).toEqual([
      { destinationIso2: "GB", count: 2 },
      { destinationIso2: "TL", count: 1 },
    ]);
  });

  it("excludes a group whose checklist never resolved a purpose — no rule was ever imported for it", () => {
    const file = fixtureFile();
    (file.checklists[0] as any).purpose = null;
    const { totalDropped, sites } = discoverDroppedGroups([file]);
    expect(totalDropped).toBe(0);
    expect(sites).toHaveLength(0);
  });

  it("excludes a file whose destinationIso2 never resolved", () => {
    const file = fixtureFile({ destinationIso2: null });
    const { totalGroupsScanned, totalDropped } = discoverDroppedGroups([file]);
    expect(totalGroupsScanned).toBe(0);
    expect(totalDropped).toBe(0);
  });
});

describe("recoverDroppedRequirementGroups", () => {
  it("appends the dropped group onto the matching DRAFT rule", async () => {
    const rule = draftRule();
    const summary = await recoverDroppedRequirementGroups([fixtureFile()], false);
    expect(summary.recovered).toBe(1);
    const stored = ruleStore.store.get(String(rule._id));
    expect(stored.documentGroups).toHaveLength(2);
    const recovered = stored.documentGroups.find((g: any) => g.key === "AUTHORISATION_LETTER");
    expect(recovered.needsCatalogueMapping).toBe(true);
    expect(recovered.unmatchedDocumentNames).toEqual(["Authorisation Letter"]);
    expect(recovered.docTypeCodes).toEqual([]);
  });

  it("dry run reports the count but writes nothing", async () => {
    const rule = draftRule();
    const summary = await recoverDroppedRequirementGroups([fixtureFile()], true);
    expect(summary.recovered).toBe(1);
    expect(ruleStore.store.get(String(rule._id)).documentGroups).toHaveLength(1);
  });

  it("is idempotent — a second apply reports alreadyPresent, never duplicates the group", async () => {
    const rule = draftRule();
    await recoverDroppedRequirementGroups([fixtureFile()], false);
    const second = await recoverDroppedRequirementGroups([fixtureFile()], false);
    expect(second.recovered).toBe(0);
    expect(second.alreadyPresent).toBe(1);
    expect(ruleStore.store.get(String(rule._id)).documentGroups).toHaveLength(2);
  });

  it("never touches a group already present with the same key, even if ops has since edited it", async () => {
    const rule = draftRule({
      documentGroups: [
        { key: "PASSPORT", label: "Some Group", requirement: "REQUIRED", docTypeCodes: ["PASSPORT_ORIGINAL"] },
        { key: "AUTHORISATION_LETTER", label: "Ops-edited label", requirement: "REQUIRED", docTypeCodes: ["AUTHORIZATION_LETTER_ORIGINAL"] },
      ],
    });
    const summary = await recoverDroppedRequirementGroups([fixtureFile()], false);
    expect(summary.alreadyPresent).toBe(1);
    expect(summary.recovered).toBe(0);
    const stored = ruleStore.store.get(String(rule._id));
    expect(stored.documentGroups.find((g: any) => g.key === "AUTHORISATION_LETTER").label).toBe("Ops-edited label");
  });

  it("reports a checklist with no imported rule as ruleNotFound, never creates one", async () => {
    const summary = await recoverDroppedRequirementGroups([fixtureFile()], false);
    expect(summary.ruleNotFound).toHaveLength(1);
    expect(summary.ruleNotFound[0].groupKey).toBe("AUTHORISATION_LETTER");
  });

  it("leaves a PUBLISHED rule completely untouched", async () => {
    const rule = draftRule({ status: "PUBLISHED" });
    const summary = await recoverDroppedRequirementGroups([fixtureFile()], false);
    expect(summary.ruleNotDraft).toEqual([{ sourceFile: "Testland-document-checklist.pdf", purposeLabel: "Tourist", groupKey: "AUTHORISATION_LETTER", status: "PUBLISHED" }]);
    expect(ruleStore.store.get(String(rule._id)).documentGroups).toHaveLength(1);
  });
});
