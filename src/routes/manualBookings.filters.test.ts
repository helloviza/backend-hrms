// Filter-enhancement coverage for /admin/manual-bookings.
//
// Asserts on the object handed to ManualBooking.find(), same discipline as the
// gate tests: a returned-rows assertion against a mocked model proves nothing
// about what was actually queried.
//
// Every case runs against BOTH the list and the export, because they share one
// non-gate builder (buildSearchFilter) and the whole point of that sharing is
// that "export what I'm filtering" stays true. A param that reaches only one
// of them is the bug this file exists to catch.
//
// NO DATABASE — apps/backend/.env points MONGO_URI at PROD Atlas. Every model
// is mocked and requirePermission is mocked (the real one does a
// UserPermission.findOne()).
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (req: any, _res: any, next: any) => {
    req.permissionScope = "ALL";
    req.permissionAccess = "FULL";
    next();
  },
  requireAnyPermission: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../models/ManualBooking.js", async () => {
  const actual: any = await vi.importActual("../models/ManualBooking.js");
  const chain = (): any => {
    const node: any = {
      sort: () => node, skip: () => node, limit: () => node, populate: () => node,
      lean: () => Promise.resolve([]),
      then: (r: any, j: any) => Promise.resolve([]).then(r, j),
    };
    return node;
  };
  return {
    // Real enum constants — the point is that the route validates against the
    // MODEL's enums, so stubbing them would validate against the test's idea
    // of the enum instead of the schema's.
    MANUAL_BOOKING_TYPES: actual.MANUAL_BOOKING_TYPES,
    ALL_SUB_STATUSES: actual.ALL_SUB_STATUSES,
    ATTACHMENT_REQUIRED_TYPES: [],
    isNewModelLineItems: () => false,
    default: {
      find: (f: any) => { (globalThis as any).__capt.push(f); return chain(); },
      countDocuments: () => Promise.resolve(0),
      aggregate: () => Promise.resolve([]),
    },
  };
});
(globalThis as any).__capt = [] as any[];

vi.mock("../models/Invoice.js", () => ({
  default: { find: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) },
}));
vi.mock("../models/Customer.js", () => ({
  default: { findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }), lean: () => Promise.resolve(null) }) },
}));
vi.mock("../models/CustomerWorkspace.js", () => ({
  default: { findOne: () => ({ lean: () => Promise.resolve(null) }), findById: () => ({ lean: () => Promise.resolve(null) }) },
}));
vi.mock("../models/CustomerMember.js", () => ({ default: { find: () => ({ lean: () => Promise.resolve([]) }) } }));
vi.mock("../models/User.js", () => ({ default: { findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) } }));
vi.mock("../models/SBTBooking.js", () => ({ default: { find: () => ({ lean: () => Promise.resolve([]) }) } }));
vi.mock("../models/SBTHotelBooking.js", () => ({ default: { find: () => ({ lean: () => Promise.resolve([]) }) } }));
vi.mock("../models/ExtractedDocument.js", () => ({ default: { find: () => ({ lean: () => Promise.resolve([]) }) } }));

import express from "express";
import request from "supertest";
import router from "./manualBookings.js";

const captured: any[] = (globalThis as any).__capt;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // SUPERADMIN so the tenant/own-scope gates stay out of the way — this file
    // is about the NON-gate filter params. Gate coverage lives in
    // manualBookings.exportScope.test.ts.
    req.user = { _id: String(new mongoose.Types.ObjectId()), roles: ["SUPERADMIN"] };
    next();
  });
  app.use("/", router);
  return app;
}

/** Runs one query string against BOTH read paths and returns both filters. */
async function bothPaths(qs: string) {
  captured.length = 0;
  await request(makeApp()).get(`/${qs}`);
  const list = captured[0];
  captured.length = 0;
  await request(makeApp()).get(`/export${qs}`);
  const exp = captured[0];
  return { list, exp };
}

beforeEach(() => { captured.length = 0; });

describe("multi-select status / type", () => {
  it("a single value stays a bare equality", async () => {
    const { list, exp } = await bothPaths("?status=PENDING");
    expect(list.status).toBe("PENDING");
    expect(exp.status).toBe("PENDING");
  });

  it("several values become $in", async () => {
    const { list, exp } = await bothPaths("?status=DRAFT,PENDING,WIP");
    // DRAFT is not a booking status — dropped; the two real ones survive.
    expect(list.status).toEqual({ $in: ["PENDING", "WIP"] });
    expect(exp.status).toEqual({ $in: ["PENDING", "WIP"] });
  });

  it("drops unknown values but keeps the valid ones", async () => {
    const { list } = await bothPaths("?type=FLIGHT,NONSENSE,HOTEL");
    expect(list.type).toEqual({ $in: ["FLIGHT", "HOTEL"] });
  });

  it("an all-invalid list matches NOTHING rather than everything", async () => {
    // This is the retired `DONE` option's behaviour, now explicit: it was
    // never in the schema enum, so it must not silently become "no filter".
    const { list, exp } = await bothPaths("?status=DONE");
    expect(list.status).toEqual({ $in: [] });
    expect(exp.status).toEqual({ $in: [] });
  });

  it("TRAIN is accepted — the 20th type, previously missing from the UI", async () => {
    const { list } = await bothPaths("?type=TRAIN");
    expect(list.type).toBe("TRAIN");
  });

  it("de-duplicates repeated values", async () => {
    const { list } = await bothPaths("?status=PENDING,PENDING,WIP");
    expect(list.status).toEqual({ $in: ["PENDING", "WIP"] });
  });
});

describe("subStatus / source / assignment — exact match", () => {
  it("subStatus single value is an equality", async () => {
    const { list, exp } = await bothPaths("?subStatus=" + encodeURIComponent("Plan changed"));
    expect(list.subStatus).toBe("Plan changed");
    expect(exp.subStatus).toBe("Plan changed");
  });

  it("subStatus multi spans both model groups", async () => {
    const q = encodeURIComponent("Pending for Supplier Confirmation") + "," + encodeURIComponent("Travel cancelled");
    const { list } = await bothPaths("?subStatus=" + q);
    expect(list.subStatus).toEqual({
      $in: ["Pending for Supplier Confirmation", "Travel cancelled"],
    });
  });

  it("source is enum-validated", async () => {
    const { list, exp } = await bothPaths("?source=SBT_AUTO");
    expect(list.source).toBe("SBT_AUTO");
    expect(exp.source).toBe("SBT_AUTO");
    const bogus = await bothPaths("?source=CARRIER_PIGEON");
    expect(bogus.list.source).toEqual({ $in: [] });
  });

  it("assignmentStatus is enum-validated", async () => {
    const { list, exp } = await bothPaths("?assignmentStatus=PENDING_TO_ASSIGN");
    expect(list.assignmentStatus).toBe("PENDING_TO_ASSIGN");
    expect(exp.assignmentStatus).toBe("PENDING_TO_ASSIGN");
  });

  it("assignPerson is cast to an ObjectId", async () => {
    const id = new mongoose.Types.ObjectId();
    const { list, exp } = await bothPaths(`?assignPerson=${String(id)}`);
    expect(String(list.assignPerson)).toBe(String(id));
    expect(String(exp.assignPerson)).toBe(String(id));
    expect(list.assignPerson).toBeInstanceOf(mongoose.Types.ObjectId);
  });

  it("an unparseable assignPerson matches nothing rather than being ignored", async () => {
    const { list } = await bothPaths("?assignPerson=not-an-id");
    expect(list.assignPerson).toBeNull();
  });
});

describe("travel-date range", () => {
  it("maps to travelDate with inclusive IST bounds", async () => {
    const { list, exp } = await bothPaths("?travelFrom=2026-09-01&travelTo=2026-09-30");
    for (const f of [list, exp]) {
      expect(f.travelDate.$gte.toISOString()).toBe("2026-08-31T18:30:00.000Z"); // 00:00 IST 1 Sep
      expect(f.travelDate.$lte.toISOString()).toBe("2026-09-30T18:29:59.999Z"); // 23:59:59.999 IST 30 Sep
    }
  });

  it("is a SEPARATE range from the booking-date one", async () => {
    const { list } = await bothPaths("?dateFrom=2026-01-01&travelFrom=2026-09-01");
    expect(list.bookingDate.$gte.toISOString()).toBe("2025-12-31T18:30:00.000Z");
    expect(list.travelDate.$gte.toISOString()).toBe("2026-08-31T18:30:00.000Z");
    // Two sibling keys — implicitly ANDed, neither clobbering the other.
    expect(Object.keys(list)).toEqual(expect.arrayContaining(["bookingDate", "travelDate"]));
  });

  it("accepts an open-ended range", async () => {
    const { list } = await bothPaths("?travelTo=2026-09-30");
    expect(list.travelDate.$gte).toBeUndefined();
    expect(list.travelDate.$lte).toBeTruthy();
  });
});

describe("search is escaped", () => {
  it("a bare '(' does not throw", async () => {
    captured.length = 0;
    const res = await request(makeApp()).get("/?search=" + encodeURIComponent("("));
    expect(res.status).toBe(200);
    const or = captured[0].$and.find((c: any) => Array.isArray(c.$or) && c.$or.some((a: any) => "bookingRef" in a));
    expect(or.$or[0].bookingRef.test("(ABC")).toBe(true);
  });

  it("treats input as literal text, not a pattern", async () => {
    captured.length = 0;
    await request(makeApp()).get("/?search=" + encodeURIComponent(".*"));
    const or = captured[0].$and.find((c: any) => Array.isArray(c.$or) && c.$or.some((a: any) => "bookingRef" in a));
    expect(or.$or[0].bookingRef.test("MB-123")).toBe(false);
    expect(or.$or[0].bookingRef.test("a.*b")).toBe(true);
  });

  it("the export path escapes it too", async () => {
    captured.length = 0;
    const res = await request(makeApp()).get("/export?search=" + encodeURIComponent("("));
    expect(res.status).toBe(200);
  });

  it("givenBy and sector regexes are escaped as well", async () => {
    const { list } = await bothPaths("?givenBy=" + encodeURIComponent("a(b") + "&sector=" + encodeURIComponent("x)y"));
    expect(list.givenBy.test("a(b")).toBe(true);
    expect(list.sector.test("x)y")).toBe(true);
  });
});

describe("every new param reaches the export path", () => {
  it("a fully-loaded query produces an identical non-gate filter on both", async () => {
    const qs =
      "?status=PENDING,WIP&type=FLIGHT,TRAIN&source=MANUAL" +
      "&subStatus=" + encodeURIComponent("Plan changed") +
      "&assignmentStatus=ASSIGNED" +
      "&travelFrom=2026-09-01&travelTo=2026-09-30" +
      "&dateFrom=2026-08-01&search=MB";
    const { list, exp } = await bothPaths(qs);

    for (const key of ["status", "type", "source", "subStatus", "assignmentStatus"]) {
      expect(exp[key], `${key} missing from export`).toEqual(list[key]);
    }
    expect(exp.travelDate.$gte.getTime()).toBe(list.travelDate.$gte.getTime());
    expect(exp.bookingDate.$gte.getTime()).toBe(list.bookingDate.$gte.getTime());
    // Search lives in $and on both, lifted out of the sibling $or by the gates.
    const orOf = (f: any) => (f.$and ?? []).find((c: any) => Array.isArray(c.$or) && c.$or.some((a: any) => "bookingRef" in a));
    expect(orOf(exp)).toBeTruthy();
    expect(orOf(list)).toBeTruthy();
  });

  it("demo rows stay excluded on both paths", async () => {
    const { list, exp } = await bothPaths("?status=PENDING");
    expect(list.isDemo).toEqual({ $ne: true });
    expect(exp.isDemo).toEqual({ $ne: true });
  });
});
