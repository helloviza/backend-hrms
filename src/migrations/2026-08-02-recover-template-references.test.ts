// Unit coverage for the template-reference recovery migration —
// discoverTemplateReferences (pure) and recoverTemplateReferences (mocked
// VisaRule/VisaTemplate, same in-memory-collection convention as this
// directory's other migration tests).
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const { ruleStore, templateStore } = vi.hoisted(() => {
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
      findOneRaw(filter: Doc): Doc | null {
        for (const rec of store.values()) {
          if (Object.entries(filter).every(([k, v]) => String(rec[k]) === String(v))) return rec;
        }
        return null;
      },
      clear() {
        store.clear();
      },
    };
  }
  return { ruleStore: makeCollection(), templateStore: makeCollection() };
});

function chainableLeanOne(getResult: () => any) {
  return { lean: () => Promise.resolve(getResult()) };
}

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
    findOne: (filter: any) => {
      const rec = ruleStore.findOneRaw(filter);
      const p: any = Promise.resolve(wrapRuleDoc(rec));
      return p;
    },
  },
}));

vi.mock("../models/VisaTemplate.js", () => ({
  default: {
    findOne: (filter: any) => chainableLeanOne(() => templateStore.findOneRaw(filter)),
    create: async (doc: any) => templateStore.insert(doc),
    updateOne: async (filter: any, update: any) => {
      const rec = templateStore.findOneRaw(filter);
      if (!rec) return { matchedCount: 0 };
      if (update.$set) Object.assign(rec, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  },
}));

import { discoverTemplateReferences, recoverTemplateReferences } from "./2026-08-02-recover-template-references.js";
import type { ExtractedVisaChecklistFile } from "../scripts/extract-visa-checklists.js";

beforeEach(() => {
  ruleStore.clear();
  templateStore.clear();
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
    extractedAt: "2026-08-02T00:00:00Z",
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
          requirementGroup({ key: "COVER_LETTER", templateReference: "Cover Letter Template" }),
          requirementGroup({ key: "FORM_1229", templateReference: "Form 1229" }), // not "...Template" — excluded
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
    ],
    ...overrides,
  });
}

describe("discoverTemplateReferences", () => {
  it("finds only references ending in the word 'Template', not form numbers or samples", () => {
    const { discovered } = discoverTemplateReferences([fixtureFile()]);
    const names = discovered.map((d) => d.name);
    expect(names).toEqual(["Cover Letter Template"]);
    expect(names).not.toContain("Form 1229");
  });

  it("counts uses and destinations across multiple files", () => {
    const { discovered } = discoverTemplateReferences([
      fixtureFile(),
      fixtureFile({ destinationIso2: "GB", sourceFile: "UK.json" }),
    ]);
    const cover = discovered.find((d) => d.name === "Cover Letter Template")!;
    expect(cover.count).toBe(2);
    expect(cover.applicableCountries).toEqual(["GB", "TL"]);
  });

  it("still counts a reference from a checklist whose purpose never resolved, but doesn't produce a relink target for it", () => {
    const file = fixtureFile();
    (file.checklists[0] as any).purpose = null;
    const { discovered, relinkTargets } = discoverTemplateReferences([file]);
    expect(discovered.find((d) => d.name === "Cover Letter Template")?.count).toBe(1);
    expect(relinkTargets).toHaveLength(0);
  });

  it("produces one relink target per template-referencing group with a resolved purpose", () => {
    const { relinkTargets } = discoverTemplateReferences([fixtureFile()]);
    expect(relinkTargets).toHaveLength(1);
    expect(relinkTargets[0]).toMatchObject({ groupKey: "COVER_LETTER", templateName: "Cover Letter Template" });
  });
});

describe("recoverTemplateReferences", () => {
  it("seeds a new VisaTemplate for a discovered, curated reference", async () => {
    draftRule();
    const summary = await recoverTemplateReferences([fixtureFile()], false);
    expect(summary.templatesSeeded).toBe(1);
    expect(templateStore.store.size).toBe(1);
    const seeded = [...templateStore.store.values()][0];
    expect(seeded.code).toBe("COVER_LETTER_TEMPLATE");
    expect(seeded.name).toBe("Cover Letter Template");
    expect(seeded.s3Key).toBeNull();
    expect(seeded.applicableCountries).toEqual(["TL"]);
  });

  it("relinks templateCode onto the matching rule's requirement group", async () => {
    const rule = draftRule();
    const summary = await recoverTemplateReferences([fixtureFile()], false);
    expect(summary.relinkApplied).toBe(1);
    const stored = ruleStore.store.get(String(rule._id));
    expect(stored.documentGroups[0].templateCode).toBe("COVER_LETTER_TEMPLATE");
  });

  it("dry run writes nothing", async () => {
    const rule = draftRule();
    const summary = await recoverTemplateReferences([fixtureFile()], true);
    expect(summary.templatesSeeded).toBe(1);
    expect(summary.relinkApplied).toBe(1);
    expect(templateStore.store.size).toBe(0);
    expect(ruleStore.store.get(String(rule._id)).documentGroups[0].templateCode).toBeUndefined();
  });

  it("never overwrites a group that already has a templateCode", async () => {
    const rule = draftRule({ documentGroups: [{ key: "COVER_LETTER", label: "Cover Letter", requirement: "REQUIRED", docTypeCodes: ["COVER_LETTER"], templateCode: "SOMETHING_ELSE" }] });
    const summary = await recoverTemplateReferences([fixtureFile()], false);
    expect(summary.relinkAlreadySet).toBe(1);
    expect(summary.relinkApplied).toBe(0);
    expect(ruleStore.store.get(String(rule._id)).documentGroups[0].templateCode).toBe("SOMETHING_ELSE");
  });

  it("is idempotent — a second apply reports unchanged/already-set, no duplicate template rows", async () => {
    draftRule();
    await recoverTemplateReferences([fixtureFile()], false);
    const second = await recoverTemplateReferences([fixtureFile()], false);
    expect(second.templatesSeeded).toBe(0);
    expect(second.templatesUnchanged).toBe(1);
    expect(second.relinkAlreadySet).toBe(1);
    expect(templateStore.store.size).toBe(1);
  });

  it("reports a rule that was never imported (unresolved purpose) as relinkRuleNotFound", async () => {
    // No draftRule() inserted — nothing exists for this natural key.
    const summary = await recoverTemplateReferences([fixtureFile()], false);
    expect(summary.relinkRuleNotFound).toHaveLength(1);
    expect(summary.relinkRuleNotFound[0].groupKey).toBe("COVER_LETTER");
  });

  it("reports a rule that exists but is missing this specific group key as relinkGroupNotFound", async () => {
    draftRule({ documentGroups: [{ key: "SOME_OTHER_GROUP", label: "Other", requirement: "REQUIRED", docTypeCodes: ["PASSPORT_ORIGINAL"] }] });
    const summary = await recoverTemplateReferences([fixtureFile()], false);
    expect(summary.relinkGroupNotFound).toHaveLength(1);
  });

  it("widens applicableCountries on an already-seeded template rather than re-creating it", async () => {
    draftRule();
    await recoverTemplateReferences([fixtureFile()], false);
    draftRule({ destinationIso2: "GB", _id: new mongoose.Types.ObjectId(), documentGroups: [{ key: "COVER_LETTER", label: "Cover Letter", requirement: "REQUIRED", docTypeCodes: ["COVER_LETTER"] }] });
    const second = await recoverTemplateReferences([fixtureFile(), fixtureFile({ destinationIso2: "GB", sourceFile: "UK.json" })], false);
    expect(second.templatesUpdated).toBe(1);
    expect(templateStore.store.size).toBe(1);
    expect([...templateStore.store.values()][0].applicableCountries).toEqual(["GB", "TL"]);
  });
});
