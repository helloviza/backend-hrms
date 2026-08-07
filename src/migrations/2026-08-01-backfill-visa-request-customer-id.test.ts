// Unit coverage for backfillVisaRequestCustomerId — the exported, testable
// core of the VisaRequest/VisaApplication.customerId backfill. VisaRequest,
// VisaApplication and User are backed by small in-memory collections (same
// convention as this directory's other migration tests), so the idempotency,
// "unresolved raiser" and dry-run-vs-apply behaviour are actually exercised,
// not just asserted against a hand-picked fixture. NOTE: the mocks are a
// convention, not a constraint — mongodb-memory-server does start here (see
// utils/visaPredicatePersistence.test.ts), so real persistence is available
// if this test ever needs schema defaults or casting to be real.
//
// main()/mongoose.connect are never invoked here — the module guards its
// auto-run behind `process.env.VITEST !== "true"` (set automatically by the
// test runner), so importing it for this test is safe.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const { requests, applications, users, chainableArray, chainableOne } = vi.hoisted(() => {
  type Doc = Record<string, any>;

  function matches(rec: Doc, filter: Doc): boolean {
    return Object.entries(filter).every(([key, cond]) => {
      if (key === "$or") {
        return (cond as Doc[]).some((sub) => matches(rec, sub));
      }
      const val = rec[key];
      if (cond && typeof cond === "object" && cond !== null && !(cond instanceof Date)) {
        if ("$exists" in cond) {
          const has = val !== undefined;
          if (cond.$exists !== has) return false;
          if ("$ne" in cond) return val !== cond.$ne;
          return true;
        }
        if ("$ne" in cond) return val !== cond.$ne;
      }
      // Real Mongo semantics: querying a field against literal null matches
      // BOTH an explicit null and a missing/undefined field — relevant here
      // since the "predates the field entirely" fixture deletes the key
      // rather than setting it to null.
      if (cond === null) return val === null || val === undefined;
      return String(val) === String(cond);
    });
  }

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
      get(id: any): Doc | null {
        return store.get(String(id)) ?? null;
      },
      query(filter: Doc): Doc[] {
        return Array.from(store.values()).filter((rec) => matches(rec, filter));
      },
      clear() {
        store.clear();
      },
    };
  }

  function chainableArray(getResult: () => any[]) {
    const obj: any = {
      select: () => obj,
      lean: () => Promise.resolve(getResult()),
    };
    return obj;
  }

  function chainableOne(getResult: () => any) {
    const obj: any = {
      select: () => obj,
      lean: () => Promise.resolve(getResult()),
    };
    return obj;
  }

  return {
    requests: makeCollection(),
    applications: makeCollection(),
    users: makeCollection(),
    chainableArray,
    chainableOne,
  };
});

vi.mock("../models/VisaRequest.js", () => ({
  default: {
    find: (filter: any) => chainableArray(() => requests.query(filter)),
    updateOne: async (filter: any, update: any) => {
      const rec = requests.query(filter)[0];
      if (!rec) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(rec, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  },
}));

vi.mock("../models/VisaApplication.js", () => ({
  default: {
    updateMany: async (filter: any, update: any) => {
      const recs = applications.query(filter);
      for (const rec of recs) {
        if (update.$set) Object.assign(rec, update.$set);
      }
      return { matchedCount: recs.length, modifiedCount: recs.length };
    },
    countDocuments: async (filter: any) => applications.query(filter).length,
  },
}));

vi.mock("../models/User.js", () => ({
  default: {
    findById: (id: any) => chainableOne(() => users.get(id)),
  },
}));

import { backfillVisaRequestCustomerId } from "./2026-08-01-backfill-visa-request-customer-id.js";

beforeEach(() => {
  requests.store.clear();
  applications.store.clear();
  users.store.clear();
});

describe("backfillVisaRequestCustomerId", () => {
  it("derives customerId from the raiser's CURRENT customerId and copies it onto the request and its applications", async () => {
    const raiser = users.insert({ customerId: "cust-123" });
    const requestId = new mongoose.Types.ObjectId();
    requests.insert({ _id: requestId, raisedByUserId: raiser._id, customerId: null });
    const app1 = applications.insert({ requestId, customerId: null });
    const app2 = applications.insert({ requestId, customerId: null });

    const summary = await backfillVisaRequestCustomerId(false);

    expect(summary).toEqual({
      requestsScanned: 1,
      requestsResolved: 1,
      requestsUnresolved: 0,
      applicationsUpdated: 2,
    });
    expect(requests.get(requestId).customerId).toBe("cust-123");
    expect(applications.get(app1._id).customerId).toBe("cust-123");
    expect(applications.get(app2._id).customerId).toBe("cust-123");
  });

  it("falls back to businessId when the raiser has no customerId", async () => {
    const raiser = users.insert({ businessId: "cust-456" });
    const requestId = new mongoose.Types.ObjectId();
    requests.insert({ _id: requestId, raisedByUserId: raiser._id, customerId: null });

    const summary = await backfillVisaRequestCustomerId(false);
    expect(summary.requestsResolved).toBe(1);
    expect(requests.get(requestId).customerId).toBe("cust-456");
  });

  it("counts as unresolved, and leaves customerId null, when the raiser has neither customerId nor businessId (staff-raised)", async () => {
    const staffRaiser = users.insert({ email: "admin@plumtrips.com" }); // no customerId/businessId
    const requestId = new mongoose.Types.ObjectId();
    requests.insert({ _id: requestId, raisedByUserId: staffRaiser._id, customerId: null });

    const summary = await backfillVisaRequestCustomerId(false);
    expect(summary).toEqual({
      requestsScanned: 1,
      requestsResolved: 0,
      requestsUnresolved: 1,
      applicationsUpdated: 0,
    });
    expect(requests.get(requestId).customerId).toBeNull();
  });

  it("counts as unresolved when the raiser no longer exists at all", async () => {
    const requestId = new mongoose.Types.ObjectId();
    requests.insert({ _id: requestId, raisedByUserId: new mongoose.Types.ObjectId(), customerId: null });

    const summary = await backfillVisaRequestCustomerId(false);
    expect(summary.requestsUnresolved).toBe(1);
    expect(requests.get(requestId).customerId).toBeNull();
  });

  it("dry-run reports the same counts but writes nothing", async () => {
    const raiser = users.insert({ customerId: "cust-789" });
    const requestId = new mongoose.Types.ObjectId();
    requests.insert({ _id: requestId, raisedByUserId: raiser._id, customerId: null });
    const app = applications.insert({ requestId, customerId: null });

    const summary = await backfillVisaRequestCustomerId(true);

    expect(summary).toEqual({
      requestsScanned: 1,
      requestsResolved: 1,
      requestsUnresolved: 0,
      applicationsUpdated: 1,
    });
    expect(requests.get(requestId).customerId).toBeNull();
    expect(applications.get(app._id).customerId).toBeNull();
  });

  it("is idempotent — a second run over already-backfilled data is a clean no-op", async () => {
    const raiser = users.insert({ customerId: "cust-abc" });
    const requestId = new mongoose.Types.ObjectId();
    requests.insert({ _id: requestId, raisedByUserId: raiser._id, customerId: null });
    applications.insert({ requestId, customerId: null });

    const first = await backfillVisaRequestCustomerId(false);
    expect(first.requestsResolved).toBe(1);

    const second = await backfillVisaRequestCustomerId(false);
    expect(second).toEqual({
      requestsScanned: 0,
      requestsResolved: 0,
      requestsUnresolved: 0,
      applicationsUpdated: 0,
    });
  });

  it("also matches rows written before the field existed at all (customerId missing, not just null)", async () => {
    const raiser = users.insert({ customerId: "cust-legacy" });
    const requestId = new mongoose.Types.ObjectId();
    const rec = requests.insert({ _id: requestId, raisedByUserId: raiser._id });
    delete rec.customerId; // simulates a pre-migration document with no field at all

    const summary = await backfillVisaRequestCustomerId(false);
    expect(summary.requestsResolved).toBe(1);
    expect(requests.get(requestId).customerId).toBe("cust-legacy");
  });

  it("never touches a request that already has a customerId set", async () => {
    const raiser = users.insert({ customerId: "cust-new" });
    const requestId = new mongoose.Types.ObjectId();
    requests.insert({ _id: requestId, raisedByUserId: raiser._id, customerId: "cust-original" });

    const summary = await backfillVisaRequestCustomerId(false);
    expect(summary.requestsScanned).toBe(0);
    expect(requests.get(requestId).customerId).toBe("cust-original");
  });
});
