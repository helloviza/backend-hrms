// apps/backend/src/routes/cstep.approverReport.test.ts
//
// CSTEP My Team report (GET /approver-report): which request lands in which
// bucket for a manager (the Tour Approver slot), the money columns each
// bucket carries, the period filter (pending is never filtered), and
// "Approved by me" read from the approval log rather than the current
// mapping. Also my-roles' isTourApprover flag, and the Travel Register
// export opened to an Approver for their own team.
//
// Real: cstep router, models, the register workbook, in-memory Mongo REPLICA
//   SET (the approve test runs a real transaction) on a fresh database,
//   cstep_qc_approver_report. Fixtures are raw inserts, so absent fields stay
//   absent the way they are on prod rows.
// Stubbed: S3, mail, the PDF helpers, auth (x-test-user) and the workspace
//   resolver (x-test-ws).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
// config/env.ts requires these at import; none of them is ever used here.
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_approver_report";
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

const DB = "cstep_qc_approver_report";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
const U = { manager: oid(), otherManager: oid(), traveller: oid(), finance: oid(), admin: oid(), nobody: oid() };
// alpha / beta are the manager's team; gamma is another manager's; moved was
// the manager's once, and has since been given to the other manager.
const TP = { alpha: oid(), beta: oid(), gamma: oid(), moved: oid() };

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
  manager: who(U.manager),
  otherManager: who(U.otherManager),
  finance: who(U.finance),
  admin: who(U.admin, ["ADMIN"]),
  nobody: who(U.nobody),
};
const get = (as: any, path: string) =>
  request(app).get(`/api/cstep${path}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS));
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};

// FY 2026-27 (1 Apr 2026 – 31 Mar 2027) — every report call pins it.
const FY = "?period=fy&anchor=2026-10-15";
const report = async (as: any, query = FY) => ok(await get(as, `/approver-report${query}`)).body;
const ids = (rows: any[]) => rows.map((r) => r._id).sort();

// One request per case. `in` = departure inside FY 2026-27, `out` = before it.
const R = {
  pendingOld: oid(), // SUBMITTED, departure outside the period — still pending
  approved: oid(), // APPROVED tour, estimated cost
  reportSubmitted: oid(), // REPORT_SUBMITTED (beta)
  reimbursed: oid(), // REIMBURSED tour, finalized settlement
  claimWithFinance: oid(), // TRANSFERRED_TO_FINANCE Local Travel Claim (beta)
  rejected: oid(),
  cancelled: oid(),
  draft: oid(), // with the traveller — no bucket
  returned: oid(), // with the traveller — no bucket
  outOfPeriod: oid(), // APPROVED, departure in the previous FY
  othersTeam: oid(), // SETTLED, gamma (the other manager's team)
  movedTraveller: oid(), // APPROVED, moved — approved by the manager back when moved was theirs
  approvedLastFy: oid(), // REIMBURSED, approved by the manager in the previous FY
  forApprove: oid(), // SUBMITTED, approved through the real route in the last test
};

const IN = "2026-10-20";
const OUT = "2026-02-10";
const reqDoc = (id: mongoose.Types.ObjectId, tp: mongoose.Types.ObjectId, status: string, departureDate: string, over: any = {}) => ({
  _id: id,
  workspaceId: WS,
  travelerProfileId: tp,
  formType: "TOUR_PROPOSAL",
  type: "DOMESTIC",
  purpose: `QC ${status}`,
  stations: [{ from: "Bengaluru", to: "Delhi" }],
  countries: [],
  modesRequested: ["AIR"],
  transportRequired: false,
  accommodationRequired: false,
  sponsored: false,
  status,
  departureDate,
  returnDate: departureDate,
  createdBy: U.traveller,
  createdAt: new Date("2026-04-02T05:00:00Z"),
  updatedAt: new Date("2026-10-01T05:00:00Z"),
  ...over,
});
const log = (entityId: mongoose.Types.ObjectId, actor: mongoose.Types.ObjectId, action: string, at: string) => ({
  workspaceId: WS, entityType: "REQUEST", entityId, stage: "APPROVER", actor, action, at,
});

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

  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany((Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: `${U[k]}@qc.local`, roles: ["REQUESTER"], workspaceId: WS })) as any[]);
  const tp = (_id: mongoose.Types.ObjectId, travelerId: string, firstName: string, approver: mongoose.Types.ObjectId) => ({
    _id, workspaceId: WS, travelerId, firstName, lastName: "QC", isActive: true, email: `${travelerId}@qc.local`,
    tourApproverId: approver, financeUserId: U.finance,
  });
  await col("travellerprofiles").insertMany([
    tp(TP.alpha, "CSTEP-A", "Alpha", U.manager),
    tp(TP.beta, "CSTEP-B", "Beta", U.manager),
    tp(TP.gamma, "CSTEP-G", "Gamma", U.otherManager),
    tp(TP.moved, "CSTEP-M", "Moved", U.otherManager),
  ] as any[]);

  await col("csteptravelrequests").insertMany([
    reqDoc(R.pendingOld, TP.alpha, "SUBMITTED", OUT, { estimatedCost: 900 }),
    reqDoc(R.approved, TP.alpha, "APPROVED", IN, { estimatedCost: 5000 }),
    reqDoc(R.reportSubmitted, TP.beta, "REPORT_SUBMITTED", IN),
    reqDoc(R.reimbursed, TP.alpha, "REIMBURSED", IN, { estimatedCost: 15000 }),
    reqDoc(R.claimWithFinance, TP.beta, "TRANSFERRED_TO_FINANCE", IN, {
      formType: "LOCAL_TRAVEL_CLAIM",
      type: undefined,
      claimTotals: { travel: 800, food: 0, other: 0, gross: 800, advance: 200, net: 600, dueByCstep: 600, dueToCstep: 0 },
    }),
    reqDoc(R.rejected, TP.alpha, "REJECTED", IN),
    reqDoc(R.cancelled, TP.beta, "CANCELLED", IN),
    reqDoc(R.draft, TP.alpha, "DRAFT", IN),
    reqDoc(R.returned, TP.alpha, "RETURNED", IN),
    reqDoc(R.outOfPeriod, TP.alpha, "APPROVED", OUT),
    reqDoc(R.othersTeam, TP.gamma, "SETTLED", IN),
    reqDoc(R.movedTraveller, TP.moved, "APPROVED", IN),
    reqDoc(R.approvedLastFy, TP.alpha, "REIMBURSED", OUT),
    reqDoc(R.forApprove, TP.beta, "SUBMITTED", IN, { estimatedCost: 1234 }),
  ] as any[]);

  await col("cstepsettlements").insertOne({
    _id: oid(), workspaceId: WS, requestId: R.reimbursed, status: "FINALIZED",
    totalCostOfTour: 12000, amountClaimed: 3000, perDiem: { days: 1, rate: 1000, currency: "INR", amountInr: 1000, computedDays: 1 },
  } as any);

  await col("cstepapprovals").insertMany([
    log(R.approved, U.manager, "APPROVE", "2026-09-30T06:00:00.000Z"),
    log(R.reimbursed, U.manager, "APPROVE", "2026-08-01T06:00:00.000Z"),
    log(R.movedTraveller, U.manager, "APPROVE", "2026-09-01T06:00:00.000Z"),
    log(R.approvedLastFy, U.manager, "APPROVE", "2026-01-15T06:00:00.000Z"), // before FY 2026-27
    log(R.rejected, U.manager, "REJECT", "2026-09-02T06:00:00.000Z"), // not an approval
    log(R.reportSubmitted, U.manager, "SUBMIT", "2026-09-03T06:00:00.000Z"), // not an approval
    log(R.othersTeam, U.otherManager, "APPROVE", "2026-09-04T06:00:00.000Z"), // someone else's
  ] as any[]);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("GET /approver-report — buckets", () => {
  it("puts each team request in exactly one status bucket, leaving drafts, returned and other teams out", async () => {
    const body = await report(ACT.manager);
    expect(body.teamSize).toBe(2);
    expect(body.period).toEqual({ kind: "fy", from: "2026-04-01", to: "2027-03-31" });
    expect(ids(body.buckets.pending)).toEqual(ids([{ _id: String(R.pendingOld) }, { _id: String(R.forApprove) }]));
    expect(ids(body.buckets.planned)).toEqual([String(R.approved), String(R.reportSubmitted)].sort());
    expect(ids(body.buckets.closed)).toEqual([String(R.reimbursed), String(R.claimWithFinance)].sort());
    expect(ids(body.buckets.rejected)).toEqual([String(R.rejected)]);
    expect(ids(body.buckets.cancelled)).toEqual([String(R.cancelled)]);
    expect(body.counts).toEqual({ pending: 2, approvedByMe: 3, planned: 2, closed: 2, rejected: 1, cancelled: 1 });

    const everyTeamRow = ["pending", "planned", "closed", "rejected", "cancelled"].flatMap((k) => body.buckets[k]).map((r: any) => r._id);
    for (const id of [R.draft, R.returned, R.othersTeam, R.movedTraveller, R.outOfPeriod]) {
      expect(everyTeamRow).not.toContain(String(id));
    }
  });

  it("pending ignores the period — an old submission still waits on the manager", async () => {
    const body = await report(ACT.manager, "?period=month&anchor=2026-12-01");
    expect(ids(body.buckets.pending)).toEqual([String(R.pendingOld), String(R.forApprove)].sort());
    expect(body.counts.planned).toBe(0);
    expect(body.counts.closed).toBe(0);
  });

  it("planned rows carry the estimated cost; closed rows the settlement's figures, claims their stored totals", async () => {
    const body = await report(ACT.manager);
    const by = (k: string, id: mongoose.Types.ObjectId) => body.buckets[k].find((r: any) => r._id === String(id));

    expect(by("planned", R.approved).amounts).toMatchObject({ estimatedCost: 5000, costOfTour: null, amountClaimed: null });
    expect(by("planned", R.approved).travellerName).toBe("Alpha QC");
    // No estimate on the proposal — null, never a made-up zero.
    expect(by("planned", R.reportSubmitted).amounts.estimatedCost).toBeNull();

    expect(by("closed", R.reimbursed).amounts).toMatchObject({
      estimatedCost: 15000, costOfTour: 12000, amountClaimed: 3000, settlementStatus: "FINALIZED",
    });
    expect(by("closed", R.claimWithFinance).amounts).toMatchObject({
      estimatedCost: null, costOfTour: null, amountClaimed: 800, claimNet: 600,
    });
  });

  it("previous-period trips fall out of planned / closed", async () => {
    const body = await report(ACT.manager, "?period=fy&anchor=2026-02-01"); // FY 2025-26
    expect(ids(body.buckets.planned)).toEqual([String(R.outOfPeriod)]);
    expect(ids(body.buckets.closed)).toEqual([String(R.approvedLastFy)]);
  });
});

describe("GET /approver-report — Approved by me comes from the approval log", () => {
  it("lists the caller's APPROVE entries in the period, newest first, with the request's status now", async () => {
    const body = await report(ACT.manager);
    expect(body.buckets.approvedByMe.map((r: any) => r._id)).toEqual([
      String(R.approved), // 30 Sep
      String(R.movedTraveller), // 1 Sep
      String(R.reimbursed), // 1 Aug
    ]);
    const reimbursed = body.buckets.approvedByMe.find((r: any) => r._id === String(R.reimbursed));
    expect(reimbursed.status).toBe("REIMBURSED");
    expect(reimbursed.approvedAt).toBe("2026-08-01T06:00:00.000Z");
    expect(reimbursed.amounts.costOfTour).toBe(12000);
  });

  it("keeps a request whose traveller has since moved to another approver", async () => {
    const body = await report(ACT.manager);
    const moved = body.buckets.approvedByMe.find((r: any) => r._id === String(R.movedTraveller));
    expect(moved).toBeTruthy();
    expect(moved.travellerName).toBe("Moved QC");
    // …while the current mapping puts its live status with the new approver.
    expect(ids(body.buckets.planned)).not.toContain(String(R.movedTraveller));
    const theirs = await report(ACT.otherManager);
    expect(ids(theirs.buckets.planned)).toEqual([String(R.movedTraveller)]);
    expect(theirs.buckets.approvedByMe.map((r: any) => r._id)).toEqual([String(R.othersTeam)]);
  });

  it("an approval outside the period is left out; REJECT / SUBMIT entries never count", async () => {
    const body = await report(ACT.manager);
    const approved = body.buckets.approvedByMe.map((r: any) => r._id);
    expect(approved).not.toContain(String(R.approvedLastFy));
    expect(approved).not.toContain(String(R.rejected));
    expect(approved).not.toContain(String(R.reportSubmitted));
    const lastFy = await report(ACT.manager, "?period=fy&anchor=2026-02-01");
    expect(lastFy.buckets.approvedByMe.map((r: any) => r._id)).toEqual([String(R.approvedLastFy)]);
  });

  it("an approval through the real approve route shows up in Approved by me and moves the request to planned", async () => {
    ok(await request(app)
      .post(`/api/cstep/requests/${R.forApprove}/approve`)
      .set("x-test-user", JSON.stringify(ACT.manager))
      .set("x-test-ws", String(WS))
      .send({}));
    const body = await report(ACT.manager);
    expect(body.buckets.approvedByMe[0]._id).toBe(String(R.forApprove));
    expect(body.buckets.approvedByMe[0].status).toBe("APPROVED");
    expect(ids(body.buckets.pending)).toEqual([String(R.pendingOld)]);
    expect(body.buckets.planned.find((r: any) => r._id === String(R.forApprove)).amounts.estimatedCost).toBe(1234);
  });
});

describe("GET /approver-report — scope", () => {
  it("is the caller's own team even for a CSTEP Admin; nobody's report is empty, not a 403", async () => {
    const admin = await report(ACT.admin);
    expect(admin.teamSize).toBe(0);
    expect(Object.values(admin.counts).every((n) => n === 0)).toBe(true);
    const nobody = await report(ACT.nobody);
    expect(nobody.teamSize).toBe(0);
    expect(nobody.counts.pending).toBe(0);
  });

  it("a bad period is a 400", async () => {
    const r = await get(ACT.manager, "/approver-report?period=custom&from=2026-10-01");
    expect(r.status).toBe(400);
  });
});

describe("GET /my-roles — isTourApprover", () => {
  it("is true only for a user actually named as someone's approver", async () => {
    expect(ok(await get(ACT.manager, "/my-roles")).body.isTourApprover).toBe(true);
    expect(ok(await get(ACT.finance, "/my-roles")).body.isTourApprover).toBe(false);
    // An Admin sees every queue (isApprover) but has no team of their own.
    const admin = ok(await get(ACT.admin, "/my-roles")).body;
    expect(admin.isApprover).toBe(true);
    expect(admin.isTourApprover).toBe(false);
  });
});

describe("GET /reports/travel-register — Approver scoping", () => {
  const download = (as: any) =>
    get(as, "/reports/travel-register?period=fy&anchor=2026-10-15")
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
  const namesIn = async (body: Buffer) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(body as any);
    const seen = new Set<string>();
    wb.getWorksheet("Travel Register")!.eachRow((row) =>
      row.eachCell((cell) => {
        const v = String(cell.value ?? "");
        for (const n of ["Alpha QC", "Beta QC", "Gamma QC", "Moved QC"]) if (v.includes(n)) seen.add(n);
      }),
    );
    return [...seen].sort();
  };

  it("an Approver gets their own team's trips only", async () => {
    const r = await download(ACT.manager);
    expect(r.status).toBe(200);
    expect(await namesIn(r.body)).toEqual(["Alpha QC", "Beta QC"]);
  });

  it("a Finance user still gets every traveller they pay", async () => {
    const r = await download(ACT.finance);
    expect(r.status).toBe(200);
    expect(await namesIn(r.body)).toEqual(["Alpha QC", "Beta QC", "Gamma QC", "Moved QC"]);
  });

  it("anyone in no slot is refused", async () => {
    const r = await get(ACT.nobody, "/reports/travel-register?period=fy&anchor=2026-10-15");
    expect(r.status).toBe(403);
  });
});
