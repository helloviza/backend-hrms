// Unit coverage for the visa price-list merge — resolvePriceListRow (pure)
// and mergeVisaPriceList (mocked VisaRule, same in-memory-collection
// convention as scripts/import-visa-checklist-rules.test.ts).
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
      findAllRaw(filter: Doc): Doc[] {
        return Array.from(store.values()).filter((rec) =>
          Object.entries(filter).every(([k, v]) => String(rec[k]) === String(v)),
        );
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
function chainableSelectLeanArray(getResult: () => any[]) {
  return { select: () => ({ lean: () => Promise.resolve(getResult()) }) };
}

vi.mock("../models/VisaRule.js", () => ({
  default: {
    findOne: (filter: any) => chainableLeanOne(() => ruleStore.findOneRaw(filter)),
    find: (filter: any) => chainableSelectLeanArray(() => ruleStore.findAllRaw(filter)),
    updateOne: async (filter: any, update: any) => {
      const rec = ruleStore.findOneRaw(filter);
      if (!rec) return { matchedCount: 0 };
      if (update.$set) Object.assign(rec, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  },
  VISA_SERVICE_TIERS: ["STANDARD", "EXPRESS", "SUPERFAST", "PRIORITY", "SUPER_PRIORITY"],
  VISA_ETA_BASES: ["BUSINESS", "CALENDAR"],
}));

import { resolvePriceListRow, mergeVisaPriceList, type ResolvedPriceListRow } from "./2026-08-02-merge-visa-price-list.js";
import { SEED_SOURCE as CHECKLIST_SEED_SOURCE } from "../scripts/import-visa-checklist-rules.js";

beforeEach(() => {
  ruleStore.clear();
});

function draftRule(overrides: Record<string, any> = {}) {
  return ruleStore.insert({
    nationality: "IN",
    destinationIso2: "JP",
    destinationName: "Japan",
    purpose: "TOURIST",
    entryType: "UNSPECIFIED",
    serviceTier: "STANDARD",
    variantKey: "DEFAULT",
    status: "DRAFT",
    seedSource: CHECKLIST_SEED_SOURCE,
    ...overrides,
  });
}

function priceRow(overrides: Partial<ResolvedPriceListRow> = {}): ResolvedPriceListRow {
  return {
    sourceRowNumber: 2,
    destinationRaw: "Japan",
    destinationIso2: "JP",
    purpose: "TOURIST",
    serviceTier: "STANDARD",
    variantKey: "DEFAULT",
    indicativeVisaCostInr: 7500,
    etaBasis: "BUSINESS",
    ...overrides,
  };
}

describe("resolvePriceListRow", () => {
  it("resolves a well-formed row with defaults (Standard tier, DEFAULT variant, Business basis)", () => {
    const result = resolvePriceListRow(
      { destination: "Japan", purpose: "Tourist", indicativevisacostinr: "7500" },
      2,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.row).toMatchObject({
        destinationIso2: "JP",
        purpose: "TOURIST",
        serviceTier: "STANDARD",
        variantKey: "DEFAULT",
        indicativeVisaCostInr: 7500,
        etaBasis: "BUSINESS",
      });
      expect(result.row.etaMinDays).toBeUndefined();
      expect(result.row.priceNote).toBeUndefined();
    }
  });

  it("resolves explicit serviceTier/variantKey/etaBasis/priceNote", () => {
    const result = resolvePriceListRow(
      {
        destination: "United Arab Emirates",
        purpose: "Tourist",
        servicetier: "Express",
        variantkey: "e_visa",
        indicativevisacostinr: "9,000",
        etamindays: "1",
        etamaxdays: "2",
        etabasis: "Calendar",
        pricenote: "Subject to embassy holidays",
      },
      3,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.row).toMatchObject({
        destinationIso2: "AE",
        serviceTier: "EXPRESS",
        variantKey: "E_VISA",
        indicativeVisaCostInr: 9000,
        etaMinDays: 1,
        etaMaxDays: 2,
        etaBasis: "CALENDAR",
        priceNote: "Subject to embassy holidays",
      });
    }
  });

  it("resolves a combined B1/B2-style purpose the same way the checklist extraction does", () => {
    const result = resolvePriceListRow({ destination: "USA", purpose: "B1/B2", indicativevisacostinr: "16500" }, 2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.row.purpose).toBe("TOURIST_OR_BUSINESS");
  });

  it("rejects an unrecognised destination", () => {
    const result = resolvePriceListRow({ destination: "Narnia", purpose: "Tourist", indicativevisacostinr: "1" }, 2);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toMatch(/destination/);
  });

  it("rejects an unrecognised purpose", () => {
    const result = resolvePriceListRow({ destination: "Japan", purpose: "Pilgrimage", indicativevisacostinr: "1" }, 2);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toMatch(/purpose/);
  });

  it("rejects an unrecognised serviceTier", () => {
    const result = resolvePriceListRow(
      { destination: "Japan", purpose: "Tourist", servicetier: "Deluxe", indicativevisacostinr: "1" },
      2,
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toMatch(/serviceTier/);
  });

  it("rejects an unrecognised etaBasis", () => {
    const result = resolvePriceListRow(
      { destination: "Japan", purpose: "Tourist", indicativevisacostinr: "1", etabasis: "Lunar" },
      2,
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toMatch(/etaBasis/);
  });

  it("requires indicativeVisaCostInr", () => {
    const result = resolvePriceListRow({ destination: "Japan", purpose: "Tourist" }, 2);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toMatch(/indicativeVisaCostInr is required/);
  });

  it("rejects a negative or non-numeric indicativeVisaCostInr", () => {
    const result = resolvePriceListRow({ destination: "Japan", purpose: "Tourist", indicativevisacostinr: "-5" }, 2);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toMatch(/not a valid non-negative number/);
  });

  it("rejects etaMinDays without etaMaxDays (must both be present or both absent)", () => {
    const result = resolvePriceListRow(
      { destination: "Japan", purpose: "Tourist", indicativevisacostinr: "1", etamindays: "3" },
      2,
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toMatch(/must both be present or both be absent/);
  });

  it("rejects etaMinDays greater than etaMaxDays", () => {
    const result = resolvePriceListRow(
      { destination: "Japan", purpose: "Tourist", indicativevisacostinr: "1", etamindays: "10", etamaxdays: "5" },
      2,
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toMatch(/greater than/);
  });
});

describe("mergeVisaPriceList", () => {
  it("matches a DRAFT rule and sets cost + eta + basis", async () => {
    const rule = draftRule();
    const summary = await mergeVisaPriceList([priceRow({ etaMinDays: 3, etaMaxDays: 5 })], false);

    expect(summary.toUpdate).toBe(1);
    expect(ruleStore.store.get(String(rule._id))).toMatchObject({
      indicativeVisaCostInr: 7500,
      etaMinDays: 3,
      etaMaxDays: 5,
      etaBasis: "BUSINESS",
    });
  });

  it("never sets visaCategory, even though the rule lacks one", async () => {
    const rule = draftRule();
    await mergeVisaPriceList([priceRow()], false);
    expect(ruleStore.store.get(String(rule._id)).visaCategory).toBeUndefined();
  });

  it("sets priceNote when the row carries one", async () => {
    const rule = draftRule();
    await mergeVisaPriceList([priceRow({ priceNote: "Fee varies by season" })], false);
    expect(ruleStore.store.get(String(rule._id)).priceNote).toBe("Fee varies by season");
  });

  it("sets only indicativeVisaCostInr when the row has no ETA — never writes a bare etaBasis", async () => {
    const rule = draftRule();
    await mergeVisaPriceList([priceRow()], false);
    const updated = ruleStore.store.get(String(rule._id));
    expect(updated.indicativeVisaCostInr).toBe(7500);
    expect(updated.etaMinDays).toBeUndefined();
    expect(updated.etaBasis).toBeUndefined();
  });

  it("dry run computes the same summary but writes nothing", async () => {
    const rule = draftRule();
    const summary = await mergeVisaPriceList([priceRow()], true);
    expect(summary.toUpdate).toBe(1);
    expect(ruleStore.store.get(String(rule._id)).indicativeVisaCostInr).toBeUndefined();
  });

  it("is idempotent — a second apply over already-merged data reports unchanged", async () => {
    draftRule();
    await mergeVisaPriceList([priceRow()], false);
    const second = await mergeVisaPriceList([priceRow()], false);
    expect(second).toMatchObject({ toUpdate: 0, unchanged: 1 });
  });

  it("reports (and never overwrites) a price-list row matching a rule that is no longer DRAFT", async () => {
    draftRule({ status: "PUBLISHED" });
    const summary = await mergeVisaPriceList([priceRow()], false);
    expect(summary.priceListRowsSkippedNotDraft).toEqual([
      { destinationIso2: "JP", purpose: "TOURIST", serviceTier: "STANDARD", variantKey: "DEFAULT", status: "PUBLISHED" },
    ]);
    expect(summary.toUpdate).toBe(0);
  });

  it("reports a price-list row with no matching VisaRule at all", async () => {
    const summary = await mergeVisaPriceList([priceRow({ destinationIso2: "ZZ" })], false);
    expect(summary.priceListRowsUnmatched).toEqual([
      { destinationIso2: "ZZ", purpose: "TOURIST", serviceTier: "STANDARD", variantKey: "DEFAULT" },
    ]);
  });

  it("reports a checklist-import DRAFT rule that still has no price after the run", async () => {
    draftRule(); // Japan — never priced by any row in this run
    const summary = await mergeVisaPriceList([], false);
    expect(summary.draftRulesWithNoPrice).toEqual([
      { destinationIso2: "JP", destinationName: "Japan", purpose: "TOURIST", serviceTier: "STANDARD", variantKey: "DEFAULT" },
    ]);
  });

  it("excludes a DRAFT rule already priced by an earlier run from the still-unpriced report", async () => {
    draftRule({ indicativeVisaCostInr: 5000 }); // already priced, e.g. by a prior --apply
    const summary = await mergeVisaPriceList([], false);
    expect(summary.draftRulesWithNoPrice).toHaveLength(0);
  });

  it("ignores a non-checklist-import DRAFT rule entirely for the still-unpriced report", async () => {
    draftRule({ seedSource: "seed-visa-rules@2026-07" });
    const summary = await mergeVisaPriceList([], false);
    expect(summary.draftRulesWithNoPrice).toHaveLength(0);
  });

  it("skips (and reports) BOTH rows when two price-list rows resolve to the identical natural key", async () => {
    draftRule();
    const summary = await mergeVisaPriceList(
      [priceRow({ sourceRowNumber: 2, indicativeVisaCostInr: 7000 }), priceRow({ sourceRowNumber: 3, indicativeVisaCostInr: 8000 })],
      false,
    );
    expect(summary.toUpdate).toBe(0);
    expect(summary.duplicateKeysInCsv).toHaveLength(1);
    expect(summary.duplicateKeysInCsv[0].sourceRowNumbers).toEqual([2, 3]);
  });

  it("treats different variantKeys for the same destination/purpose as independent, non-colliding rows", async () => {
    const evisa = draftRule({ variantKey: "E_VISA" });
    const sticker = draftRule({ variantKey: "STICKER" });
    const summary = await mergeVisaPriceList(
      [
        priceRow({ variantKey: "E_VISA", indicativeVisaCostInr: 3000 }),
        priceRow({ variantKey: "STICKER", indicativeVisaCostInr: 6000 }),
      ],
      false,
    );
    expect(summary.toUpdate).toBe(2);
    expect(ruleStore.store.get(String(evisa._id)).indicativeVisaCostInr).toBe(3000);
    expect(ruleStore.store.get(String(sticker._id)).indicativeVisaCostInr).toBe(6000);
  });
});
