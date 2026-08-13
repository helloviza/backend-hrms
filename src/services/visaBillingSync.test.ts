// Coverage for services/visaBillingSync.ts — the Phase 8 billing handoff.
// Same in-memory-collection mocking approach as the rest of the visa test
// suite: every model this service touches is backed by a small generic
// store with real find/create/save semantics. NOTE: that approach is a
// convention, not a constraint — mongodb-memory-server does start here (see
// utils/visaPredicatePersistence.test.ts), so real persistence is available
// if this test ever needs schema defaults or casting to be real.
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
  _users,
  _customers,
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
    _users: makeCollection(),
    _customers: makeCollection(),
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

// User/Customer back resolveBillingCustomer's two-tier resolution
// (services/visaBillingSync.ts). middleware/requireWorkspace.js's
// isCustomerUser is left REAL — it's a pure function over `roles`, no DB
// access, so mocking it would just be re-implementing it.
vi.mock("../models/User.js", () => ({
  default: {
    findById: (id: any) => ({ select: () => ({ lean: () => Promise.resolve(_users.get(id)) }) }),
  },
}));

vi.mock("../models/Customer.js", () => ({
  default: {
    findById: (id: any) => ({ select: () => ({ lean: () => Promise.resolve(_customers.get(id)) }) }),
    countDocuments: (filter: any) => Promise.resolve(_customers.query(filter).length),
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

import { syncVisaApplicationBilling, createVisaWorkStartBooking } from "./visaBillingSync.js";
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

// Healthy, unambiguous 1:1 workspace by default — a matching Customer is
// created alongside it, with its OWN workspaceId pointing back at this
// workspace, so resolveBillingCustomer's fallback tier (CustomerWorkspace.
// customerId, only accepted when exactly one Customer shares the
// workspace) succeeds exactly the way it did before this file's own
// ambiguous/broken-link describe block existed. Pass
// { skipCustomerRecord: true } to omit the Customer (a broken link), or
// insert additional Customers with the same workspaceId yourself to
// exercise ambiguity.
function workspaceFixture(overrides: Record<string, any> & { skipCustomerRecord?: boolean } = {}) {
  const { skipCustomerRecord, ...workspaceOverrides } = overrides;
  const customerId = new mongoose.Types.ObjectId();
  const workspace = _workspaces.insert({
    customerId: String(customerId),
    ...workspaceOverrides,
  });
  if (!skipCustomerRecord) {
    _customers.insert({ _id: customerId, workspaceId: workspace._id });
  }
  return workspace;
}

// Staff by default (isCustomerUser reads roles) — no customerId, so
// resolveBillingCustomer's user-tier never fires unless a test explicitly
// gives roles a customer role AND a customerId.
function userFixture(overrides: Record<string, any> = {}) {
  return _users.insert({ roles: ["EMPLOYEE"], ...overrides });
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
    // Embassy 5000 + VFS 1500 + service 1000 + 18% GST on the service fee
    // (180) = 7680 — computeVisaFeeBlock's own ITEMISED formula
    // (utils/visaFee.ts), the SAME function createVisaWorkStartBooking
    // reuses to reconstruct this from components.
    indicativeCostSnapshot: {
      embassyFeeInr: 5000,
      vfsFeeInr: 1500,
      plumtripsServiceFeeInr: 1000,
      totalInr: 7680,
      displayMode: "ITEMISED",
    },
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

  it("skips a traveller-erased application — never creates or touches a ManualBooking", async () => {
    const { application } = fullFixtureSet({ travellerErasedAt: new Date() });
    const result = await syncVisaApplicationBilling(application, new mongoose.Types.ObjectId());
    expect(result).toEqual({ action: "skipped_traveller_erased", manualBookingId: null });
    expect(_manualBookings.query({})).toHaveLength(0);
  });
});

describe("createVisaWorkStartBooking — Phase 9e", () => {
  it("creates a WIP booking priced from indicative COMPONENTS, never the total", async () => {
    const { application } = fullFixtureSet({ status: "docs_under_review", outcome: undefined });
    const actorId = new mongoose.Types.ObjectId();

    const result = await createVisaWorkStartBooking(application, actorId);

    expect(result.action).toBe("created");
    const booking = _manualBookings.get(result.manualBookingId!);
    expect(booking.status).toBe("WIP");
    expect(booking.bookedBy).toEqual(actorId);
    expect(booking.type).toBe("VISA");
    // actualPrice = indicative embassy + indicative VFS only.
    expect(booking.pricing.actualPrice).toBe(6500);
    // quotedPrice reconstructs embassy + vfs + service + GST-on-service —
    // NOT read from indicativeCostSnapshot.totalInr directly.
    expect(booking.pricing.quotedPrice).toBe(7680);
    expect(booking.metadata.visaApplicationId).toBe(String(application._id));
  });

  it("totalWithGST on the created booking equals the indicative GST-inclusive total", async () => {
    const { application } = fullFixtureSet({ status: "docs_under_review", outcome: undefined });

    const result = await createVisaWorkStartBooking(application, new mongoose.Types.ObjectId());
    const booking = _manualBookings.get(result.manualBookingId!);

    expect(booking.pricing.totalWithGST).toBe(application.indicativeCostSnapshot.totalInr);
    expect(booking.pricing.grandTotal).toBe(application.indicativeCostSnapshot.totalInr);
  });

  it("is idempotent — a second call for the same application never creates a duplicate", async () => {
    const { application } = fullFixtureSet({ status: "docs_under_review", outcome: undefined });

    const first = await createVisaWorkStartBooking(application, new mongoose.Types.ObjectId());
    const second = await createVisaWorkStartBooking(application, new mongoose.Types.ObjectId());

    expect(second.action).toBe("skipped_already_exists");
    expect(second.manualBookingId).toBe(first.manualBookingId);
    expect(_manualBookings.query({})).toHaveLength(1);
  });

  it("a rule quoted in INDICATIVE display mode (no component breakdown) yields zero pricing, not a crash", async () => {
    const { application } = fullFixtureSet({
      status: "docs_under_review",
      outcome: undefined,
      indicativeCostSnapshot: { indicativeVisaCostInr: 4000, totalInr: 4000, displayMode: "INDICATIVE" },
    });

    const result = await createVisaWorkStartBooking(application, new mongoose.Types.ObjectId());
    const booking = _manualBookings.get(result.manualBookingId!);
    expect(booking.pricing.actualPrice).toBe(0);
    expect(booking.pricing.quotedPrice).toBe(0);
  });

  it("skips a traveller-erased application — never creates a work-start booking, even though the route-level guard should already have blocked reaching here", async () => {
    const { application } = fullFixtureSet({ status: "docs_under_review", outcome: undefined, travellerErasedAt: new Date() });
    const result = await createVisaWorkStartBooking(application, new mongoose.Types.ObjectId());
    expect(result).toEqual({ action: "skipped_traveller_erased", manualBookingId: null });
    expect(_manualBookings.query({})).toHaveLength(0);
  });
});

describe("syncVisaApplicationBilling — WIP flips to CONFIRMED at outcome (Phase 9e)", () => {
  it("a work-start WIP booking becomes CONFIRMED with the actual (not indicative) pricing", async () => {
    const { application } = fullFixtureSet({ status: "docs_under_review", outcome: undefined });
    const workStart = await createVisaWorkStartBooking(application, new mongoose.Types.ObjectId());
    expect(_manualBookings.get(workStart.manualBookingId!).status).toBe("WIP");

    // Outcome recorded — application now carries actual costs.
    const decided = { ...application, status: "decision_received", outcome: "APPROVED" };
    const result = await syncVisaApplicationBilling(decided, new mongoose.Types.ObjectId());

    expect(result.action).toBe("updated");
    expect(result.manualBookingId).toBe(workStart.manualBookingId);

    const booking = _manualBookings.get(workStart.manualBookingId!);
    expect(booking.status).toBe("CONFIRMED");
    // Actual pricing (embassy 5000 + vfs 1500 + service 1000 = 7500,
    // GST-exclusive per the outcome-time convention) — NOT the indicative
    // 7680 the work-start booking carried.
    expect(booking.pricing.quotedPrice).toBe(7500);
  });
});

describe("service partner feeds ManualBooking.supplierName (task brief, 2026-08-01)", () => {
  it("a work-start booking created before servicePartnerName is set has a blank supplier", async () => {
    const { application } = fullFixtureSet({ status: "docs_under_review", outcome: undefined, servicePartnerName: null });

    const result = await createVisaWorkStartBooking(application, new mongoose.Types.ObjectId());

    const booking = _manualBookings.get(result.manualBookingId!);
    expect(booking.supplierName).toBeUndefined();
  });

  it("a work-start booking created WITH servicePartnerName already set carries it as the supplier", async () => {
    const { application } = fullFixtureSet({ status: "docs_under_review", outcome: undefined, servicePartnerName: "VFS Bengaluru" });

    const result = await createVisaWorkStartBooking(application, new mongoose.Types.ObjectId());

    const booking = _manualBookings.get(result.manualBookingId!);
    expect(booking.supplierName).toBe("VFS Bengaluru");
  });

  it("setting the partner AFTER work-start, then re-syncing at outcome, populates the previously-blank supplier", async () => {
    const { application } = fullFixtureSet({ status: "docs_under_review", outcome: undefined, servicePartnerName: null });
    const workStart = await createVisaWorkStartBooking(application, new mongoose.Types.ObjectId());
    expect(_manualBookings.get(workStart.manualBookingId!).supplierName).toBeUndefined();

    // The concierge learns which centre handled it only later, and the
    // outcome is recorded after — same application object, now carrying
    // both the actual costs AND the partner name a console PATCH would
    // have set on VisaApplication in between.
    const decided = { ...application, status: "decision_received", outcome: "APPROVED", servicePartnerName: "VFS Bengaluru" };
    const result = await syncVisaApplicationBilling(decided, new mongoose.Types.ObjectId());

    expect(result.action).toBe("updated");
    const booking = _manualBookings.get(workStart.manualBookingId!);
    expect(booking.supplierName).toBe("VFS Bengaluru");
  });

  it("syncVisaApplicationBilling's own create path (no prior work-start booking) also carries the supplier when set", async () => {
    const { application } = fullFixtureSet({ servicePartnerName: "BLS Chennai" }); // decision_received/APPROVED by default, no existing booking

    const result = await syncVisaApplicationBilling(application, new mongoose.Types.ObjectId());

    expect(result.action).toBe("created");
    const booking = _manualBookings.get(result.manualBookingId!);
    expect(booking.supplierName).toBe("BLS Chennai");
  });
});

describe("syncVisaApplicationBilling — INVOICED and CANCELLED are never mutated (Phase 9e)", () => {
  it("never mutates an already-CANCELLED booking", async () => {
    const { application } = fullFixtureSet();
    const first = await syncVisaApplicationBilling(application, new mongoose.Types.ObjectId());
    const booking = _manualBookings.get(first.manualBookingId!);
    booking.status = "CANCELLED"; // simulate a staff-initiated cancel, or an earlier zero-cost auto-cancel

    const revised = { ...application, actualPlumtripsServiceFeeInr: 99999, actualTotalInr: 106499 };
    const second = await syncVisaApplicationBilling(revised, new mongoose.Types.ObjectId());

    expect(second.action).toBe("skipped_cancelled");
    expect(second.manualBookingId).toBe(first.manualBookingId);

    const unchanged = _manualBookings.get(first.manualBookingId!);
    expect(unchanged.pricing.quotedPrice).toBe(7500); // untouched
    expect(unchanged.status).toBe("CANCELLED");
  });

  it("leaves an unexpected status (e.g. a staff member manually reset it to PENDING) untouched, just logs it", async () => {
    const { application } = fullFixtureSet();
    const first = await syncVisaApplicationBilling(application, new mongoose.Types.ObjectId());
    const booking = _manualBookings.get(first.manualBookingId!);
    booking.status = "PENDING";

    const second = await syncVisaApplicationBilling(application, new mongoose.Types.ObjectId());

    expect(second.action).toBe("skipped_unexpected_status");
    const unchanged = _manualBookings.get(first.manualBookingId!);
    expect(unchanged.status).toBe("PENDING");
    expect(unchanged.pricing.quotedPrice).toBe(7500); // untouched
  });
});

describe("syncVisaApplicationBilling — zero cost at outcome cancels (Phase 9e)", () => {
  it("cancels a pre-existing WIP booking when the outcome's computed cost is zero — WITHDRAWN case", async () => {
    const { application } = fullFixtureSet({ status: "docs_under_review", outcome: undefined });
    const workStart = await createVisaWorkStartBooking(application, new mongoose.Types.ObjectId());
    expect(_manualBookings.get(workStart.manualBookingId!).status).toBe("WIP");

    const withdrawnNoCost = {
      ...application,
      status: "decision_received",
      outcome: "WITHDRAWN",
      actualEmbassyFeeInr: 0,
      actualVfsFeeInr: 0,
      actualPlumtripsServiceFeeInr: 0,
      actualTotalInr: 0,
    };
    const result = await syncVisaApplicationBilling(withdrawnNoCost, new mongoose.Types.ObjectId());

    expect(result.action).toBe("cancelled_zero_cost");
    expect(_manualBookings.get(workStart.manualBookingId!).status).toBe("CANCELLED");
  });

  it("cancels by COST, not by outcome value — an APPROVED case totalling zero also cancels", async () => {
    const { application } = fullFixtureSet({ status: "docs_under_review", outcome: undefined });
    const workStart = await createVisaWorkStartBooking(application, new mongoose.Types.ObjectId());

    const approvedNoCost = {
      ...application,
      status: "decision_received",
      outcome: "APPROVED",
      actualEmbassyFeeInr: 0,
      actualVfsFeeInr: 0,
      actualPlumtripsServiceFeeInr: 0,
      actualTotalInr: 0,
    };
    const result = await syncVisaApplicationBilling(approvedNoCost, new mongoose.Types.ObjectId());

    expect(result.action).toBe("cancelled_zero_cost");
    expect(_manualBookings.get(workStart.manualBookingId!).status).toBe("CANCELLED");
  });

  it("a WITHDRAWN case with REAL incurred costs still confirms normally, not cancelled", async () => {
    const { application } = fullFixtureSet({ status: "docs_under_review", outcome: undefined });
    const workStart = await createVisaWorkStartBooking(application, new mongoose.Types.ObjectId());

    const withdrawnWithCosts = {
      ...application,
      status: "decision_received",
      outcome: "WITHDRAWN",
      actualEmbassyFeeInr: 5000,
      actualVfsFeeInr: 1500,
      actualPlumtripsServiceFeeInr: 0,
      actualTotalInr: 6500,
    };
    const result = await syncVisaApplicationBilling(withdrawnWithCosts, new mongoose.Types.ObjectId());

    expect(result.action).toBe("updated");
    const booking = _manualBookings.get(workStart.manualBookingId!);
    expect(booking.status).toBe("CONFIRMED");
    expect(booking.pricing.quotedPrice).toBe(6500);
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

describe("resolveBillingCustomer (via createVisaWorkStartBooking) — customer resolution", () => {
  it("resolves via the raising user's own customerId when it's a customer-type account, even on an otherwise-ambiguous workspace", async () => {
    const workspace = workspaceFixture();
    // Make the workspace genuinely ambiguous — a SECOND Customer also
    // shares it — to prove the user-tier is checked FIRST and wins outright,
    // never even reaching the ambiguity check.
    _customers.insert({ workspaceId: workspace._id });

    const realCustomer = _customers.insert({ workspaceId: new mongoose.Types.ObjectId() });
    const raisingUser = userFixture({ roles: ["CUSTOMER", "REQUESTER"], customerId: String(realCustomer._id) });
    const request = visaRequestFixture({ raisedByUserId: raisingUser._id });
    const traveller = travellerFixture();
    const application = applicationFixture({
      requestId: request._id,
      travellerProfileId: traveller._id,
      workspaceId: workspace._id,
      status: "docs_under_review",
      outcome: undefined,
    });

    const result = await createVisaWorkStartBooking(application, new mongoose.Types.ObjectId());

    expect(result.action).toBe("created");
    const booking = _manualBookings.get(result.manualBookingId!);
    expect(String(booking.workspaceId)).toBe(String(realCustomer._id));
  });

  it("falls back to CustomerWorkspace.customerId when the raising user has no customer link — the healthy 1:1 case", async () => {
    const { application } = fullFixtureSet({ status: "docs_under_review", outcome: undefined });
    const workspace = _workspaces.get(application.workspaceId);

    const result = await createVisaWorkStartBooking(application, new mongoose.Types.ObjectId());

    expect(result.action).toBe("created");
    const booking = _manualBookings.get(result.manualBookingId!);
    expect(String(booking.workspaceId)).toBe(String(workspace.customerId));
  });

  it("also falls back to CustomerWorkspace.customerId when the raising user is STAFF (not a customer account)", async () => {
    const staffUser = userFixture({ roles: ["EMPLOYEE"] }); // no customerId at all
    const request = visaRequestFixture({ raisedByUserId: staffUser._id });
    const traveller = travellerFixture();
    const workspace = workspaceFixture();
    const application = applicationFixture({
      requestId: request._id,
      travellerProfileId: traveller._id,
      workspaceId: workspace._id,
      status: "docs_under_review",
      outcome: undefined,
    });

    const result = await createVisaWorkStartBooking(application, new mongoose.Types.ObjectId());

    expect(result.action).toBe("created");
    const booking = _manualBookings.get(result.manualBookingId!);
    expect(String(booking.workspaceId)).toBe(String(workspace.customerId));
  });

  it("skips — AMBIGUOUS_CUSTOMER — when more than one Customer shares the workspace and the raising user has no link (the HOUSE case)", async () => {
    const workspace = workspaceFixture(); // already has one Customer via the fixture
    _customers.insert({ workspaceId: workspace._id }); // a second one — now ambiguous
    _customers.insert({ workspaceId: workspace._id }); // a third, for good measure

    const request = visaRequestFixture(); // no raisedByUserId at all
    const traveller = travellerFixture();
    const application = applicationFixture({
      requestId: request._id,
      travellerProfileId: traveller._id,
      workspaceId: workspace._id,
      status: "docs_under_review",
      outcome: undefined,
    });

    const result = await createVisaWorkStartBooking(application, new mongoose.Types.ObjectId());

    expect(result).toEqual({
      action: "skipped_billing_customer_unresolved",
      manualBookingId: null,
      skipReason: "AMBIGUOUS_CUSTOMER",
      skipDetail: expect.stringContaining("3 Customer records share workspace"),
    });
    // Never created — a missing booking someone notices beats a wrong one
    // someone invoices.
    expect(_manualBookings.query({ "metadata.visaApplicationId": String(application._id) })).toHaveLength(0);
  });

  it("skips — BROKEN_CUSTOMER_LINK — when the workspace has no customerId at all", async () => {
    const workspace = workspaceFixture({ skipCustomerRecord: true }, );
    // Blank out customerId entirely (workspaceFixture always sets one).
    _workspaces.get(workspace._id).customerId = undefined;

    const request = visaRequestFixture();
    const traveller = travellerFixture();
    const application = applicationFixture({
      requestId: request._id,
      travellerProfileId: traveller._id,
      workspaceId: workspace._id,
      status: "docs_under_review",
      outcome: undefined,
    });

    const result = await createVisaWorkStartBooking(application, new mongoose.Types.ObjectId());

    expect(result.action).toBe("skipped_billing_customer_unresolved");
    expect(result.skipReason).toBe("BROKEN_CUSTOMER_LINK");
    expect(_manualBookings.query({ "metadata.visaApplicationId": String(application._id) })).toHaveLength(0);
  });

  it("skips — BROKEN_CUSTOMER_LINK — when CustomerWorkspace.customerId points at a Customer that doesn't exist", async () => {
    const workspace = workspaceFixture({ skipCustomerRecord: true }); // customerId set, but no matching Customer row
    const request = visaRequestFixture();
    const traveller = travellerFixture();
    const application = applicationFixture({
      requestId: request._id,
      travellerProfileId: traveller._id,
      workspaceId: workspace._id,
      status: "docs_under_review",
      outcome: undefined,
    });

    const result = await createVisaWorkStartBooking(application, new mongoose.Types.ObjectId());

    expect(result.action).toBe("skipped_billing_customer_unresolved");
    expect(result.skipReason).toBe("BROKEN_CUSTOMER_LINK");
    expect(_manualBookings.query({ "metadata.visaApplicationId": String(application._id) })).toHaveLength(0);
  });

  it("logs the skip as an internal VisaActivityLog row carrying only the reason code, never the free-text detail", async () => {
    const { logVisaActivity } = await import("../models/VisaActivityLog.js");
    (logVisaActivity as any).mockClear();

    const workspace = workspaceFixture();
    _customers.insert({ workspaceId: workspace._id }); // ambiguous
    const request = visaRequestFixture();
    const traveller = travellerFixture();
    const application = applicationFixture({
      requestId: request._id,
      travellerProfileId: traveller._id,
      workspaceId: workspace._id,
      status: "docs_under_review",
      outcome: undefined,
    });

    await createVisaWorkStartBooking(application, new mongoose.Types.ObjectId());

    expect(logVisaActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "MANUAL_BOOKING_SKIPPED",
        detail: { reason: "AMBIGUOUS_CUSTOMER" },
      }),
    );
  });

  it("also skips via syncVisaApplicationBilling's own create-at-outcome path when no work-start booking exists", async () => {
    const workspace = workspaceFixture();
    _customers.insert({ workspaceId: workspace._id }); // ambiguous
    const request = visaRequestFixture();
    const traveller = travellerFixture();
    const application = applicationFixture({
      requestId: request._id,
      travellerProfileId: traveller._id,
      workspaceId: workspace._id,
    }); // decision_received/APPROVED by default — quotedPrice > 0, no existing booking

    const result = await syncVisaApplicationBilling(application, new mongoose.Types.ObjectId());

    expect(result.action).toBe("skipped_billing_customer_unresolved");
    expect(result.skipReason).toBe("AMBIGUOUS_CUSTOMER");
    expect(_manualBookings.query({ "metadata.visaApplicationId": String(application._id) })).toHaveLength(0);
  });
});
