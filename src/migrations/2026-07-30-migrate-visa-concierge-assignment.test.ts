// Unit coverage for migrateVisaConciergeAssignments — the exported, testable
// core of the Phase 9a assignment migration. VisaRequest/VisaApplication are
// backed by small in-memory collections (same convention as every other
// route/model test in this module), so the idempotency and per-application
// skip logic are actually exercised, not just asserted against a
// hand-picked fixture. NOTE: the mocks are a convention, not a constraint —
// mongodb-memory-server does start here (see
// utils/visaPredicatePersistence.test.ts), so real persistence is available
// if this test ever needs schema defaults or casting to be real.
//
// main()/mongoose.connect are never invoked here — the module guards its
// auto-run behind `process.env.VITEST !== "true"` (set automatically by the
// test runner), so importing it for this test is safe.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const { requests, applications, resetStores } = vi.hoisted(() => {
  type Doc = Record<string, any>;

  function matches(rec: Doc, filter: Doc): boolean {
    return Object.entries(filter).every(([key, cond]) => {
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
      return String(val) === String(cond);
    });
  }

  function makeCollection() {
    const store = new Map<string, Doc>();
    return {
      store,
      insert(doc: Doc): Doc {
        const id = doc._id ?? new mongoose.Types.ObjectId();
        const record: Doc = { updatedAt: new Date(), ...doc, _id: id };
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

  return {
    requests: makeCollection(),
    applications: makeCollection(),
    resetStores() {
      // placeholder — real clear happens in beforeEach via the collections
      // themselves, kept here only so destructuring above stays uniform
      // with this file's sibling test files' vi.hoisted shape.
    },
  };
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
    updateOne: async (filter: any, update: any) => {
      const rec = requests.query(filter)[0];
      if (!rec) return { matchedCount: 0 };
      if (update.$unset) for (const key of Object.keys(update.$unset)) delete rec[key];
      if (update.$set) Object.assign(rec, update.$set);
      return { matchedCount: 1 };
    },
  },
}));

vi.mock("../models/VisaApplication.js", () => ({
  default: {
    find: (filter: any) => chainableArray(() => applications.query(filter)),
    updateOne: async (filter: any, update: any) => {
      const rec = applications.query(filter)[0];
      if (!rec) return { matchedCount: 0 };
      if (update.$set) Object.assign(rec, update.$set);
      return { matchedCount: 1 };
    },
  },
}));

import { migrateVisaConciergeAssignments } from "./2026-07-30-migrate-visa-concierge-assignment.js";

beforeEach(() => {
  requests.store.clear();
  applications.store.clear();
});

describe("migrateVisaConciergeAssignments", () => {
  it("moves a request's assignedConciergeUserId down onto every one of its applications that doesn't already have one", async () => {
    const concierge = new mongoose.Types.ObjectId();
    const requestId = new mongoose.Types.ObjectId();
    const updatedAt = new Date("2026-06-01T00:00:00.000Z");
    requests.insert({ _id: requestId, assignedConciergeUserId: concierge, updatedAt });

    const app1 = applications.insert({ requestId });
    const app2 = applications.insert({ requestId });

    const summary = await migrateVisaConciergeAssignments(false);

    expect(summary).toEqual({
      requestsScanned: 1,
      applicationsAssigned: 2,
      applicationsAlreadyAssignedSkipped: 0,
      requestsCleared: 1,
    });

    expect(String(applications.get(app1._id).assignedConciergeUserId)).toBe(String(concierge));
    expect(applications.get(app1._id).assignedConciergeAssignedAt).toEqual(updatedAt);
    expect(String(applications.get(app2._id).assignedConciergeUserId)).toBe(String(concierge));

    // The request-level field is gone, not just set to null — $unset, not
    // $set: null (task brief: "remove it").
    expect("assignedConciergeUserId" in requests.get(requestId)).toBe(false);
  });

  it("never overwrites an application that already has its own assignedConciergeUserId", async () => {
    const requestConcierge = new mongoose.Types.ObjectId();
    const ownConcierge = new mongoose.Types.ObjectId();
    const requestId = new mongoose.Types.ObjectId();
    requests.insert({ _id: requestId, assignedConciergeUserId: requestConcierge });

    const alreadyAssigned = applications.insert({ requestId, assignedConciergeUserId: ownConcierge });
    const unassigned = applications.insert({ requestId });

    const summary = await migrateVisaConciergeAssignments(false);

    expect(summary.applicationsAssigned).toBe(1);
    expect(summary.applicationsAlreadyAssignedSkipped).toBe(1);
    // Untouched — the application's own, independently-set assignee survives.
    expect(String(applications.get(alreadyAssigned._id).assignedConciergeUserId)).toBe(String(ownConcierge));
    expect(String(applications.get(unassigned._id).assignedConciergeUserId)).toBe(String(requestConcierge));
  });

  it("dry-run computes the same summary but writes nothing", async () => {
    const concierge = new mongoose.Types.ObjectId();
    const requestId = new mongoose.Types.ObjectId();
    requests.insert({ _id: requestId, assignedConciergeUserId: concierge });
    const app = applications.insert({ requestId });

    const summary = await migrateVisaConciergeAssignments(true);

    expect(summary).toEqual({
      requestsScanned: 1,
      applicationsAssigned: 1,
      applicationsAlreadyAssignedSkipped: 0,
      requestsCleared: 1,
    });
    expect(applications.get(app._id).assignedConciergeUserId).toBeUndefined();
    expect(requests.get(requestId).assignedConciergeUserId).toEqual(concierge);
  });

  it("is idempotent — a second run over already-migrated data is a clean no-op", async () => {
    const concierge = new mongoose.Types.ObjectId();
    const requestId = new mongoose.Types.ObjectId();
    requests.insert({ _id: requestId, assignedConciergeUserId: concierge });
    const app = applications.insert({ requestId });

    const first = await migrateVisaConciergeAssignments(false);
    expect(first.applicationsAssigned).toBe(1);
    expect(first.requestsCleared).toBe(1);

    const second = await migrateVisaConciergeAssignments(false);
    expect(second).toEqual({
      requestsScanned: 0,
      applicationsAssigned: 0,
      applicationsAlreadyAssignedSkipped: 0,
      requestsCleared: 0,
    });

    // Unchanged by the second run.
    expect(String(applications.get(app._id).assignedConciergeUserId)).toBe(String(concierge));
  });

  it("skips requests with no assignedConciergeUserId set", async () => {
    const requestId = new mongoose.Types.ObjectId();
    requests.insert({ _id: requestId });
    applications.insert({ requestId });

    const summary = await migrateVisaConciergeAssignments(false);
    expect(summary).toEqual({
      requestsScanned: 0,
      applicationsAssigned: 0,
      applicationsAlreadyAssignedSkipped: 0,
      requestsCleared: 0,
    });
  });
});
