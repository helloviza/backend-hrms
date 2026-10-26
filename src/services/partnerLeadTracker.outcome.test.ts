// apps/backend/src/services/partnerLeadTracker.outcome.test.ts
//
// Student Cases' Booking done / Booking dropped split: by the step the partner
// sees, never a re-read of the bookings. Booking processed → done; Request
// cancelled (every sub status) / Request closed → dropped; a Pending booking
// (NC sub statuses too) stays In progress. One case, one count; the four
// cards sum to Registered. `bucket` / `actioned` and the student's row
// (trackerRow) are unchanged.
import { describe, it, expect } from "vitest";
import { CANCELLED_SUB_STATUSES, PENDING_SUB_STATUSES } from "../models/ManualBooking.js";
import { outcomeOf, partnerCaseRow, trackerCounts, trackerRow } from "./partnerLeadTracker.js";

const t = (m: number) => new Date(Date.UTC(2026, 9, 20, 10, m));
const row = (action: string, m: number, extra: Record<string, any> = {}) => ({ action, at: t(m), ...extra });
const QUEUED = [row("submitted", 0), row("approved", 0)];
const ASSIGNED = [...QUEUED, row("admin_assigned", 1, { assigneeName: "Rita Menon" })];
const STARTED = [...ASSIGNED, row("booking_started", 2)];
const kase = (history: any[], over: Record<string, any> = {}) => ({ _id: "c1", createdAt: t(0), adminState: "pending", stage: "REQUEST_APPROVED", meta: {}, history, ...over });
const opsClosed = (over: Record<string, any> = {}) => kase([...STARTED, row("admin_closed", 9)], { adminState: "cancelled", stage: "BOOKING_CANCELLED", meta: { closedReason: "NOT_AVAILABLE" }, ...over });
const booking = (status: string, subStatus = "", m = 5) => ({ status, subStatus, isActive: true, updatedAt: t(m), attachments: [], type: "FLIGHT" });
const of = (c: any, bookings: any[] = []) => {
  const r = partnerCaseRow(c, bookings);
  return [r.currentStep.label, r.bucket, r.outcome];
};

describe("outcome of each step", () => {
  it("processed → done; cancelled / closed → dropped; everything else → none", () => {
    expect(outcomeOf("processed")).toBe("bookingDone");
    expect(outcomeOf("cancelled")).toBe("bookingDropped");
    expect(outcomeOf("closed")).toBe("bookingDropped");
    for (const s of ["created", "queued", "assigned", "started", "in_progress"] as const) expect(outcomeOf(s)).toBeNull();
  });
});

describe("Booking done", () => {
  it("a CONFIRMED or INVOICED booking", () => {
    for (const s of ["CONFIRMED", "INVOICED"]) expect(of(kase(STARTED), [booking(s)])).toEqual(["Booking processed", "actioned", "bookingDone"]);
  });
  it("a done booking beats a cancelled one", () => {
    expect(of(kase(STARTED), [booking("CANCELLED", "Plan changed", 9), booking("CONFIRMED", "", 5)])).toEqual(["Booking processed", "actioned", "bookingDone"]);
  });
  it("edge 4: ops marked it done with no booking — it shows Booking processed, so it is done", () => {
    expect(of(kase([...STARTED, row("admin_done", 8)], { adminState: "done", stage: "COMPLETED" }))).toEqual(["Booking processed", "actioned", "bookingDone"]);
  });
});

describe("Booking dropped", () => {
  it("every booking cancelled, under each Cancelled sub status (Lead Not Contactable included)", () => {
    for (const sub of [...CANCELLED_SUB_STATUSES, ""]) {
      expect(of(kase(STARTED), [booking("CANCELLED", sub)])).toEqual(["Request cancelled", "actioned", "bookingDropped"]);
      expect(of(opsClosed(), [booking("CANCELLED", sub)])).toEqual(["Request cancelled", "actioned", "bookingDropped"]);
    }
  });
  it("closed by ops with no booking (Mark Processed with a reason, or cancel)", () => {
    expect(of(opsClosed())).toEqual(["Request closed", "actioned", "bookingDropped"]);
    expect(of(kase([...ASSIGNED, row("admin_cancelled", 9)], { adminState: "cancelled" }))).toEqual(["Request closed", "actioned", "bookingDropped"]);
  });
  it("edge 2: closed by ops while a booking is CONFIRMED — shows Request closed, so dropped", () => {
    expect(of(opsClosed(), [booking("CONFIRMED")])).toEqual(["Request closed", "actioned", "bookingDropped"]);
  });
  it("edge 3: closed by ops while a booking is still PENDING / WIP — dropped", () => {
    for (const s of ["PENDING", "WIP"]) expect(of(opsClosed(), [booking(s, "Lead Not Contactable")])).toEqual(["Request closed", "actioned", "bookingDropped"]);
  });
});

describe("still In progress (the RM is working it)", () => {
  it("a PENDING booking under every Pending sub status, the NC ones included", () => {
    for (const sub of PENDING_SUB_STATUSES) expect(of(kase(STARTED), [booking("PENDING", sub)])).toEqual(["In progress", "inProgress", null]);
  });
  it("edge 1: one CONFIRMED + one PENDING booking — the open one wins, In progress, counted once", () => {
    expect(of(kase(STARTED), [booking("CONFIRMED", "", 9), booking("PENDING", "Lead Not Contactable", 5)])).toEqual(["In progress", "inProgress", null]);
  });
});

describe("counts", () => {
  const cases: Array<[any, any[]]> = [
    [kase(QUEUED), []],
    [kase(ASSIGNED), []],
    [kase(STARTED, { adminState: "in_progress" }), []],
    [kase(STARTED), [booking("PENDING", "NC Leads - Email Sent")]],
    [kase(STARTED), [booking("CONFIRMED"), booking("PENDING")]], // edge 1
    [kase(STARTED), [booking("CONFIRMED"), booking("INVOICED"), booking("CANCELLED", "Plan changed")]], // multi-booking, done once
    [kase([...STARTED, row("admin_done", 8)], { adminState: "done" }), []], // edge 4
    [kase(STARTED), [booking("CANCELLED", "Lead Not Contactable"), booking("CANCELLED", "Fare Difference")]], // multi-booking, dropped once
    [opsClosed(), []],
    [opsClosed(), [booking("CONFIRMED")]], // edge 2
    [opsClosed(), [booking("WIP")]], // edge 3
  ];
  const rows = cases.map(([c, b]) => partnerCaseRow(c, b));

  it("one case, one count; Pending action + In progress + Booking done + Booking dropped = Registered", () => {
    const n = trackerCounts(rows);
    expect(n).toEqual({ registered: 11, pendingAction: 2, inProgress: 3, actioned: 6, bookingDone: 2, bookingDropped: 4 });
    expect(n.pendingAction + n.inProgress + n.bookingDone + n.bookingDropped).toBe(n.registered);
    expect(n.bookingDone + n.bookingDropped).toBe(n.actioned);
  });
  it("no cases → all zero", () => {
    expect(trackerCounts([])).toEqual({ registered: 0, pendingAction: 0, inProgress: 0, actioned: 0, bookingDone: 0, bookingDropped: 0 });
  });
  it("the student's Track my case row is unchanged: no outcome", () => {
    for (const [c, b] of cases) expect("outcome" in trackerRow(c, b)).toBe(false);
  });
});

describe("the edge-2 count script (read only)", () => {
  it("matches only a Request closed case with a live Confirmed / Invoiced booking", async () => {
    const { closedWithConfirmedBooking } = await import("../scripts/count-partner-closed-with-confirmed-booking.js");
    const hit = (c: any, b: any[]) => closedWithConfirmedBooking(partnerCaseRow(c, b), b);
    expect(hit(opsClosed(), [booking("CONFIRMED")])).toBe(true);
    expect(hit(opsClosed(), [booking("INVOICED"), booking("CANCELLED")])).toBe(true);
    expect(hit(opsClosed(), [])).toBe(false);
    expect(hit(opsClosed(), [booking("WIP")])).toBe(false);
    expect(hit(opsClosed(), [{ ...booking("CONFIRMED"), isActive: false }])).toBe(false);
    expect(hit(kase(STARTED), [booking("CONFIRMED")])).toBe(false); // Booking processed, not closed
  });
  it("refuses to run without --expect-db naming the connected db", async () => {
    const { countPartnerClosedWithConfirmed } = await import("../scripts/count-partner-closed-with-confirmed-booking.js");
    await expect(countPartnerClosedWithConfirmed({ log: () => {} })).rejects.toThrow(/--expect-db=<name> is required/);
    await expect(countPartnerClosedWithConfirmed({ expectDb: "plumbox_prod_guess", log: () => {} })).rejects.toThrow(/REFUSING/);
  });
});
