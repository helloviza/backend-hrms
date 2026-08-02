// Unit coverage for scripts/import-visa-checklist-rules.ts — buildRuleCandidate
// (pure) and importVisaChecklistRules (mocked VisaRule, same in-memory-
// collection convention as migrations/2026-08-02-visa-checklist-model-v2.test.ts).
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const { ruleStore, auditStore, userStore } = vi.hoisted(() => {
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
  return { ruleStore: makeCollection(), auditStore: makeCollection(), userStore: makeCollection() };
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

vi.mock("../models/VisaRuleAudit.js", () => ({
  default: {
    create: async (doc: any) => auditStore.insert(doc),
  },
}));

vi.mock("../models/User.js", () => ({
  default: {
    findOne: (filter: any) => ({
      select: () => chainableLeanOne(() => userStore.findOneRaw(filter)),
    }),
    create: async (doc: any) => userStore.insert(doc),
  },
}));

import {
  buildRuleCandidate,
  importVisaChecklistRules,
  mergeSharedBaseChecklists,
  resolveSystemImportActorId,
  SEED_SOURCE,
} from "./import-visa-checklist-rules.js";
import type { ExtractedVisaChecklistFile } from "./extract-visa-checklists.js";

const TEST_ACTOR_ID = new mongoose.Types.ObjectId().toString();

beforeEach(() => {
  ruleStore.clear();
  auditStore.clear();
  userStore.clear();
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
  it("builds a candidate with visaCategory left unset when the PDF never states it — this pass never guesses it, ops sets it later via the fee/rule UI", () => {
    const file = laosFile();
    const result = buildRuleCandidate(file, file.checklists[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.visaCategory).toBeUndefined();
    }
  });

  it("skips a checklist whose visaCategory is set but not a real VisaCategory value — a real data error, not an absence", () => {
    const file = laosFile();
    file.checklists[0].visaCategory = "NOT_A_REAL_CATEGORY" as any;
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

  it("imports a group with ZERO matched documents anyway, flagged needsCatalogueMapping with the original document names preserved", () => {
    const file = laosFile();
    file.checklists[0].visaCategory = "E_VISA" as any;
    const result = buildRuleCandidate(file, file.checklists[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.documentGroups).toHaveLength(2);
      const matched = result.candidate.documentGroups.find((g) => g.key === "PHOTOGRAPH")!;
      expect(matched.needsCatalogueMapping).toBeUndefined();
      expect(matched.unmatchedDocumentNames).toBeUndefined();

      const unmapped = result.candidate.documentGroups.find((g) => g.key === "PASSPORT_FRONT_PAGE")!;
      expect(unmapped.docTypeCodes).toEqual([]);
      expect(unmapped.needsCatalogueMapping).toBe(true);
      expect(unmapped.unmatchedDocumentNames).toEqual(["Passport Front Page"]);
      expect(result.droppedDocumentCount).toBe(1); // the unmatched Passport Front Page document
    }
  });

  it("flags an unresolved templateReference (F5) — group otherwise fully matched, template text preserved", () => {
    const file = laosFile();
    file.checklists[0].visaCategory = "E_VISA" as any;
    file.checklists[0].requirementGroups[0].templateReference = "Cover Letter Template";
    const result = buildRuleCandidate(file, file.checklists[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const group = result.candidate.documentGroups.find((g) => g.key === "PHOTOGRAPH")!;
      expect(group.docTypeCodes).toEqual(["PHOTOGRAPH"]); // documents are fine — this is a template-only gap
      expect(group.templateCode).toBeUndefined();
      expect(group.needsCatalogueMapping).toBe(true);
      expect(group.unmatchedTemplateReference).toBe("Cover Letter Template");
    }
  });

  it("does not flag a templateReference that already resolved to matchedTemplateCode", () => {
    const file = laosFile();
    file.checklists[0].visaCategory = "E_VISA" as any;
    file.checklists[0].requirementGroups[0].templateReference = "Cover Letter Template";
    file.checklists[0].requirementGroups[0].matchedTemplateCode = "COVER_LETTER_TEMPLATE";
    const result = buildRuleCandidate(file, file.checklists[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const group = result.candidate.documentGroups.find((g) => g.key === "PHOTOGRAPH")!;
      expect(group.templateCode).toBe("COVER_LETTER_TEMPLATE");
      expect(group.unmatchedTemplateReference).toBeUndefined();
    }
  });

  it("flags a PARTIALLY matched group too — some documents matched, some not — without losing the group's real docTypeCodes", () => {
    const file = laosFile();
    file.checklists[0].visaCategory = "E_VISA" as any;
    file.checklists[0].requirementGroups[0].documents.push({
      sourceName: "Cover Letter",
      sourceDescription: null,
      matchedCode: null,
      matchConfidence: null,
      matchReasoning: null,
      stringMatchCode: null,
      matchesAgree: false,
      suggestions: [],
    });
    const result = buildRuleCandidate(file, file.checklists[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const partial = result.candidate.documentGroups.find((g) => g.key === "PHOTOGRAPH")!;
      expect(partial.docTypeCodes).toEqual(["PHOTOGRAPH"]); // the real match is untouched
      expect(partial.needsCatalogueMapping).toBe(true);
      expect(partial.unmatchedDocumentNames).toEqual(["Cover Letter"]);
      expect(result.droppedDocumentCount).toBe(2); // Cover Letter here + Passport Front Page's own group
    }
  });

  it("resolves destinationName from countryCodes.ts rather than the source document's own text — same ISO2 must never diverge across files", () => {
    const file = laosFile({ destinationName: "Lao People's Democratic Republic" }); // whatever this PDF's title said
    file.checklists[0].visaCategory = "E_VISA" as any;
    const result = buildRuleCandidate(file, file.checklists[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.destinationName).toBe("Laos"); // countryCodes.ts's own canonical name for LA
    }
  });

  it("falls back to the source document's destinationName when countryCodes.ts doesn't recognise the ISO2", () => {
    const file = laosFile({ destinationIso2: "ZZ", destinationName: "Nowhereland" });
    file.checklists[0].visaCategory = "E_VISA" as any;
    const result = buildRuleCandidate(file, file.checklists[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.destinationName).toBe("Nowhereland");
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

  it("wires MATCHED questions into questions[]; an unmatched question lands in additionalQuestions instead, flagged and never as a bare questionCode ref", () => {
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
      expect(result.candidate.additionalQuestions).toEqual([
        { code: "SOME_GENUINELY_NEW_QUESTION", prompt: "Some genuinely new question?", needsCatalogueMapping: true },
      ]);
    }
  });

  it("2026-08-03 — an unmatched question is no longer dropped entirely: prompt text and a needsCatalogueMapping flag survive", () => {
    const file = laosFile();
    file.checklists[0].visaCategory = "E_VISA" as any;
    file.checklists[0].questions = [
      { sourcePrompt: "Have you previously been refused a visa?", detailsText: null, matchedQuestionCode: null, suggestions: [] },
    ];
    const result = buildRuleCandidate(file, file.checklists[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.questions).toEqual([]);
      expect(result.candidate.additionalQuestions).toHaveLength(1);
      expect(result.candidate.additionalQuestions[0].prompt).toBe("Have you previously been refused a visa?");
      expect(result.candidate.additionalQuestions[0].needsCatalogueMapping).toBe(true);
      expect(result.candidate.additionalQuestions[0].answerType).toBeUndefined();
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
    const summary = await importVisaChecklistRules([readyFile()], false, TEST_ACTOR_ID);
    expect(summary.toCreate).toBe(1);
    expect(ruleStore.store.size).toBe(1);
    const created = [...ruleStore.store.values()][0];
    expect(created.status).toBe("DRAFT");
    expect(created.seedSource).toBe(SEED_SOURCE);
    expect(created.embassyFeeInr).toBeUndefined();
    expect(created.indicativeVisaCostInr).toBeUndefined();
  });

  it("is idempotent — a second apply run over the same data reports unchanged, not a duplicate create", async () => {
    await importVisaChecklistRules([readyFile()], false, TEST_ACTOR_ID);
    const second = await importVisaChecklistRules([readyFile()], false, TEST_ACTOR_ID);
    expect(second).toMatchObject({ toCreate: 0, toUpdate: 0, unchanged: 1 });
    expect(ruleStore.store.size).toBe(1);
  });

  it("skips (never overwrites) a rule that has since been promoted to PUBLISHED", async () => {
    await importVisaChecklistRules([readyFile()], false, TEST_ACTOR_ID);
    const rec = [...ruleStore.store.values()][0];
    rec.status = "PUBLISHED";
    rec.documentGroups = [{ key: "MANUALLY_EDITED", label: "Manually edited by ops", requirement: "REQUIRED", docTypeCodes: ["PHOTOGRAPH"] }];

    const summary = await importVisaChecklistRules([readyFile()], false, TEST_ACTOR_ID);
    expect(summary.skippedNotDraft).toHaveLength(1);
    expect(rec.documentGroups[0].key).toBe("MANUALLY_EDITED"); // untouched
  });

  it("creates a DRAFT rule with visaCategory left unset when the PDF never states it", async () => {
    const summary = await importVisaChecklistRules([laosFile()], false, TEST_ACTOR_ID);
    expect(summary.toCreate).toBe(1);
    expect(summary.skipped).toHaveLength(0);
    const created = [...ruleStore.store.values()][0];
    expect(created.status).toBe("DRAFT");
    expect(created.visaCategory).toBeUndefined();
  });

  it("never clears an ops-set visaCategory on re-run just because the extraction still doesn't know it", async () => {
    await importVisaChecklistRules([laosFile()], false, TEST_ACTOR_ID);
    const rec = [...ruleStore.store.values()][0];
    rec.visaCategory = "E_VISA"; // ops set this via the fee/rule UI after the first import

    const summary = await importVisaChecklistRules([laosFile()], false, TEST_ACTOR_ID);
    expect(summary.unchanged).toBe(1);
    expect(rec.visaCategory).toBe("E_VISA"); // untouched
  });

  it("skips (and reports) BOTH entries when two checklists resolve to the identical natural key within one run", async () => {
    const file = readyFile();
    const second = { ...file.checklists[0], purposeLabel: "Tourist (duplicate variant)" };
    file.checklists = [file.checklists[0], second];

    const summary = await importVisaChecklistRules([file], true);
    expect(summary.toCreate).toBe(0);
    expect(summary.duplicateKeyCollisions).toHaveLength(1);
    expect(summary.duplicateKeyCollisions[0].entries).toHaveLength(2);
    expect(summary.duplicateKeyCollisions[0].entries.map((e) => e.purposeLabel)).toEqual([
      "Tourist",
      "Tourist (duplicate variant)",
    ]);
  });

  it("tallies rules per country and reports zero duplicate collisions/merges when there are none", async () => {
    const summary = await importVisaChecklistRules([readyFile()], true);
    expect(summary.perCountry.LA).toMatchObject({ toCreate: 1, toUpdate: 0, unchanged: 0, skippedNotDraft: 0 });
    expect(summary.duplicateKeyCollisions).toHaveLength(0);
    expect(summary.merges).toHaveLength(0);
  });

  describe("F8/F9 (2026-08-03) — change detection derived from the write set, one audit entry per create/update", () => {
    it("writes an IMPORT audit entry on create, every written field logged from: null", async () => {
      await importVisaChecklistRules([readyFile()], false, TEST_ACTOR_ID);
      expect(auditStore.store.size).toBe(1);
      const audit = [...auditStore.store.values()][0];
      expect(audit.action).toBe("IMPORT");
      expect(audit.performedByUserId).toBe(TEST_ACTOR_ID);
      const byField = Object.fromEntries(audit.changes.map((c: any) => [c.field, c]));
      expect(byField.status).toEqual({ field: "status", from: null, to: "DRAFT" });
      expect(byField.seedSource).toEqual({ field: "seedSource", from: null, to: SEED_SOURCE });
    });

    it("writes no audit entry when a re-run reports unchanged", async () => {
      await importVisaChecklistRules([readyFile()], false, TEST_ACTOR_ID);
      await importVisaChecklistRules([readyFile()], false, TEST_ACTOR_ID);
      expect(auditStore.store.size).toBe(1); // only the original create, no second entry
    });

    it("writes no audit entry on a dry run, even when it would create", async () => {
      await importVisaChecklistRules([readyFile()], true);
      expect(auditStore.store.size).toBe(0);
    });

    it("detects and logs a change to opsNotes, variantLabel, or applicability on re-import — the exact drift F8 found (these were silently never compared before)", async () => {
      const file = readyFile();
      file.checklists[0].opsNotes = "Mapped to BUSINESS purely for lack of a closer fit — official/diplomatic travel.";
      await importVisaChecklistRules([file], false, TEST_ACTOR_ID);
      expect(auditStore.store.size).toBe(1);

      const changedFile = readyFile();
      changedFile.checklists[0].opsNotes = "Updated note: reclassified after a second review.";
      const summary = await importVisaChecklistRules([changedFile], false, TEST_ACTOR_ID);
      expect(summary.toUpdate).toBe(1);
      expect(summary.unchanged).toBe(0);
      expect(auditStore.store.size).toBe(2);
      const secondAudit = [...auditStore.store.values()][1];
      const byField = Object.fromEntries(secondAudit.changes.map((c: any) => [c.field, c]));
      expect(byField.opsNotes).toEqual({
        field: "opsNotes",
        from: "Mapped to BUSINESS purely for lack of a closer fit — official/diplomatic travel.",
        to: "Updated note: reclassified after a second review.",
      });
    });

    it("a genuinely no-op re-import (identical opsNotes) still reports unchanged and writes no second audit entry", async () => {
      const file = readyFile();
      file.checklists[0].opsNotes = "Same note both times.";
      await importVisaChecklistRules([file], false, TEST_ACTOR_ID);
      const summary = await importVisaChecklistRules([file], false, TEST_ACTOR_ID);
      expect(summary.unchanged).toBe(1);
      expect(auditStore.store.size).toBe(1);
    });
  });
});

describe("resolveSystemImportActorId", () => {
  it("creates the System Import user once, idempotently, and reuses it on subsequent calls", async () => {
    const first = await resolveSystemImportActorId();
    expect(userStore.store.size).toBe(1);
    const created = [...userStore.store.values()][0];
    expect(created.email).toBe("system-import@plumtrips.com");
    expect(created.roles).toEqual(["SYSTEM_IMPORT"]);
    expect(created.passwordHash).toBeTruthy();

    const second = await resolveSystemImportActorId();
    expect(String(second)).toBe(String(first));
    expect(userStore.store.size).toBe(1); // never created twice
  });
});

describe("mergeSharedBaseChecklists", () => {
  function southAfricaShapedFile(): ExtractedVisaChecklistFile {
    return {
      sourceFile: "South Africa-document-checklist.pdf",
      duplicateOfSourceFiles: [],
      destinationName: "South Africa",
      destinationIso2: "ZA",
      nationality: "IN",
      extractedAt: "2026-08-02T00:00:00Z",
      model: "gemini-2.5-flash",
      checklists: [
        {
          purposeLabel: "General Requirements",
          purpose: null,
          variantLabel: null,
          variantKey: "DEFAULT",
          applicability: null,
          visaCategory: null,
          productClass: "VISA",
          entryType: "UNSPECIFIED",
          serviceTier: "STANDARD",
          requirementGroups: [
            {
              key: "PASSPORT",
              label: "Valid passport",
              requirement: "REQUIRED",
              conditionText: null,
              appliesWhen: null,
              specification: null,
              templateReference: null,
              matchedTemplateCode: null,
              documents: [{ sourceName: "Passport", sourceDescription: null, matchedCode: "PASSPORT_ORIGINAL", suggestions: [] }],
              allDocumentsMatched: true,
            },
            {
              key: "PHOTOGRAPH",
              label: "Photograph",
              requirement: "REQUIRED",
              conditionText: null,
              appliesWhen: null,
              specification: null,
              templateReference: null,
              matchedTemplateCode: null,
              documents: [{ sourceName: "Photo", sourceDescription: null, matchedCode: "PHOTOGRAPH", suggestions: [] }],
              allDocumentsMatched: true,
            },
          ],
          questions: [],
        },
        {
          purposeLabel: "BUSINESS VISITOR",
          purpose: "BUSINESS",
          variantLabel: null,
          variantKey: "DEFAULT",
          applicability: null,
          visaCategory: null,
          productClass: "VISA",
          entryType: "UNSPECIFIED",
          serviceTier: "STANDARD",
          requirementGroups: [
            {
              key: "PASSPORT",
              label: "Valid passport",
              requirement: "REQUIRED",
              conditionText: null,
              appliesWhen: null,
              specification: null,
              templateReference: null,
              matchedTemplateCode: null,
              documents: [{ sourceName: "Passport", sourceDescription: null, matchedCode: "PASSPORT_ORIGINAL", suggestions: [] }],
              allDocumentsMatched: true,
            },
            {
              key: "INVITATION_LETTER",
              label: "Invitation letter",
              requirement: "REQUIRED",
              conditionText: null,
              appliesWhen: null,
              specification: null,
              templateReference: null,
              matchedTemplateCode: null,
              documents: [{ sourceName: "Invitation letter", sourceDescription: null, matchedCode: "INVITATION_LETTER", suggestions: [] }],
              allDocumentsMatched: true,
            },
          ],
          questions: [],
        },
      ],
    } as ExtractedVisaChecklistFile;
  }

  it("merges the shared-base checklist's groups into every sibling and drops the standalone entry", () => {
    const { file, report } = mergeSharedBaseChecklists(southAfricaShapedFile());

    expect(file.checklists).toHaveLength(1);
    expect(file.checklists[0].purposeLabel).toBe("BUSINESS VISITOR");
    expect(report).not.toBeNull();
    expect(report!.sharedBaseLabels).toEqual(["General Requirements"]);
  });

  it("deduplicates a shared-base group whose matched document the sibling already lists", () => {
    const { file, report } = mergeSharedBaseChecklists(southAfricaShapedFile());

    // BUSINESS VISITOR already lists PASSPORT_ORIGINAL itself — the shared
    // base's own "Valid passport" group must NOT be duplicated in.
    const passportGroups = file.checklists[0].requirementGroups.filter((g) =>
      g.documents.some((d) => d.matchedCode === "PASSPORT_ORIGINAL"),
    );
    expect(passportGroups).toHaveLength(1);

    // PHOTOGRAPH is new to BUSINESS VISITOR — it must merge in.
    expect(file.checklists[0].requirementGroups.some((g) => g.key === "PHOTOGRAPH")).toBe(true);

    expect(report!.targets).toEqual([{ purposeLabel: "BUSINESS VISITOR", groupsMergedIn: 1, groupsDeduped: 1 }]);
  });

  it("leaves a singleton checklist alone even if its label matches the shared-base pattern — nothing to merge it into", () => {
    const file: ExtractedVisaChecklistFile = laosFile();
    file.checklists[0].purposeLabel = "General";
    file.checklists[0].purpose = null;

    const result = mergeSharedBaseChecklists(file);
    expect(result.report).toBeNull();
    expect(result.file.checklists).toHaveLength(1);
  });

  it("does nothing when no checklist in the file matches the shared-base label pattern", () => {
    const file = southAfricaShapedFile();
    file.checklists[0].purposeLabel = "Something Else Entirely";
    const result = mergeSharedBaseChecklists(file);
    expect(result.report).toBeNull();
    expect(result.file.checklists).toHaveLength(2);
  });
});
