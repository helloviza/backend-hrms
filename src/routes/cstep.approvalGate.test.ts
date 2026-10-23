// apps/backend/src/routes/cstep.approvalGate.test.ts
//
// The approval gate (routes/cstep.ts callerApprovalRefusal): when a traveller has
// a Tour Approver (Manager) assigned, only that Manager may start-review,
// approve a proposal, or approve a travel report — a CSTEP Admin (ADMIN, HR,
// SUPERADMIN, WORKSPACE_LEADER) is refused with "Only the assigned manager can
// approve this". Only a traveller with NO approver falls back to the Admin.
// The rest of the approval stage stays as it was: an Admin can still return
// or reject a managed request, and send its report back.
//
// Real: cstep router, models, in-memory Mongo REPLICA SET (approve runs in a
//   transaction) on a fresh database, cstep_qc_gate.
// Stubbed: mail, S3 + PDF helpers, auth (x-test-user) and the workspace
//   resolver (x-test-ws).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_gate";
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

const DB = "cstep_qc_gate";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);
const BLOCKED = "Only the assigned manager can approve this";

const WS = oid();
const QC_PROJECT = oid();
const U = {
  traveller: oid(), solo: oid(), approver: oid(), official: oid(), stranger: oid(),
  admin: oid(), hr: oid(), superadmin: oid(), leader: oid(), adminApprover: oid(), selfManaged: oid(),
};
const TP = { managed: oid(), unassigned: oid(), adminManaged: oid() };

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

const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"], extra: any = {}) => ({
  _id: String(id), id: String(id), sub: String(id), email: `${String(id)}@qc.local`, roles, workspaceId: String(WS), ...extra,
});
const ACT = {
  traveller: who(U.traveller),
  solo: who(U.solo),
  selfManaged: who(U.selfManaged),
  approver: who(U.approver, ["APPROVER"]),
  official: who(U.official),
  stranger: who(U.stranger),
  admin: who(U.admin, ["ADMIN"]),
  hr: who(U.hr, ["HR"]),
  superadmin: who(U.superadmin, ["SUPERADMIN"]),
  // A workspace leader reaches CSTEP Admin through the JWT's customerMemberRole.
  leader: who(U.leader, ["CUSTOMER", "REQUESTER"], { customerMemberRole: "WORKSPACE_LEADER" }),
  // A CSTEP Admin who IS some traveller's assigned approver.
  adminApprover: who(U.adminApprover, ["ADMIN"]),
};
const ADMINS = [ACT.admin, ACT.hr, ACT.superadmin, ACT.leader];
const send = (m: "get" | "post", as: any, path: string, body?: any) => {
  const r = request(app)[m](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as));
  if (m === "get") return r;
  return r.send(path === "/requests" ? { projectId: String(QC_PROJECT), ...body } : body || {});
};
const get = (as: any, path: string) => send("get", as, path);
const post = (as: any, path: string, body?: any) => send("post", as, path, body);
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};

const TOUR = {
  type: "DOMESTIC",
  purpose: "QC approval gate",
  departureDate: "2026-11-02",
  returnDate: "2026-11-04",
  stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }],
  modesRequested: ["AIR"],
  transportRequired: false,
  accommodationRequired: false,
  sponsored: false,
};

/** A submitted Tour filed by `as` (whose profile decides managed / unassigned). */
async function submitted(as: any, purpose = TOUR.purpose): Promise<string> {
  const r = ok(await post(as, "/requests", { ...TOUR, purpose }));
  expect(r.body.request.status).toBe("SUBMITTED");
  return String(r.body.request._id);
}
/** Approve (by `approver`), arrange, and file the report → REPORT_UNDER_APPROVAL. */
async function reportWithManager(as: any, approver: any, purpose: string): Promise<string> {
  const id = await submitted(as, purpose);
  ok(await post(approver, `/requests/${id}/approve`));
  ok(await post(ACT.official, `/requests/${id}/start-arranging`));
  ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
  ok(await post(as, `/requests/${id}/report/start`));
  const r = ok(await post(as, `/requests/${id}/report/submit`));
  expect(r.body.request.status).toBe("REPORT_UNDER_APPROVAL");
  return id;
}
const statusOf = async (id: string) => ok(await get(ACT.admin, `/requests/${id}`)).body.request.status;
const logCount = async (id: string, action: string) =>
  col("cstepapprovals").countDocuments({ entityId: new mongoose.Types.ObjectId(id), action });

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
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany(
    (Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: `${String(U[k])}@qc.local`, roles: ["REQUESTER"], workspaceId: WS })) as any[],
  );
  const profile = (_id: mongoose.Types.ObjectId, code: string, extra: any) => ({
    _id, workspaceId: WS, travelerId: code, firstName: "Asha", lastName: code, isActive: true, officialUserId: U.official, ...extra,
  });
  await col("travellerprofiles").insertMany([
    profile(TP.managed, "CSTEP-001", { claimedBy: U.traveller, tourApproverId: U.approver }),
    profile(TP.unassigned, "CSTEP-002", { claimedBy: U.solo }),
    profile(TP.adminManaged, "CSTEP-003", { claimedBy: U.selfManaged, tourApproverId: U.adminApprover }),
  ] as any[]);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("proposal approval — traveller with an assigned Manager", () => {
  let id = "";

  it("every kind of CSTEP Admin is refused start-review, with the clear message, and nothing is logged", async () => {
    id = await submitted(ACT.traveller);
    for (const as of ADMINS) {
      const r = await post(as, `/requests/${id}/start-review`);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(BLOCKED);
    }
    expect(await logCount(id, "START_REVIEW")).toBe(0);
  });

  it("every kind of CSTEP Admin is refused approve; the request stays SUBMITTED with no TIN", async () => {
    for (const as of ADMINS) {
      const r = await post(as, `/requests/${id}/approve`);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(BLOCKED);
    }
    const g = ok(await get(ACT.traveller, `/requests/${id}`)).body.request;
    expect(g.status).toBe("SUBMITTED");
    expect(g.claimReference).toBeFalsy();
    expect(await logCount(id, "APPROVE")).toBe(0);
  });

  it("GET tells the Admin they can decide but not approve, and why", async () => {
    const b = ok(await get(ACT.admin, `/requests/${id}`)).body;
    expect(b).toMatchObject({ canApprove: false, canDecide: true, approvalBlockedReason: BLOCKED });
    const m = ok(await get(ACT.approver, `/requests/${id}`)).body;
    expect(m).toMatchObject({ canApprove: true, canDecide: true });
    expect(m.approvalBlockedReason).toBeUndefined();
  });

  it("an unrelated user is still refused (not the Manager, not an Admin)", async () => {
    for (const as of [ACT.stranger, ACT.official]) {
      expect((await post(as, `/requests/${id}/start-review`)).status).toBe(403);
      expect((await post(as, `/requests/${id}/approve`)).status).toBe(403);
    }
  });

  it("the assigned Manager starts review and approves normally", async () => {
    ok(await post(ACT.approver, `/requests/${id}/start-review`));
    expect(await logCount(id, "START_REVIEW")).toBe(1);
    const r = ok(await post(ACT.approver, `/requests/${id}/approve`));
    expect(r.body.request.status).toBe("APPROVED");
    expect(r.body.request.claimReference).toMatch(/^\d{4}\/\d{4}$/);
  });

  it("send-back stays as it was: an Admin can still return, and reject, a managed request", async () => {
    const a = await submitted(ACT.traveller, "QC admin return");
    expect(ok(await post(ACT.admin, `/requests/${a}/return`, { reason: "Add the agenda" })).body.request.status).toBe("RETURNED");
    const b = await submitted(ACT.traveller, "QC admin reject");
    expect(ok(await post(ACT.admin, `/requests/${b}/reject`, { reason: "Not in budget" })).body.request.status).toBe("REJECTED");
  });

  it("an Admin who IS the traveller's assigned approver approves as that approver", async () => {
    const x = await submitted(ACT.selfManaged, "QC admin-as-approver");
    ok(await post(ACT.adminApprover, `/requests/${x}/start-review`));
    expect(ok(await post(ACT.adminApprover, `/requests/${x}/approve`)).body.request.status).toBe("APPROVED");
    // ...and a different Admin still can't on that traveller's next one.
    const y = await submitted(ACT.selfManaged, "QC admin-as-approver 2");
    expect((await post(ACT.admin, `/requests/${y}/approve`)).body.error).toBe(BLOCKED);
  });
});

describe("report approval — traveller with an assigned Manager", () => {
  let id = "";

  it("every kind of CSTEP Admin is refused report/approve; the report stays with the Manager", async () => {
    id = await reportWithManager(ACT.traveller, ACT.approver, "QC report gate");
    for (const as of ADMINS) {
      const r = await post(as, `/requests/${id}/report/approve`);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(BLOCKED);
    }
    expect(ok(await get(ACT.traveller, `/requests/${id}`)).body.request.status).toBe("REPORT_UNDER_APPROVAL");
    expect(await logCount(id, "APPROVE_REPORT")).toBe(0);
  });

  it("GET tells the Admin they can send it back but not approve it", async () => {
    const b = ok(await get(ACT.admin, `/requests/${id}`)).body;
    expect(b).toMatchObject({ canApproveReport: false, canDecideReport: true, approvalBlockedReason: BLOCKED });
    expect(ok(await get(ACT.approver, `/requests/${id}`)).body).toMatchObject({ canApproveReport: true, canDecideReport: true });
  });

  it("the assigned Manager approves the report on to the Official", async () => {
    const r = ok(await post(ACT.approver, `/requests/${id}/report/approve`));
    expect(r.body.request.status).toBe("REPORT_SUBMITTED");
  });

  it("send-back stays as it was: an Admin can still send a managed report back", async () => {
    const x = await reportWithManager(ACT.traveller, ACT.approver, "QC report admin send-back");
    const r = ok(await post(ACT.admin, `/requests/${x}/report/return`, { reason: "Hotel bill missing" }));
    expect(r.body.request.status).toBe("REPORT_PENDING");
  });
});

describe("unassigned traveller — the Admin fallback still works", () => {
  it("a CSTEP Admin starts review and approves the proposal", async () => {
    const id = await submitted(ACT.solo, "QC unassigned proposal");
    const g = ok(await get(ACT.admin, `/requests/${id}`)).body;
    expect(g).toMatchObject({ canApprove: true, canDecide: true });
    ok(await post(ACT.admin, `/requests/${id}/start-review`));
    expect(ok(await post(ACT.admin, `/requests/${id}/approve`)).body.request.status).toBe("APPROVED");
  });

  it("each kind of CSTEP Admin can approve an unassigned proposal", async () => {
    for (const as of [ACT.hr, ACT.superadmin, ACT.leader]) {
      const id = await submitted(ACT.solo, `QC unassigned ${as.roles[0]}`);
      expect(ok(await post(as, `/requests/${id}/approve`)).body.request.status).toBe("APPROVED");
    }
  });

  it("a CSTEP Admin approves the unassigned traveller's report", async () => {
    const id = await reportWithManager(ACT.solo, ACT.admin, "QC unassigned report");
    expect(ok(await get(ACT.admin, `/requests/${id}`)).body).toMatchObject({ canApproveReport: true });
    expect(ok(await post(ACT.admin, `/requests/${id}/report/approve`)).body.request.status).toBe("REPORT_SUBMITTED");
  });

  it("a non-Admin can't approve an unassigned traveller's request", async () => {
    const id = await submitted(ACT.solo, "QC unassigned stranger");
    for (const as of [ACT.stranger, ACT.approver, ACT.official]) {
      expect((await post(as, `/requests/${id}/approve`)).status).toBe(403);
      expect((await post(as, `/requests/${id}/start-review`)).status).toBe(403);
    }
    expect(await statusOf(id)).toBe("SUBMITTED");
  });
});
