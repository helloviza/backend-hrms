// apps/backend/src/routes/cstep.notificationsClaims.test.ts
//
// CSTEP notification emails on the CLAIM path (Local Travel Claim, Expense
// Claim), driven through the real CSTEP router:
//   - every email names the form as itself ("Local Travel Claim", "Expense
//     Claim") with its own reference label (LTC / EXP), never "Tour
//     proposal" / "TIN";
//   - the manager's approval notifies the CSTEP Admin addresses from the
//     notification settings (CLAIM_APPROVED), not the Official;
//   - Finance sending a claim back notifies the Admins (RETURN_TO_ADMIN);
//   - the money's direction reads right both ways: "payable to" when CSTEP
//     pays, "to be recovered from" when the claimant repays an advance, and
//     a repayment received never says nothing was owed.
//
// Real: cstep router, notifyCstep, enqueueEmail + EmailOutbox, renderLayout,
//   cstepMailTransport, models, in-memory Mongo REPLICA SET.
// Stubbed: the SMTP send (utils/mailer — records every call), S3 + PDF
//   helpers, auth (x-test-user) and the workspace resolver (x-test-ws).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_notif_claims";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
process.env.DISABLE_EMAILS = "";
process.env.CSTEP_NOTIFICATIONS_ENABLED = "true";

const sent = vi.hoisted(() => [] as any[]);
let uploadSeq = 0;
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      return {};
    }
  },
  PutObjectCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  GetObjectCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
}));
vi.mock("../utils/mailer.js", () => ({
  sendMail: vi.fn(async (args: any) => {
    sent.push(args);
    return { ok: true };
  }),
}));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: vi.fn(async (args: any) => ({ key: `${args.keyPrefix}/qc-${++uploadSeq}` })),
  getObjectBuffer: vi.fn(async () => Buffer.from("")),
}));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async () => "http://qc/presigned") }));
vi.mock("../utils/cstepEventRequestPdf.js", () => ({ uploadCstepEventRequestPdf: vi.fn(async () => ({ key: "qc-event" })) }));
vi.mock("../utils/cstepPacketPdf.js", () => ({ uploadCstepPacketPdf: vi.fn(async () => ({ key: "qc-packet" })) }));

const { default: cstepRouter } = await import("./cstep.js");
const { notifyCstep, renderCstepEmail } = await import("../services/cstepNotifications.js");
const { encryptCstepSmtpPass } = await import("../services/cstepMailTransport.js");
const { default: CstepNotificationSettings } = await import("../models/cstep/CstepNotificationSettings.js");

const DB = "cstep_qc_notif_claims";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
const QC_PROJECT = oid();
const withProject = (path: string, body: any) =>
  path === "/requests" && body && body.projectId === undefined ? { ...body, projectId: String(QC_PROJECT) } : body;
const U = { traveller: oid(), approver: oid(), official: oid(), finance: oid(), admin: oid() };
const EMAIL = {
  traveller: "traveller@qc.local",
  approver: "approver@qc.local",
  official: "official@qc.local",
  finance: "finance@qc.local",
  admin: "admin-user@qc.local",
};
const ADMINS = ["cstep-admin1@qc.local", "cstep-admin2@qc.local"];
const TP = oid();

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
  admin: who(U.admin, EMAIL.admin, ["ADMIN"]),
};
const send = (method: "get" | "post" | "patch", as: any, path: string, body?: any) => {
  const r = request(app)[method](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS));
  return body === undefined ? r : r.send(body);
};
const post = (as: any, path: string, body: any = {}) => send("post", as, path, withProject(path, body));
const patch = (as: any, path: string, body: any = {}) => send("patch", as, path, body);
const get = (as: any, path: string) => send("get", as, path);
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const stage = async (as: any) =>
  String(
    ok(
      await request(app)
        .post("/api/cstep/attachments/staging")
        .set("x-test-user", JSON.stringify(as))
        .set("x-test-ws", String(WS))
        .field("documentType", "CAB_RECEIPT")
        .attach("file", Buffer.from("%PDF-1.4 qc invoice"), { filename: "invoice.pdf", contentType: "application/pdf" }),
    ).body.attachment._id,
  );

const ltcBody = (over: any = {}) => ({
  formType: "LOCAL_TRAVEL_CLAIM",
  purpose: "Client meetings across the city",
  departureDate: "2026-10-05",
  returnDate: "2026-10-09",
  travelLines: [],
  foodLines: [],
  ...over,
});
const expBody = (over: any = {}) => ({
  formType: "EXPENSE_CLAIM",
  purpose: "Workshop materials and courier",
  departureDate: "2026-10-12",
  returnDate: "2026-10-16",
  expenseLines: [{ date: "2026-10-12", description: "Stationery", amount: 300 }],
  ...over,
});

/* The emails sent since the last call: event, recipient, subject, html, text. */
let seen = 0;
async function delta() {
  const rows = await col("emailoutboxes").find({}).sort({ _id: 1 }).toArray();
  const fresh = rows.slice(seen);
  seen = rows.length;
  return fresh.map((r: any) => ({ event: r.event as string, to: (r.to || []).join(","), subject: r.subject as string, html: r.html as string, text: r.text as string }));
}
const events = (d: Array<{ event: string; to: string }>) => d.map((x) => [x.event, x.to]);
const verifyAll = async (id: string) => {
  const lines = ok(await get(ACT.admin, `/requests/${id}/settlement`)).body.lines;
  for (const l of lines) ok(await patch(ACT.admin, `/requests/${id}/settlement/lines/${l._id}`, { verified: true }));
};

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri(DB);
  const host = new URL(uri.replace(/^mongodb:\/\//, "http://")).hostname;
  if (host !== "127.0.0.1") throw new Error(`Step 0: refusing to seed — host is ${host}, not 127.0.0.1`);
  await mongoose.connect(uri, { autoIndex: false });
  if (mongoose.connection.db!.databaseName !== DB) throw new Error("Step 0: wrong database");
  const existing = await mongoose.connection.db!.listCollections().toArray();
  if (existing.length) throw new Error(`Step 0: refusing to seed — ${DB} is not empty (${existing.length} collections)`);

  await mongoose.connection.syncIndexes();
  await CstepNotificationSettings.create({
    workspaceId: WS, enabled: true, senderMailbox: "notify@cstep-qc.local", senderName: "CSTEP",
    smtpHost: "smtp.cstep-qc.local", smtpPort: 587, smtpPassEnc: encryptCstepSmtpPass("qc", WS), adminRecipients: ADMINS,
  });
  await col("cstepprojects").insertOne({ _id: QC_PROJECT, workspaceId: WS, projectCode: "PRJ-QC", projectName: "QC Project", tallyProjectCC: "100 QC 01", isActive: true } as any);
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany(
    (Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: EMAIL[k], roles: ["REQUESTER"], workspaceId: WS })) as any[],
  );
  await col("travellerprofiles").insertOne({
    _id: TP, workspaceId: WS, travelerId: "CSTEP-001", firstName: "Asha", lastName: "Rao", isActive: true,
    email: EMAIL.traveller, claimedBy: U.traveller, tourApproverId: U.approver, officialUserId: U.official, financeUserId: U.finance,
  } as any);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("Local Travel Claim — CSTEP pays the claimant (PAY_OUT)", () => {
  let id = "";

  it("SUBMITTED → the approver, named as a Local Travel Claim", async () => {
    const r = ok(await post(ACT.traveller, "/requests", ltcBody({ foodLines: [{ date: "2026-10-06", amount: 900 }], advanceTaken: 500 })));
    id = String(r.body.request._id);
    const d = await delta();
    expect(events(d)).toEqual([["cstep_submitted", EMAIL.approver]]);
    expect(d[0].subject).toBe("[CSTEP] Local Travel Claim awaiting your approval — Asha Rao");
    expect(d[0].html).toContain("Asha Rao has submitted a local travel claim");
    expect(d[0].html).not.toMatch(/Tour proposal|tour proposal/);
  });

  it("the manager approves → CLAIM_APPROVED to every CSTEP Admin address, nothing to the Official", async () => {
    ok(await post(ACT.approver, `/requests/${id}/approve`));
    const d = await delta();
    expect(events(d)).toEqual([
      ["cstep_claim_approved", ADMINS[0]],
      ["cstep_claim_approved", ADMINS[1]],
    ]);
    expect(d[0].subject).toBe("[CSTEP] Local Travel Claim approved — awaiting your verification — Asha Rao");
    expect(d[0].html).toContain("Please verify the claim and send it on to Finance.");
    // The claim's reference carries its own label, not "TIN".
    expect(d[0].html).toContain(">LTC reference<");
    expect(d[0].html).not.toMatch(/>TIN</);
    expect(d[0].text).toContain("LTC reference: ");
    expect(d[0].html).toContain("Amount claimed");
    const entry = await col("cstepapprovals").findOne({ entityId: new mongoose.Types.ObjectId(id), action: "APPROVE" });
    const claims = await col("cstepnotifications").find({ event: "CLAIM_APPROVED" }).toArray();
    expect(claims.map((c: any) => String(c.logEntryId))).toEqual([String(entry!._id), String(entry!._id)]);
  });

  it("Admin verifies → Finance reads “₹400 payable to Asha Rao”", async () => {
    await verifyAll(id);
    ok(await post(ACT.admin, `/requests/${id}/claim/verify`));
    const d = await delta();
    expect(events(d)).toEqual([["cstep_transferred_to_finance", EMAIL.finance]]);
    expect(d[0].subject).toBe("[CSTEP] Claim ready for reimbursement — Asha Rao");
    expect(d[0].html).toContain("₹400 payable to Asha Rao");
    expect(d[0].html).not.toContain("recovered");
  });

  it("Finance sends it back → RETURN_TO_ADMIN to the Admins, with the reason", async () => {
    ok(await post(ACT.finance, `/requests/${id}/finance/return`, { reason: "Check the dinner bill" }));
    const d = await delta();
    expect(events(d)).toEqual([
      ["cstep_return_to_admin", ADMINS[0]],
      ["cstep_return_to_admin", ADMINS[1]],
    ]);
    expect(d[0].subject).toBe("[CSTEP] Local Travel Claim sent back by Finance — Asha Rao");
    expect(d[0].html).toContain("Check the dinner bill");
    const entry = await col("cstepapprovals").findOne({ entityId: new mongoose.Types.ObjectId(id), action: "RETURN_TO_ADMIN" });
    const n = await col("cstepnotifications").findOne({ event: "RETURN_TO_ADMIN" });
    expect(String(n!.logEntryId)).toBe(String(entry!._id));
  });

  it("re-verify → Finance again; Finance pays → REIMBURSED to the claimant, named as their claim", async () => {
    ok(await post(ACT.admin, `/requests/${id}/claim/verify`));
    expect(events(await delta())).toEqual([["cstep_transferred_to_finance", EMAIL.finance]]);
    ok(await post(ACT.finance, `/requests/${id}/finance/settle`, { reference: "UTR-LTC-1" }));
    const d = await delta();
    expect(events(d)).toEqual([["cstep_reimbursed", EMAIL.traveller]]);
    expect(d[0].subject).toBe("[CSTEP] Your local travel claim has been reimbursed");
    expect(d[0].html).toContain("₹400 has been reimbursed");
    expect(d[0].html).toContain("UTR-LTC-1");
  });
});

describe("Local Travel Claim — the claimant repays CSTEP (COLLECT)", () => {
  let id = "";

  it("Admin verifies an over-advanced claim → Finance reads “₹300 to be recovered from Asha Rao”", async () => {
    const r = ok(await post(ACT.traveller, "/requests", ltcBody({ foodLines: [{ date: "2026-10-07", amount: 200 }], advanceTaken: 500 })));
    id = String(r.body.request._id);
    ok(await post(ACT.approver, `/requests/${id}/approve`));
    await verifyAll(id);
    await delta();
    ok(await post(ACT.admin, `/requests/${id}/claim/verify`));
    const d = await delta();
    expect(events(d)).toEqual([["cstep_transferred_to_finance", EMAIL.finance]]);
    expect(d[0].subject).toBe("[CSTEP] Claim verified — amount to recover — Asha Rao");
    expect(d[0].html).toContain("₹300 to be recovered from Asha Rao");
    expect(d[0].html).toContain("Please recover the amount from the traveller.");
    expect(d[0].html).not.toMatch(/payable|owed to/);
  });

  it("Finance records the repayment → SETTLED that says the repayment was received, never “nothing owed”", async () => {
    ok(await post(ACT.finance, `/requests/${id}/finance/settle`, { reference: "RCPT-9" }));
    const d = await delta();
    expect(events(d)).toEqual([["cstep_settled", EMAIL.traveller]]);
    expect(d[0].subject).toBe("[CSTEP] Your local travel claim is settled");
    expect(d[0].html).toContain("Your repayment of ₹300 has been received");
    expect(d[0].html).toContain("RCPT-9");
    expect(d[0].html).not.toMatch(/[Nn]othing is (owed|due)/);
  });
});

describe("Local Travel Claim — nothing due either way", () => {
  it("Admin verify closes it SETTLED with claim wording, not trip wording", async () => {
    const r = ok(await post(ACT.traveller, "/requests", ltcBody({ otherExpenses: 400, advanceTaken: 400 })));
    const id = String(r.body.request._id);
    ok(await post(ACT.approver, `/requests/${id}/approve`));
    await verifyAll(id);
    await delta();
    ok(await post(ACT.admin, `/requests/${id}/claim/verify`));
    const d = await delta();
    expect(events(d)).toEqual([["cstep_settled", EMAIL.traveller]]);
    expect(d[0].html).toContain("Nothing is due either way on this claim, so it is closed.");
    expect(d[0].html).not.toContain("on this trip");
  });
});

describe("Expense Claim", () => {
  it("is named as an Expense Claim with its EXP reference label", async () => {
    const inv = await stage(ACT.traveller);
    const r = ok(await post(ACT.traveller, "/requests", expBody({ invoiceAttachmentIds: [inv] })));
    const id = String(r.body.request._id);
    let d = await delta();
    expect(d[0].subject).toBe("[CSTEP] Expense Claim awaiting your approval — Asha Rao");
    expect(d[0].html).toContain("Asha Rao has submitted an expense claim");
    ok(await post(ACT.approver, `/requests/${id}/approve`));
    d = await delta();
    expect(events(d)).toEqual([
      ["cstep_claim_approved", ADMINS[0]],
      ["cstep_claim_approved", ADMINS[1]],
    ]);
    expect(d[0].subject).toBe("[CSTEP] Expense Claim approved — awaiting your verification — Asha Rao");
    expect(d[0].html).toContain("EXP reference");
    expect(d[0].html).toMatch(/EXP\d{4}\//);
  });
});

describe("Admin recipients and other form labels", () => {
  it("no Admin addresses in the settings → the Admin email is skipped, no fallback to anyone", async () => {
    await CstepNotificationSettings.updateOne({ workspaceId: WS }, { $set: { adminRecipients: [] } });
    try {
      const r = await notifyCstep(
        "CLAIM_APPROVED",
        { _id: oid(), workspaceId: WS, travelerProfileId: TP, formType: "LOCAL_TRAVEL_CLAIM", purpose: "x" },
        { logEntryId: oid() },
      );
      expect(r).toMatchObject({ status: "SKIPPED", reason: "no admin email mapped" });
      expect(await delta()).toEqual([]);
    } finally {
      await CstepNotificationSettings.updateOne({ workspaceId: WS }, { $set: { adminRecipients: ADMINS } });
    }
  });

  it("a Tour proposal and an Event request keep their own names and reference labels", () => {
    const tp = { firstName: "Asha", lastName: "Rao" };
    const tour = renderCstepEmail("SUBMITTED", { _id: oid(), formType: "TOUR_PROPOSAL", purpose: "p", claimReference: "0001/1026" }, tp, { logEntryId: oid() });
    expect(tour.subject).toBe("[CSTEP] Tour proposal awaiting your approval — Asha Rao");
    expect(tour.html).toContain("has submitted a tour proposal");
    expect(tour.html).toContain(">TIN<");
    const ev = renderCstepEmail("SUBMITTED", { _id: oid(), formType: "EVENT_REQUEST", purpose: "p", claimReference: "EVR0001/1026" }, tp, { logEntryId: oid() });
    expect(ev.subject).toBe("[CSTEP] Event request awaiting your approval — Asha Rao");
    expect(ev.html).toContain("has submitted an event request");
    expect(ev.html).toContain("EVR reference");
  });

  it("every claim email went over the CSTEP transport", async () => {
    const rows = await col("emailoutboxes").find({}).toArray();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.transport).toBe("CSTEP");
    for (const s of sent) expect(s.smtp?.host).toBe("smtp.cstep-qc.local");
  });
});
