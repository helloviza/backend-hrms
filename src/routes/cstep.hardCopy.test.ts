// apps/backend/src/routes/cstep.hardCopy.test.ts
//
// P3 — the travel report's hard copy, Traveller → Admin → Finance
// (utils/cstepHardCopy.ts). The answer to each prompt rides on the action it
// belongs to — report/submit, settlement/finalize, finance/settle — and is
// record-only: every action proceeds on any answer. PATCH /hard-copy sets it
// directly (corrections, the paper arriving after closure). Mail only on a
// "No": L1 / L2 standalone (HARD_COPY_PENDING), L3 on the reimbursement mail;
// all under CSTEP_NOTIFICATIONS_ENABLED. Every answer and change is a
// HARD_COPY entry with who / when / from → to.
//
// Real: cstep router, models, notification module + outbox, in-memory Mongo
//   REPLICA SET (transactions) on a fresh database, cstep_qc_hard_copy.
// Stubbed: the SMTP send, S3 + PDF helpers, auth (x-test-user), the
//   workspace resolver.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
// config/env.ts requires these at import; none of them is ever used here.
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_hard_copy";
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

vi.setConfig({ testTimeout: 60_000 });

const { default: cstepRouter } = await import("./cstep.js");
const { encryptCstepSmtpPass } = await import("../services/cstepMailTransport.js");
const { default: CstepNotificationSettings } = await import("../models/cstep/CstepNotificationSettings.js");
const { HARD_COPY_L1, HARD_COPY_L2, HARD_COPY_L3 } = await import("../services/cstepNotifications.js");

const DB = "cstep_qc_hard_copy";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
const QC_PROJECT = oid();
const VENDOR = oid();
const U = { traveller: oid(), manager: oid(), official: oid(), finance: oid(), desk: oid(), admin: oid(), stranger: oid() };
const TP = { main: oid() };
const TRAVELLER_EMAIL = "traveller@qc.local";

const app = express();
app.use(express.json());
app.use(
  "/api/cstep",
  (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    req.workspaceObjectId = WS;
    next();
  },
  cstepRouter,
);

const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"], email = `${id}@qc.local`) => ({
  _id: String(id), id: String(id), sub: String(id), email, roles, workspaceId: String(WS),
});
const ACT = {
  traveller: who(U.traveller, ["REQUESTER"], TRAVELLER_EMAIL),
  manager: who(U.manager, ["APPROVER"]),
  official: who(U.official),
  finance: who(U.finance),
  desk: who(U.desk),
  admin: who(U.admin, ["ADMIN"]),
  stranger: who(U.stranger),
};

const send = (m: "get" | "post" | "patch", as: any, path: string, body?: any) => {
  const r = request(app)[m](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as));
  if (m === "get") return r;
  return r.send(path === "/requests" && body?.projectId === undefined ? { ...body, projectId: String(QC_PROJECT) } : body || {});
};
const get = (as: any, path: string) => send("get", as, path);
const post = (as: any, path: string, body?: any) => send("post", as, path, body);
const patch = (as: any, path: string, body?: any) => send("patch", as, path, body);
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const id$ = (id: string) => new mongoose.Types.ObjectId(id);
const reqDoc = async (id: string) => (await col("csteptravelrequests").findOne({ _id: id$(id) }))!;
const hc = async (id: string) => (await reqDoc(id)).hardCopy?.status ?? null;
const hcEntries = (id: string) => col("cstepapprovals").find({ entityId: id$(id), action: "HARD_COPY" }).sort({ _id: 1 }).toArray();
const outbox = (id: string, event: string) => col("emailoutboxes").find({ requestId: id$(id), event }).sort({ _id: 1 }).toArray();

const TOUR = {
  type: "DOMESTIC",
  purpose: "QC paper trail",
  departureDate: "2026-11-02",
  returnDate: "2026-11-04",
  stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }],
  modesRequested: ["AIR"],
  transportRequired: false,
  accommodationRequired: false,
  sponsored: false,
};

/** A Tour with its report filed (REPORT_PENDING), every leg documented: a
 * CSTEP-paid flight and one self-paid ₹1,200 cab, so finalize goes to Finance. */
async function tourAtReport(): Promise<string> {
  const id = String(ok(await post(ACT.traveller, "/requests", TOUR)).body.request._id);
  ok(await post(ACT.manager, `/requests/${id}/approve`));
  const [flight] = ok(await post(ACT.official, `/requests/${id}/start-arranging`)).body.arrangements;
  ok(await patch(ACT.official, `/requests/${id}/arrangements/${flight._id}`, { vendorId: String(VENDOR), amount: 6400, currency: "INR", status: "ARRANGED" }));
  ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
  ok(await post(ACT.traveller, `/requests/${id}/report/start`));
  ok(
    await post(ACT.traveller, `/requests/${id}/report/legs`, {
      direction: "ONWARD", travelMode: "CAB", paidBy: "SELF", fare: 1200, currency: "INR",
      fromLocation: "Airport", toLocation: "Office", fromDate: "2026-11-02", toDate: "2026-11-02",
    }),
  );
  await col("cstepreportlegs").updateMany({ requestId: id$(id), attachmentId: { $exists: false } }, { $set: { attachmentId: oid(), boardingPassAttachmentIds: [oid()] } });
  return id;
}

/** Submit (with the traveller's answer), approve, open the settlement — at REPORT_SUBMITTED. */
async function tourAtSettlement(travellerAnswer?: string): Promise<string> {
  const id = await tourAtReport();
  ok(await post(ACT.traveller, `/requests/${id}/report/submit`, travellerAnswer ? { hardCopy: travellerAnswer } : {}));
  ok(await post(ACT.manager, `/requests/${id}/report/approve`));
  ok(await post(ACT.official, `/requests/${id}/settlement/start`));
  ok(await patch(ACT.official, `/requests/${id}/settlement/perdiem`, { rate: 0, rateReason: "QC rate" }));
  return id;
}

/** ...and finalized to Finance (with the Admin's answer) — at TRANSFERRED_TO_FINANCE. */
async function tourWithFinance(travellerAnswer?: string, adminAnswer?: string): Promise<string> {
  const id = await tourAtSettlement(travellerAnswer);
  const r = ok(await post(ACT.official, `/requests/${id}/settlement/finalize`, { force: true, ...(adminAnswer ? { hardCopy: adminAnswer } : {}) }));
  expect(r.body.request.status).toBe("TRANSFERRED_TO_FINANCE");
  return id;
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
  const existing = await mongoose.connection.db!.listCollections().toArray();
  if (existing.length) throw new Error(`Step 0: refusing to seed — ${DB} is not empty (${existing.length} collections)`);
  await mongoose.connection.syncIndexes();

  await CstepNotificationSettings.create({
    workspaceId: WS, enabled: true, senderMailbox: "notify@cstep-qc.local", senderName: "CSTEP",
    smtpHost: "smtp.cstep-qc.local", smtpPort: 587, smtpPassEnc: encryptCstepSmtpPass("qc-app-password", WS),
  });
  await col("cstepprojects").insertOne({ _id: QC_PROJECT, workspaceId: WS, projectCode: "PRJ-QC", projectName: "QC Project", tallyProjectCC: "100 QC 01", isActive: true } as any);
  await col("cstepvendors").insertOne({ _id: VENDOR, workspaceId: WS, vendorCode: "CSTEPVEN0001", name: "Skyline Travels", isActive: true } as any);
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany(
    (Object.keys(U) as Array<keyof typeof U>).map((k) => ({
      _id: U[k], email: k === "traveller" ? TRAVELLER_EMAIL : `${U[k]}@qc.local`, roles: ["REQUESTER"], workspaceId: WS,
    })) as any[],
  );
  await col("csteptraveldeskgrants").insertOne({ workspaceId: WS, userId: U.desk, grantedBy: U.admin, grantedAt: new Date() } as any);
  await col("travellerprofiles").insertOne({
    _id: TP.main, workspaceId: WS, travelerId: "CSTEP-001", firstName: "Asha", lastName: "Rao", isActive: true,
    claimedBy: U.traveller, email: TRAVELLER_EMAIL, tourApproverId: U.manager, officialUserId: U.official, financeUserId: U.finance,
  } as any);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("1 · Traveller — at report submit", () => {
  it("Yes → to Admin: SUBMITTED_TO_ADMIN, the report is submitted, no traveller mail", async () => {
    const id = await tourAtReport();
    const r = ok(await post(ACT.traveller, `/requests/${id}/report/submit`, { hardCopy: "ADMIN" }));
    expect(r.body.request.status).toBe("REPORT_UNDER_APPROVAL");
    expect(r.body.request.hardCopy.status).toBe("SUBMITTED_TO_ADMIN");
    expect(await hc(id)).toBe("SUBMITTED_TO_ADMIN");
    expect(await outbox(id, "cstep_hard_copy_pending")).toHaveLength(0);
  });

  it("Yes → to Finance: SUBMITTED_TO_FINANCE, no mail", async () => {
    const id = await tourAtReport();
    ok(await post(ACT.traveller, `/requests/${id}/report/submit`, { hardCopy: "FINANCE" }));
    expect(await hc(id)).toBe("SUBMITTED_TO_FINANCE");
    expect(await outbox(id, "cstep_hard_copy_pending")).toHaveLength(0);
  });

  it("No: PENDING and L1 to the traveller — a mail of its own (the submit mail goes to the Manager)", async () => {
    const id = await tourAtReport();
    const r = ok(await post(ACT.traveller, `/requests/${id}/report/submit`, { hardCopy: "NO" }));
    expect(r.body.request.status).toBe("REPORT_UNDER_APPROVAL");
    expect(await hc(id)).toBe("PENDING");
    const mails = await outbox(id, "cstep_hard_copy_pending");
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual([TRAVELLER_EMAIL]);
    expect(mails[0].text).toContain(HARD_COPY_L1);
    expect(mails[0].text).not.toContain(HARD_COPY_L2);
    // The Manager's own submit mail is untouched and carries no hard-copy line.
    const [mgr] = await outbox(id, "cstep_report_submitted");
    expect(mgr.to).toEqual([`${U.manager}@qc.local`]);
    expect(mgr.text.toLowerCase()).not.toContain("hard copy");
  });

  it("no answer (an older client): the submit proceeds and the hard copy stays not captured", async () => {
    const id = await tourAtReport();
    ok(await post(ACT.traveller, `/requests/${id}/report/submit`, {}));
    expect(await hc(id)).toBeNull();
    expect(await hcEntries(id)).toHaveLength(0);
  });

  it("an unknown answer is refused before anything happens", async () => {
    const id = await tourAtReport();
    const r = await post(ACT.traveller, `/requests/${id}/report/submit`, { hardCopy: "MAYBE" });
    expect(r.status).toBe(400);
    expect((await reqDoc(id)).status).toBe("REPORT_PENDING");
  });

  it("a resubmit after a send-back does not overwrite what Admin recorded", async () => {
    const id = await tourAtSettlement("ADMIN");
    ok(await patch(ACT.official, `/requests/${id}/hard-copy`, { status: "RECEIVED_AT_ADMIN" }));
    ok(await post(ACT.official, `/requests/${id}/report/return`, { reason: "Fix the cab fare" }));
    ok(await post(ACT.traveller, `/requests/${id}/report/submit`, { hardCopy: "NO" }));
    expect(await hc(id)).toBe("RECEIVED_AT_ADMIN");
    expect(await outbox(id, "cstep_hard_copy_pending")).toHaveLength(0);
  });
});

describe("2 · Admin — at finalize (transfer to Finance)", () => {
  it("received and forwarded: SUBMITTED_TO_FINANCE, transfer proceeds, no L2", async () => {
    const id = await tourWithFinance("NO", "FORWARDED");
    expect(await hc(id)).toBe("SUBMITTED_TO_FINANCE");
    expect(await outbox(id, "cstep_hard_copy_pending")).toHaveLength(1); // the L1 from the traveller's No only
  });

  it("received, not forwarded: RECEIVED_AT_ADMIN, no L2", async () => {
    const id = await tourWithFinance("ADMIN", "RECEIVED");
    expect(await hc(id)).toBe("RECEIVED_AT_ADMIN");
    expect(await outbox(id, "cstep_hard_copy_pending")).toHaveLength(0);
  });

  it("not received: stays PENDING, transfer proceeds, L2 to the traveller on its own", async () => {
    const id = await tourWithFinance("ADMIN", "NOT_RECEIVED");
    expect(await hc(id)).toBe("PENDING");
    const mails = await outbox(id, "cstep_hard_copy_pending");
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual([TRAVELLER_EMAIL]);
    expect(mails[0].text).toContain(HARD_COPY_L2);
    // The transfer mail still goes to Finance, unchanged.
    const [fin] = await outbox(id, "cstep_transferred_to_finance");
    expect(fin.to).toEqual([`${U.finance}@qc.local`]);
    expect(fin.text.toLowerCase()).not.toContain("hard copy");
  });

  it("not prompted when the traveller went direct to Finance — an answer sent anyway is ignored", async () => {
    const id = await tourWithFinance("FINANCE", "NOT_RECEIVED");
    expect(await hc(id)).toBe("SUBMITTED_TO_FINANCE");
    expect((await hcEntries(id)).map((e: any) => e.hardCopyChange.source)).toEqual(["TRAVELLER_SUBMIT"]);
    expect(await outbox(id, "cstep_hard_copy_pending")).toHaveLength(0);
  });

  it("a finalize that closes at ₹0 records the answer but sends no L2 (nothing went to Finance)", async () => {
    const id = await tourAtSettlement("NO");
    const lines = ok(await get(ACT.official, `/requests/${id}/settlement`)).body.lines;
    const cab = lines.find((l: any) => l.classification === "PERSONAL");
    ok(await patch(ACT.official, `/requests/${id}/settlement/lines/${cab._id}`, { amountInr: 0, amountReason: "QC: not claimable" }));
    const r = ok(await post(ACT.official, `/requests/${id}/settlement/finalize`, { force: true, hardCopy: "NOT_RECEIVED" }));
    expect(r.body.request.status).toBe("SETTLED");
    expect(await hc(id)).toBe("PENDING");
    expect((await outbox(id, "cstep_hard_copy_pending")).map((m: any) => m.text.includes(HARD_COPY_L2))).toEqual([false]);
  });
});

describe("3 · Finance — at reimburse", () => {
  it("Yes: RECEIVED_AT_FINANCE, reimbursed, the mail has no L3", async () => {
    const id = await tourWithFinance("ADMIN", "FORWARDED");
    const r = ok(await post(ACT.finance, `/requests/${id}/finance/settle`, { reference: "UTR1", hardCopy: "RECEIVED" }));
    expect(r.body.request.status).toBe("REIMBURSED");
    expect(await hc(id)).toBe("RECEIVED_AT_FINANCE");
    const [mail] = await outbox(id, "cstep_reimbursed");
    expect(mail.text).not.toContain(HARD_COPY_L3);
    expect(mail.text).toContain("Nothing more to do");
  });

  it("No: status unchanged, still reimbursed, the reimbursement mail carries L3 (no extra mail)", async () => {
    const id = await tourWithFinance("ADMIN", "FORWARDED");
    const r = ok(await post(ACT.finance, `/requests/${id}/finance/settle`, { hardCopy: "NOT_RECEIVED" }));
    expect(r.body.request.status).toBe("REIMBURSED");
    expect(await hc(id)).toBe("SUBMITTED_TO_FINANCE");
    const mails = await outbox(id, "cstep_reimbursed");
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual([TRAVELLER_EMAIL]);
    expect(mails[0].text).toContain(HARD_COPY_L3);
    expect(await outbox(id, "cstep_hard_copy_pending")).toHaveLength(0);
    const last = (await hcEntries(id)).at(-1)!;
    expect(last.hardCopyChange).toEqual({ from: "SUBMITTED_TO_FINANCE", to: "SUBMITTED_TO_FINANCE", source: "FINANCE_SETTLE" });
  });

  it("Pending with Admin: RECEIVED_AT_ADMIN, reimbursed, L3 on the mail", async () => {
    const id = await tourWithFinance("ADMIN", "FORWARDED");
    ok(await post(ACT.finance, `/requests/${id}/finance/settle`, { hardCopy: "PENDING_WITH_ADMIN" }));
    expect(await hc(id)).toBe("RECEIVED_AT_ADMIN");
    const [mail] = await outbox(id, "cstep_reimbursed");
    expect(mail.text).toContain(HARD_COPY_L3);
  });

  it("a legacy case (not captured) answered No: recorded as unchanged, L3 on the mail", async () => {
    const id = await tourWithFinance();
    expect(await hc(id)).toBeNull();
    ok(await post(ACT.finance, `/requests/${id}/finance/settle`, { hardCopy: "NOT_RECEIVED" }));
    expect(await hc(id)).toBeNull();
    const [e] = await hcEntries(id);
    expect(e.hardCopyChange).toEqual({ from: "NOT_CAPTURED", to: "NOT_CAPTURED", source: "FINANCE_SETTLE" });
    expect((await outbox(id, "cstep_reimbursed"))[0].text).toContain(HARD_COPY_L3);
  });

  it("no answer (the bulk import's path): reimbursed, nothing recorded, no L3", async () => {
    const id = await tourWithFinance("ADMIN", "FORWARDED");
    ok(await post(ACT.finance, `/requests/${id}/finance/settle`, {}));
    expect(await hc(id)).toBe("SUBMITTED_TO_FINANCE");
    expect((await outbox(id, "cstep_reimbursed"))[0].text).not.toContain(HARD_COPY_L3);
  });

  it("an unknown answer is refused before payment", async () => {
    const id = await tourWithFinance("ADMIN", "FORWARDED");
    const r = await post(ACT.finance, `/requests/${id}/finance/settle`, { hardCopy: "YES" });
    expect(r.status).toBe(400);
    expect((await reqDoc(id)).status).toBe("TRANSFERRED_TO_FINANCE");
  });

  it("already received at Finance: not prompted — an answer sent anyway changes nothing", async () => {
    const id = await tourWithFinance("FINANCE");
    ok(await patch(ACT.finance, `/requests/${id}/hard-copy`, { status: "RECEIVED_AT_FINANCE" }));
    const before = (await hcEntries(id)).length;
    ok(await post(ACT.finance, `/requests/${id}/finance/settle`, { hardCopy: "NOT_RECEIVED" }));
    expect(await hc(id)).toBe("RECEIVED_AT_FINANCE");
    expect(await hcEntries(id)).toHaveLength(before);
    expect((await outbox(id, "cstep_reimbursed"))[0].text).not.toContain(HARD_COPY_L3);
  });
});

describe("4/5 · Post-closure edit and corrections (PATCH /hard-copy)", () => {
  it("Finance marks a REIMBURSED case received later — audited who / when / from → to, note kept, no mail", async () => {
    const id = await tourWithFinance("NO", "NOT_RECEIVED");
    ok(await post(ACT.finance, `/requests/${id}/finance/settle`, { hardCopy: "NOT_RECEIVED" }));
    expect((await reqDoc(id)).status).toBe("REIMBURSED");
    const mailsBefore = (await col("emailoutboxes").countDocuments({ requestId: id$(id) }));
    const detail = ok(await get(ACT.finance, `/requests/${id}`)).body;
    expect(detail.canEditHardCopy).toBe(true);
    const t0 = Date.now();
    const r = ok(await patch(ACT.finance, `/requests/${id}/hard-copy`, { status: "RECEIVED_AT_FINANCE", note: "Arrived by courier" }));
    expect(r.body.request.hardCopy.status).toBe("RECEIVED_AT_FINANCE");
    expect((await reqDoc(id)).status).toBe("REIMBURSED");
    const stamp = (await reqDoc(id)).hardCopy;
    expect(String(stamp.updatedBy)).toBe(String(U.finance));
    expect(new Date(stamp.updatedAt).getTime()).toBeGreaterThanOrEqual(t0 - 1000);
    const e = (await hcEntries(id)).at(-1)!;
    expect(String(e.actor)).toBe(String(U.finance));
    expect(e.stage).toBe("FINANCE");
    expect(e.hardCopyChange).toEqual({ from: "PENDING", to: "RECEIVED_AT_FINANCE", source: "CORRECTION" });
    expect(e.comment).toContain("pending submission → received at Finance");
    expect(e.comment).toContain("Arrived by courier");
    expect(new Date(e.at).getTime()).toBeGreaterThanOrEqual(t0 - 1000);
    expect(await col("emailoutboxes").countDocuments({ requestId: id$(id) })).toBe(mailsBefore);
  });

  it("Admin (the Travel Desk) and a CSTEP Admin can fix a wrong status; it shows in the activity log", async () => {
    const id = await tourAtSettlement("FINANCE");
    ok(await patch(ACT.desk, `/requests/${id}/hard-copy`, { status: "RECEIVED_AT_ADMIN", note: "Traveller handed it to us" }));
    ok(await patch(ACT.admin, `/requests/${id}/hard-copy`, { status: "SUBMITTED_TO_FINANCE" }));
    const all = await hcEntries(id);
    expect(all.map((e: any) => [e.hardCopyChange.from, e.hardCopyChange.to, String(e.actor), e.stage])).toEqual([
      ["NOT_CAPTURED", "SUBMITTED_TO_FINANCE", String(U.traveller), "TRAVELER"],
      ["SUBMITTED_TO_FINANCE", "RECEIVED_AT_ADMIN", String(U.desk), "OFFICIAL"],
      ["RECEIVED_AT_ADMIN", "SUBMITTED_TO_FINANCE", String(U.admin), "OFFICIAL"],
    ]);
    const activity = ok(await get(ACT.official, `/requests/${id}/activity`)).body.activity;
    expect(activity.filter((a: any) => a.action === "HARD_COPY")).toHaveLength(3);
  });

  it("the traveller, the Manager and a stranger are refused; unchanged and invalid statuses are refused", async () => {
    const id = await tourAtSettlement("ADMIN");
    for (const as of [ACT.traveller, ACT.manager, ACT.stranger]) {
      const r = await patch(as, `/requests/${id}/hard-copy`, { status: "RECEIVED_AT_FINANCE" });
      expect(r.status).toBe(403);
    }
    expect((await patch(ACT.finance, `/requests/${id}/hard-copy`, { status: "SUBMITTED_TO_ADMIN" })).status).toBe(400);
    expect((await patch(ACT.finance, `/requests/${id}/hard-copy`, { status: "NOT_CAPTURED" })).status).toBe(400);
    expect(await hc(id)).toBe("SUBMITTED_TO_ADMIN");
    expect(await hcEntries(id)).toHaveLength(1);
  });

  it("refused before the report is submitted, and on a claim", async () => {
    const id = await tourAtReport();
    expect((await patch(ACT.finance, `/requests/${id}/hard-copy`, { status: "PENDING" })).status).toBe(409);
    const claim = String(
      ok(await post(ACT.traveller, "/requests", { formType: "LOCAL_TRAVEL_CLAIM", purpose: "QC", departureDate: "2026-10-05", returnDate: "2026-10-09", travelLines: [], foodLines: [], otherExpenses: 100 })).body.request._id,
    );
    expect((await patch(ACT.admin, `/requests/${claim}/hard-copy`, { status: "PENDING" })).status).toBe(409);
  });
});

describe("Display — every login sees the status; Finance's queue carries it", () => {
  it("traveller, Manager, Official, Travel Desk, Finance and Admin all read it; only Desk / Finance / Admin may edit", async () => {
    const id = await tourWithFinance("ADMIN", "RECEIVED");
    const canEdit: Record<string, boolean> = { traveller: false, manager: false, official: true, desk: true, finance: true, admin: true };
    for (const [k, edit] of Object.entries(canEdit)) {
      const body = ok(await get((ACT as any)[k], `/requests/${id}`)).body;
      expect(body.request.hardCopy?.status, k).toBe("RECEIVED_AT_ADMIN");
      expect(body.canEditHardCopy, k).toBe(edit);
    }
    const q = ok(await get(ACT.finance, "/finance-queue")).body;
    expect(q.requests.find((r: any) => String(r._id) === id).hardCopy.status).toBe("RECEIVED_AT_ADMIN");
    ok(await post(ACT.finance, `/requests/${id}/finance/settle`, { hardCopy: "RECEIVED" }));
    const q2 = ok(await get(ACT.finance, "/finance-queue")).body;
    expect(q2.closed.find((r: any) => String(r._id) === id).hardCopy.status).toBe("RECEIVED_AT_FINANCE");
  });

  it("a hard-copy change does not make the packet / approval PDFs stale", async () => {
    const id = await tourAtSettlement("ADMIN");
    await col("csteptravelrequests").updateOne({ _id: id$(id) }, { $set: { packetStale: false, pdfStale: false } });
    ok(await patch(ACT.official, `/requests/${id}/hard-copy`, { status: "RECEIVED_AT_ADMIN" }));
    const d = await reqDoc(id);
    expect([d.packetStale, d.pdfStale]).toEqual([false, false]);
  });
});

describe("Mail gate — CSTEP_NOTIFICATIONS_ENABLED", () => {
  it("off: every No still records, but no L1 / L2 / L3 mail is queued", async () => {
    process.env.CSTEP_NOTIFICATIONS_ENABLED = "";
    try {
      const id = await tourWithFinance("NO", "NOT_RECEIVED");
      ok(await post(ACT.finance, `/requests/${id}/finance/settle`, { hardCopy: "NOT_RECEIVED" }));
      expect(await hc(id)).toBe("PENDING");
      expect((await hcEntries(id)).map((e: any) => e.hardCopyChange.source)).toEqual(["TRAVELLER_SUBMIT", "ADMIN_FINALIZE", "FINANCE_SETTLE"]);
      expect(await col("emailoutboxes").countDocuments({ requestId: id$(id) })).toBe(0);
    } finally {
      process.env.CSTEP_NOTIFICATIONS_ENABLED = "true";
    }
  });
});
