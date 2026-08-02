// Unit coverage for scripts/import-visa-checklist-rules.ts — buildRuleCandidate
// (pure) and importVisaChecklistRules (mocked VisaRule, same in-memory-
// collection convention as migrations/2026-08-02-visa-checklist-model-v2.test.ts).
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const { ruleStore } = vi.hoisted(() => {
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
  return { ruleStore: makeCollection() };
});

function chainableLeanOne(getResult: () => any) {
  return { lean: () => Promise.resolve(getResult()) };
}

vi.mock("../models/VisaRule.js", () => ({
  default: {
    findOne: (filter: any) => chainableLeanOne(() => ruleStore.findOneRaw(filter)),
    create: async (doc: any) => ruleStore.insert(doc),
    updateOne: async (filter: any, update: any) => {
      const rec = ruleStore.findOneRaw(filter);
      if (!rec) return { matchedCount: 0 };
      if (update.$set) Object.assign(rec, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  },
  VISA_CATEGORIES: ["STICKER", "STAMP", "E_VISA", "VOA", "VISA_FREE"],
}));

import { buildRuleCandidate, importVisaChecklistRules, SEED_SOURCE } from "./import-visa-checklist-rules.js";
import type { ExtractedVisaChecklistFile } from "./extract-visa-checklists.js";

beforeEach(() => {
  ruleStore.clear();
});

function laosFile(overrides: Partial<ExtractedVisaChecklistFile> = {}): ExtractedVisaChecklistFile {
  return {
    sourceFile: "Laos-document-checklist.pdf",
    duplicateOfSourceFiles: [],
    destinationName: "Laos",
    destinationIso2: "LA",
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
          {
            key: "PHOTOGRAPH",
            label: "Photograph",
            requirement: "REQUIRED",
            conditionText: null,
            appliesWhen: null,
            specification: "Clear scanned copy of your photograph",
            templateReference: null,
            matchedTemplateCode: null,
            documents: [{ sourceName: "Photograph", sourceDescription: null, matchedCode: "PHOTOGRAPH", suggestions: [] }],
            allDocumentsMatched: true,
          },
          {
            key: "PASSPORT_FRONT_PAGE",
            label: "Passport Front Page",
            requirement: "REQUIRED",
            conditionText: null,
            appliesWhen: null,
            specification: "Clear picture of passport front page",
            templateReference: null,
            matchedTemplateCode: null,
            documents: [{ sourceName: "Passport Front Page", sourceDescription: null, matchedCode: null, suggestions: [] }],
            allDocumentsMatched: false,
          },
        ],
        questions: [],
      },
    ],
    ...overrides,
  } as ExtractedVisaChecklistFile;
}

describe("buildRuleCandidate", () => {
  it("skips a checklist with no visaCategory set — the PDF never states it, and this pass never guesses it", () => {
    const file = laosFile();
    const result = buildRuleCandidate(file, file.checklists[0]);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toMatch(/visaCategory/);
  });

  it("builds a candidate once visaCategory is set (by ops, in the JSON)", () => {
    const file = laosFile();
    file.checklists[0].visaCategory = "E_VISA" as any;
    const result = buildRuleCandidate(file, file.checklists[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.destinationIso2).toBe("LA");
      expect(result.candidate.nationality).toBe("IN");
      expect(result.candidate.seedSource).toBe(SEED_SOURCE);
    }
  });

  it("drops a group with ZERO matched documents entirely — never imports a vacuously-satisfied requirement", () => {
    const file = laosFile();
    file.checklists[0].visaCategory = "E_VISA" as any;
    const result = buildRuleCandidate(file, file.checklists[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.documentGroups).toHaveLength(1);
      expect(result.candidate.documentGroups[0].key).toBe("PHOTOGRAPH");
      expect(result.droppedDocumentCount).toBe(1); // the unmatched Passport Front Page document
    }
  });

  it("skips when destinationIso2 is unresolved", () => {
    const file = laosFile({ destinationIso2: null });
    file.checklists[0].visaCategory = "E_VISA" as any;
    const result = buildRuleCandidate(file, file.checklists[0]);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toMatch(/destinationIso2/);
  });

  it("skips when purpose is unresolved", () => {
    const file = laosFile();
    file.checklists[0].visaCategory = "E_VISA" as any;
    file.checklists[0].purpose = null;
    const result = buildRuleCandidate(file, file.checklists[0]);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toMatch(/purpose/);
  });

  it("only wires MATCHED questions into questions[] — an unmatched question is never smuggled in as inline", () => {
    const file = laosFile();
    file.checklists[0].visaCategory = "E_VISA" as any;
    file.checklists[0].questions = [
      { sourcePrompt: "What is your marital status?", detailsText: null, matchedQuestionCode: "MARITAL_STATUS", suggestions: [] },
      { sourcePrompt: "Some genuinely new question?", detailsText: null, matchedQuestionCode: null, suggestions: [] },
    ];
    const result = buildRuleCandidate(file, file.checklists[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.questions).toEqual([{ questionCode: "MARITAL_STATUS" }]);
    }
  });

  it("carries a structured appliesWhen and specification through onto the group", () => {
    const file = laosFile();
    file.checklists[0].visaCategory = "E_VISA" as any;
    file.checklists[0].requirementGroups[0].appliesWhen = [{ field: "employmentStatus", equals: "SELF_EMPLOYED" }];
    file.checklists[0].requirementGroups[0].specification = "35x45mm";
    const result = buildRuleCandidate(file, file.checklists[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const group = result.candidate.documentGroups.find((g) => g.key === "PHOTOGRAPH")!;
      expect(group.appliesWhen).toEqual([{ field: "employmentStatus", equals: "SELF_EMPLOYED" }]);
      expect(group.specification).toBe("35x45mm");
    }
  });

  it("keeps legacyConditionNote only when there's no structured appliesWhen", () => {
    const file = laosFile();
    file.checklists[0].visaCategory = "E_VISA" as any;
    file.checklists[0].requirementGroups[0].conditionText = "if requested by immigration on arrival";
    file.checklists[0].requirementGroups[0].appliesWhen = null;
    const result = buildRuleCandidate(file, file.checklists[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const group = result.candidate.documentGroups.find((g) => g.key === "PHOTOGRAPH")!;
      expect(group.legacyConditionNote).toBe("if requested by immigration on arrival");
      expect(group.appliesWhen).toBeUndefined();
    }
  });
});

describe("importVisaChecklistRules", () => {
  function readyFile(): ExtractedVisaChecklistFile {
    const f = laosFile();
    f.checklists[0].visaCategory = "E_VISA" as any;
    return f;
  }

  it("dry run reports toCreate without writing", async () => {
    const summary = await importVisaChecklistRules([readyFile()], true);
    expect(summary).toMatchObject({ checklistsScanned: 1, toCreate: 1, toUpdate: 0, unchanged: 0 });
    expect(ruleStore.store.size).toBe(0);
  });

  it("apply creates a DRAFT rule, never PUBLISHED", async () => {
    const summary = await importVisaChecklistRules([readyFile()], false);
    expect(summary.toCreate).toBe(1);
    expect(ruleStore.store.size).toBe(1);
    const created = [...ruleStore.store.values()][0];
    expect(created.status).toBe("DRAFT");
    expect(created.seedSource).toBe(SEED_SOURCE);
    expect(created.embassyFeeInr).toBeUndefined();
    expect(created.indicativeVisaCostInr).toBeUndefined();
  });

  it("is idempotent — a second apply run over the same data reports unchanged, not a duplicate create", async () => {
    await importVisaChecklistRules([readyFile()], false);
    const second = await importVisaChecklistRules([readyFile()], false);
    expect(second).toMatchObject({ toCreate: 0, toUpdate: 0, unchanged: 1 });
    expect(ruleStore.store.size).toBe(1);
  });

  it("skips (never overwrites) a rule that has since been promoted to PUBLISHED", async () => {
    await importVisaChecklistRules([readyFile()], false);
    const rec = [...ruleStore.store.values()][0];
    rec.status = "PUBLISHED";
    rec.documentGroups = [{ key: "MANUALLY_EDITED", label: "Manually edited by ops", requirement: "REQUIRED", docTypeCodes: ["PHOTOGRAPH"] }];

    const summary = await importVisaChecklistRules([readyFile()], false);
    expect(summary.skippedNotDraft).toHaveLength(1);
    expect(rec.documentGroups[0].key).toBe("MANUALLY_EDITED"); // untouched
  });

  it("reports (and never creates) a checklist still missing visaCategory", async () => {
    const summary = await importVisaChecklistRules([laosFile()], true);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0].reason).toMatch(/visaCategory/);
    expect(summary.toCreate).toBe(0);
  });
});
