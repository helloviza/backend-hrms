import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  sendTemplateMock: vi.fn(),
  sendTextResultMock: vi.fn(),
  sendMailMock: vi.fn(),
  emitMetricMock: vi.fn(),
}));
vi.mock("./whatsappCloud.service.js", () => ({
  sendTemplateMessage: H.sendTemplateMock,
  sendTextMessageResult: H.sendTextResultMock,
}));
vi.mock("../utils/mailer.js", () => ({ sendMail: H.sendMailMock }));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: H.emitMetricMock }));

import { renderAlertMessage, deliverTripAlert, MAX_ATTEMPTS } from "./tripNotifier.js";

const waWatch = (over: any = {}) => ({
  workspaceId: "ws1", flightNo: "6E-204", origin: "DEL", destination: "BOM",
  departDate: new Date("2026-08-12T10:00:00Z"), notifyChannel: "WHATSAPP",
  notifyTarget: "+919876543210", fallbackEmail: null, ...over,
});
const alert = (over: any = {}) => ({ detail: "Departure delayed 45 min", attempts: 0, ...over });

beforeEach(() => {
  Object.values(H).forEach((m: any) => m.mockReset());
  H.sendTextResultMock.mockResolvedValue(true);
  H.sendTemplateMock.mockResolvedValue(true);
  H.sendMailMock.mockResolvedValue(undefined);
  delete process.env.WA_DISRUPTION_TEMPLATE;
});

describe("renderAlertMessage", () => {
  it("renders a short traveler message", () => {
    const msg = renderAlertMessage(alert(), waWatch());
    expect(msg).toContain("6E-204");
    expect(msg).toContain("DEL→BOM");
    expect(msg).toContain("delayed 45 min");
    expect(msg).toContain("Reply HELP");
  });
});

describe("deliverTripAlert", () => {
  it("WhatsApp free-form when no template env → SENT via WHATSAPP", async () => {
    const r = await deliverTripAlert(alert(), waWatch());
    expect(H.sendTextResultMock).toHaveBeenCalledTimes(1);
    expect(H.sendTemplateMock).not.toHaveBeenCalled();
    expect(r).toMatchObject({ delivered: true, channelUsed: "WHATSAPP", deliveryStatus: "SENT" });
  });

  it("uses the Meta template when WA_DISRUPTION_TEMPLATE is set", async () => {
    process.env.WA_DISRUPTION_TEMPLATE = "flight_disruption";
    await deliverTripAlert(alert(), waWatch());
    expect(H.sendTemplateMock).toHaveBeenCalledWith(
      "919876543210", "flight_disruption", ["6E-204", "DEL→BOM", "Departure delayed 45 min", ""],
    );
    expect(H.sendTextResultMock).not.toHaveBeenCalled();
  });

  it("WhatsApp fails + fallbackEmail present → falls back to EMAIL, channelUsed EMAIL", async () => {
    H.sendTextResultMock.mockResolvedValue(false);
    const r = await deliverTripAlert(alert(), waWatch({ fallbackEmail: "t@x.com" }));
    expect(H.sendMailMock).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ delivered: true, channelUsed: "EMAIL" });
  });

  it("EMAIL channel routes straight to the mailer", async () => {
    const r = await deliverTripAlert(alert(), waWatch({ notifyChannel: "EMAIL", notifyTarget: "t@x.com" }));
    expect(H.sendMailMock).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ delivered: true, channelUsed: "EMAIL" });
  });

  it("retry-then-fail: 1st failure → PENDING, 2nd failure → FAILED, metric emitted", async () => {
    H.sendTextResultMock.mockResolvedValue(false); // whatsapp fails, no fallback email
    const first = await deliverTripAlert(alert({ attempts: 0 }), waWatch());
    expect(first).toMatchObject({ delivered: false, deliveryStatus: "PENDING", attempts: 1 });

    const second = await deliverTripAlert(alert({ attempts: 1 }), waWatch());
    expect(second).toMatchObject({ delivered: false, deliveryStatus: "FAILED", attempts: MAX_ATTEMPTS });

    const failedMetrics = H.emitMetricMock.mock.calls.map((c) => c[0]?.type).filter((t) => t === "pluto.notify.failed");
    expect(failedMetrics.length).toBe(2);
  });
});
