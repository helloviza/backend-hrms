// Unit coverage for migrateVisaConsentArray — the exported, testable core of
// the v1->v2 consent migration. VisaRequest is backed by a small in-memory
// collection (same convention as every other migration/route test in this
// module — mongodb-memory-server can't start in this environment), so the
// idempotency and missing-actor skip logic are actually exercised, not just
// asserted against a hand-picked fixture.
//
// main()/mongoose.connect are never invoked here — the module guards its
// auto-run behind `process.env.VITEST !== "true"` (set automatically by the
// test runner), so importing it for this test is safe.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const { requests } = vi.hoisted(() => {
  type Doc = Record<string, any>;

  function matches(rec: Doc, filter: Doc): boolean {
    return Object.entries(filter).every(([key, cond]) => {
      if (key === "consents.0" && cond && typeof cond === "object" && "$exists" in cond) {
        const hasFirst = Array.isArray(rec.consents) && rec.consents.length > 0;
        return cond.$exists ? hasFirst : !hasFirst;
      }
      const val = rec[key];
      if (cond && typeof cond === "object" && cond !== null) {
        if ("$exists" in cond) {
          const has = val !== undefined;
          if (cond.$exists !== has) return false;
          if ("$ne" in cond) return val !== cond.$ne;
          return true;
        }
        if ("$ne" in cond) return val !== cond.$ne;
      }
      return String(val) === String(cond);
    });
  }

  function makeCollection() {
    const store = new Map<string, Doc>();
    return {
      store,
      insert(doc: Doc): Doc {
        const id = doc._id ?? new mongoose.Types.ObjectId();
        const record: Doc = { _id: id, ...doc };
        store.set(String(id), record);
        return record;
      },
      get(id: any): Doc | null {
        return store.get(String(id)) ?? null;
      },
      query(filter: Doc): Doc[] {
        return Array.from(store.values()).filter((rec) => matches(rec, filter));
      },
      updateOne(filter: Doc, update: Doc): { matchedCount: number } {
        const rec = this.query(filter)[0];
        if (!rec) return { matchedCount: 0 };
        if (update.$push) {
          for (const [key, val] of Object.entries(update.$push as Record<string, any>)) {
            rec[key] = [...(rec[key] || []), val];
          }
        }
        if (update.$unset) for (const key of Object.keys(update.$unset)) delete rec[key];
        return { matchedCount: 1 };
      },
      clear() {
        store.clear();
      },
    };
  }

  return { requests: makeCollection() };
});

function chainableArray(getResult: () => any[]) {
  const obj: any = {
    select: () => obj,
    lean: () => Promise.resolve(getResult()),
  };
  return obj;
}

vi.mock("../models/VisaRequest.js", () => ({
  default: {
    find: (filter: any) => chainableArray(() => requests.query(filter)),
    updateOne: async (filter: any, update: any) => requests.updateOne(filter, update),
  },
}));

import { migrateVisaConsentArray } from "./2026-08-01-migrate-visa-consent-array.js";

beforeEach(() => {
  requests.clear();
});

describe("migrateVisaConsentArray", () => {
  it("backfills exactly ONE REPRESENTATION entry per prior acceptance, stamped with the old version/actor/timestamp", async () => {
    const actor = new mongoose.Types.ObjectId();
    const acceptedAt = new Date("2026-05-01T00:00:00.000Z");
    const requestId = new mongoose.Types.ObjectId();
    requests.insert({
      _id: requestId,
      consentAcceptedAt: acceptedAt,
      consentAcceptedByUserId: actor,
      consentVersion: "v1",
    });

    const summary = await migrateVisaConsentArray(false);

    expect(summary).toEqual({ requestsScanned: 1, requestsMigrated: 1, requestsSkippedMissingActor: 0 });

    const stored = requests.get(requestId);
    expect(stored.consents).toEqual([
      { clauseId: "REPRESENTATION", version: "v1", acceptedAt, acceptedByUserId: actor },
    ]);
    // Never two or three entries — the old text never explicitly covered
    // DATA_PROCESSING (DPDP-framed) or TERMS (ToS/Privacy Policy) as
    // separate clauses, so those are never fabricated.
    expect(stored.consents).toHaveLength(1);
  });

  it("removes the old fields entirely — $unset, not left dangling alongside the new array", async () => {
    const requestId = new mongoose.Types.ObjectId();
    requests.insert({
      _id: requestId,
      consentAcceptedAt: new Date(),
      consentAcceptedByUserId: new mongoose.Types.ObjectId(),
      consentVersion: "v1",
    });

    await migrateVisaConsentArray(false);

    const stored = requests.get(requestId);
    expect("consentAcceptedAt" in stored).toBe(false);
    expect("consentAcceptedByUserId" in stored).toBe(false);
    expect("consentVersion" in stored).toBe(false);
  });

  it("falls back to v1 when the old consentVersion field is missing", async () => {
    const requestId = new mongoose.Types.ObjectId();
    requests.insert({
      _id: requestId,
      consentAcceptedAt: new Date(),
      consentAcceptedByUserId: new mongoose.Types.ObjectId(),
    });

    await migrateVisaConsentArray(false);

    expect(requests.get(requestId).consents[0].version).toBe("v1");
  });

  it("skips (never fabricates an actor for) a request with consentAcceptedAt but no consentAcceptedByUserId", async () => {
    const requestId = new mongoose.Types.ObjectId();
    requests.insert({ _id: requestId, consentAcceptedAt: new Date(), consentVersion: "v1" });

    const summary = await migrateVisaConsentArray(false);

    expect(summary).toEqual({ requestsScanned: 1, requestsMigrated: 0, requestsSkippedMissingActor: 1 });
    expect(requests.get(requestId).consents).toBeUndefined();
  });

  it("dry-run computes the same summary but writes nothing", async () => {
    const requestId = new mongoose.Types.ObjectId();
    requests.insert({
      _id: requestId,
      consentAcceptedAt: new Date(),
      consentAcceptedByUserId: new mongoose.Types.ObjectId(),
      consentVersion: "v1",
    });

    const summary = await migrateVisaConsentArray(true);

    expect(summary).toEqual({ requestsScanned: 1, requestsMigrated: 1, requestsSkippedMissingActor: 0 });
    expect(requests.get(requestId).consents).toBeUndefined();
    expect(requests.get(requestId).consentAcceptedAt).toBeDefined();
  });

  it("is idempotent — a second run over already-migrated data is a clean no-op", async () => {
    const requestId = new mongoose.Types.ObjectId();
    requests.insert({
      _id: requestId,
      consentAcceptedAt: new Date(),
      consentAcceptedByUserId: new mongoose.Types.ObjectId(),
      consentVersion: "v1",
    });

    const first = await migrateVisaConsentArray(false);
    expect(first.requestsMigrated).toBe(1);

    const second = await migrateVisaConsentArray(false);
    expect(second).toEqual({ requestsScanned: 0, requestsMigrated: 0, requestsSkippedMissingActor: 0 });
    expect(requests.get(requestId).consents).toHaveLength(1); // never duplicated
  });

  it("skips requests with no prior acceptance at all", async () => {
    const requestId = new mongoose.Types.ObjectId();
    requests.insert({ _id: requestId, consents: [] });

    const summary = await migrateVisaConsentArray(false);
    expect(summary).toEqual({ requestsScanned: 0, requestsMigrated: 0, requestsSkippedMissingActor: 0 });
  });
});
