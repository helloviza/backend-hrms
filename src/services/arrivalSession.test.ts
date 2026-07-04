// Phase 4 Step 1 — arrival session open + greeting + idempotency/expiry.
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  asFindOne: vi.fn(),
  asCreate: vi.fn(),
  reqFindById: vi.fn(),
  hbFindOne: vi.fn(),
  userFindById: vi.fn(),
  sendTemplate: vi.fn(),
  sendText: vi.fn(),
  sendButtons: vi.fn(),
  emitMetric: vi.fn(),
}));

vi.mock("../models/ArrivalSession.js", () => ({ default: { findOne: H.asFindOne, create: H.asCreate } }));
vi.mock("../models/SBTRequest.js", () => ({ default: { findById: H.reqFindById } }));
vi.mock("../models/SBTHotelBooking.js", () => ({ default: { findOne: H.hbFindOne } }));
vi.mock("../models/User.js", () => ({ default: { findById: H.userFindById } }));
vi.mock("./whatsappCloud.service.js", () => ({
  sendTemplateMessage: H.sendTemplate,
  sendTextMessageResult: H.sendText,
  sendButtonMessage: H.sendButtons,
}));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: H.emitMetric }));

import { openArrivalSession, computeExpiry, resolveArrivalContext } from "./arrivalSession.js";

const leanSel = (v: any) => ({ select: () => ({ lean: () => Promise.resolve(v) }) });

const watch = (over: any = {}) => ({
  _id: "w1",
  workspaceId: "507f1f77bcf86cd799439011",
  notifyChannel: "WHATSAPP",
  notifyTarget: "+919876543210",
  destination: "BOM",
  sbtRequestId: null,
  bookingId: null,
  travelerUserId: null,
  ...over,
});
const info = (over: any = {}) => ({ arrival: { iata: "BOM", city: "Mumbai" }, ...over });

// A create() stand-in: returns a mutable doc whose save() is observable.
function makeDoc(seed: any) {
  return { ...seed, save: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  Object.values(H).forEach((m: any) => m.mockReset());
  delete process.env.WA_ARRIVAL_TEMPLATE;
  H.reqFindById.mockReturnValue(leanSel(null));
  H.hbFindOne.mockReturnValue(leanSel(null));
  H.userFindById.mockReturnValue(leanSel(null));
});

describe("computeExpiry", () => {
  const base = new Date("2026-08-12T12:00:00Z");
  it("no checkIn → base + 48h", () => {
    expect(computeExpiry(null, base).toISOString()).toBe("2026-08-14T12:00:00.000Z");
  });
  it("early checkIn + 1 day is sooner than 48h → uses checkIn+1d", () => {
    // checkIn same day; +1d = 2026-08-13T00:00Z which is < base+48h.
    expect(computeExpiry("2026-08-12", base).toISOString()).toBe("2026-08-13T00:00:00.000Z");
  });
  it("far checkIn → capped at base + 48h", () => {
    expect(computeExpiry("2026-08-20", base).toISOString()).toBe("2026-08-14T12:00:00.000Z");
  });
  it("invalid checkIn → base + 48h", () => {
    expect(computeExpiry("not-a-date", base).toISOString()).toBe("2026-08-14T12:00:00.000Z");
  });
});

describe("openArrivalSession", () => {
  it("EMAIL-channel watch → no session created, no greeting", async () => {
    await openArrivalSession(watch({ notifyChannel: "EMAIL" }), info());
    expect(H.asFindOne).not.toHaveBeenCalled();
    expect(H.asCreate).not.toHaveBeenCalled();
    expect(H.sendText).not.toHaveBeenCalled();
  });

  it("creates PENDING session, greeting succeeds → ACTIVE + session_opened + menu", async () => {
    H.asFindOne.mockResolvedValue(null);
    const created = makeDoc({ status: "PENDING", greetingAttempts: 0, phone: "+919876543210", destinationCity: "Mumbai", hotel: null });
    H.asCreate.mockResolvedValue(created);
    H.sendText.mockResolvedValue(true);

    await openArrivalSession(watch(), info(), new Date("2026-08-12T12:00:00Z"));

    expect(H.asCreate).toHaveBeenCalledTimes(1);
    expect(H.sendText).toHaveBeenCalledTimes(1);
    // welcome to the resolved city, number WITHOUT the leading +
    expect(H.sendText).toHaveBeenCalledWith("919876543210", expect.stringContaining("Mumbai"));
    expect(H.sendButtons).toHaveBeenCalledTimes(1);
    const buttons = H.sendButtons.mock.calls[0][2];
    expect(buttons.map((b: any) => b.id)).toEqual(["arr_hotel", "arr_booker", "arr_help"]);
    expect(created.status).toBe("ACTIVE");
    expect(created.openedAt).toEqual(new Date("2026-08-12T12:00:00Z"));
    expect(H.emitMetric).toHaveBeenCalledTimes(1);
    expect(H.emitMetric.mock.calls[0][0].type).toBe("pluto.arrive.session_opened");
  });

  it("idempotent across two cycles: existing ACTIVE session → no re-create, no re-greet", async () => {
    H.asFindOne.mockResolvedValue(makeDoc({ status: "ACTIVE" }));
    await openArrivalSession(watch(), info());
    expect(H.asCreate).not.toHaveBeenCalled();
    expect(H.sendText).not.toHaveBeenCalled();
    expect(H.sendButtons).not.toHaveBeenCalled();
  });

  it("greeting fails → stays PENDING (attempt 1); next cycle fails again → EXPIRED + greeting_failed", async () => {
    // Cycle 1: no existing session, create PENDING, greeting fails.
    const doc = makeDoc({ status: "PENDING", greetingAttempts: 0, phone: "+919876543210", hotel: null, destinationCity: "Mumbai" });
    H.asFindOne.mockResolvedValueOnce(null);
    H.asCreate.mockResolvedValue(doc);
    H.sendText.mockResolvedValue(false);

    await openArrivalSession(watch(), info());
    expect(doc.status).toBe("PENDING");
    expect(doc.greetingAttempts).toBe(1);
    expect(H.sendButtons).not.toHaveBeenCalled(); // no menu when greeting fails

    // Cycle 2: findOne returns the same PENDING doc; greeting fails again → EXPIRED.
    H.asFindOne.mockResolvedValueOnce(doc);
    await openArrivalSession(watch(), info());
    expect(doc.status).toBe("EXPIRED");
    expect(doc.greetingAttempts).toBe(2);
    const types = H.emitMetric.mock.calls.map((c: any) => c[0].type);
    expect(types).toContain("pluto.arrive.greeting_failed");
  });

  it("concurrent create (E11000) → swallowed, no throw", async () => {
    H.asFindOne.mockResolvedValue(null);
    H.asCreate.mockRejectedValue({ code: 11000 });
    await expect(openArrivalSession(watch(), info())).resolves.toBeUndefined();
    expect(H.sendText).not.toHaveBeenCalled();
  });
});

describe("resolveArrivalContext", () => {
  it("pulls hotel from tripBundle.hotel and booker from assignedBookerId → User", async () => {
    H.reqFindById.mockReturnValue(
      leanSel({ assignedBookerId: "bk1", tripBundle: { hotel: { name: "Taj", address: "Colaba", phone: "+912266", checkInDate: "2026-08-12" } } }),
    );
    H.userFindById.mockReturnValue(leanSel({ name: "Asha Rao", email: "asha@ex.com", phone: "+9199" }));

    const ctx = await resolveArrivalContext(watch({ sbtRequestId: "r1" }), info());
    expect(ctx.destinationCity).toBe("Mumbai");
    expect(ctx.hotel).toMatchObject({ name: "Taj", address: "Colaba", checkInDate: "2026-08-12" });
    expect(ctx.bookerName).toBe("Asha Rao");
    expect(ctx.bookerEmail).toBe("asha@ex.com");
  });

  it("falls back to SBTHotelBooking when tripBundle has no hotel", async () => {
    H.reqFindById.mockReturnValue(leanSel({ assignedBookerId: null, tripBundle: {} }));
    H.hbFindOne.mockReturnValue(leanSel({ hotelName: "Novotel", cityName: "Mumbai", checkIn: "2026-08-12" }));

    const ctx = await resolveArrivalContext(watch({ sbtRequestId: "r1" }), info());
    expect(ctx.hotel).toMatchObject({ name: "Novotel", address: "Mumbai", checkInDate: "2026-08-12" });
  });
});
