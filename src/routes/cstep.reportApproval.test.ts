// apps/backend/src/routes/cstep.reportApproval.test.ts
//
// CSTEP report approval — the post-tour Travel Report goes to the Manager
// (the traveller's Tour Approver) before the Travel Desk (Official):
//
//   report/submit → REPORT_UNDER_APPROVAL (Manager's queue)
//     → report/approve → REPORT_SUBMITTED (Official) → settlement, unchanged
//     → report/return (Manager) → REPORT_PENDING → resubmit → Manager again
//
// Proves nothing vanishes at the new status: the Manager's Approvals queue,
// the Admin's, the Official's Processing board, the My Team report, the
// Travel Register, vendor payment and the traveller's own list all still show
// the case. Also: who may act at each step, the Admin fallback for a
// traveller with no Manager, and that a case already at REPORT_SUBMITTED
// before this change stays with the Official, untouched.
//
// Real: cstep router, models, the register workbook, in-memory Mongo REPLICA
//   SET (approve runs a transaction) on a fresh database, cstep_qc_report_approval.
// Stubbed: S3, mail, the PDF helpers, auth (x-test-user) and the workspace
//   resolver (x-test-ws). Notifications stay off here — routing of the emails
//   is cstep.notifications.test.ts's.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
// config/env.ts requires these at import; none of them is ever used here.
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_report_approval";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
delete process.env.CSTEP_NOTIFICATIONS_ENABLED;

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      return {};
    }
  },
  PutObjectCommand: class {},
  GetObjectCommand: class {},
}));
vi.mock("../utils/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: vi.fn(async () => ({ key: "qc" })),
  getObjectBuffer: vi.fn(async () => Buffer.from("")),
}));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async () => "http://qc/presigned") }));
vi.mock("../utils/cstepEventRequestPdf.js", () => ({ uploadCstepEventRequestPdf: vi.fn(async () => ({ key: "qc-event" })) }));
vi.mock("../utils/cstepPacketPdf.js", () => ({ uploadCstepPacketPdf: vi.fn(async () => ({ key: "qc-packet" })) }));

const { default: cstepRouter } = await import("./cstep.js");
const { CSTEP_VENDOR_PAYABLE_STATUSES } = await import("../models/cstep/CstepArrangement.js");

const DB = "cstep_qc_report_approval";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
const QC_PROJECT = oid();
const U = { traveller: oid(), solo: oid(), manager: oid(), official: oid(), finance: oid(), admin: oid(), stranger: oid() };
// main: the full mapping. solo: no Manager at all (the Admin fallback).
const TP = { main: oid(), solo: oid() };

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

const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"]) => ({
  _id: String(id), id: String(id), sub: String(id), email: `${id}@qc.local`, roles, workspaceId: String(WS),
});
const ACT = {
  traveller: who(U.traveller),
  solo: who(U.solo),
  manager: who(U.manager),
  official: who(U.official),
  finance: who(U.finance),
  admin: who(U.admin, ["ADMIN"]),
  stranger: who(U.stranger),
};
const send = (method: "get" | "post", as: any, path: string, body?: any) => {
  const r = request(app)[method](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS));
  return body === undefined ? r : r.send(body);
};
const get = (as: any, path: string) => send("get", as, path);
const post = (as: any, path: string, body: any = {}) =>
  send("post", as, path, path === "/requests" && body.projectId === undefined ? { ...body, projectId: String(QC_PROJECT) } : body);
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};

const TOUR = {
  type: "DOMESTIC",
  purpose: "QC field visit",
  departureDate: "2026-11-02",
  returnDate: "2026-11-04",
  stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }],
  modesRequested: ["AIR"],
  transportRequired: false,
  accommodationRequired: false,
  sponsored: false,
};

/** A Tour filed by `owner`, approved by `approver`, arranged by the
 * Official and with its report started — i.e. at REPORT_PENDING. */
async function tourAtReportPending(owner: any, approver: any, purpose: string): Promise<string> {
  const r = ok(await post(owner, "/requests", { ...TOUR, purpose }));
  const id = String(r.body.request._id);
  ok(await post(approver, `/requests/${id}/approve`));
  ok(await post(ACT.official, `/requests/${id}/start-arranging`));
  ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
  ok(await post(owner, `/requests/${id}/report/start`));
  return id;
}
const statusOf = async (id: string) => (await col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(id) }))!.status;
const lastLog = async (id: string) =>
  (await col("cstepapprovals").find({ entityId: new mongoose.Types.ObjectId(id) }).sort({ _id: -1 }).limit(1).toArray())[0];
const ids = (rows: any[]) => rows.map((r: any) => String(r._id));

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

  await col("cstepprojects").insertOne({ _id: QC_PROJECT, workspaceId: WS, projectCode: "PRJ-QC", projectName: "QC Project", tallyProjectCC: "100 QC 01", isActive: true } as any);
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany((Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: `${U[k]}@qc.local`, roles: ["REQUESTER"], workspaceId: WS })) as any[]);
  await col("travellerprofiles").insertMany([
    {
      _id: TP.main, workspaceId: WS, travelerId: "CSTEP-001", firstName: "Asha", lastName: "Rao", isActive: true,
      email: `${U.traveller}@qc.local`, claimedBy: U.traveller,
      tourApproverId: U.manager, officialUserId: U.official, financeUserId: U.finance,
    },
    {
      _id: TP.solo, workspaceId: WS, travelerId: "CSTEP-002", firstName: "Solo", lastName: "Nomanager", isActive: true,
      email: `${U.solo}@qc.local`, claimedBy: U.solo, officialUserId: U.official, financeUserId: U.finance,
    },
  ] as any[]);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("submit → REPORT_UNDER_APPROVAL → approve → REPORT_SUBMITTED → settlement", () => {
  let id = "";

  it("report/submit puts the report with the Manager, not the Official", async () => {
    id = await tourAtReportPending(ACT.traveller, ACT.manager, "QC main flow");
    const r = ok(await post(ACT.traveller, `/requests/${id}/report/submit`));
    expect(r.body.request.status).toBe("REPORT_UNDER_APPROVAL");
    expect(await lastLog(id)).toMatchObject({ action: "SUBMIT_REPORT", stage: "TRAVELER" });
  });

  it("the case shows in every queue, board and register at the new status", async () => {
    // The Manager's Approvals queue, and the Admin's.
    const mine = ok(await get(ACT.manager, "/approvals")).body.requests;
    expect(mine.find((r: any) => r._id === id)?.status).toBe("REPORT_UNDER_APPROVAL");
    expect(ids(ok(await get(ACT.admin, "/approvals")).body.requests)).toContain(id);
    // …never the Official's Approvals.
    expect(ids(ok(await get(ACT.official, "/approvals")).body.requests)).not.toContain(id);

    // The Official's Processing board keeps it, at its own stage.
    const board = ok(await get(ACT.official, "/official-queue")).body;
    expect(board.requests.find((r: any) => r._id === id)?.status).toBe("REPORT_UNDER_APPROVAL");
    expect(board.stageCounts.REPORT_UNDER_APPROVAL).toBe(1);
    expect(ids(ok(await get(ACT.admin, "/official-queue")).body.requests)).toContain(id);

    // The Manager's My Team report: Pending.
    const team = ok(await get(ACT.manager, "/approver-report?period=fy&anchor=2026-11-02")).body;
    expect(ids(team.buckets.pending)).toContain(id);
    expect(ids(team.buckets.planned)).not.toContain(id);

    // The traveller's own list.
    expect(ids(ok(await get(ACT.traveller, "/requests")).body.requests)).toContain(id);

    // Vendor payment stays open on its lines. The Vendor payments list and
    // its payment import read CSTEP_VENDOR_PAYABLE_STATUSES (the Tally export
    // goes by paid-on date, not request status).
    expect(ok(await get(ACT.finance, `/requests/${id}`)).body.canPayVendors).toBe(true);
    expect(CSTEP_VENDOR_PAYABLE_STATUSES).toContain("REPORT_UNDER_APPROVAL");

    // The Travel Register labels it.
    const reg = await get(ACT.admin, "/reports/travel-register?period=custom&from=2026-11-01&to=2026-11-30")
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(reg.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(reg.body as any);
    let labelled = false;
    wb.getWorksheet("Travel Register")!.eachRow((row) =>
      row.eachCell((c) => {
        if (String(c.value ?? "").includes("Travel report with the manager")) labelled = true;
      }),
    );
    expect(labelled).toBe(true);
  });

  it("detail flags: the Manager may approve the report (an Admin only sends it back); the Official may not settle yet", async () => {
    expect(ok(await get(ACT.manager, `/requests/${id}`)).body.canApproveReport).toBe(true);
    // The traveller has a Manager, so the Admin is no longer a blanket
    // fallback here (cstep.approvalGate.test.ts) — they keep the send-back.
    expect(ok(await get(ACT.admin, `/requests/${id}`)).body).toMatchObject({ canApproveReport: false, canDecideReport: true });
    const asOfficial = ok(await get(ACT.official, `/requests/${id}`)).body;
    expect(asOfficial.canApproveReport).toBe(false);
    expect(asOfficial.canSettle).toBe(false);
    expect(ok(await get(ACT.traveller, `/requests/${id}`)).body.canApproveReport).toBe(false);
    // The Manager can read the report they are approving.
    expect((await get(ACT.manager, `/requests/${id}/report`)).status).toBe(200);
  });

  it("nobody else can move it: the Official, the traveller, a stranger", async () => {
    expect((await post(ACT.official, `/requests/${id}/settlement/start`)).status).toBe(409);
    expect((await post(ACT.official, `/requests/${id}/report/approve`)).status).toBe(403);
    expect((await post(ACT.official, `/requests/${id}/report/return`, { reason: "x" })).status).toBe(403);
    expect((await post(ACT.traveller, `/requests/${id}/report/approve`)).status).toBe(403);
    expect((await post(ACT.stranger, `/requests/${id}/report/approve`)).status).toBe(403);
    // Same rule as REPORT_SUBMITTED: a filed report can no longer be cancelled.
    expect((await post(ACT.traveller, `/requests/${id}/cancel`, { reason: "x" })).status).toBe(409);
    expect(await statusOf(id)).toBe("REPORT_UNDER_APPROVAL");
  });

  it("the Manager sends it back with a reason → REPORT_PENDING; the resubmit returns to the Manager", async () => {
    expect((await post(ACT.manager, `/requests/${id}/report/return`, {})).status).toBe(400);
    const r = ok(await post(ACT.manager, `/requests/${id}/report/return`, { reason: "Hotel bill missing" }));
    expect(r.body.request.status).toBe("REPORT_PENDING");
    expect(await lastLog(id)).toMatchObject({ action: "RETURN_REPORT", stage: "APPROVER", comment: "Hotel bill missing", actor: U.manager });

    ok(await post(ACT.traveller, `/requests/${id}/report/submit`));
    expect(await statusOf(id)).toBe("REPORT_UNDER_APPROVAL");
    expect(ids(ok(await get(ACT.manager, "/approvals")).body.requests)).toContain(id);
  });

  it("the Manager approves → REPORT_SUBMITTED, logged APPROVE_REPORT, and it moves to the Official", async () => {
    const r = ok(await post(ACT.manager, `/requests/${id}/report/approve`, { comment: "Bills check out" }));
    expect(r.body.request.status).toBe("REPORT_SUBMITTED");
    expect(await lastLog(id)).toMatchObject({ action: "APPROVE_REPORT", stage: "APPROVER", comment: "Bills check out", actor: U.manager });
    expect((await post(ACT.manager, `/requests/${id}/report/approve`)).status).toBe(409);

    expect(ids(ok(await get(ACT.manager, "/approvals")).body.requests)).not.toContain(id);
    const board = ok(await get(ACT.official, "/official-queue")).body;
    expect(board.requests.find((r: any) => r._id === id)?.status).toBe("REPORT_SUBMITTED");
    expect(board.stageCounts.REPORT_UNDER_APPROVAL).toBe(0);
    expect(ok(await get(ACT.official, `/requests/${id}`)).body.canSettle).toBe(true);

    // My Team: out of Pending; Approved by me dated by the report approval.
    const team = ok(await get(ACT.manager, "/approver-report?period=fy&anchor=2026-11-02")).body;
    expect(ids(team.buckets.pending)).not.toContain(id);
    expect(ids(team.buckets.planned)).toContain(id);
    const mine = team.buckets.approvedByMe.find((r: any) => r._id === id);
    const reportApproval = await lastLog(id);
    expect(mine.approvedAt).toBe(reportApproval.at);
  });

  it("the settlement path after approval is unchanged", async () => {
    ok(await post(ACT.official, `/requests/${id}/settlement/start`));
    const f = ok(await post(ACT.official, `/requests/${id}/settlement/finalize`, { force: true }));
    expect(["SETTLED", "TRANSFERRED_TO_FINANCE"]).toContain(f.body.request.status);
  });
});

describe("the Official's send-back at REPORT_SUBMITTED is unchanged", () => {
  it("Official returns → REPORT_PENDING (stage OFFICIAL); the Manager cannot return at that stage; resubmit goes to the Manager", async () => {
    const id = await tourAtReportPending(ACT.traveller, ACT.manager, "QC official send-back");
    ok(await post(ACT.traveller, `/requests/${id}/report/submit`));
    ok(await post(ACT.manager, `/requests/${id}/report/approve`));
    ok(await post(ACT.official, `/requests/${id}/settlement/start`));

    // At REPORT_SUBMITTED the report is the Official's — the Manager has no say.
    expect((await post(ACT.manager, `/requests/${id}/report/return`, { reason: "late" })).status).toBe(403);

    const r = ok(await post(ACT.official, `/requests/${id}/report/return`, { reason: "Boarding pass missing" }));
    expect(r.body.request.status).toBe("REPORT_PENDING");
    expect(await lastLog(id)).toMatchObject({ action: "RETURN_REPORT", stage: "OFFICIAL" });
    // The VERIFYING settlement is discarded, as before.
    expect(await col("cstepsettlements").countDocuments({ requestId: new mongoose.Types.ObjectId(id) })).toBe(0);

    ok(await post(ACT.traveller, `/requests/${id}/report/submit`));
    expect(await statusOf(id)).toBe("REPORT_UNDER_APPROVAL");
  });
});

describe("Admin fallback — a traveller with no Manager", () => {
  it("the report lands in the Admin's queue flagged unassigned, and the Admin approves it", async () => {
    const id = await tourAtReportPending(ACT.solo, ACT.admin, "QC no manager");
    ok(await post(ACT.solo, `/requests/${id}/report/submit`));
    const row = ok(await get(ACT.admin, "/approvals")).body.requests.find((r: any) => r._id === id);
    expect(row).toMatchObject({ status: "REPORT_UNDER_APPROVAL", unassigned: true });
    // Nobody but the Admin can act on it.
    expect((await post(ACT.manager, `/requests/${id}/report/approve`)).status).toBe(403);

    const r = ok(await post(ACT.admin, `/requests/${id}/report/approve`));
    expect(r.body.request.status).toBe("REPORT_SUBMITTED");
    expect(await lastLog(id)).toMatchObject({ action: "APPROVE_REPORT", actor: U.admin });
  });
});

describe("cases already at REPORT_SUBMITTED before this change", () => {
  const legacy = oid();
  beforeAll(async () => {
    // As written before report approval existed: SUBMIT_REPORT straight to
    // REPORT_SUBMITTED, no APPROVE_REPORT anywhere.
    await col("csteptravelrequests").insertOne({
      _id: legacy, workspaceId: WS, travelerProfileId: TP.main, formType: "TOUR_PROPOSAL", type: "DOMESTIC",
      purpose: "QC legacy report", stations: [{ from: "Bengaluru", to: "Pune" }], countries: [], modesRequested: ["AIR"],
      transportRequired: false, accommodationRequired: false, sponsored: false, status: "REPORT_SUBMITTED",
      departureDate: "2026-10-05", returnDate: "2026-10-07", createdBy: U.traveller, claimReference: "0099/1026",
      createdAt: new Date("2026-10-01"), updatedAt: new Date("2026-10-08"),
    } as any);
    await col("cstepapprovals").insertOne({
      workspaceId: WS, entityType: "REQUEST", entityId: legacy, stage: "TRAVELER", actor: U.traveller, action: "SUBMIT_REPORT", at: "2026-10-08T05:00:00.000Z",
    } as any);
  });

  it("stay with the Official: on the board at REPORT_SUBMITTED, never in the Manager's queue", async () => {
    const board = ok(await get(ACT.official, "/official-queue")).body;
    expect(board.requests.find((r: any) => r._id === String(legacy))?.status).toBe("REPORT_SUBMITTED");
    expect(ids(ok(await get(ACT.manager, "/approvals")).body.requests)).not.toContain(String(legacy));
    const team = ok(await get(ACT.manager, "/approver-report?period=fy&anchor=2026-10-05")).body;
    expect(ids(team.buckets.pending)).not.toContain(String(legacy));
    expect(ids(team.buckets.planned)).toContain(String(legacy));
  });

  it("the Manager cannot approve it after the fact; the Official settles it as before", async () => {
    expect(ok(await get(ACT.manager, `/requests/${legacy}`)).body.canApproveReport).toBe(false);
    expect((await post(ACT.manager, `/requests/${legacy}/report/approve`)).status).toBe(409);
    expect(ok(await get(ACT.official, `/requests/${legacy}`)).body.canSettle).toBe(true);
    ok(await post(ACT.official, `/requests/${legacy}/settlement/start`));
    expect(await statusOf(String(legacy))).toBe("REPORT_SUBMITTED");
  });
});
