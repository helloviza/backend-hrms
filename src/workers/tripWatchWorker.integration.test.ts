// End-to-end watcher: real runRealCycle + real diff + real notifier, with only
// the edges mocked (models, FlightAware, Meta Graph WhatsApp, mailer).
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  claim: vi.fn(), wUpdateOne: vi.fn(), wFind: vi.fn(), wFindById: vi.fn(), wUpdateMany: vi.fn(),
  aCreate: vi.fn(), aUpdateOne: vi.fn(), aFind: vi.fn(), aFindOne: vi.fn(),
  bFindById: vi.fn(),
  flightStatus: vi.fn(),
  sendTemplate: vi.fn(), sendText: vi.fn(), sendMail: vi.fn(),
  emitMetric: vi.fn(), getWeather: vi.fn(),
}));

vi.mock("../models/TripWatch.js", () => ({ default: {
  findOneAndUpdate: H.claim, updateOne: H.wUpdateOne, find: H.wFind, findById: H.wFindById, updateMany: H.wUpdateMany,
} }));
vi.mock("../models/TripAlert.js", () => ({ default: {
  create: H.aCreate, updateOne: H.aUpdateOne, find: H.aFind, findOne: H.aFindOne,
} }));
vi.mock("../models/SBTBooking.js", () => ({ default: { findById: H.bFindById } }));
vi.mock("../services/flightService.js", () => ({ getDelightfulFlightStatus: H.flightStatus }));
vi.mock("../services/whatsappCloud.service.js", () => ({ sendTemplateMessage: H.sendTemplate, sendTextMessageResult: H.sendText }));
vi.mock("../utils/mailer.js", () => ({ sendMail: H.sendMail }));
vi.mock("../services/weatherService.js", () => ({ getDestinationWeather: H.getWeather }));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: H.emitMetric }));

import { runRealCycle } from "./tripWatchWorker.js";

const leanList = (v: any) => ({ limit: () => ({ lean: () => Promise.resolve(v) }) });
const leanOne = (v: any) => ({ lean: () => Promise.resolve(v) });
const leanSel = (v: any) => ({ select: () => ({ lean: () => Promise.resolve(v) }) });

const watch = (over: any = {}) => ({
  _id: "w1", workspaceId: "ws1", flightNo: "6E-204", carrier: "6E", origin: "DEL", destination: "BOM",
  departDate: new Date(Date.now() + 2 * 3600_000), notifyChannel: "WHATSAPP", notifyTarget: "+919876543210",
  fallbackEmail: null,
  lastKnownState: { status: "Scheduled", depScheduled: "2026-08-12T10:00:00Z", depActual: "2026-08-12T10:10:00Z" },
  ...over,
});
const delayInfo = { flight_status: "Delayed", departure: { scheduled: "2026-08-12T10:00:00Z", actual: "2026-08-12T10:45:00Z", gate: "A1", terminal: "2" } };

beforeEach(() => {
  Object.values(H).forEach((m: any) => m.mockReset());
  // default no-ops for the passes we aren't exercising
  H.wFind.mockReturnValue(leanList([]));      // weather pass: no due watches
  H.aFind.mockReturnValue(leanList([]));       // retry pass: no pending
  H.wUpdateMany.mockResolvedValue({});
  H.wUpdateOne.mockResolvedValue({});
  H.aUpdateOne.mockResolvedValue({});
  H.aCreate.mockImplementation(async (doc: any) => ({ _id: "al1", attempts: 0, ...doc }));
  H.getWeather.mockResolvedValue(null);
  H.bFindById.mockReturnValue(leanSel(null));
  process.env.WA_DISRUPTION_TEMPLATE = "flight_disruption";
});

function claimOnce(w: any) {
  H.claim.mockResolvedValueOnce(w).mockResolvedValue(null);
}

describe("watcher → alert → delivery (e2e)", () => {
  it("2a: 45-min delay → DELAY alert → WhatsApp template → SENT/WHATSAPP", async () => {
    claimOnce(watch());
    H.flightStatus.mockResolvedValue(delayInfo);
    H.sendTemplate.mockResolvedValue(true);

    await runRealCycle(new Date());

    expect(H.flightStatus).toHaveBeenCalledTimes(1);
    expect(H.aCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: "DELAY", deliveryStatus: "PENDING" }));
    expect(H.sendTemplate).toHaveBeenCalledWith("919876543210", "flight_disruption", ["6E-204", "DEL→BOM", expect.stringContaining("45"), ""]);
    expect(H.aUpdateOne).toHaveBeenCalledWith({ _id: "al1" }, { $set: expect.objectContaining({ deliveryStatus: "SENT", channelUsed: "WHATSAPP" }) });
  });

  it("2b: WhatsApp fails + fallback email → SENT/EMAIL", async () => {
    claimOnce(watch({ fallbackEmail: "t@x.com" }));
    H.flightStatus.mockResolvedValue(delayInfo);
    H.sendTemplate.mockResolvedValue(false); // whatsapp fails
    H.sendMail.mockResolvedValue(undefined);

    await runRealCycle(new Date());

    expect(H.sendMail).toHaveBeenCalledTimes(1);
    expect(H.aUpdateOne).toHaveBeenCalledWith({ _id: "al1" }, { $set: expect.objectContaining({ deliveryStatus: "SENT", channelUsed: "EMAIL" }) });
  });

  it("2c: both channels fail on a retry (attempts already 1) → FAILED, no 3rd attempt", async () => {
    // No new check this cycle; a PENDING alert with attempts:1 is retried and fails terminally.
    H.claim.mockResolvedValue(null);
    H.aFind.mockReturnValue(leanList([{ _id: "al1", tripWatchId: "w1", attempts: 1, deliveryStatus: "PENDING" }]));
    H.wFindById.mockReturnValue(leanOne(watch({ fallbackEmail: "t@x.com" })));
    H.sendTemplate.mockResolvedValue(false);
    H.sendMail.mockRejectedValue(new Error("smtp down"));

    await runRealCycle(new Date());

    expect(H.aUpdateOne).toHaveBeenCalledWith({ _id: "al1" }, { $set: expect.objectContaining({ deliveryStatus: "FAILED", attempts: 2 }) });
  });

  it("2d: cancelled booking → cancel watch, ZERO FlightAware calls", async () => {
    claimOnce(watch({ bookingId: "bk1" }));
    H.bFindById.mockReturnValue(leanSel({ status: "CANCELLED" }));

    await runRealCycle(new Date());

    expect(H.flightStatus).not.toHaveBeenCalled();
    expect(H.wUpdateOne).toHaveBeenCalledWith({ _id: "w1" }, { $set: expect.objectContaining({ status: "CANCELLED" }) });
  });
});
