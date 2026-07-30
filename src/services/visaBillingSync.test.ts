// Coverage for services/visaBillingSync.ts — the Phase 8 billing handoff.
// Same in-memory-collection mocking approach as the rest of the visa test
// suite (mongodb-memory-server can't start in this environment): every
// model this service touches is backed by a small generic store with real
// find/create/save semantics.
//
// models/ManualBooking.ts is mocked for its `default` (the Model — find/
// create/save need to be fakeable) but its named export
// syncManualBookingToMirror is left REAL (via vi.importActual + spread) so
// the "TravelBooking mirror receives it" test exercises the actual,
// existing mirror-sync function against exactly what this service builds —
// not a re-implementation of it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const {
  _manualBookings,
  _requests,
  _travellers,
  _workspaces,
  _travelBookings,
  deriveOnMarkupPricing,
  findOneManualBookingDoc,
} = vi.hoisted(() => {
  function matches(rec: Record<string, any>, filter: Record<string, any>): boolean {
    return Object.entries(filter || {}).every(([key, cond]) => {
      if (key === "metadata.visaApplicationId") {
        return String(rec.metadata?.visaApplicationId ?? "") === String(cond);
      }
      return String(rec[key]) === String(cond);
    });
  }

  function makeCollection() {
    const store = new Map<string, Record<string, any>>();
    return {
      store,
      insert(doc: Record<string, any>): Record<string, any> {
        const id = doc._id ?? new mongoose.Types.ObjectId();
        const rec = { ...doc, _id: id };
        store.set(String(id), rec);
        return rec;
      },
      get(id: any) {
        return store.get(String(id)) ?? null;
      },
      query(filter: Record<string, any> = {}) {
        return Array.from(store.values()).filter((rec) => matches(rec, filter));
      },
      clear() {
        store.clear();
      },
    };
  }

  // Faithful copy of ManualBooking.ts's pre-save hook's ON_MARKUP/ON_FULL
  // branch — this test needs the REAL formula (not a stand-in) so the GST
  // assertion is actually testing something. Only the single-pricing-object
  // path is replicated (visa never populates lineItems).
  function deriveOnMarkupPricing(p: Record<string, any>) {
    const actualPrice = p.actualPrice || p.supplierCost || 0;
    const quotedPrice = p.quotedPrice || p.sellingPrice || 0;
    const gstPercent = p.gstPercent ?? 18;
    const gstMode = p.gstMode ?? "ON_MARKUP";
    const diff = quotedPrice - actualPrice;
    let gstAmount = 0;
    let basePrice = 0;
    let grandTotal = 0;
    if (gstMode === "ON_MARKUP") {
      gstAmount = parseFloat(((diff * gstPercent) / (100 + gstPercent)).toFixed(2));
      basePrice = parseFloat((diff - gstAmount).toFixed(2));
      grandTotal = parseFloat(quotedPrice.toFixed(2));
    } else if (gstMode === "ON_FULL") {
      gstAmount = parseFloat(((quotedPrice * gstPercent) / 100).toFixed(2));
      grandTotal = parseFloat((quotedPrice + gstAmount).toFixed(2));
      basePrice = parseFloat(diff.toFixed(2));
    }
    return {
      ...p,
      actualPrice,
      supplierCost: actualPrice,
      quotedPrice,
      sellingPrice: quotedPrice,
      diff: parseFloat(diff.toFixed(2)),
      markupAmount: parseFloat(diff.toFixed(2)),
      gstAmount,
      basePrice,
      grandTotal,
      totalWithGST: grandTotal,
      profitMargin: actualPrice > 0 ? parseFloat(((basePrice / actualPrice) * 100).toFixed(2)) : 0,
    };
  }

  const _manualBookings = makeCollection();

  function wrapManualBookingDoc(rec: Record<string, any> | null) {
    if (!rec) return null;
    const doc: any = { ...rec };
    Object.defineProperty(doc, "save", {
      enumerable: false,
      value: async () => {
        doc.pricing = deriveOnMarkupPricing(doc.pricing || {});
        Object.assign(rec, doc);
        return doc;
      },
    });
    return doc;
  }

  function findOneManualBookingDoc(filter: Record<string, any>) {
    const rec = _manualBookings.query(filter)[0] ?? null;
    return Promise.resolve(wrapManualBookingDoc(rec));
  }

  return {
    _manualBookings,
    _requests: makeCollection(),
    _travellers: makeCollection(),
    _workspaces: makeCollection(),
    _travelBookings: makeCollection(),
    deriveOnMarkupPricing,
    findOneManualBookingDoc,
  };
});

vi.mock("../models/ManualBooking.js", async () => {
  const actual: any = await vi.importActual("../models/ManualBooking.js");
  return {
    ...actual, // keeps the REAL syncManualBookingToMirror/manualTypeToService/etc.
    default: {
      findOne: (filter: any) => findOneManualBookingDoc(filter),
      create: async (payload: any) => {
        const rec = _manualBookings.insert({
          status: "CONFIRMED",
          bookingRef: `MB-TEST-${_manualBookings.store.size + 1}`,
          createdAt: new Date(),
          ...payload,
        });
        rec.pricing = deriveOnMarkupPricing(rec.pricing || {});
        return { ...rec };
      },
    },
  };
});

vi.mock("../models/VisaRequest.js", () => ({
  default: {
    findById: (id: any) => ({ lean: () => Promise.resolve(_requests.get(id)) }),
  },
}));

vi.mock("../models/TravellerProfile.js", () => ({
  default: {
    findById: (id: any) => ({ lean: () => Promise.resolve(_travellers.get(id)) }),
  },
}));

// findById is this service's own lookup; findOne is what the REAL
// syncManualBookingToMirror (imported via importActual above) calls
// internally — both need to work on this one mock.
vi.mock("../models/CustomerWorkspace.js", () => ({
  default: {
    findById: (id: any) => ({ select: () => ({ lean: () => Promise.resolve(_workspaces.get(id)) }) }),
    findOne: (filter: any) => ({ select: () => ({ lean: () => Promise.resolve(_workspaces.query(filter)[0] ?? null) }) }),
  },
}));

vi.mock("../models/TravelBooking.js", () => ({
  default: {
    findOneAndUpdate: async (filter: any, update: any) => {
      const existing = _travelBookings.query(filter)[0];
      if (existing) {
        Object.assign(existing, update);
        return { ...existing };
      }
      const rec = _travelBookings.insert({ ...filter, ...update });
      return { ...rec };
    },
  },
}));

// A created/updated booking logs a VisaActivityLog row — mocked to a no-op
// so tests never touch the real (unconnected, in this test environment)
// collection. This file's own coverage is the pricing/idempotency logic,
// not the activity trail.
vi.mock("../models/VisaActivityLog.js", () => ({
  logVisaActivity: vi.fn().mockResolvedValue(undefined),
}));

import { syncVisaApplicationBilling } from "./visaBillingSync.js";
import { syncManualBookingToMirror } from "../models/ManualBooking.js";

function visaRequestFixture(overrides: Record<string, any> = {}) {
  return _requests.insert({
    referenceNumber: "HV26-000123",
    destinationIso2: "DE",
    purpose: "TOURIST",
    travelDateFrom: new Date("2026-09-01"),
    travelDateTo: new Date("2026-09-10"),
    ...overrides,
  });
}

function travellerFixture(overrides: Record<string, any> = {}) {
  return _travellers.insert({
    firstName: "Asha",
    lastName: "Rao",
    email: "asha@example.com",
    mobile: "9876543210",
    passportNo: "P1234567",
    ...overrides,
  });
}

function workspaceFixture(overrides: Record<string, any> = {}) {
  const customerId = new mongoose.Types.ObjectId();
  return _workspaces.insert({
    customerId: String(customerId),
    ...overrides,
  });
}

function applicationFixture(opts: {
  requestId: any;
  travellerProfileId: any;
  workspaceId: any;
  [k: string]: any;
}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    status: "decision_received",
    outcome: "APPROVED",
    ruleSnapshot: { destinationName: "Germany", purpose: "TOURIST" },
    actualEmbassyFeeInr: 5000,
    actualVfsFeeInr: 1500,
    actualPlumtripsServiceFeeInr: 1000,
    actualTotalInr: 7500,
    submittedAt: new Date("2026-08-01"),
    ...opts,
  };
}

function fullFixtureSet(appOverrides: Record<string, any> = {}) {
  const request = visaRequestFixture();
  const traveller = travellerFixture();
  const workspace = workspaceFixture();
  const application = applicationFixture({
    requestId: request._id,
    travellerProfileId: traveller._id,
    workspaceId: workspace._id,
    ...appOverrides,
  });
  return { request, traveller, workspace, application };
}

beforeEach(() => {
  _manualBookings.clear();
  _requests.clear();
  _travellers.clear();
  _workspaces.clear();
  _travelBookings.clear();
});

describe("syncVisaApplicationBilling — create", () => {
  it("creates a ManualBooking with ON_MARKUP pricing, single traveller, and a traceable HV reference", async () => {
    const { request, workspace, application } = fullFixtureSet();
    const actorId = new mongoose.Types.ObjectId();

    const result = await syncVisaApplicationBilling(application, actorId);

    expect(result.action).toBe("created");
    const booking = _manualBookings.get(result.manualBookingId!);
    expect(booking.type).toBe("VISA");
    expect(booking.status).toBe("CONFIRMED");
    expect(booking.bookedBy).toEqual(actorId);

    expect(booking.passengers).toHaveLength(1);
    expect(booking.passengers[0].name).toBe("Asha Rao");
    expect(booking.passengers[0].email).toBe("asha@example.com");
    expect(booking.passengers[0].passportNo).toBe("P1234567");
    expect(booking.passengers[0].type).toBe("ADULT");

    expect(booking.itinerary.visaCountry).toBe("Germany");
    expect(booking.itinerary.visaType).toBe("TOURIST");

    // Traceable back to the request, but never via sourceBookingId (see the
    // mirror test below for why).
    expect(booking.sourceBookingRef).toBe("HV26-000123");
    expect(booking.metadata.visaApplicationId).toBe(String(application._id));
    expect(booking.metadata.visaRequestReferenceNumber).toBe("HV26-000123");

    expect(booking.workspaceId.toString()).toBe(String(workspace.customerId));
  });

  it("actualPrice/quotedPrice are assembled from the raw fee components — no GST math performed by this service", async () => {
    const { application } = fullFixtureSet();
    const result = await syncVisaApplicationBilling(application, new mongoose.Types.ObjectId());
    const booking = _manualBookings.get(result.manualBookingId!);

    expect(booking.pricing.gstMode).toBe("ON_MARKUP");
    expect(booking.pricing.gstPercent).toBe(18);
    // actualPrice = embassy + vfs only (the pass-through, GST-free portion).
    expect(booking.pricing.actualPrice).toBe(6500);
    // quotedPrice = actualPrice + service fee, GST-EXCLUSIVE — the hook (via
    // deriveOnMarkupPricing here, a faithful copy) does the GST math, not us.
    expect(booking.pricing.quotedPrice).toBe(7500);
  });

  it("totalWithGST equals the application's actual GST-inclusive total — the guard against double-taxing", async () => {
    const { application } = fullFixtureSet();
    const result = await syncVisaApplicationBilling(application, new mongoose.Types.ObjectId());
    const booking = _manualBookings.get(result.manualBookingId!);

    expect(booking.pricing.totalWithGST).toBe(application.actualTotalInr);
    expect(booking.pricing.grandTotal).toBe(application.actualTotalInr);
  });

  it("bills REJECTED and WITHDRAWN applications identically to APPROVED — outcome never changes the amount", async () => {
    for (const outcome of ["APPROVED", "REJECTED", "WITHDRAWN"]) {
      _manualBookings.clear();
      const { application } = fullFixtureSet({ outcome });
      const result = await syncVisaApplicationBilling(application, new mongoose.Types.ObjectId());
      expect(result.action).toBe("created");
      const booking = _manualBookings.get(result.manualBookingId!);
      expect(booking.pricing.quotedPrice).toBe(7500);
      expect(booking.metadata.visaOutcome).toBe(outcome);
    }
  });
});

describe("syncVisaApplicationBilling — zero total", () => {
  it("creates nothing when the computed total is zero", async () => {
    const { application } = fullFixtureSet({
      actualEmbassyFeeInr: 0,
      actualVfsFeeInr: 0,
      actualPlumtripsServiceFeeInr: 0,
      actualTotalInr: 0,
    });
    const result = await syncVisaApplicationBilling(application, new mongoose.Types.ObjectId());
    expect(result.action).toBe("skipped_zero_total");
    expect(result.manualBookingId).toBeNull();
    expect(_manualBookings.query({})).toHaveLength(0);
  });

  it("also skips when the cost fields were simply never captured (null/undefined)", async () => {
    const { application } = fullFixtureSet({
      actualEmbassyFeeInr: null,
      actualVfsFeeInr: null,
      actualPlumtripsServiceFeeInr: null,
      actualTotalInr: null,
    });
    const result = await syncVisaApplicationBilling(application, new mongoose.Types.ObjectId());
    expect(result.action).toBe("skipped_zero_total");
    expect(_manualBookings.query({})).toHaveLength(0);
  });
});

describe("syncVisaApplicationBilling — idempotency and updates", () => {
  it("a repeated call for the same application does not create a duplicate", async () => {
    const { application } = fullFixtureSet();
    const actorId = new mongoose.Types.ObjectId();

    const first = await syncVisaApplicationBilling(application, actorId);
    expect(first.action).toBe("created");

    const second = await syncVisaApplicationBilling(application, actorId);
    expect(second.action).toBe("updated");
    expect(second.manualBookingId).toBe(first.manualBookingId);

    expect(_manualBookings.query({})).toHaveLength(1);
  });

  it("updates pricing when costs change and the booking is not yet INVOICED", async () => {
    const { application } = fullFixtureSet();
    const actorId = new mongoose.Types.ObjectId();

    const first = await syncVisaApplicationBilling(application, actorId);
    const revised = { ...application, actualPlumtripsServiceFeeInr: 2000, actualTotalInr: 8500 };

    const second = await syncVisaApplicationBilling(revised, actorId);
    expect(second.action).toBe("updated");
    expect(second.manualBookingId).toBe(first.manualBookingId);

    const booking = _manualBookings.get(first.manualBookingId!);
    expect(booking.pricing.quotedPrice).toBe(8500);
    expect(booking.pricing.totalWithGST).toBe(8500);
  });

  it("never mutates an already-INVOICED booking — flags it instead of touching it", async () => {
    const { application } = fullFixtureSet();
    const actorId = new mongoose.Types.ObjectId();

    const first = await syncVisaApplicationBilling(application, actorId);
    const booking = _manualBookings.get(first.manualBookingId!);
    booking.status = "INVOICED"; // simulate staff having already invoiced it

    const revised = { ...application, actualPlumtripsServiceFeeInr: 99999, actualTotalInr: 106499 };
    const second = await syncVisaApplicationBilling(revised, actorId);

    expect(second.action).toBe("skipped_invoiced");
    expect(second.manualBookingId).toBe(first.manualBookingId);

    const unchanged = _manualBookings.get(first.manualBookingId!);
    expect(unchanged.pricing.quotedPrice).toBe(7500); // untouched
    expect(unchanged.status).toBe("INVOICED");
  });
});

describe("syncVisaApplicationBilling — TravelBooking mirror", () => {
  it("the created booking is picked up by ManualBooking's own TravelBooking mirror sync", async () => {
    const { application } = fullFixtureSet();
    const result = await syncVisaApplicationBilling(application, new mongoose.Types.ObjectId());
    const booking = _manualBookings.get(result.manualBookingId!);

    // The specific fields that would make syncManualBookingToMirror SKIP
    // this booking (its own file-header rule: SBT/SBT_AUTO source, or any
    // truthy sourceBookingId) must be absent — this is the guard against a
    // silent, invisible failure to reach TravelBooking/exports/travel-spend.
    expect(booking.sourceBookingId).toBeUndefined();
    expect(booking.source).not.toBe("SBT");
    expect(booking.source).not.toBe("SBT_AUTO");

    await syncManualBookingToMirror(booking);

    const mirrored = _travelBookings.query({ reference: booking._id })[0];
    expect(mirrored).toBeTruthy();
    expect(mirrored.service).toBe("VISA");
    expect(mirrored.amount).toBe(booking.pricing.grandTotal);
    expect(mirrored.travellerName).toBe("Asha Rao");
    expect(mirrored.isActive).toBe(true);
  });
});
