// Unit coverage for the Phase 10a visa-checklist-model-v2 migration —
// mocked in-memory collections, same convention as this directory's other
// migration tests (mongodb-memory-server can't start in this environment).
// main()/mongoose.connect are never invoked — the module guards its
// auto-run behind process.env.VITEST !== "true".
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const { ruleStore, docTypeStore, questionStore, indexState } = vi.hoisted(() => {
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
      all(): Doc[] {
        return Array.from(store.values());
      },
      clear() {
        store.clear();
      },
    };
  }

  return {
    ruleStore: makeCollection(),
    docTypeStore: makeCollection(),
    questionStore: makeCollection(),
    indexState: { indexes: [] as any[] },
  };
});

function chainableLeanOne(getResult: () => any) {
  return { lean: () => Promise.resolve(getResult()) };
}
function chainableLeanArray(getResult: () => any[]) {
  return { lean: () => Promise.resolve(getResult()) };
}

vi.mock("../models/VisaRule.js", () => ({
  default: {
    find: (filter: any) => chainableLeanArray(() => ruleStore.all()),
    updateOne: async (filter: any, update: any) => {
      const rec = ruleStore.findOneRaw(filter);
      if (!rec) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(rec, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    collection: {
      indexes: async () => indexState.indexes,
      createIndex: async (key: any, opts: any) => {
        indexState.indexes.push({ key, name: opts?.name || "new_idx", unique: !!opts?.unique });
      },
      dropIndex: async (name: string) => {
        indexState.indexes = indexState.indexes.filter((i: any) => i.name !== name);
      },
    },
  },
}));

vi.mock("../models/VisaDocumentType.js", () => ({
  default: {
    findOne: (filter: any) => chainableLeanOne(() => docTypeStore.findOneRaw(filter)),
    create: async (doc: any) => docTypeStore.insert(doc),
    updateOne: async (filter: any, update: any) => {
      const rec = docTypeStore.findOneRaw(filter);
      if (!rec) return { matchedCount: 0 };
      if (update.$set) Object.assign(rec, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  },
}));

vi.mock("../models/VisaQuestion.js", () => ({
  default: {
    findOne: (filter: any) => chainableLeanOne(() => questionStore.findOneRaw(filter)),
    create: async (doc: any) => questionStore.insert(doc),
    updateOne: async (filter: any, update: any) => {
      const rec = questionStore.findOneRaw(filter);
      if (!rec) return { matchedCount: 0 };
      if (update.$set) Object.assign(rec, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  },
}));

import {
  structureLegacyCondition,
  buildDocumentGroupsFromLegacyRequirements,
  seedVisaDocumentTypes,
  seedVisaQuestionBank,
  migrateVisaRulesToV2,
  migrateRuleKeyIndex,
  VISA_QUESTION_BANK_SEED,
} from "./2026-08-02-visa-checklist-model-v2.js";
import { VISA_DOCUMENT_TYPE_CATALOGUE } from "../config/visaDocumentTypeCatalogue.js";

beforeEach(() => {
  ruleStore.clear();
  docTypeStore.clear();
  questionStore.clear();
  indexState.indexes = [
    { key: { nationality: 1, destinationIso2: 1, purpose: 1, entryType: 1, serviceTier: 1 }, name: "nat_dest_purp_entry_tier_unique", unique: true },
  ];
});

describe("structureLegacyCondition", () => {
  it("structures the one known attribute-shaped legacy condition", () => {
    const result = structureLegacyCondition("If self-employed or a business owner");
    expect(result.appliesWhen).toEqual([{ field: "employmentStatus", in: ["SELF_EMPLOYED"] }]);
    expect(result.legacyConditionNote).toBe("If self-employed or a business owner");
  });

  it("keeps an unstructurable condition as free text only, without inventing a predicate", () => {
    const result = structureLegacyCondition("If requested by immigration on arrival");
    expect(result.appliesWhen).toBeUndefined();
    expect(result.legacyConditionNote).toBe("If requested by immigration on arrival");
  });

  it("returns an empty object for an undefined condition", () => {
    expect(structureLegacyCondition(undefined)).toEqual({});
  });
});

describe("buildDocumentGroupsFromLegacyRequirements", () => {
  it("wraps each legacy requirement in a single-doctype group, translating the docCode to its semantic equivalent", () => {
    const groups = buildDocumentGroupsFromLegacyRequirements([
      { docCode: "DOC-01", requirement: "REQUIRED" },
      { docCode: "DOC-04", requirement: "CONDITIONAL", condition: "If self-employed or a business owner" },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ label: "Passport", requirement: "REQUIRED", docTypeCodes: ["PASSPORT_ORIGINAL"] });
    expect(groups[0].appliesWhen).toBeUndefined();

    expect(groups[1]).toMatchObject({ label: "Income Tax Return", requirement: "CONDITIONAL", docTypeCodes: ["INCOME_TAX_RETURN"] });
    expect(groups[1].appliesWhen).toEqual([{ field: "employmentStatus", in: ["SELF_EMPLOYED"] }]);
    expect(groups[1].legacyConditionNote).toBe("If self-employed or a business owner");
  });

  it("returns an empty array for an empty/missing requirements list", () => {
    expect(buildDocumentGroupsFromLegacyRequirements(undefined)).toEqual([]);
    expect(buildDocumentGroupsFromLegacyRequirements([])).toEqual([]);
  });

  it("is idempotent — running it twice on the same input produces a deep-equal result", () => {
    const input = [{ docCode: "DOC-07", requirement: "REQUIRED" as const }];
    expect(buildDocumentGroupsFromLegacyRequirements(input)).toEqual(buildDocumentGroupsFromLegacyRequirements(input));
  });
});

describe("migrateVisaRulesToV2", () => {
  it("sets variantKey and derives documentGroups on a dry run, without writing", async () => {
    const rule = ruleStore.insert({
      documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" }],
      documentGroups: [],
    });

    const summary = await migrateVisaRulesToV2(true);
    expect(summary).toEqual({ rulesScanned: 1, rulesUpdated: 1, rulesAlreadyMigrated: 0 });
    expect(ruleStore.store.get(String(rule._id)).documentGroups).toEqual([]); // unwritten
  });

  it("applies the migration — variantKey defaults to DEFAULT, documentGroups populated", async () => {
    const rule = ruleStore.insert({
      documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" }],
      documentGroups: [],
    });

    const summary = await migrateVisaRulesToV2(false);
    expect(summary.rulesUpdated).toBe(1);

    const updated = ruleStore.store.get(String(rule._id));
    expect(updated.variantKey).toBe("DEFAULT");
    expect(updated.documentGroups).toEqual([
      { key: "PASSPORT_ORIGINAL_0", label: "Passport", requirement: "REQUIRED", docTypeCodes: ["PASSPORT_ORIGINAL"] },
    ]);
  });

  it("is idempotent — a second run over already-migrated data is a clean no-op", async () => {
    ruleStore.insert({
      documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" }],
      documentGroups: [],
    });

    await migrateVisaRulesToV2(false);
    const second = await migrateVisaRulesToV2(false);
    expect(second).toEqual({ rulesScanned: 1, rulesUpdated: 0, rulesAlreadyMigrated: 1 });
  });

  it("never touches documentRequirements itself", async () => {
    const original = [{ docCode: "DOC-01", requirement: "REQUIRED" as const }];
    const rule = ruleStore.insert({ documentRequirements: original, documentGroups: [] });

    await migrateVisaRulesToV2(false);

    expect(ruleStore.store.get(String(rule._id)).documentRequirements).toEqual(original);
  });
});

describe("seedVisaDocumentTypes", () => {
  it("creates every catalogue entry on first run", async () => {
    const summary = await seedVisaDocumentTypes(false);
    expect(summary.toCreate).toBe(VISA_DOCUMENT_TYPE_CATALOGUE.length);
    expect(docTypeStore.all()).toHaveLength(VISA_DOCUMENT_TYPE_CATALOGUE.length);
  });

  it("dry run creates nothing", async () => {
    const summary = await seedVisaDocumentTypes(true);
    expect(summary.toCreate).toBe(VISA_DOCUMENT_TYPE_CATALOGUE.length);
    expect(docTypeStore.all()).toHaveLength(0);
  });

  it("is idempotent — second run reports everything unchanged", async () => {
    await seedVisaDocumentTypes(false);
    const second = await seedVisaDocumentTypes(false);
    expect(second).toEqual({ toCreate: 0, toUpdate: 0, unchanged: VISA_DOCUMENT_TYPE_CATALOGUE.length });
  });
});

describe("seedVisaQuestionBank", () => {
  it("creates every seed question, including the prior-refusal follow-up chain", async () => {
    const summary = await seedVisaQuestionBank(false);
    expect(summary.toCreate).toBe(VISA_QUESTION_BANK_SEED.length);
    const refusal = questionStore.findOneRaw({ code: "PRIOR_VISA_REFUSAL" });
    expect(refusal?.followUps).toEqual([
      { whenAnswerEquals: true, questionCodes: ["PRIOR_VISA_REFUSAL_COUNTRY", "PRIOR_VISA_REFUSAL_DATE", "PRIOR_VISA_REFUSAL_REASON"] },
    ]);
  });

  it("is idempotent — second run reports everything unchanged", async () => {
    await seedVisaQuestionBank(false);
    const second = await seedVisaQuestionBank(false);
    expect(second).toEqual({ toCreate: 0, toUpdate: 0, unchanged: VISA_QUESTION_BANK_SEED.length });
  });
});

describe("migrateRuleKeyIndex", () => {
  it("dry run reports what it would do without changing the index list", async () => {
    const before = indexState.indexes.length;
    const result = await migrateRuleKeyIndex(true);
    expect(result).toMatch(/would create/);
    expect(result).toMatch(/would drop/);
    expect(indexState.indexes.length).toBe(before);
  });

  it("apply creates the new 6-field index and drops the old 5-field one", async () => {
    await migrateRuleKeyIndex(false);
    const keys = indexState.indexes.map((i: any) => i.key);
    expect(keys).toContainEqual({
      nationality: 1, destinationIso2: 1, purpose: 1, entryType: 1, serviceTier: 1, variantKey: 1,
    });
    expect(keys).not.toContainEqual({
      nationality: 1, destinationIso2: 1, purpose: 1, entryType: 1, serviceTier: 1,
    });
  });

  it("is idempotent — a second apply is a clean no-op", async () => {
    await migrateRuleKeyIndex(false);
    const result = await migrateRuleKeyIndex(false);
    expect(result).toMatch(/already migrated/);
  });
});
