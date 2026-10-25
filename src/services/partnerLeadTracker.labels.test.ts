// apps/backend/src/services/partnerLeadTracker.labels.test.ts
//
// Every tracker label, from the one map both trackers show (partner Student
// Cases and the student's Track my case): the current step (with its bucket)
// and the timeline, case steps unchanged, booking states mapped, close
// reasons customer-safe.
import { describe, it, expect } from "vitest";
import { currentStep, stepHistory, TRACKER_LABEL, trackerRow } from "./partnerLeadTracker.js";

const t = (m: number) => new Date(Date.UTC(2026, 9, 20, 10, m));
const row = (action: string, m: number, extra: Record<string, any> = {}) => ({ action, at: t(m), ...extra });
const QUEUED = [row("submitted", 0), row("approved", 0)];
const ASSIGNED = [...QUEUED, row("admin_assigned", 1, { assigneeName: "Rita Menon" })];
const STARTED = [...ASSIGNED, row("booking_started", 2)];
const kase = (history: any[], over: Record<string, any> = {}) => ({ _id: "c1", createdAt: t(0), adminState: "pending", stage: "REQUEST_APPROVED", meta: {}, history, ...over });
const booking = (status: string, subStatus = "", m = 5) => ({ status, subStatus, isActive: true, updatedAt: t(m), attachments: [], type: "FLIGHT" });
const cur = (c: any, bookings: any[] = []) => {
  const { step, bucket } = currentStep(c, bookings);
  return [step.state, step.label, step.subStatus, bucket];
};

describe("the label map", () => {
  it("one wording per state", () => {
    expect(TRACKER_LABEL).toEqual({
      created: "Case created",
      queued: "In Admin Queue",
      assigned: "Assigned to RM",
      started: "Work started",
      in_progress: "In progress",
      processed: "Booking processed",
      cancelled: "Request cancelled",
      closed: "Request closed",
    });
  });
});

describe("current step (the case pill), from the booking rollup", () => {
  it("case steps unchanged: In Admin Queue / Assigned to RM / Work started", () => {
    expect(cur(kase(QUEUED))).toEqual(["queued", "In Admin Queue", "", "pendingAction"]);
    expect(cur(kase(ASSIGNED))).toEqual(["assigned", "Assigned to RM", "", "pendingAction"]);
    expect(cur(kase(STARTED, { adminState: "in_progress" }))).toEqual(["started", "Work started", "", "inProgress"]);
  });
  it("PENDING → In progress + sub status; WIP → In progress", () => {
    expect(cur(kase(STARTED), [booking("PENDING", "Lead Not Contactable")])).toEqual(["in_progress", "In progress", "Lead Not Contactable", "inProgress"]);
    expect(cur(kase(STARTED), [booking("WIP", "ignored")])).toEqual(["in_progress", "In progress", "", "inProgress"]);
  });
  it("CONFIRMED / INVOICED → Booking processed", () => {
    for (const s of ["CONFIRMED", "INVOICED"]) expect(cur(kase(STARTED), [booking(s, "x")])).toEqual(["processed", "Booking processed", "", "actioned"]);
  });
  it("every booking CANCELLED → Request cancelled + sub status (also when ops then closed the case)", () => {
    expect(cur(kase(STARTED), [booking("CANCELLED", "Plan changed")])).toEqual(["cancelled", "Request cancelled", "Plan changed", "actioned"]);
    const closed = kase([...STARTED, row("admin_closed", 9)], { adminState: "cancelled", meta: { closedReason: "NOT_AVAILABLE" } });
    expect(cur(closed, [booking("CANCELLED", "Plan changed")])).toEqual(["cancelled", "Request cancelled", "Plan changed", "actioned"]);
  });
  it("an open booking beats a cancelled one; a done one beats cancelled", () => {
    expect(cur(kase(STARTED), [booking("CANCELLED", "x", 9), booking("WIP", "", 5)])[1]).toBe("In progress");
    expect(cur(kase(STARTED), [booking("CANCELLED", "x", 9), booking("CONFIRMED", "", 5)])[1]).toBe("Booking processed");
  });
  it("closed by ops with no booking → Request closed + the reason's label (never the note or free text)", () => {
    const closed = (meta: any, action = "admin_closed") => kase([...ASSIGNED, row(action, 9, { comment: "Not available — call 9876543210" })], { adminState: "cancelled", stage: "BOOKING_CANCELLED", meta });
    expect(cur(closed({ closedReason: "NOT_AVAILABLE" }))).toEqual(["closed", "Request closed", "Not available", "actioned"]);
    expect(cur(closed({ closedReason: "DUPLICATE" }))[2]).toBe("Duplicate request");
    expect(cur(closed({ closedReason: "free text with 9876543210" }))[2]).toBe("");
    expect(cur(closed({}, "admin_cancelled"))).toEqual(["closed", "Request closed", "", "actioned"]);
  });
  it("marked done without a booking → Booking processed", () => {
    expect(cur(kase([...STARTED, row("admin_done", 8)], { adminState: "done", stage: "COMPLETED" }))).toEqual(["processed", "Booking processed", "", "actioned"]);
  });
});

describe("timeline", () => {
  it("case steps, then each booking status change with the same labels", () => {
    const c = kase([
      ...STARTED,
      row("booking_status", 3, { bookingStatus: "PENDING", bookingSubStatus: "Lead Not Contactable" }),
      row("booking_status", 4, { bookingStatus: "WIP", bookingSubStatus: "x" }),
      row("booking_status", 5, { bookingStatus: "CONFIRMED" }),
      row("booking_status", 6, { bookingStatus: "INVOICED" }),
      row("booking_status", 7, { bookingStatus: "CANCELLED", bookingSubStatus: "Plan changed" }),
      row("admin_done", 8), // with booking rows, the bookings tell it
    ]);
    expect(stepHistory(c).map((s) => [s.state, s.label, s.subStatus])).toEqual([
      ["created", "Case created", ""],
      ["queued", "In Admin Queue", ""],
      ["assigned", "Assigned to RM", ""],
      ["started", "Work started", ""],
      ["in_progress", "In progress", "Lead Not Contactable"],
      ["in_progress", "In progress", ""],
      ["processed", "Booking processed", ""],
      ["processed", "Booking processed", ""],
      ["cancelled", "Request cancelled", "Plan changed"],
    ]);
  });
  it("done without bookings → Booking processed; closed by ops → Request closed + reason", () => {
    expect(stepHistory(kase([...STARTED, row("admin_done", 8)])).at(-1)).toMatchObject({ state: "processed", label: "Booking processed" });
    const closed = kase([...ASSIGNED, row("admin_closed", 9)], { meta: { closedReason: "CANCELLED_BY_CLIENT" } });
    expect(stepHistory(closed).at(-1)).toMatchObject({ state: "closed", label: "Request closed", subStatus: "Cancelled by the client" });
  });
});

describe("counts are unchanged", () => {
  it("each state lands in its bucket", () => {
    const rows = [
      trackerRow(kase(QUEUED), []),
      trackerRow(kase(STARTED, { adminState: "in_progress" }), []),
      trackerRow(kase(STARTED), [booking("PENDING")]),
      trackerRow(kase(STARTED), [booking("CONFIRMED")]),
      trackerRow(kase(STARTED), [booking("CANCELLED")]),
      trackerRow(kase([...ASSIGNED, row("admin_closed", 9)], { adminState: "cancelled" }), []),
    ];
    expect(rows.map((r) => r.bucket)).toEqual(["pendingAction", "inProgress", "inProgress", "actioned", "actioned", "actioned"]);
  });
});
