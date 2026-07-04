// Phase 4 Step 4 — HELP escalation to booker.
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  reqFindOne: vi.fn(),
  reqCreate: vi.fn(),
  sendMail: vi.fn(),
  emitMetric: vi.fn(),
}));

vi.mock("../models/SBTRequest.js", () => ({ default: { findOne: H.reqFindOne, create: H.reqCreate } }));
vi.mock("../utils/mailer.js", () => ({ sendMail: H.sendMail }));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: H.emitMetric }));

import { escalateToBooker } from "./arrivalEscalation.js";

const leanSel = (v: any) => ({ select: () => ({ lean: () => Promise.resolve(v) }) });
const metricTypes = () => H.emitMetric.mock.calls.map((c: any) => c[0].type);

const session = (over: any = {}) => ({
  _id: "sess1",
  workspaceId: "507f1f77bcf86cd799439011",
  travelerUserId: "trav1",
  bookerUserId: "book1",
  bookerName: "Asha Rao",
  bookerEmail: "asha@ex.com",
  bookerPhone: "+9199",
  phone: "+919876543210",
  destinationCity: "Mumbai",
  destinationIata: "BOM",
  ...over,
});

beforeEach(() => {
  Object.values(H).forEach((m: any) => m.mockReset());
  H.reqFindOne.mockReturnValue(leanSel(null)); // no existing escalation
  H.reqCreate.mockResolvedValue({ _id: "r1" });
  H.sendMail.mockResolvedValue(undefined);
});

describe("escalateToBooker", () => {
  it("creates ONE CONCIERGE_ARRIVAL request + emails booker + escalated metric", async () => {
    const reply = await escalateToBooker(session());
    expect(H.reqCreate).toHaveBeenCalledTimes(1);
    const doc = H.reqCreate.mock.calls[0][0];
    expect(doc).toMatchObject({ source: "CONCIERGE_ARRIVAL", status: "PENDING", assignedBookerId: "book1", conversationId: "sess1" });
    expect(doc.tripBundle.conversationSummary).toContain("Mumbai");
    expect(H.sendMail).toHaveBeenCalledTimes(1);
    expect(H.sendMail.mock.calls[0][0].subject).toContain("ARRIVAL HELP");
    expect(H.sendMail.mock.calls[0][0].subject).toContain("15 minutes"); // evaluateSla("business")
    expect(reply).toContain("15 minutes");
    expect(metricTypes()).toContain("pluto.arrive.escalated");
  });

  it("repeat HELP with an open escalation → 'already alerted', no new request", async () => {
    H.reqFindOne.mockReturnValue(leanSel({ _id: "existing" }));
    const reply = await escalateToBooker(session());
    expect(H.reqCreate).not.toHaveBeenCalled();
    expect(reply.toLowerCase()).toContain("already been alerted");
  });

  it("create failure → escalation_failed + traveler still gets booker contact", async () => {
    H.reqCreate.mockRejectedValue(new Error("mongo down"));
    const reply = await escalateToBooker(session());
    expect(metricTypes()).toContain("pluto.arrive.escalation_failed");
    expect(reply).toContain("asha@ex.com");
    expect(reply).toContain("+9199");
  });

  it("no booker on session → escalation_failed + contact fallback (no crash)", async () => {
    const reply = await escalateToBooker(session({ bookerUserId: null, bookerEmail: null, bookerPhone: null, bookerName: null }));
    expect(H.reqCreate).not.toHaveBeenCalled();
    expect(metricTypes()).toContain("pluto.arrive.escalation_failed");
    expect(reply.toLowerCase()).toContain("travel desk");
  });

  it("email failure alone does NOT fail the escalation", async () => {
    H.sendMail.mockRejectedValue(new Error("smtp down"));
    const reply = await escalateToBooker(session());
    expect(H.reqCreate).toHaveBeenCalledTimes(1);
    expect(metricTypes()).toContain("pluto.arrive.escalated");
    expect(reply).toContain("15 minutes");
  });
});
