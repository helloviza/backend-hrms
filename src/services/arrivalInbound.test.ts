// Phase 4 Step 2 — inbound dispatch: security, idempotency, rate limit.
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  sendText: vi.fn(),
  sendButtons: vi.fn(),
  emitMetric: vi.fn(),
  escalate: vi.fn(),
}));

vi.mock("./arrivalEscalation.js", () => ({ escalateToBooker: H.escalate }));

vi.mock("../models/ArrivalSession.js", () => ({
  default: { findOne: H.findOne, findOneAndUpdate: H.findOneAndUpdate },
}));
vi.mock("./whatsappCloud.service.js", () => ({
  sendTextMessageResult: H.sendText,
  sendButtonMessage: H.sendButtons,
}));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: H.emitMetric }));

import { dispatchArrivalInbound } from "./arrivalInbound.js";

const sortResolves = (v: any) => ({ sort: () => Promise.resolve(v) });
const makeDoc = (seed: any) => ({ save: vi.fn().mockResolvedValue(undefined), ...seed });
const metricTypes = () => H.emitMetric.mock.calls.map((c: any) => c[0].type);

beforeEach(() => {
  Object.values(H).forEach((m: any) => m.mockReset());
  H.sendText.mockResolvedValue(true);
  H.sendButtons.mockResolvedValue(undefined);
});

describe("dispatchArrivalInbound", () => {
  it("unknown sender (no ACTIVE session) → SILENCE + unknown_sender metric", async () => {
    H.findOne.mockReturnValue(sortResolves(null));
    await dispatchArrivalInbound({ waId: "919000000000", messageId: "m1", text: "hi" });
    expect(H.sendText).not.toHaveBeenCalled();
    expect(H.sendButtons).not.toHaveBeenCalled();
    expect(metricTypes()).toContain("pluto.arrive.unknown_sender");
  });

  it("known sender, arr_hotel with no hotel on file → text reply + message_handled", async () => {
    const found = { _id: "s1" };
    H.findOne.mockReturnValue(sortResolves(found));
    H.findOneAndUpdate.mockResolvedValue(makeDoc({ _id: "s1", workspaceId: "ws", phone: "+919876543210", rateWindowCount: 0, messageCount: 0 }));

    await dispatchArrivalInbound({ waId: "919876543210", messageId: "m2", buttonId: "arr_hotel" });

    expect(H.sendText).toHaveBeenCalledWith("919876543210", expect.stringContaining("hotel on file"));
    expect(metricTypes()).toContain("pluto.arrive.message_handled");
  });

  it("STOP → session OPTED_OUT + one confirmation", async () => {
    H.findOne.mockReturnValue(sortResolves({ _id: "s1" }));
    const doc = makeDoc({ _id: "s1", workspaceId: "ws", phone: "+919876543210", rateWindowCount: 0, status: "ACTIVE" });
    H.findOneAndUpdate.mockResolvedValue(doc);
    await dispatchArrivalInbound({ waId: "919876543210", messageId: "s", text: "STOP" });
    expect(doc.status).toBe("OPTED_OUT");
    expect(H.sendText).toHaveBeenCalledWith("919876543210", expect.stringContaining("unsubscribed"));
  });

  it("HELP → delegates to escalateToBooker and sends its reply", async () => {
    H.findOne.mockReturnValue(sortResolves({ _id: "s1" }));
    H.findOneAndUpdate.mockResolvedValue(makeDoc({ _id: "s1", workspaceId: "ws", phone: "+919876543210", rateWindowCount: 0 }));
    H.escalate.mockResolvedValue("Your booker Asha has been alerted and will call you within 15 minutes.");
    await dispatchArrivalInbound({ waId: "919876543210", messageId: "h", buttonId: "arr_help" });
    expect(H.escalate).toHaveBeenCalledTimes(1);
    expect(H.sendText).toHaveBeenCalledWith("919876543210", expect.stringContaining("15 minutes"));
  });

  it("unknown command caps the menu after 3/day, then points to HELP", async () => {
    const doc = makeDoc({ _id: "s1", workspaceId: "ws", phone: "+919876543210", rateWindowCount: 0, menuCount: 3, menuWindowStart: new Date() });
    H.findOne.mockReturnValue(sortResolves({ _id: "s1" }));
    H.findOneAndUpdate.mockResolvedValue(doc);
    await dispatchArrivalInbound({ waId: "919876543210", messageId: "u", text: "blah blah" });
    expect(H.sendButtons).not.toHaveBeenCalled();
    expect(H.sendText).toHaveBeenCalledWith("919876543210", expect.stringContaining("HELP"));
  });

  it("duplicate messageId (claim returns null) → no-op, no reply", async () => {
    H.findOne.mockReturnValue(sortResolves({ _id: "s1" }));
    H.findOneAndUpdate.mockResolvedValue(null); // already in processedMessageIds
    await dispatchArrivalInbound({ waId: "919876543210", messageId: "dup", text: "hotel" });
    expect(H.sendButtons).not.toHaveBeenCalled();
    expect(H.sendText).not.toHaveBeenCalled();
  });

  it("over rate limit → one 'agent will follow up' + rate_limited, no menu", async () => {
    H.findOne.mockReturnValue(sortResolves({ _id: "s1" }));
    H.findOneAndUpdate.mockResolvedValue(
      makeDoc({ _id: "s1", workspaceId: "ws", phone: "+919876543210", rateWindowStart: new Date(), rateWindowCount: 20, rateLimitNotifiedAt: null }),
    );
    await dispatchArrivalInbound({ waId: "919876543210", messageId: "m21", text: "hotel" });
    expect(H.sendText).toHaveBeenCalledWith("919876543210", expect.stringContaining("agent will follow up"));
    expect(H.sendButtons).not.toHaveBeenCalled();
    expect(metricTypes()).toContain("pluto.arrive.rate_limited");
  });
});
