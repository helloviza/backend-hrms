// apps/backend/src/routes/cstep.reportReminder.test.ts
//
// #14 — the overdue travel-report reminder (services/cstepReportReminders.ts,
// jobs/cstep-report-reminder.ts) and the #12 Official → Travel Desk fallback
// in services/cstepNotifications.ts.
//
// Real: the sweep, notifyCstep, enqueueEmail + EmailOutbox, the cstep router
//   (for the #12 approval), models, in-memory Mongo REPLICA SET (approve runs
//   in a transaction) on a fresh database, cstep_qc_remind.
// Stubbed: the SMTP send (utils/mailer — nothing leaves the process), S3 +
//   PDF helpers, node-cron (records schedules), auth (x-test-user) and the
//   workspace resolver (x-test-ws).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_remind";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
process.env.DISABLE_EMAILS = "";
process.env.CSTEP_NOTIFICATIONS_ENABLED = "true";

vi.mock("../utils/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: vi.fn(async () => ({ key: "qc" })),
  getObjectBuffer: vi.fn(async () => Buffer.from("")),
}));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async () => "http://qc/presigned") }));
vi.mock("../utils/cstepEventRequestPdf.js", () => ({ uploadCstepEventRequestPdf: vi.fn(async () => ({})) }));
vi.mock("../utils/cstepPacketPdf.js", () => ({ uploadCstepPacketPdf: vi.fn(async () => ({})) }));
const scheduled = vi.hoisted(() => [] as any[]);
vi.mock("node-cron", () => ({ default: { schedule: vi.fn((...args: any[]) => scheduled.push(args)) } }));

// Each sweep walks every fixture; a cadence run is several sweeps.
vi.setConfig({ testTimeout: 60_000 });

const { default: cstepRouter } = await import("./cstep.js");
const { notifyCstep } = await import("../services/cstepNotifications.js");
const { runCstepReportReminders, reportReminderDue } = await import("../services/cstepReportReminders.js");
const { startCstepReportReminderCron, cstepReportReminderDisabled } = await import("../jobs/cstep-report-reminder.js");
const { encryptCstepSmtpPass } = await import("../services/cstepMailTransport.js");
const { default: CstepNotificationSettings } = await import("../models/cstep/CstepNotificationSettings.js");

const SENDER = { senderMailbox: "notify@cstep-qc.local", senderName: "CSTEP", smtpHost: "smtp.cstep-qc.local", smtpPort: 587 };
const DB = "cstep_qc_remind";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
const WS_GATED = oid(); // cstepEnabled, but no notification settings saved
const QC_PROJECT = oid();
const U = {
  traveller: oid(), traveller2: oid(), approver: oid(), official: oid(), admin: oid(),
  desk: oid(), deskRevoked: oid(), deskInactive: oid(),
};
const EMAIL: Record<keyof typeof U, string> = {
  traveller: "traveller@qc.local", traveller2: "traveller2@qc.local", approver: "approver@qc.local",
  official: "official@qc.local", admin: "admin@qc.local", desk: "desk@qc.local",
  deskRevoked: "desk-revoked@qc.local", deskInactive: "desk-inactive@qc.local",
};
const TP = { main: oid(), noOfficial: oid(), gated: oid() };

const app = express();
app.use(express.json());
app.use(
  "/api/cstep",
  (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    req.workspaceObjectId = new mongoose.Types.ObjectId(String(req.headers["x-test-ws"] || WS));
    next();
  },
  cstepRouter,
);
const who = (id: mongoose.Types.ObjectId, email: string, roles = ["REQUESTER"]) => ({
  _id: String(id), id: String(id), sub: String(id), email, roles, workspaceId: String(WS),
});
const post = (as: any, path: string, body: any = {}) =>
  request(app).post(`/api/cstep${path}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS)).send(body);
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};

/** 10:30 IST on an IST calendar day. */
const at = (day: string) => new Date(`${day}T10:30:00+05:30`);

/** Outbox rows for one request: [event, recipient], oldest first. */
async function mailsFor(id: mongoose.Types.ObjectId): Promise<Array<[string, string]>> {
  const rows = await col("emailoutboxes").find({ requestId: id }).sort({ _id: 1 }).toArray();
  return rows.map((r: any) => [r.event, (r.to || []).join(",")]);
}

const R: Record<string, mongoose.Types.ObjectId> = {};
function trip(key: string, extra: any) {
  R[key] = oid();
  return {
    _id: R[key], workspaceId: WS, travelerProfileId: TP.main, createdBy: U.traveller, formType: "TOUR_PROPOSAL",
    type: "DOMESTIC", purpose: `QC ${key}`, departureDate: "2026-11-01", stations: [{ from: "Bengaluru", to: "Delhi" }],
    projectId: QC_PROJECT, createdAt: new Date(), updatedAt: new Date(), ...extra,
  };
}

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri(DB);
  // Step 0 gate: a local server and an empty database, or nothing is seeded.
  const host = new URL(uri.replace(/^mongodb:\/\//, "http://")).hostname;
  if (host !== "127.0.0.1") throw new Error(`Step 0: refusing to seed — host is ${host}, not 127.0.0.1`);
  await mongoose.connect(uri, { autoIndex: false });
  if (mongoose.connection.db!.databaseName !== DB) throw new Error("Step 0: wrong database");
  if ((await mongoose.connection.db!.listCollections().toArray()).length) throw new Error(`Step 0: ${DB} is not empty`);
  await mongoose.connection.syncIndexes();

  await CstepNotificationSettings.create({
    workspaceId: WS, enabled: true, ...SENDER, smtpPassEnc: encryptCstepSmtpPass("qc-app-password", WS),
  });
  await col("cstepprojects").insertOne({ _id: QC_PROJECT, workspaceId: WS, projectCode: "PRJ-QC", projectName: "QC Project", tallyProjectCC: "100 QC 01", isActive: true } as any);
  await col("customerworkspaces").insertMany([
    { _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } },
    { _id: WS_GATED, customerId: String(oid()), companyName: "QC gated", config: { features: { cstepEnabled: true } } },
  ] as any[]);
  await col("users").insertMany(
    (Object.keys(U) as Array<keyof typeof U>).map((k) => ({
      _id: U[k], email: EMAIL[k], roles: ["REQUESTER"], workspaceId: WS, ...(k === "deskInactive" ? { status: "INACTIVE" } : {}),
    })) as any[],
  );
  const profile = (_id: mongoose.Types.ObjectId, code: string, extra: any) => ({
    _id, workspaceId: WS, travelerId: code, firstName: "Asha", lastName: code, isActive: true, ...extra,
  });
  await col("travellerprofiles").insertMany([
    profile(TP.main, "CSTEP-001", { email: EMAIL.traveller, claimedBy: U.traveller, tourApproverId: U.approver, officialUserId: U.official }),
    profile(TP.noOfficial, "CSTEP-002", { email: EMAIL.traveller2, claimedBy: U.traveller2, tourApproverId: U.approver }),
    { ...profile(TP.gated, "GATED-001", { email: "gated@qc.local", tourApproverId: U.approver }), workspaceId: WS_GATED },
  ] as any[]);
  const grant = (userId: mongoose.Types.ObjectId, extra: any = {}) => ({
    workspaceId: WS, userId, grantedBy: U.admin, grantedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), ...extra,
  });
  await col("csteptraveldeskgrants").insertMany([
    grant(U.desk),
    grant(U.deskRevoked, { revokedAt: new Date(), revokedBy: U.admin }),
    grant(U.deskInactive),
  ] as any[]);

  // The sweep's main fixture — "today" is 2026-11-20 (IST).
  await mongoose.connection.db!.collection("csteptravelrequests").insertMany([
    trip("day7", { status: "ARRANGED", returnDate: "2026-11-13" }),
    trip("day6", { status: "ARRANGED", returnDate: "2026-11-14" }),
    trip("graceEdge", { status: "REPORT_PENDING", returnDate: "2026-11-10" }), // due 11-17, 3 days late
    trip("backlog", { status: "REPORT_PENDING", returnDate: "2026-11-09" }), // due 11-16, 4 days late
    trip("submitted", { status: "REPORT_UNDER_APPROVAL", returnDate: "2026-11-13" }),
    trip("cancelled", { status: "CANCELLED", returnDate: "2026-11-13" }),
    trip("claim", { status: "ARRANGED", returnDate: "2026-11-13", formType: "EXPENSE_CLAIM" }),
    trip("onBehalf", { status: "ARRANGED", returnDate: "2026-11-13", createdBy: U.admin }),
    trip("event", { status: "ARRANGED", returnDate: "2026-11-13", formType: "EVENT_REQUEST", eventLocation: "Pune" }),
    // An old trip, capped on its first series, sent back on 11-13 (IST): a new series.
    trip("sentBack", {
      status: "REPORT_PENDING", returnDate: "2026-10-01",
      reportReminder: { round: "2026-10-01", count: 3, lastSentAt: new Date("2026-10-22T05:00:00Z") },
    }),
    { ...trip("gated", { status: "ARRANGED", returnDate: "2026-11-13", travelerProfileId: TP.gated }), workspaceId: WS_GATED },
  ] as any[]);
  await col("cstepapprovals").insertMany([
    { workspaceId: WS, entityType: "REQUEST", entityId: R.sentBack, stage: "APPROVER", actor: U.approver, action: "RETURN_REPORT", at: "2026-10-20T06:00:00.000Z" },
    // 11-12 22:00 UTC is 11-13 03:30 IST — the IST day counts.
    { workspaceId: WS, entityType: "REQUEST", entityId: R.sentBack, stage: "APPROVER", actor: U.approver, action: "RETURN_REPORT", at: "2026-11-12T22:00:00.000Z" },
  ] as any[]);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("the clock (reportReminderDue)", () => {
  it("is due exactly 7 days after the return date, not on day 6", () => {
    expect(reportReminderDue({ returnDate: "2026-11-13" }, "2026-11-19")).toBeNull();
    expect(reportReminderDue({ returnDate: "2026-11-13" }, "2026-11-20")).toEqual({ anchor: "2026-11-13", sentBack: false, number: 1, dueDay: "2026-11-20" });
  });

  it("crosses a month and a year boundary", () => {
    expect(reportReminderDue({ returnDate: "2026-12-28" }, "2027-01-04")).toMatchObject({ number: 1, dueDay: "2027-01-04" });
  });

  it("a first reminder is sent up to 3 days late, never later (backlog)", () => {
    expect(reportReminderDue({ returnDate: "2026-11-10" }, "2026-11-20")).toMatchObject({ number: 1 });
    expect(reportReminderDue({ returnDate: "2026-11-09" }, "2026-11-20")).toBeNull();
  });

  it("a started series carries on without the backlog limit, weekly, and stops at 3", () => {
    const reminder = (count: number) => ({ round: "2026-11-01", count });
    expect(reportReminderDue({ returnDate: "2026-11-01", reminder: reminder(1) }, "2026-11-14")).toBeNull();
    expect(reportReminderDue({ returnDate: "2026-11-01", reminder: reminder(1) }, "2026-11-15")).toMatchObject({ number: 2, dueDay: "2026-11-15" });
    expect(reportReminderDue({ returnDate: "2026-11-01", reminder: reminder(1) }, "2026-12-30")).toMatchObject({ number: 2 });
    expect(reportReminderDue({ returnDate: "2026-11-01", reminder: reminder(2) }, "2026-11-22")).toMatchObject({ number: 3 });
    expect(reportReminderDue({ returnDate: "2026-11-01", reminder: reminder(3) }, "2026-11-29")).toBeNull();
  });

  it("a later send-back re-anchors (a fresh series of 3); an earlier one does not", () => {
    const capped = { round: "2026-10-01", count: 3 };
    expect(reportReminderDue({ returnDate: "2026-10-01", lastSendBackDay: "2026-11-13", reminder: capped }, "2026-11-20"))
      .toEqual({ anchor: "2026-11-13", sentBack: true, number: 1, dueDay: "2026-11-20" });
    expect(reportReminderDue({ returnDate: "2026-11-13", lastSendBackDay: "2026-11-05" }, "2026-11-20")).toMatchObject({ anchor: "2026-11-13", sentBack: false });
  });

  it("no return date, no reminder", () => {
    expect(reportReminderDue({ returnDate: undefined }, "2026-11-20")).toBeNull();
  });
});

describe("the sweep — 2026-11-20", () => {
  let sum: Awaited<ReturnType<typeof runCstepReportReminders>>;

  it("selects exactly the owing trips that are due", async () => {
    sum = await runCstepReportReminders(at("2026-11-20"));
    expect(sum.ran).toBe(true);
    expect(sum.today).toBe("2026-11-20");
    const ids = sum.sent.map((s) => s.requestId).sort();
    expect(ids).toEqual([R.day7, R.graceEdge, R.onBehalf, R.event, R.sentBack].map(String).sort());
    expect(sum.sent.every((s) => s.status === "QUEUED" && s.number === 1)).toBe(true);
    for (const k of ["day6", "backlog", "submitted", "cancelled", "claim", "gated"]) expect(await mailsFor(R[k])).toEqual([]);
  });

  it("addresses the creator — the traveller here, once (same email)", async () => {
    expect(await mailsFor(R.day7)).toEqual([["cstep_report_reminder", EMAIL.traveller]]);
  });

  it("on-behalf: the Admin who filed it (the only one who can file the report) AND the traveller", async () => {
    expect(await mailsFor(R.onBehalf)).toEqual([
      ["cstep_report_reminder", EMAIL.admin],
      ["cstep_report_reminder", EMAIL.traveller],
    ]);
  });

  it("a sent-back report starts a new series anchored on the send-back's IST day", async () => {
    const doc = await col("csteptravelrequests").findOne({ _id: R.sentBack });
    expect(doc!.reportReminder).toMatchObject({ round: "2026-11-13", count: 1 });
    const row = await col("emailoutboxes").findOne({ requestId: R.sentBack });
    expect(row!.text).toMatch(/sent back for a fix on 13 Nov 2026/);
  });

  it("the copy names the trip's / event's end", async () => {
    expect((await col("emailoutboxes").findOne({ requestId: R.day7 }))!.subject).toBe("[CSTEP] Reminder — travel report due — Asha CSTEP-001");
    expect((await col("emailoutboxes").findOne({ requestId: R.day7 }))!.text).toMatch(/The trip ended on 13 Nov 2026/);
    expect((await col("emailoutboxes").findOne({ requestId: R.event }))!.text).toMatch(/The event ended on 13 Nov 2026/);
  });

  it("a workspace without its own notification settings is skipped and nothing is claimed there", async () => {
    expect(sum.skippedWorkspaces.map((w) => w.workspaceId)).toEqual([String(WS_GATED)]);
    expect((await col("csteptravelrequests").findOne({ _id: R.gated }))!.reportReminder).toBeUndefined();
  });

  it("a second run the same day sends nothing", async () => {
    const again = await runCstepReportReminders(at("2026-11-20"));
    expect(again.sent).toEqual([]);
    expect(await mailsFor(R.day7)).toHaveLength(1);
  });
});

describe("cadence — weekly, max 3, Manager from the 2nd", () => {
  it("1st to the traveller; 2nd and 3rd also to the Manager; nothing after", async () => {
    const id = oid();
    await col("csteptravelrequests").insertOne({ ...trip("cadence", { status: "ARRANGED", returnDate: "2027-01-01" }), _id: id } as any);
    R.cadence = id;
    const only = async (day: string) => (await runCstepReportReminders(at(day))).sent.filter((s) => s.requestId === String(id));

    expect(await only("2027-01-07")).toEqual([]);
    expect((await only("2027-01-08")).map((s) => [s.number, s.recipients])).toEqual([[1, [EMAIL.traveller]]]);
    expect(await only("2027-01-09")).toEqual([]);
    expect((await only("2027-01-15")).map((s) => [s.number, s.recipients])).toEqual([[2, [EMAIL.traveller, EMAIL.approver]]]);
    expect((await only("2027-01-22")).map((s) => [s.number, s.recipients])).toEqual([[3, [EMAIL.traveller, EMAIL.approver]]]);
    expect(await only("2027-01-29")).toEqual([]);
    expect(await only("2027-03-01")).toEqual([]);

    const rows = await col("emailoutboxes").find({ requestId: id }).sort({ _id: 1 }).toArray();
    expect(rows.map((r: any) => r.subject.replace(/ — Asha.*/, ""))).toEqual([
      "[CSTEP] Reminder — travel report due",
      "[CSTEP] Second reminder — travel report overdue",
      "[CSTEP] Second reminder — travel report overdue",
      "[CSTEP] Final reminder — travel report overdue",
      "[CSTEP] Final reminder — travel report overdue",
    ]);
    // Each reminder is its own ledger row keyed on a fresh id.
    const ledger = await col("cstepnotifications").find({ requestId: id }).toArray();
    expect(ledger).toHaveLength(5);
    expect(new Set(ledger.map((n: any) => String(n.logEntryId))).size).toBe(3);
    expect((await col("csteptravelrequests").findOne({ _id: id }))!.reportReminder).toMatchObject({ round: "2027-01-01", count: 3 });
  });

  it("submitting the report stops the series", async () => {
    const id = oid();
    await col("csteptravelrequests").insertOne({ ...trip("stop", { status: "REPORT_PENDING", returnDate: "2027-02-01" }), _id: id } as any);
    const only = async (day: string) => (await runCstepReportReminders(at(day))).sent.filter((s) => s.requestId === String(id));
    expect(await only("2027-02-08")).toHaveLength(1);
    await col("csteptravelrequests").updateOne({ _id: id }, { $set: { status: "REPORT_UNDER_APPROVAL" } });
    expect(await only("2027-02-15")).toEqual([]);
  });
});

describe("two instances sweeping at once", () => {
  it("each reminder is claimed by exactly one", async () => {
    const id = oid();
    await col("csteptravelrequests").insertOne({ ...trip("race", { status: "ARRANGED", returnDate: "2027-03-01" }), _id: id } as any);
    const [a, b] = await Promise.all([runCstepReportReminders(at("2027-03-08")), runCstepReportReminders(at("2027-03-08"))]);
    const mine = [...a.sent, ...b.sent].filter((s) => s.requestId === String(id));
    expect(mine).toHaveLength(1);
    expect(await mailsFor(id)).toEqual([["cstep_report_reminder", EMAIL.traveller]]);
  });
});

describe("gating", () => {
  it("CSTEP_NOTIFICATIONS_ENABLED off: nothing selected, claimed or queued", async () => {
    const id = oid();
    await col("csteptravelrequests").insertOne({ ...trip("dormant", { status: "ARRANGED", returnDate: "2027-04-01" }), _id: id } as any);
    delete process.env.CSTEP_NOTIFICATIONS_ENABLED;
    try {
      const r = await runCstepReportReminders(at("2027-04-08"));
      expect(r).toMatchObject({ ran: false, reason: "CSTEP_NOTIFICATIONS_ENABLED is off", sent: [] });
    } finally {
      process.env.CSTEP_NOTIFICATIONS_ENABLED = "true";
    }
    expect((await col("csteptravelrequests").findOne({ _id: id }))!.reportReminder).toBeUndefined();
    expect(await mailsFor(id)).toEqual([]);
  });

  it("CSTEP_REPORT_REMINDER_DISABLED=true: the job is never scheduled", () => {
    scheduled.length = 0;
    process.env.CSTEP_REPORT_REMINDER_DISABLED = "true";
    try {
      expect(cstepReportReminderDisabled()).toBe(true);
      startCstepReportReminderCron();
      expect(scheduled).toEqual([]);
    } finally {
      delete process.env.CSTEP_REPORT_REMINDER_DISABLED;
    }
    startCstepReportReminderCron();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0][0]).toBe("0 10 * * *");
    expect(scheduled[0][2]).toEqual({ timezone: "Asia/Kolkata" });
  });
});

describe("#12 — no Official mapped: the Travel Desk grant holders", () => {
  const TOUR = {
    type: "DOMESTIC", purpose: "QC #12", departureDate: "2026-12-02", returnDate: "2026-12-04",
    stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }], modesRequested: ["AIR"],
    transportRequired: false, accommodationRequired: false, sponsored: false, projectId: String(QC_PROJECT),
  };
  const approver = who(U.approver, EMAIL.approver, ["APPROVER"]);

  it("APPROVED (create submits directly) reaches the active grant holder (not the revoked or inactive one)", async () => {
    const t2 = who(U.traveller2, EMAIL.traveller2);
    const id = String(ok(await post(t2, "/requests", TOUR)).body.request._id);
    ok(await post(approver, `/requests/${id}/approve`));
    const oId = new mongoose.Types.ObjectId(id);
    expect((await mailsFor(oId)).filter(([e]) => e === "cstep_approved")).toEqual([["cstep_approved", EMAIL.desk]]);
  });

  it("with an Official mapped, only the Official — the desk is not double-mailed", async () => {
    const t1 = who(U.traveller, EMAIL.traveller);
    const id = String(ok(await post(t1, "/requests", TOUR)).body.request._id);
    ok(await post(approver, `/requests/${id}/approve`));
    expect((await mailsFor(new mongoose.Types.ObjectId(id))).filter(([e]) => e === "cstep_approved")).toEqual([["cstep_approved", EMAIL.official]]);
  });

  it("REPORT_APPROVED / RETURN_TO_OFFICIAL / CHANGE_RAISED fall back the same way", async () => {
    const doc = { _id: oid(), workspaceId: WS, travelerProfileId: TP.noOfficial, createdBy: U.traveller2, formType: "TOUR_PROPOSAL", purpose: "x" };
    for (const event of ["REPORT_APPROVED", "RETURN_TO_OFFICIAL", "CHANGE_RAISED"] as const) {
      const r = await notifyCstep(event, doc, {
        logEntryId: oid(),
        ...(event === "CHANGE_RAISED" ? { change: { kind: "CANCEL" as const, serviceLabel: "Flight", details: "x" } } : {}),
      });
      expect(r).toMatchObject({ status: "QUEUED", recipients: [EMAIL.desk] });
    }
  });

  it("no Official and no active grant holder: skipped, as before", async () => {
    await col("csteptraveldeskgrants").updateOne({ userId: U.desk }, { $set: { revokedAt: new Date() } });
    try {
      const doc = { _id: oid(), workspaceId: WS, travelerProfileId: TP.noOfficial, createdBy: U.traveller2, formType: "TOUR_PROPOSAL" };
      expect(await notifyCstep("APPROVED", doc, { logEntryId: oid() })).toMatchObject({ status: "SKIPPED", reason: "no official email mapped" });
    } finally {
      await col("csteptraveldeskgrants").updateOne({ userId: U.desk }, { $unset: { revokedAt: "" } });
    }
  });
});
