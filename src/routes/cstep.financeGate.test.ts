// apps/backend/src/routes/cstep.financeGate.test.ts
//
// Payments are recorded by the traveller's assigned Finance user only
// (routes/cstep.ts callerPaymentRefusal) — every payment-recording action:
//   - the reimbursement, POST /requests/:id/finance/settle (Tour and claim);
//   - a vendor line marked paid / unpaid, PATCH …/arrangements/:lineId/payment;
//   - the vendor-payables import, POST /vendor-payables/import/*.
// No CSTEP Admin, no Official, no fallback: a traveller with no Finance user
// is blocked for everyone ("assign a finance user first"). Seeing the vendor
// ledger, setting a missing amount and Finance's send-back keep their own
// (wider) rules, and the arrange → report → settlement → finance sequence is
// unchanged.
//
// Real: cstep + vendor-payables routers, models, in-memory Mongo REPLICA SET
//   (approve runs in a transaction) on a fresh database, cstep_qc_fingate.
// Stubbed: mail, S3 + PDF helpers, auth (x-test-user) and the workspace
//   resolver.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_fingate";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";

vi.mock("../utils/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: vi.fn(async () => ({ key: "qc" })),
  getObjectBuffer: vi.fn(async () => Buffer.from("")),
}));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async () => "http://qc/presigned") }));
vi.mock("../utils/cstepEventRequestPdf.js", () => ({ uploadCstepEventRequestPdf: vi.fn(async () => ({})) }));
vi.mock("../utils/cstepPacketPdf.js", () => ({ uploadCstepPacketPdf: vi.fn(async () => ({})) }));

const { default: cstepRouter } = await import("./cstep.js");
const { default: vendorPayablesRouter } = await import("./cstep.vendorPayables.js");

const DB = "cstep_qc_fingate";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);
const ONLY = "Only the assigned finance user can record payments";
const NONE = "No finance user is assigned to this traveller — assign a finance user first";

const WS = oid();
const QC_PROJECT = oid();
const VENDOR = oid();
const U = {
  traveller: oid(), solo: oid(), selfFin: oid(), approver: oid(), official: oid(), finance: oid(), stranger: oid(),
  admin: oid(), hr: oid(), superadmin: oid(), leader: oid(), adminFinance: oid(),
};
const TP = { managed: oid(), unassigned: oid(), adminFinanced: oid() };

const app = express();
app.use(express.json());
const stamp = (req: any, _res: any, next: any) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  req.workspaceObjectId = WS;
  next();
};
app.use("/api/cstep/vendor-payables", stamp, vendorPayablesRouter);
app.use("/api/cstep", stamp, cstepRouter);

const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"], extra: any = {}) => ({
  _id: String(id), id: String(id), sub: String(id), email: `${String(id)}@qc.local`, roles, workspaceId: String(WS), ...extra,
});
const ACT = {
  traveller: who(U.traveller),
  solo: who(U.solo),
  selfFin: who(U.selfFin),
  approver: who(U.approver, ["APPROVER"]),
  official: who(U.official),
  finance: who(U.finance),
  stranger: who(U.stranger),
  admin: who(U.admin, ["ADMIN"]),
  hr: who(U.hr, ["HR"]),
  superadmin: who(U.superadmin, ["SUPERADMIN"]),
  leader: who(U.leader, ["CUSTOMER", "REQUESTER"], { customerMemberRole: "WORKSPACE_LEADER" }),
  // A CSTEP Admin who IS some traveller's assigned Finance user.
  adminFinance: who(U.adminFinance, ["ADMIN"]),
};
const ADMINS = [ACT.admin, ACT.hr, ACT.superadmin, ACT.leader];
const NOT_FINANCE = [...ADMINS, ACT.official, ACT.approver, ACT.stranger, ACT.traveller];
const send = (m: "get" | "post" | "patch", as: any, path: string, body?: any) => {
  const r = request(app)[m](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as));
  if (m === "get") return r;
  return r.send(path === "/requests" ? { projectId: String(QC_PROJECT), ...body } : body || {});
};
const get = (as: any, path: string) => send("get", as, path);
const post = (as: any, path: string, body?: any) => send("post", as, path, body);
const patch = (as: any, path: string, body?: any) => send("patch", as, path, body);
const upload = (step: "preview" | "commit", as: any, csv: string) =>
  request(app)
    .post(`/api/cstep/vendor-payables/import/${step}`)
    .set("x-test-user", JSON.stringify(as))
    .attach("file", Buffer.from(csv), { filename: "payments.csv", contentType: "text/csv" });
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const statusOf = async (id: string) => ok(await get(ACT.admin, `/requests/${id}`)).body.request.status;
const logs = (id: string, action: string) => col("cstepapprovals").countDocuments({ entityId: new mongoose.Types.ObjectId(id), action });
const lineOf = (lineId: string) => col("csteparrangements").findOne({ _id: new mongoose.Types.ObjectId(lineId) });

const TOUR = {
  type: "DOMESTIC",
  purpose: "QC finance gate",
  departureDate: "2026-11-02",
  returnDate: "2026-11-04",
  stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }],
  modesRequested: ["AIR"],
  transportRequired: false,
  accommodationRequired: false,
  sponsored: false,
};

/** A Tour filed by `as` and ARRANGED with one vendor-bearing Flight line (amount set, unpaid). */
async function arranged(as: any, purpose: string): Promise<{ id: string; lineId: string; ref: string }> {
  const id = String(ok(await post(as, "/requests", { ...TOUR, purpose })).body.request._id);
  const ref = ok(await post(ACT.approver, `/requests/${id}/approve`)).body.request.claimReference;
  const [line] = ok(await post(ACT.official, `/requests/${id}/start-arranging`)).body.arrangements;
  ok(await patch(ACT.official, `/requests/${id}/arrangements/${line._id}`, { vendorId: String(VENDOR), amount: 6400, currency: "INR", status: "ARRANGED" }));
  ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
  return { id, lineId: String(line._id), ref };
}

/** A Tour filed by `as`, taken through report and settlement to TRANSFERRED_TO_FINANCE (no vendor lines). */
async function withFinance(as: any, purpose: string): Promise<string> {
  const id = String(ok(await post(as, "/requests", { ...TOUR, purpose })).body.request._id);
  ok(await post(ACT.approver, `/requests/${id}/approve`));
  ok(await post(ACT.official, `/requests/${id}/start-arranging`));
  ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
  ok(await post(as, `/requests/${id}/report/start`));
  ok(await post(as, `/requests/${id}/report/submit`));
  ok(await post(ACT.approver, `/requests/${id}/report/approve`));
  ok(await post(ACT.official, `/requests/${id}/settlement/start`));
  ok(await patch(ACT.official, `/requests/${id}/settlement/perdiem`, { rate: 1500, rateReason: "QC rate" }));
  const r = ok(await post(ACT.official, `/requests/${id}/settlement/finalize`, { force: true }));
  expect(r.body.request.status).toBe("TRANSFERRED_TO_FINANCE");
  return id;
}

const paidCsv = (ref: string, paymentRef: string) =>
  ["Vendor Code,Reference,Payment Status,Paid On,Payment Ref", `CSTEPVEN0001,${ref},Paid,2026-10-20,${paymentRef}`].join("\n") + "\n";

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

  await col("cstepprojects").insertOne({ _id: QC_PROJECT, workspaceId: WS, projectCode: "PRJ-QC", projectName: "QC Project", tallyProjectCC: "100 QC 01", isActive: true } as any);
  await col("cstepvendors").insertOne({ _id: VENDOR, workspaceId: WS, vendorCode: "CSTEPVEN0001", name: "Skyline Travels", isActive: true } as any);
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany(
    (Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: `${String(U[k])}@qc.local`, roles: ["REQUESTER"], workspaceId: WS })) as any[],
  );
  const profile = (_id: mongoose.Types.ObjectId, code: string, extra: any) => ({
    _id, workspaceId: WS, travelerId: code, firstName: "Asha", lastName: code, isActive: true,
    tourApproverId: U.approver, officialUserId: U.official, ...extra,
  });
  await col("travellerprofiles").insertMany([
    profile(TP.managed, "CSTEP-001", { claimedBy: U.traveller, financeUserId: U.finance }),
    profile(TP.unassigned, "CSTEP-002", { claimedBy: U.solo }), // no financeUserId
    profile(TP.adminFinanced, "CSTEP-003", { claimedBy: U.selfFin, financeUserId: U.adminFinance }),
  ] as any[]);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("reimburse (finance/settle) — the assigned Finance user only", () => {
  let id = "";

  it("every Admin kind, the Official, the Approver, a stranger and the traveller are refused; nothing is recorded", async () => {
    id = await withFinance(ACT.traveller, "QC reimburse managed");
    for (const as of NOT_FINANCE) {
      const r = await post(as, `/requests/${id}/finance/settle`, { reference: "UTR-NO" });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(ONLY);
    }
    expect(await statusOf(id)).toBe("TRANSFERRED_TO_FINANCE");
    expect(await logs(id, "FINANCE_SETTLE")).toBe(0);
  });

  it("GET: the Admin keeps the Finance card (send back) but not the record button, and is told why", async () => {
    expect(ok(await get(ACT.admin, `/requests/${id}`)).body).toMatchObject({ canFinance: false, canFinanceDecide: true, paymentBlockedReason: ONLY });
    const f = ok(await get(ACT.finance, `/requests/${id}`)).body;
    expect(f).toMatchObject({ canFinance: true, canFinanceDecide: true });
    expect(f.paymentBlockedReason).toBeUndefined();
  });

  it("the assigned Finance user records it → REIMBURSED, logged once", async () => {
    expect(ok(await post(ACT.finance, `/requests/${id}/finance/settle`, { reference: "UTR-QC-1" })).body.request.status).toBe("REIMBURSED");
    expect(await logs(id, "FINANCE_SETTLE")).toBe(1);
  });

  it("send-back stays as it was: an Admin can still return a case to the Official", async () => {
    const x = await withFinance(ACT.traveller, "QC reimburse admin send-back");
    expect(ok(await post(ACT.admin, `/requests/${x}/finance/return`, { reason: "Per diem looks high" })).body.request.status).toBe("REPORT_SUBMITTED");
  });

  it("an Admin who IS the assigned Finance user records it as that user", async () => {
    const x = await withFinance(ACT.selfFin, "QC admin-as-finance");
    expect((await post(ACT.admin, `/requests/${x}/finance/settle`)).body.error).toBe(ONLY);
    expect(ok(await post(ACT.adminFinance, `/requests/${x}/finance/settle`)).body.request.status).toBe("REIMBURSED");
  });
});

describe("single-line vendor payment — the assigned Finance user only", () => {
  let t: { id: string; lineId: string; ref: string };

  it("the Official keeps the ledger past ARRANGED but can't pay; nor can any Admin", async () => {
    t = await arranged(ACT.traveller, "QC vendor line managed");
    const o = ok(await get(ACT.official, `/requests/${t.id}`)).body;
    expect(o).toMatchObject({ hasVendorLedger: true, canPayVendors: false, paymentBlockedReason: ONLY });
    expect(ok(await get(ACT.admin, `/requests/${t.id}`)).body).toMatchObject({ hasVendorLedger: true, canPayVendors: false });
    expect(ok(await get(ACT.finance, `/requests/${t.id}`)).body).toMatchObject({ hasVendorLedger: true, canPayVendors: true });
    for (const as of NOT_FINANCE) {
      const r = await patch(as, `/requests/${t.id}/arrangements/${t.lineId}/payment`, { paymentStatus: "PAID", paymentRef: "UTR-NO" });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(ONLY);
    }
    expect((await lineOf(t.lineId))!.paymentStatus).toBe("UNPAID");
    expect(await logs(t.id, "VENDOR_PAYMENT")).toBe(0);
  });

  it("the assigned Finance user marks it paid (logged as FINANCE) and unpaid; the Official still can't unmark it", async () => {
    const r = ok(await patch(ACT.finance, `/requests/${t.id}/arrangements/${t.lineId}/payment`, { paymentStatus: "PAID", paymentRef: "UTR-LINE-1", paidAt: "2026-10-20" })).body.line;
    expect(r).toMatchObject({ paymentStatus: "PAID", paymentRef: "UTR-LINE-1", paidBy: String(U.finance) });
    expect((await col("cstepapprovals").find({ entityId: new mongoose.Types.ObjectId(t.id), action: "VENDOR_PAYMENT" }).toArray()).map((e) => e.stage)).toEqual(["FINANCE"]);
    expect((await patch(ACT.official, `/requests/${t.id}/arrangements/${t.lineId}/payment`, { paymentStatus: "UNPAID" })).status).toBe(403);
    ok(await patch(ACT.finance, `/requests/${t.id}/arrangements/${t.lineId}/payment`, { paymentStatus: "UNPAID" }));
    expect((await lineOf(t.lineId))!.paymentStatus).toBe("UNPAID");
  });

  it("setting a missing amount is not a payment: Finance and Admin keep it", async () => {
    expect(ok(await get(ACT.admin, `/requests/${t.id}`)).body.canSetMissingAmounts).toBe(true);
    expect(ok(await get(ACT.finance, `/requests/${t.id}`)).body.canSetMissingAmounts).toBe(true);
    expect(ok(await get(ACT.official, `/requests/${t.id}`)).body.canSetMissingAmounts).toBe(false);
  });
});

describe("vendor-payables import — the assigned Finance user only", () => {
  it("an Admin (preview or commit) and the Official are refused; the Admin still sees the line", async () => {
    const t = await arranged(ACT.traveller, "QC vendor import managed");
    for (const as of [...ADMINS, ACT.official]) {
      for (const step of ["preview", "commit"] as const) {
        const r = await upload(step, as, paidCsv(t.ref, "UTR-ADMIN"));
        expect(r.status).toBe(403);
        expect(r.body.error).toMatch(/^Only the assigned finance user can record payments/);
      }
    }
    expect((await lineOf(t.lineId))!.paymentStatus).toBe("UNPAID");
    const listed = ok(await get(ACT.admin, "/vendor-payables")).body;
    expect(listed.scope).toBe("ALL");
    expect(listed.rows.some((r: any) => r.reference === t.ref)).toBe(true);
  });

  it("the assigned Finance user imports it → PAID (IMPORT)", async () => {
    const t = await arranged(ACT.traveller, "QC vendor import finance");
    const r = ok(await upload("commit", ACT.finance, paidCsv(t.ref, "UTR-IMP-1"))).body;
    expect(r.results[0]).toMatchObject({ outcome: "PAID", paidLines: 1 });
    expect(await lineOf(t.lineId)).toMatchObject({ paymentStatus: "PAID", paymentRef: "UTR-IMP-1", paymentSource: "IMPORT", paidBy: U.finance });
  });
});

describe("no Finance user assigned — every payment is blocked for everyone", () => {
  it("reimburse: every Admin kind and everyone else gets 'assign a finance user first'", async () => {
    const id = await withFinance(ACT.solo, "QC unassigned reimburse");
    for (const as of [...NOT_FINANCE, ACT.finance]) {
      const r = await post(as, `/requests/${id}/finance/settle`);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(NONE);
    }
    expect(await statusOf(id)).toBe("TRANSFERRED_TO_FINANCE");
    expect(ok(await get(ACT.admin, `/requests/${id}`)).body).toMatchObject({ canFinance: false, canFinanceDecide: true, paymentBlockedReason: NONE });
  });

  it("vendor line and import: blocked too; an Admin's import has nothing to pay", async () => {
    const t = await arranged(ACT.solo, "QC unassigned vendor");
    for (const as of [...NOT_FINANCE, ACT.finance]) {
      const r = await patch(as, `/requests/${t.id}/arrangements/${t.lineId}/payment`, { paymentStatus: "PAID", paymentRef: "UTR-NO" });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(NONE);
    }
    expect(ok(await get(ACT.official, `/requests/${t.id}`)).body).toMatchObject({ canPayVendors: false, paymentBlockedReason: NONE });
    expect((await upload("commit", ACT.admin, paidCsv(t.ref, "UTR-ADMIN"))).status).toBe(403);
    // The other traveller's Finance user can't reach it either.
    expect(ok(await upload("commit", ACT.finance, paidCsv(t.ref, "UTR-FIN"))).body.counts.OUT_OF_SCOPE).toBe(1);
    expect((await lineOf(t.lineId))!.paymentStatus).toBe("UNPAID");
  });

  it("once an Admin assigns a Finance user (a mapping, not a payment), that user records it", async () => {
    const id = await withFinance(ACT.solo, "QC unassigned then mapped");
    await col("travellerprofiles").updateOne({ _id: TP.unassigned }, { $set: { financeUserId: U.finance } });
    try {
      expect(ok(await post(ACT.finance, `/requests/${id}/finance/settle`)).body.request.status).toBe("REIMBURSED");
    } finally {
      await col("travellerprofiles").updateOne({ _id: TP.unassigned }, { $unset: { financeUserId: "" } });
    }
  });
});

describe("the sequence doesn't depend on the Official paying vendors", () => {
  it("arrange → report → settlement → finance runs with every vendor line unpaid, the Official keeping the ledger", async () => {
    const t = await arranged(ACT.traveller, "QC sequence unpaid");
    expect((await lineOf(t.lineId))!.paymentStatus).toBe("UNPAID");
    ok(await post(ACT.traveller, `/requests/${t.id}/report/start`));
    expect(ok(await get(ACT.official, `/requests/${t.id}`)).body).toMatchObject({ hasVendorLedger: true, canPayVendors: false });
    // The seeded leg needs its document before the report can go in.
    const legs = ok(await get(ACT.traveller, `/requests/${t.id}/report`)).body.legs as any[];
    for (const l of legs) ok(await send("delete" as any, ACT.traveller, `/requests/${t.id}/report/legs/${l._id}`));
    ok(await post(ACT.traveller, `/requests/${t.id}/report/submit`));
    ok(await post(ACT.approver, `/requests/${t.id}/report/approve`));
    ok(await post(ACT.official, `/requests/${t.id}/settlement/start`));
    const fin = ok(await post(ACT.official, `/requests/${t.id}/settlement/finalize`, { force: true })).body.request.status;
    expect(["TRANSFERRED_TO_FINANCE", "SETTLED"]).toContain(fin);
    // Finance pays the vendor line after the fact, at the finance stage.
    ok(await patch(ACT.finance, `/requests/${t.id}/arrangements/${t.lineId}/payment`, { paymentStatus: "PAID", paymentRef: "UTR-LATE" }));
    expect((await lineOf(t.lineId))!.paymentStatus).toBe("PAID");
  });
});
