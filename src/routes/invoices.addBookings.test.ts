// Route-level coverage for the Phase 9e piggyback fix: PATCH /api/admin/
// invoices/:id's "add bookings" path must require status CONFIRMED, exactly
// matching GET /:id/eligible-bookings' own filter. Before this fix it only
// rejected INVOICED/CANCELLED/inactive bookings, which would have let a WIP
// visa work-start booking (services/visaBillingSync.ts, Phase 9e) onto an
// invoice weeks before it was ever meant to become billable.
//
// Same "spy on the real mongoose.startSession" approach as
// admin.visa.rules.test.ts — withTransaction just runs the callback inline,
// since this test only needs to reach the eligibility check, well before
// anything the transaction would actually need to roll back.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

const _bookings = new Map<string, any>();

vi.mock("../models/ManualBooking.js", () => ({
  default: {
    find: (filter: any) => ({
      session: () =>
        Promise.resolve(
          Array.from(_bookings.values()).filter((b) => (filter._id?.$in ?? []).map(String).includes(String(b._id))),
        ),
    }),
  },
}));

let invoiceDoc: any;
vi.mock("../models/Invoice.js", () => ({
  default: {
    findById: (id: any) => ({
      session: () => Promise.resolve(invoiceDoc && String(invoiceDoc._id) === String(id) ? invoiceDoc : null),
    }),
  },
}));

vi.mock("../models/CustomerWorkspace.js", () => ({
  default: { findById: () => ({ session: () => ({ lean: () => Promise.resolve(null) }) }) },
}));

import express from "express";
import request from "supertest";
import router from "./invoices.js";

const WORKSPACE_ID = new mongoose.Types.ObjectId();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // SUPERADMIN bypasses both requireAdmin and requirePermission — this
    // file's own coverage is the booking-eligibility check inside the
    // route, not the permission gate (admin.visa.test.ts's job pattern,
    // applied here).
    req.user = { _id: String(new mongoose.Types.ObjectId()), roles: ["SUPERADMIN"] };
    next();
  });
  app.use("/", router);
  return app;
}

function bookingFixture(overrides: Record<string, any> = {}) {
  const booking = {
    _id: new mongoose.Types.ObjectId(),
    workspaceId: WORKSPACE_ID,
    bookingRef: "MB-TEST-1",
    isActive: true,
    invoiceId: null,
    status: "CONFIRMED",
    ...overrides,
  };
  _bookings.set(String(booking._id), booking);
  return booking;
}

beforeEach(() => {
  _bookings.clear();
  vi.spyOn(mongoose, "startSession").mockResolvedValue({
    withTransaction: async (fn: () => Promise<any>) => fn(),
    endSession: () => {},
  } as any);

  invoiceDoc = {
    _id: new mongoose.Types.ObjectId(),
    status: "DRAFT",
    workspaceId: WORKSPACE_ID,
    bookingIds: [],
    lineItems: [],
    save: vi.fn().mockResolvedValue(undefined),
  };
});

describe("PATCH /api/admin/invoices/:id — add-bookings eligibility", () => {
  it("rejects a WIP booking — a work-start visa booking must never be addable", async () => {
    const booking = bookingFixture({ status: "WIP" });

    const res = await request(makeApp())
      .patch(`/${invoiceDoc._id}`)
      .send({ bookingsToAdd: [String(booking._id)] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("must be CONFIRMED");
    expect(res.body.error).toContain("MB-TEST-1");
  });

  it("rejects a PENDING booking the same way", async () => {
    const booking = bookingFixture({ status: "PENDING" });

    const res = await request(makeApp())
      .patch(`/${invoiceDoc._id}`)
      .send({ bookingsToAdd: [String(booking._id)] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("must be CONFIRMED");
  });

  it("still rejects INVOICED and CANCELLED bookings (unchanged behaviour)", async () => {
    for (const status of ["INVOICED", "CANCELLED"]) {
      _bookings.clear();
      const booking = bookingFixture({ status });
      const res = await request(makeApp())
        .patch(`/${invoiceDoc._id}`)
        .send({ bookingsToAdd: [String(booking._id)] });
      expect(res.status).toBe(400);
    }
  });

  it("does not reject on eligibility when the booking is CONFIRMED", async () => {
    const booking = bookingFixture({ status: "CONFIRMED" });

    const res = await request(makeApp())
      .patch(`/${invoiceDoc._id}`)
      .send({ bookingsToAdd: [String(booking._id)] });

    // Whatever happens further down this route (line-item building, GST,
    // totals — outside this fix's scope and not mocked here), it must NOT
    // be the eligibility 400 this test targets.
    expect(res.body?.error ?? "").not.toContain("must be CONFIRMED");
  });
});
