// apps/backend/src/services/whatsappService.hybrid.test.ts
//
// Smoke coverage for the hybrid report fork in sendImageToRecipients():
// individuals over the Meta Cloud API as an image-header template, groups over
// whatsapp-web.js. Every Cloud API call is mocked — nothing leaves the process
// and no real send is attempted.
//
// WA_HOST is left unset throughout, so whatsappService.initialize() short-
// circuits and no Chromium/session work is ever attempted. The web.js client is
// injected directly when a test needs a live-looking one.

import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  uploadMedia: vi.fn(),
  sendTemplateWithImageHeader: vi.fn(),
}));

vi.mock("./whatsappCloud.service.js", () => ({
  uploadMedia: H.uploadMedia,
  sendTemplateWithImageHeader: H.sendTemplateWithImageHeader,
}));

// Every test passes an explicit roster, so the config model is never read.
// Stubbing it keeps mongoose out of the test entirely — without this,
// vi.resetModules() re-runs model() and throws OverwriteModelError.
vi.mock("../models/EodReportConfig.js", () => ({
  EodReportConfig: {
    findOne: () => ({ lean: async () => null }),
    findOneAndUpdate: async () => null,
  },
}));

const PNG = Buffer.from("fake-png-bytes");
const EOD_CAPTION =
  "📊 Plumtrips EOD · 05 Sep 2026\n12 bookings · ₹4,20,000 net sales · 8.1% margin";

/** Recipient row in the stored shape. */
function rec(over: Record<string, any> = {}) {
  return {
    type: "individual",
    number: "",
    groupId: "",
    name: "unnamed",
    active: true,
    ...over,
  } as any;
}

/** A mixed roster exercising every branch at once. */
const MIXED = [
  rec({ type: "individual", number: "919876543210", name: "Valid Indiv" }),
  rec({ type: "group", groupId: "120363012345678901@g.us", name: "Valid Group" }),
  rec({ type: "individual", number: "12", name: "Bad Indiv" }),
  rec({ type: "group", groupId: "not-a-group-id", name: "Bad Group" }),
  rec({ type: "individual", number: "919000000001", name: "Muted", active: false }),
];

/** Reload the service with a specific env so module-load constants re-evaluate. */
async function loadService(env: Record<string, string | undefined>) {
  vi.resetModules();
  delete process.env.WA_HOST; // never let a cron/worker path arm
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import("./whatsappService.js");
}

/** A stand-in for a connected whatsapp-web.js client. */
function fakeClient() {
  return {
    info: { wid: { _serialized: "919000000000@c.us" } },
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getNumberId: vi.fn(),
  };
}

const HYBRID_ON = {
  WA_REPORTS_HYBRID_ENABLED: "true",
  WA_REPORT_TEMPLATE: "plumtrips_report_ready",
  WA_REPORT_TEMPLATE_LANG: "en",
};

beforeEach(() => {
  H.uploadMedia.mockReset();
  H.sendTemplateWithImageHeader.mockReset();
  H.uploadMedia.mockResolvedValue("MEDIA_ID_1");
  H.sendTemplateWithImageHeader.mockResolvedValue({ sent: true });
});

describe("deriveReportVars", () => {
  it("derives report name + date from an EOD caption", async () => {
    const { deriveReportVars } = await loadService(HYBRID_ON);
    expect(deriveReportVars(EOD_CAPTION)).toEqual({
      reportName: "EOD",
      dateLabel: "05 Sep 2026",
    });
  });

  it("derives name + date/slot from a Sales Pulse caption", async () => {
    const { deriveReportVars } = await loadService(HYBRID_ON);
    expect(
      deriveReportVars("📊 Plumtrips Sales Pulse · 05 Sep 2026 (4 PM)\n3 active reps"),
    ).toEqual({ reportName: "Sales Pulse", dateLabel: "05 Sep 2026 (4 PM)" });
  });

  it("prefers explicit meta over the caption", async () => {
    const { deriveReportVars } = await loadService(HYBRID_ON);
    expect(
      deriveReportVars(EOD_CAPTION, { reportName: "Custom", dateLabel: "Yesterday" }),
    ).toEqual({ reportName: "Custom", dateLabel: "Yesterday" });
  });

  it("falls back to safe generics on an unparseable caption", async () => {
    const { deriveReportVars } = await loadService(HYBRID_ON);
    expect(deriveReportVars("")).toEqual({ reportName: "Report", dateLabel: "" });
  });
});

describe("sendImageToRecipients — hybrid fork", () => {
  it("routes individuals to the Cloud API and groups to web.js, tallying malformed rows", async () => {
    const { whatsappService } = await loadService(HYBRID_ON);
    const client = fakeClient();
    (whatsappService as any).client = client;

    const res = await whatsappService.sendImageToRecipients(PNG, EOD_CAPTION, MIXED);

    // 1 valid individual (Cloud API) + 1 valid group (web.js)
    expect(res.sent).toBe(2);
    // bad individual + bad group; the muted row is filtered out entirely
    expect(res.failed).toBe(2);

    // Individual leg → template, never the web client
    expect(H.sendTemplateWithImageHeader).toHaveBeenCalledTimes(1);
    expect(H.sendTemplateWithImageHeader).toHaveBeenCalledWith(
      "919876543210",
      "plumtrips_report_ready",
      "en",
      "MEDIA_ID_1",
      ["EOD", "05 Sep 2026"],
    );

    // Group leg → web client, addressed by the raw @g.us id
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage.mock.calls[0][0]).toBe("120363012345678901@g.us");

    // Errors name the offending rows and nothing else
    expect(res.errors).toHaveLength(2);
    expect(res.errors.join(" ")).toContain("Bad Indiv");
    expect(res.errors.join(" ")).toContain("Bad Group");
    // The muted recipient is never mentioned
    expect(res.errors.join(" ")).not.toContain("Muted");
  });

  it("uploads the media exactly once per run, no matter how many individuals", async () => {
    const { whatsappService } = await loadService(HYBRID_ON);
    (whatsappService as any).client = fakeClient();

    const many = [
      rec({ number: "919876543210", name: "A" }),
      rec({ number: "919876543211", name: "B" }),
      rec({ number: "919876543212", name: "C" }),
    ];
    const res = await whatsappService.sendImageToRecipients(PNG, EOD_CAPTION, many);

    expect(H.uploadMedia).toHaveBeenCalledTimes(1);
    expect(H.uploadMedia).toHaveBeenCalledWith(PNG, "image/png", "plumtrips-report.png");
    expect(H.sendTemplateWithImageHeader).toHaveBeenCalledTimes(3);
    // The same media id is reused for every recipient
    const ids = H.sendTemplateWithImageHeader.mock.calls.map((c: any[]) => c[3]);
    expect(new Set(ids)).toEqual(new Set(["MEDIA_ID_1"]));
    expect(res.sent).toBe(3);
  });

  // 15s budget: the real reconnect path awaits a 5s settle after initialize().
  it("a NULL web.js client fails ONLY the group leg — individuals still dispatch", async () => {
    const { whatsappService } = await loadService(HYBRID_ON);
    (whatsappService as any).client = null; // WA_HOST unset ⇒ initialize() no-ops

    const res = await whatsappService.sendImageToRecipients(PNG, EOD_CAPTION, [
      rec({ number: "919876543210", name: "Indiv" }),
      rec({ type: "group", groupId: "120363012345678901@g.us", name: "Group" }),
    ]);

    expect(H.sendTemplateWithImageHeader).toHaveBeenCalledTimes(1);
    expect(res.sent).toBe(1); // the individual got through
    expect(res.failed).toBe(1); // only the group failed
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain("Group");
    expect(res.errors[0]).toContain("not initialized");
  }, 15_000);

  it("a media-upload failure fails individuals only; groups still send", async () => {
    H.uploadMedia.mockRejectedValue(new Error("Graph 400: media too large"));
    const { whatsappService } = await loadService(HYBRID_ON);
    const client = fakeClient();
    (whatsappService as any).client = client;

    const res = await whatsappService.sendImageToRecipients(PNG, EOD_CAPTION, [
      rec({ number: "919876543210", name: "Indiv" }),
      rec({ type: "group", groupId: "120363012345678901@g.us", name: "Group" }),
    ]);

    expect(H.sendTemplateWithImageHeader).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledTimes(1); // group unaffected
    expect(res.sent).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.errors[0]).toContain("media too large");
  });

  it("records a per-recipient template failure without throwing", async () => {
    H.sendTemplateWithImageHeader
      .mockResolvedValueOnce({ sent: false, error: "Template not approved (code 132001)" })
      .mockResolvedValueOnce({ sent: true });

    const { whatsappService } = await loadService(HYBRID_ON);
    (whatsappService as any).client = fakeClient();

    const res = await whatsappService.sendImageToRecipients(PNG, EOD_CAPTION, [
      rec({ number: "919876543210", name: "First" }),
      rec({ number: "919876543211", name: "Second" }),
    ]);

    expect(res.sent).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.errors[0]).toContain("Template not approved");
  });

  it("skips the media upload entirely when no individual is addressable", async () => {
    const { whatsappService } = await loadService(HYBRID_ON);
    (whatsappService as any).client = fakeClient();

    const res = await whatsappService.sendImageToRecipients(PNG, EOD_CAPTION, [
      rec({ number: "12", name: "Bad" }),
    ]);

    expect(H.uploadMedia).not.toHaveBeenCalled();
    expect(res.sent).toBe(0);
    expect(res.failed).toBe(1);
  });
});

describe("sendImageToRecipients — legacy mode (flag off)", () => {
  it("sends everything over web.js and never touches the Cloud API", async () => {
    const { whatsappService } = await loadService({
      WA_REPORTS_HYBRID_ENABLED: undefined,
    });
    const client = fakeClient();
    (whatsappService as any).client = client;
    // resolveChatId() validates individuals through the web client
    client.getNumberId.mockResolvedValue({
      user: "919876543210",
      server: "c.us",
      _serialized: "919876543210@c.us",
    });

    const res = await whatsappService.sendImageToRecipients(PNG, EOD_CAPTION, [
      rec({ number: "919876543210", name: "Indiv" }),
      rec({ type: "group", groupId: "120363012345678901@g.us", name: "Group" }),
    ]);

    expect(H.uploadMedia).not.toHaveBeenCalled();
    expect(H.sendTemplateWithImageHeader).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(res.sent).toBe(2);
    expect(res.failed).toBe(0);
  });

  it("a null client fails the whole roster, exactly as before", async () => {
    const { whatsappService } = await loadService({
      WA_REPORTS_HYBRID_ENABLED: undefined,
    });
    (whatsappService as any).client = null;

    const res = await whatsappService.sendImageToRecipients(PNG, EOD_CAPTION, [
      rec({ number: "919876543210", name: "Indiv" }),
      rec({ type: "group", groupId: "120363012345678901@g.us", name: "Group" }),
    ]);

    expect(res.sent).toBe(0);
    expect(res.failed).toBe(2);
  }, 15_000);
});
