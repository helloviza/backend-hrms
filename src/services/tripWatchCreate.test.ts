import { describe, it, expect, vi, beforeEach } from "vitest";

const { createMock, emitMetricMock } = vi.hoisted(() => ({ createMock: vi.fn(), emitMetricMock: vi.fn() }));
vi.mock("../models/TripWatch.js", () => ({ default: { create: createMock } }));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: emitMetricMock }));

import { maybeCreateTripWatch } from "./tripWatchCreate.js";

const booking = (over: any = {}) => ({
  _id: "bk1", airlineCode: "6E", flightNumber: "204",
  origin: { code: "DEL" }, destination: { code: "BOM" },
  departureTime: "2026-08-12T10:00:00", contactEmail: "b@x.com", ...over,
});
const request = (over: any = {}) => ({
  _id: "req1", workspaceId: "ws1", requesterId: "u1", type: "flight", source: "CONCIERGE",
  contactDetails: { email: "r@x.com" },
  tripBundle: { consent: { watchOptIn: true, whatsappNumber: "+919876543210" } },
  ...over,
});

beforeEach(() => {
  createMock.mockReset();
  emitMetricMock.mockReset();
  createMock.mockResolvedValue({ _id: "w1" });
});

describe("maybeCreateTripWatch", () => {
  it("creates a WHATSAPP watch for concierge flight + valid opt-in number", async () => {
    await maybeCreateTripWatch(request(), booking());
    expect(createMock).toHaveBeenCalledTimes(1);
    const doc = createMock.mock.calls[0][0];
    expect(doc).toMatchObject({
      workspaceId: "ws1", bookingId: "bk1", sbtRequestId: "req1",
      flightNo: "6E-204", origin: "DEL", destination: "BOM",
      notifyChannel: "WHATSAPP", notifyTarget: "+919876543210", status: "ACTIVE",
    });
    expect(doc.departDate).toBeInstanceOf(Date);
    expect(doc.fallbackEmail).toBe("r@x.com");
  });

  it("falls back to EMAIL channel when the opt-in number is absent/invalid", async () => {
    await maybeCreateTripWatch(request({ tripBundle: { consent: { watchOptIn: true } } }), booking());
    expect(createMock.mock.calls[0][0]).toMatchObject({ notifyChannel: "EMAIL", notifyTarget: "r@x.com" });
  });

  it("NO watch without opt-in consent", async () => {
    await maybeCreateTripWatch(request({ tripBundle: { consent: { watchOptIn: false } } }), booking());
    await maybeCreateTripWatch(request({ tripBundle: {} }), booking());
    await maybeCreateTripWatch(request({ tripBundle: null }), booking());
    expect(createMock).not.toHaveBeenCalled();
  });

  it("NO watch for non-concierge source or non-flight type", async () => {
    await maybeCreateTripWatch(request({ source: "SBT" }), booking());
    await maybeCreateTripWatch(request({ type: "hotel" }), booking());
    expect(createMock).not.toHaveBeenCalled();
  });

  it("unparseable departureTime → no watch + create_failed metric", async () => {
    await maybeCreateTripWatch(request(), booking({ departureTime: "not-a-date" }));
    expect(createMock).not.toHaveBeenCalled();
    const types = emitMetricMock.mock.calls.map((c) => c[0]?.type);
    expect(types).toContain("pluto.watch.create_failed");
  });
});
