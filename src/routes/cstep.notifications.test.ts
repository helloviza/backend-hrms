// apps/backend/src/routes/cstep.notifications.test.ts
//
// CSTEP notification emails (services/cstepNotifications.ts) driven through
// the real CSTEP router: every transition in the event set lands exactly one
// outbox row for exactly the right recipient; a RETURN → RESUBMIT notifies
// the approver a second time (the dedupe key is the log entry, not the event);
// the four open-and-start routes (start-review, start-arranging, report/start,
// settlement/start) send nothing; an unmapped recipient, a repeat call and a
// non-CSTEP workspace send nothing.
//
// Real: cstep router, notifyCstep, enqueueEmail + EmailOutbox, renderLayout,
//   models, in-memory Mongo REPLICA SET (approve runs in a transaction) on a
//   fresh database, cstep_qc_notif.
// Stubbed: the SMTP send (utils/mailer — records every call, nothing leaves
//   the process), S3 + PDF helpers, auth (x-test-user) and the workspace
//   resolver (x-test-ws), as requireWorkspace sets them.
//
// Set CSTEP_QC_RENDER_OUT=<file.html> to write one rendered email to disk.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
// config/env.ts requires these at import; none of them is ever used here.
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_notif";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
process.env.DISABLE_EMAILS = "";
// The module ships dormant; every case below switches it on except the
// "flag off" case, which unsets it for its own run.
process.env.CSTEP_NOTIFICATIONS_ENABLED = "true";

const sent = vi.hoisted(() => [] as any[]);
vi.mock("../utils/mailer.js", () => ({
  sendMail: vi.fn(async (args: any) => {
    sent.push(args);
    return { ok: true };
  }),
}));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: vi.fn(async () => ({ key: "qc" })),
  getObjectBuffer: vi.fn(async () => Buffer.from("")),
}));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async () => "http://qc/presigned") }));
vi.mock("../utils/cstepEventRequestPdf.js", () => ({ uploadCstepEventRequestPdf: vi.fn(async () => ({})) }));
vi.mock("../utils/cstepPacketPdf.js", () => ({ uploadCstepPacketPdf: vi.fn(async () => ({})) }));

const { default: cstepRouter } = await import("./cstep.js");
const { notifyCstep, renderCstepEmail } = await import("../services/cstepNotifications.js");
const { CSTEP_NOTIFICATION_FROM } = await import("../config/cstepNotification.js");

const DB = "cstep_qc_notif";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
// Project Master — every request needs a project picked from the master.
// One QC project, added to a create body that names none (QC_PROJECT seeded
// in beforeAll).
const QC_PROJECT = oid();
const withProject = (path: string, body: any) =>
  path === "/requests" && body && body.projectId === undefined ? { ...body, projectId: String(QC_PROJECT) } : body;
const WS_OFF = oid();
const U = { traveller: oid(), approver: oid(), official: oid(), finance: oid(), admin: oid(), creator: oid() };
const EMAIL = {
  traveller: "traveller@qc.local",
  approver: "approver@qc.local",
  official: "official@qc.local",
  finance: "finance@qc.local",
  admin: "admin@qc.local",
  creator: "creator@qc.local",
};
const TP = { main: oid(), emailOnly: oid(), bare: oid(), noFinance: oid(), off: oid() };

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
const ACT = {
  traveller: who(U.traveller, EMAIL.traveller),
  approver: who(U.approver, EMAIL.approver, ["APPROVER"]),
  official: who(U.official, EMAIL.official),
  finance: who(U.finance, EMAIL.finance),
};
const post = (as: any, path: string, body: any = {}) =>
  request(app).post(`/api/cstep${path}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS)).send(withProject(path, body));
const patch = (as: any, path: string, body: any = {}) =>
  request(app).patch(`/api/cstep${path}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS)).send(body);

const TOUR = {
  type: "DOMESTIC",
  purpose: "QC workshop",
  departureDate: "2026-11-02",
  returnDate: "2026-11-04",
  stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }],
  modesRequested: ["AIR"],
  transportRequired: false,
  accommodationRequired: false,
  sponsored: false,
};

/* Outbox rows written since the last call: [event, recipient]. */
let seen = 0;
async function delta(): Promise<Array<[string, string]>> {
  const rows = await col("emailoutboxes").find({}).sort({ _id: 1 }).toArray();
  const fresh = rows.slice(seen);
  seen = rows.length;
  return fresh.map((r: any) => [r.event, (r.to || []).join(",")]);
}
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri(DB);

  // Step 0 gate: a local server and an empty database, or nothing is seeded.
  const host = new URL(uri.replace(/^mongodb:\/\//, "http://")).hostname;
  if (host !== "127.0.0.1") throw new Error(`Step 0: refusing to seed — host is ${host}, not 127.0.0.1`);
  // autoIndex off so connecting creates nothing before the emptiness check.
  await mongoose.connect(uri, { autoIndex: false });
  if (mongoose.connection.db!.databaseName !== DB) throw new Error("Step 0: wrong database");
  const existing = await mongoose.connection.db!.listCollections().toArray();
  if (existing.length) throw new Error(`Step 0: refusing to seed — ${DB} is not empty (${existing.length} collections)`);

  await mongoose.connection.syncIndexes();
  await col("cstepprojects").insertOne({ _id: QC_PROJECT, workspaceId: WS, projectCode: "PRJ-QC", projectName: "QC Project", tallyProjectCC: "100 QC 01", isActive: true } as any);

  await col("customerworkspaces").insertMany([
    { _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } },
    { _id: WS_OFF, customerId: String(oid()), companyName: "QC other tenant", config: { features: { cstepEnabled: false } } },
  ] as any[]);
  await col("users").insertMany(
    (Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: EMAIL[k], roles: ["REQUESTER"], workspaceId: WS })) as any[],
  );
  const profile = (_id: mongoose.Types.ObjectId, code: string, extra: any) => ({
    _id, workspaceId: WS, travelerId: code, firstName: "Asha", lastName: code, isActive: true, ...extra,
  });
  await col("travellerprofiles").insertMany([
    profile(TP.main, "CSTEP-001", {
      email: EMAIL.traveller, claimedBy: U.traveller,
      tourApproverId: U.approver, officialUserId: U.official, financeUserId: U.finance,
    }),
    profile(TP.emailOnly, "CSTEP-002", { email: "profile-only@qc.local", tourApproverId: U.approver }),
    profile(TP.bare, "CSTEP-003", { tourApproverId: U.approver }),
    profile(TP.noFinance, "CSTEP-004", { email: "nofinance@qc.local", officialUserId: U.official }),
    { ...profile(TP.off, "OFF-001", { email: "off@qc.local", tourApproverId: U.approver }), workspaceId: WS_OFF },
  ] as any[]);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("CSTEP notifications through the router — Tour Proposal, full pipeline", () => {
  let id = "";

  it("a draft sends nothing", async () => {
    const r = ok(await post(ACT.traveller, "/requests", { ...TOUR, saveDraft: true }));
    id = String(r.body.request._id);
    expect(r.body.request.status).toBe("DRAFT");
    expect(await delta()).toEqual([]);
  });

  it("SUBMITTED → the Tour Approver", async () => {
    ok(await post(ACT.traveller, `/requests/${id}/submit`));
    expect(await delta()).toEqual([["cstep_submitted", EMAIL.approver]]);
  });

  it("start-review (auto-fire on open) sends nothing", async () => {
    ok(await post(ACT.approver, `/requests/${id}/start-review`));
    expect(await delta()).toEqual([]);
  });

  it("RETURN → the owner (the traveller)", async () => {
    ok(await post(ACT.approver, `/requests/${id}/return`, { reason: "Add the agenda" }));
    expect(await delta()).toEqual([["cstep_return", EMAIL.traveller]]);
  });

  it("RESUBMIT → a SECOND SUBMITTED to the approver (dedupe does not block it)", async () => {
    ok(await post(ACT.traveller, `/requests/${id}/submit`));
    expect(await delta()).toEqual([["cstep_submitted", EMAIL.approver]]);
    const submitted = await col("cstepnotifications").find({ requestId: new mongoose.Types.ObjectId(id), event: "SUBMITTED" }).toArray();
    expect(submitted).toHaveLength(2);
    expect(String(submitted[0].logEntryId)).not.toBe(String(submitted[1].logEntryId));
  });

  it("start-review again sends nothing", async () => {
    ok(await post(ACT.approver, `/requests/${id}/start-review`));
    expect(await delta()).toEqual([]);
  });

  it("APPROVED → the Official (after the transaction commits)", async () => {
    const r = ok(await post(ACT.approver, `/requests/${id}/approve`));
    expect(r.body.request.status).toBe("APPROVED");
    expect(await delta()).toEqual([["cstep_approved", EMAIL.official]]);
    const entry = await col("cstepapprovals").findOne({ entityId: new mongoose.Types.ObjectId(id), action: "APPROVE" });
    const n = await col("cstepnotifications").findOne({ event: "APPROVED" });
    expect(String(n!.logEntryId)).toBe(String(entry!._id));
  });

  it("start-arranging (auto-fire on open) sends nothing", async () => {
    ok(await post(ACT.official, `/requests/${id}/start-arranging`));
    ok(await post(ACT.official, `/requests/${id}/start-arranging`));
    expect(await delta()).toEqual([]);
  });

  it("ARRANGED → the traveller", async () => {
    ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
    expect(await delta()).toEqual([["cstep_arranged", EMAIL.traveller]]);
  });

  it("report/start (auto-fire on open) sends nothing", async () => {
    ok(await post(ACT.traveller, `/requests/${id}/report/start`));
    ok(await post(ACT.traveller, `/requests/${id}/report/start`));
    expect(await delta()).toEqual([]);
  });

  it("REPORT_SUBMITTED → the Official", async () => {
    ok(await post(ACT.traveller, `/requests/${id}/report/submit`));
    expect(await delta()).toEqual([["cstep_report_submitted", EMAIL.official]]);
  });

  it("settlement/start (auto-fire on open) sends nothing", async () => {
    ok(await post(ACT.official, `/requests/${id}/settlement/start`));
    ok(await post(ACT.official, `/requests/${id}/settlement/start`));
    expect(await delta()).toEqual([]);
  });

  it("RETURN_REPORT → the traveller", async () => {
    ok(await post(ACT.official, `/requests/${id}/report/return`, { reason: "Boarding pass missing" }));
    expect(await delta()).toEqual([["cstep_return_report", EMAIL.traveller]]);
  });

  it("report/start on an already-pending report sends nothing; resubmitting the report → the Official again", async () => {
    ok(await post(ACT.traveller, `/requests/${id}/report/start`));
    expect(await delta()).toEqual([]);
    ok(await post(ACT.traveller, `/requests/${id}/report/submit`));
    expect(await delta()).toEqual([["cstep_report_submitted", EMAIL.official]]);
  });

  it("settlement/start + a per-diem edit send nothing", async () => {
    ok(await post(ACT.official, `/requests/${id}/settlement/start`));
    ok(await patch(ACT.official, `/requests/${id}/settlement/perdiem`, { rate: 1500 }));
    expect(await delta()).toEqual([]);
  });

  it("TRANSFERRED_TO_FINANCE → the Finance user", async () => {
    const r = ok(await post(ACT.official, `/requests/${id}/settlement/finalize`, { force: true }));
    expect(r.body.request.status).toBe("TRANSFERRED_TO_FINANCE");
    expect(await delta()).toEqual([["cstep_transferred_to_finance", EMAIL.finance]]);
  });

  it("RETURN_TO_OFFICIAL → the Official (not the traveller)", async () => {
    ok(await post(ACT.finance, `/requests/${id}/finance/return`, { reason: "Per diem rate looks high" }));
    expect(await delta()).toEqual([["cstep_return_to_official", EMAIL.official]]);
  });

  it("re-finalizing → Finance again (a new log entry, not a duplicate)", async () => {
    ok(await post(ACT.official, `/requests/${id}/settlement/finalize`, { force: true }));
    expect(await delta()).toEqual([["cstep_transferred_to_finance", EMAIL.finance]]);
  });

  it("REIMBURSED → the traveller", async () => {
    const r = ok(await post(ACT.finance, `/requests/${id}/finance/settle`, { reference: "UTR-QC-1" }));
    expect(r.body.request.status).toBe("REIMBURSED");
    expect(await delta()).toEqual([["cstep_reimbursed", EMAIL.traveller]]);
  });
});

describe("CSTEP notifications through the router — reject and nothing-owed paths", () => {
  it("created straight as SUBMITTED → approver; REJECTED → traveller", async () => {
    const r = ok(await post(ACT.traveller, "/requests", TOUR));
    const id = String(r.body.request._id);
    expect(await delta()).toEqual([["cstep_submitted", EMAIL.approver]]);
    ok(await post(ACT.approver, `/requests/${id}/reject`, { reason: "Not in budget" }));
    expect(await delta()).toEqual([["cstep_rejected", EMAIL.traveller]]);
  });

  it("finalize with nothing owed → SETTLED to the traveller, nothing to Finance", async () => {
    const r = ok(await post(ACT.traveller, "/requests", { ...TOUR, purpose: "QC zero claim" }));
    const id = String(r.body.request._id);
    ok(await post(ACT.approver, `/requests/${id}/approve`));
    ok(await post(ACT.official, `/requests/${id}/start-arranging`));
    ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
    ok(await post(ACT.traveller, `/requests/${id}/report/start`));
    ok(await post(ACT.traveller, `/requests/${id}/report/submit`));
    ok(await post(ACT.official, `/requests/${id}/settlement/start`));
    await delta();
    const f = ok(await post(ACT.official, `/requests/${id}/settlement/finalize`, { force: true }));
    expect(f.body.request.status).toBe("SETTLED");
    expect(await delta()).toEqual([["cstep_settled", EMAIL.traveller]]);
  });
});

describe("notifyCstep — recipients, skips and the dedupe guard", () => {
  const req = (travelerProfileId: mongoose.Types.ObjectId, extra: any = {}) => ({
    _id: oid(), workspaceId: WS, travelerProfileId, createdBy: U.creator, formType: "TOUR_PROPOSAL",
    purpose: "QC direct", departureDate: "2026-11-02", returnDate: "2026-11-04", ...extra,
  });

  it("owner falls back to TravellerProfile.email when no login has claimed the profile", async () => {
    const r = await notifyCstep("REJECTED", req(TP.emailOnly), { logEntryId: oid(), reason: "x" });
    expect(r).toMatchObject({ status: "QUEUED", recipient: "profile-only@qc.local" });
    await delta();
  });

  it("owner falls back to the request creator when the profile has neither a login nor an email", async () => {
    const r = await notifyCstep("RETURN", req(TP.bare), { logEntryId: oid(), reason: "x" });
    expect(r).toMatchObject({ status: "QUEUED", recipient: EMAIL.creator });
    await delta();
  });

  it("an unmapped recipient is skipped — no row, no fallback to anyone else", async () => {
    const r = await notifyCstep("TRANSFERRED_TO_FINANCE", req(TP.noFinance), { logEntryId: oid(), amountInr: 10 });
    expect(r).toMatchObject({ status: "SKIPPED" });
    expect((r as any).reason).toMatch(/no finance email mapped/);
    expect(await delta()).toEqual([]);
  });

  it("the same log entry never notifies the same address twice", async () => {
    const r1 = req(TP.main);
    const logEntryId = oid();
    expect(await notifyCstep("SUBMITTED", r1, { logEntryId })).toMatchObject({ status: "QUEUED" });
    expect(await notifyCstep("SUBMITTED", r1, { logEntryId })).toMatchObject({ status: "SKIPPED" });
    expect(await delta()).toEqual([["cstep_submitted", EMAIL.approver]]);
  });

  it("a workspace without cstepEnabled is inert", async () => {
    const r = await notifyCstep("SUBMITTED", { ...req(TP.off), workspaceId: WS_OFF }, { logEntryId: oid() });
    expect(r).toMatchObject({ status: "SKIPPED", reason: "workspace is not cstepEnabled" });
    expect(await delta()).toEqual([]);
  });
});

describe("CSTEP_NOTIFICATIONS_ENABLED off (the default) — dormant", () => {
  afterAll(() => {
    process.env.CSTEP_NOTIFICATIONS_ENABLED = "true";
  });

  it("a full submit → reimburse run produces zero outbox rows and zero claim rows", async () => {
    delete process.env.CSTEP_NOTIFICATIONS_ENABLED;
    await delta();
    const outboxBefore = await col("emailoutboxes").countDocuments();
    const claimsBefore = await col("cstepnotifications").countDocuments();
    const mailsBefore = sent.length;

    const r = ok(await post(ACT.traveller, "/requests", { ...TOUR, saveDraft: true, purpose: "QC dormant" }));
    const id = String(r.body.request._id);
    ok(await post(ACT.traveller, `/requests/${id}/submit`));
    ok(await post(ACT.approver, `/requests/${id}/start-review`));
    ok(await post(ACT.approver, `/requests/${id}/return`, { reason: "dormant return" }));
    ok(await post(ACT.traveller, `/requests/${id}/submit`));
    ok(await post(ACT.approver, `/requests/${id}/approve`));
    ok(await post(ACT.official, `/requests/${id}/start-arranging`));
    ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
    ok(await post(ACT.traveller, `/requests/${id}/report/start`));
    ok(await post(ACT.traveller, `/requests/${id}/report/submit`));
    ok(await post(ACT.official, `/requests/${id}/settlement/start`));
    ok(await patch(ACT.official, `/requests/${id}/settlement/perdiem`, { rate: 1500 }));
    ok(await post(ACT.official, `/requests/${id}/settlement/finalize`, { force: true }));
    ok(await post(ACT.finance, `/requests/${id}/finance/return`, { reason: "dormant send-back" }));
    ok(await post(ACT.official, `/requests/${id}/settlement/finalize`, { force: true }));
    const done = ok(await post(ACT.finance, `/requests/${id}/finance/settle`, { reference: "UTR-DORMANT" }));
    expect(done.body.request.status).toBe("REIMBURSED");

    expect(await delta()).toEqual([]);
    expect(await col("emailoutboxes").countDocuments()).toBe(outboxBefore);
    expect(await col("cstepnotifications").countDocuments()).toBe(claimsBefore);
    expect(sent.length).toBe(mailsBefore);
  });

  it("only an explicitly truthy value switches it on", async () => {
    const { cstepNotificationsEnabled } = await import("../services/cstepNotifications.js");
    for (const v of [undefined, "", "false", "0", "off", "no", "enabled"]) {
      if (v === undefined) delete process.env.CSTEP_NOTIFICATIONS_ENABLED;
      else process.env.CSTEP_NOTIFICATIONS_ENABLED = v;
      expect(cstepNotificationsEnabled(), String(v)).toBe(false);
    }
    for (const v of ["true", "TRUE", "1", "yes", "on", " true "]) {
      process.env.CSTEP_NOTIFICATIONS_ENABLED = v;
      expect(cstepNotificationsEnabled(), v).toBe(true);
    }
  });
});

describe("what was sent", () => {
  it("every CSTEP email went out from the CSTEP sender, recorded on its outbox row, with no history hooks", async () => {
    const rows = await col("emailoutboxes").find({}).toArray();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.event).toMatch(/^cstep_/);
      expect(r.from).toBe(CSTEP_NOTIFICATION_FROM);
      expect(r.status).toBe("SENT");
      expect(r.onSent).toBeNull();
      expect(r.onFailed).toBeNull();
    }
    expect(sent).toHaveLength(rows.length);
    for (const s of sent) expect(s.from).toBe(CSTEP_NOTIFICATION_FROM);
    // Every claim row points at the outbox row it produced.
    const claims = await col("cstepnotifications").find({ outboxId: { $exists: true } }).toArray();
    expect(claims).toHaveLength(rows.length);
  });

  it("the CSTEP layout carries no Plumtrips branding", async () => {
    const tp: any = await col("travellerprofiles").findOne({ _id: TP.main });
    const { subject, html } = renderCstepEmail(
      "RETURN",
      { _id: oid(), formType: "TOUR_PROPOSAL", purpose: "QC workshop", departureDate: "2026-11-02", returnDate: "2026-11-04", stations: TOUR.stations, claimReference: "" },
      tp,
      { logEntryId: oid(), reason: "Please attach the workshop agenda." },
    );
    expect(subject).toBe("[CSTEP] Your tour proposal was returned");
    expect(html).not.toMatch(/logo\.png/);
    expect(html).not.toMatch(/ops@plumtrips\.com/);
    expect(html).not.toMatch(/PLUMTRIPS/);
    expect(html).toMatch(/CSTEP Travel &amp; Claim Portal/);
    if (process.env.CSTEP_QC_RENDER_OUT) fs.writeFileSync(process.env.CSTEP_QC_RENDER_OUT, html);
  });
});
