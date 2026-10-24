// apps/backend/src/routes/cstep.travelDesk.test.ts
//
// #12 — "Travel Desk" is its own role, separate from Admin. The Travel Desk
// for a traveller is the holder of the workspace Travel Desk grant (every
// traveller — POST/DELETE /travel-desk, CSTEP Admin only) or that
// traveller's assigned Official (officialUserId). The Travel Desk surface —
// arranging, vendor options, change requests, settlement — passes for them
// as a normal desk action. A CSTEP Admin who is neither still passes (never
// blocked) but every audit entry it writes is marked adminOverride: true.
// /my-roles reports isTravelDesk / isOfficial only for a real desk person.
// The Travel Desk gets none of the Admin's own powers, and the #3 approval
// and #5 payment gates are untouched.
//
// Real: cstep router, models, in-memory Mongo REPLICA SET (approve runs in a
//   transaction) on a fresh database, cstep_qc_traveldesk.
// Stubbed: mail, S3 + PDF helpers, auth (x-test-user) and the workspace
//   resolver.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_traveldesk";
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

const DB = "cstep_qc_traveldesk";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
const QC_PROJECT = oid();
const U = {
  travellerA: oid(), // TP_A — has an Official assigned
  travellerB: oid(), // TP_B — no Official assigned
  approver: oid(),
  official: oid(), // TP_A's Official only
  finance: oid(),
  desk: oid(), // granted the workspace Travel Desk role, not an Admin
  plain: oid(),
  admin: oid(), // CSTEP Admin, not granted, not anyone's Official
  adminDesk: oid(), // CSTEP Admin (workspace leader) also granted the Travel Desk role
};
const TP_A = oid();
const TP_B = oid();

const app = express();
app.use(express.json());
app.use((req: any, _res: any, next: any) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  req.workspaceObjectId = WS;
  next();
});
app.use("/api/cstep", cstepRouter);

const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"], extra: any = {}) => ({
  _id: String(id), id: String(id), sub: String(id), email: `${String(id)}@qc.local`, roles, workspaceId: String(WS), ...extra,
});
const ACT = {
  travellerA: who(U.travellerA),
  travellerB: who(U.travellerB),
  approver: who(U.approver, ["APPROVER"]),
  official: who(U.official),
  finance: who(U.finance),
  desk: who(U.desk),
  plain: who(U.plain),
  admin: who(U.admin, ["ADMIN"]),
  adminDesk: who(U.adminDesk, ["REQUESTER"], { customerMemberRole: "WORKSPACE_LEADER" }),
};
const send = (m: "get" | "post" | "patch" | "delete", as: any, path: string, body?: any) => {
  const r = request(app)[m](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as));
  if (m === "get" || m === "delete") return r;
  return r.send(path === "/requests" ? { projectId: String(QC_PROJECT), ...body } : body || {});
};
const get = (as: any, path: string) => send("get", as, path);
const post = (as: any, path: string, body?: any) => send("post", as, path, body);
const patch = (as: any, path: string, body?: any) => send("patch", as, path, body);
const del = (as: any, path: string) => send("delete", as, path);
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const auditRows = (id: string) =>
  col("cstepapprovals").find({ entityId: new mongoose.Types.ObjectId(id) }).sort({ at: 1 }).toArray() as Promise<any[]>;
const rowsBy = async (id: string, actor: mongoose.Types.ObjectId) =>
  (await auditRows(id)).filter((r) => String(r.actor) === String(actor));

const TOUR = {
  type: "DOMESTIC",
  purpose: "QC travel desk",
  departureDate: "2026-11-02",
  returnDate: "2026-11-04",
  stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }],
  modesRequested: ["AIR"],
  transportRequired: false,
  accommodationRequired: false,
  sponsored: false,
};

/** A Tour filed by the traveller and approved by their Manager — APPROVED, with the Travel Desk. */
async function approved(traveller: any, purpose: string): Promise<string> {
  const id = String(ok(await post(traveller, "/requests", { ...TOUR, purpose })).body.request._id);
  ok(await post(ACT.approver, `/requests/${id}/approve`));
  return id;
}

/** The whole Travel Desk run by `desk`: open arranging, vendor options, mark
 * arranged (the untouched seed line drops, so the report needs no leg
 * documents), the traveller's report through to approval, settlement start,
 * a per-diem deduction, finalize → TRANSFERRED_TO_FINANCE. Editing a line
 * (ARRANGE_SERVICE) is covered by the change-request test. */
async function runDesk(desk: any, traveller: any, purpose: string): Promise<string> {
  const id = await approved(traveller, purpose);
  ok(await post(desk, `/requests/${id}/start-arranging`));
  ok(await get(desk, `/requests/${id}/vendor-options`));
  ok(await post(desk, `/requests/${id}/mark-arranged`));
  ok(await post(traveller, `/requests/${id}/report/start`));
  ok(await post(traveller, `/requests/${id}/report/submit`));
  ok(await post(ACT.approver, `/requests/${id}/report/approve`));
  ok(await post(desk, `/requests/${id}/settlement/start`));
  ok(await patch(desk, `/requests/${id}/settlement/perdiem`, { deductionInr: 300, deductionReason: "Lunch provided" }));
  const fin = ok(await post(desk, `/requests/${id}/settlement/finalize`, { force: true }));
  expect(fin.body.request?.status ?? (await col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(id) }))!.status).toBe(
    "TRANSFERRED_TO_FINANCE",
  );
  return id;
}

/** Desk actions written by `actor` on `id` — the arrange / settlement audit entries. */
const DESK_ACTIONS = new Set([
  "START_ARRANGING", "ARRANGE_SERVICE", "ADD_SERVICE", "MARK_ARRANGED", "CHANGE_REQUEST", "CHANGE_RESOLVE",
  "START_VERIFICATION", "REDUCE_AMOUNT", "VERIFY_LINE", "PERDIEM_ADJUST", "RETURN_REPORT", "SETTLE", "TRANSFER_TO_FINANCE",
]);
const deskRowsBy = async (id: string, actor: mongoose.Types.ObjectId) =>
  (await rowsBy(id, actor)).filter((r) => DESK_ACTIONS.has(r.action));

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

  await col("cstepprojects").insertOne({ _id: QC_PROJECT, workspaceId: WS, projectCode: "PRJ-QC", projectName: "QC Project", isActive: true } as any);
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany(
    (Object.keys(U) as Array<keyof typeof U>).map((k) => ({
      _id: U[k], email: `${String(U[k])}@qc.local`, firstName: k, roles: ["REQUESTER"], workspaceId: WS,
    })) as any[],
  );
  await col("travellerprofiles").insertMany([
    {
      _id: TP_A, workspaceId: WS, travelerId: "CSTEP-001", firstName: "Asha", lastName: "QC", isActive: true,
      claimedBy: U.travellerA, tourApproverId: U.approver, officialUserId: U.official, financeUserId: U.finance,
      perDiemRateDomesticInr: 1000,
    },
    {
      _id: TP_B, workspaceId: WS, travelerId: "CSTEP-002", firstName: "Bala", lastName: "QC", isActive: true,
      claimedBy: U.travellerB, tourApproverId: U.approver, financeUserId: U.finance,
      perDiemRateDomesticInr: 1000,
    },
  ] as any[]);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("granting the Travel Desk role — CSTEP Admin only", () => {
  it("nobody but a CSTEP Admin can list, grant or revoke it — not the Travel Desk itself", async () => {
    for (const as of [ACT.plain, ACT.official, ACT.finance, ACT.approver]) {
      expect((await get(as, "/travel-desk")).status).toBe(403);
      expect((await post(as, "/travel-desk", { userId: String(U.desk) })).status).toBe(403);
    }
    expect(ok(await get(ACT.admin, "/travel-desk")).body.grants).toEqual([]);
  });

  it("an Admin grants it to a plain user and to a workspace leader; the list names them", async () => {
    ok(await post(ACT.admin, "/travel-desk", { userId: String(U.desk) }));
    ok(await post(ACT.adminDesk, "/travel-desk", { userId: String(U.adminDesk) }));
    const grants = ok(await get(ACT.admin, "/travel-desk")).body.grants as any[];
    expect(grants.map((g) => g.userId).sort()).toEqual([String(U.desk), String(U.adminDesk)].sort());
    expect(grants.find((g) => g.userId === String(U.desk))).toMatchObject({ name: "desk", grantedByName: "admin" });
    // the Travel Desk can't pass the role on
    expect((await post(ACT.desk, "/travel-desk", { userId: String(U.plain) })).status).toBe(403);
    expect((await del(ACT.desk, `/travel-desk/${U.adminDesk}`)).status).toBe(403);
  });

  it("only an active user of this workspace can be granted it", async () => {
    expect((await post(ACT.admin, "/travel-desk", { userId: "nope" })).status).toBe(400);
    expect((await post(ACT.admin, "/travel-desk", { userId: String(oid()) })).status).toBe(400);
  });
});

describe("/my-roles — Travel Desk only for a real desk person", () => {
  const roles = async (as: any) => ok(await get(as, "/my-roles")).body;

  it("the grant holder and an assigned Official are the Travel Desk", async () => {
    expect(await roles(ACT.desk)).toMatchObject({ isAdmin: false, isTravelDesk: true, isOfficial: true, hasTravelDeskGrant: true });
    expect(await roles(ACT.official)).toMatchObject({ isAdmin: false, isTravelDesk: true, isOfficial: true, hasTravelDeskGrant: false });
  });

  it("an Admin who is neither is NOT labelled the Travel Desk — still Admin", async () => {
    expect(await roles(ACT.admin)).toMatchObject({ isAdmin: true, isTravelDesk: false, isOfficial: false, hasTravelDeskGrant: false });
    expect(await roles(ACT.adminDesk)).toMatchObject({ isAdmin: true, isTravelDesk: true, isOfficial: true, hasTravelDeskGrant: true });
  });

  it("a plain user is nothing", async () => {
    expect(await roles(ACT.plain)).toMatchObject({ isAdmin: false, isTravelDesk: false, isOfficial: false, hasTravelDeskGrant: false });
  });
});

describe("the Travel Desk surface — who may act, and how it is logged", () => {
  it("the grant holder runs a traveller with no Official end to end — normal desk entries, no override", async () => {
    const id = await runDesk(ACT.desk, ACT.travellerB, "QC desk runs TP_B");
    const rows = await deskRowsBy(id, U.desk);
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["START_ARRANGING", "MARK_ARRANGED", "START_VERIFICATION", "PERDIEM_ADJUST", "SETTLE", "TRANSFER_TO_FINANCE"]),
    );
    expect(rows.every((r) => r.adminOverride === undefined)).toBe(true);
  });

  it("the grant holder covers a traveller who HAS an Official too", async () => {
    const id = await approved(ACT.travellerA, "QC desk on TP_A");
    ok(await post(ACT.desk, `/requests/${id}/start-arranging`));
    expect((await deskRowsBy(id, U.desk))[0]).toMatchObject({ action: "START_ARRANGING" });
    expect((await deskRowsBy(id, U.desk))[0].adminOverride).toBeUndefined();
  });

  it("the grant holder sees every case on the Processing board, and reads it", async () => {
    const id = await approved(ACT.travellerB, "QC desk queue");
    const q = ok(await get(ACT.desk, "/official-queue")).body.requests as any[];
    expect(q.map((r) => String(r._id))).toContain(id);
    const d = ok(await get(ACT.desk, `/requests/${id}`)).body;
    expect(d).toMatchObject({ isAdmin: false, isTravelDesk: true, travelDeskOverride: false, canArrange: true });
    expect(ok(await get(ACT.desk, `/requests/${id}/activity`)).body.activity.length).toBeGreaterThan(0);
  });

  it("an assigned Official is the Travel Desk for their own traveller only", async () => {
    const mine = await runDesk(ACT.official, ACT.travellerA, "QC official on TP_A");
    expect((await deskRowsBy(mine, U.official)).every((r) => r.adminOverride === undefined)).toBe(true);
    const notMine = await approved(ACT.travellerB, "QC official not on TP_B");
    expect((await post(ACT.official, `/requests/${notMine}/start-arranging`)).status).toBe(403);
    expect((await get(ACT.official, `/requests/${notMine}`)).status).toBe(403);
    const q = ok(await get(ACT.official, "/official-queue")).body.requests as any[];
    expect(q.map((r) => String(r._id))).not.toContain(notMine);
  });

  it("a plain user can't touch the desk surface or read the case", async () => {
    const id = await approved(ACT.travellerB, "QC plain refused");
    expect((await post(ACT.plain, `/requests/${id}/start-arranging`)).status).toBe(403);
    expect((await get(ACT.plain, `/requests/${id}/vendor-options`)).status).toBe(403);
    expect((await get(ACT.plain, `/requests/${id}`)).status).toBe(403);
    expect(ok(await get(ACT.plain, "/official-queue")).body.requests).toEqual([]);
    expect(ok(await get(ACT.plain, "/change-requests")).body.changeRequests).toEqual([]);
  });

  it("an Admin without the role still acts — every entry it writes is marked an override", async () => {
    const id = await runDesk(ACT.admin, ACT.travellerA, "QC admin override");
    const rows = await deskRowsBy(id, U.admin);
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["START_ARRANGING", "MARK_ARRANGED", "START_VERIFICATION", "PERDIEM_ADJUST", "SETTLE", "TRANSFER_TO_FINANCE"]),
    );
    expect(rows.every((r) => r.adminOverride === true)).toBe(true);
    // ...and the people who ARE the desk / Manager aren't marked
    expect((await auditRows(id)).filter((r) => String(r.actor) !== String(U.admin)).every((r) => r.adminOverride === undefined)).toBe(true);
  });

  it("the case page tells an override from a desk action", async () => {
    const id = await approved(ACT.travellerA, "QC admin flags");
    expect(ok(await get(ACT.admin, `/requests/${id}`)).body).toMatchObject({
      isAdmin: true, isTravelDesk: false, travelDeskOverride: true, canArrange: true,
    });
    expect(ok(await get(ACT.adminDesk, `/requests/${id}`)).body).toMatchObject({
      isAdmin: true, isTravelDesk: true, travelDeskOverride: false, canArrange: true,
    });
    expect(ok(await get(ACT.official, `/requests/${id}`)).body).toMatchObject({
      isAdmin: false, isTravelDesk: true, travelDeskOverride: false, canArrange: true,
    });
  });

  it("an Admin who holds the role acts as the desk — no override mark", async () => {
    const id = await approved(ACT.travellerB, "QC admin desk");
    ok(await post(ACT.adminDesk, `/requests/${id}/start-arranging`));
    const [row] = await deskRowsBy(id, U.adminDesk);
    expect(row).toMatchObject({ action: "START_ARRANGING" });
    expect(row.adminOverride).toBeUndefined();
  });

  it("change requests: raised and resolved by the desk — marked only when an Admin overrides", async () => {
    const id = await approved(ACT.travellerB, "QC change requests");
    const lines = ok(await post(ACT.desk, `/requests/${id}/start-arranging`)).body.arrangements as any[];
    for (const l of lines) ok(await patch(ACT.desk, `/requests/${id}/arrangements/${l._id}`, { status: "ARRANGED", amount: 4000, currency: "INR" }));
    ok(await post(ACT.desk, `/requests/${id}/mark-arranged`));
    const flight = lines[0]._id;

    const raised = ok(await post(ACT.desk, `/requests/${id}/change-requests`, { kind: "REBOOK", details: "Move to 3 Nov", reason: "Meeting moved", arrangementId: flight }));
    const crId = String(raised.body.changeRequest?._id ?? (await col("cstepchangerequests").findOne({ travelRequestId: new mongoose.Types.ObjectId(id) }))!._id);
    expect(ok(await get(ACT.desk, "/change-requests")).body.changeRequests.map((c: any) => String(c._id))).toContain(crId);
    ok(await post(ACT.admin, `/change-requests/${crId}/resolve`, { status: "DONE", note: "Rebooked" }));

    const rows = await auditRows(id);
    expect(rows.filter((r) => r.action === "ARRANGE_SERVICE").map((r) => [String(r.actor), r.adminOverride])).toEqual(
      lines.map(() => [String(U.desk), undefined]),
    );
    expect(rows.find((r) => r.action === "CHANGE_REQUEST")).toMatchObject({ actor: U.desk });
    expect(rows.find((r) => r.action === "CHANGE_REQUEST").adminOverride).toBeUndefined();
    expect(rows.find((r) => r.action === "CHANGE_RESOLVE")).toMatchObject({ actor: U.admin, adminOverride: true });
  });

  it("a revoked grant is no longer the Travel Desk; granting again restores it", async () => {
    ok(await del(ACT.admin, `/travel-desk/${U.desk}`));
    expect((await del(ACT.admin, `/travel-desk/${U.desk}`)).status).toBe(404);
    const id = await approved(ACT.travellerB, "QC revoked");
    expect((await post(ACT.desk, `/requests/${id}/start-arranging`)).status).toBe(403);
    expect(ok(await get(ACT.desk, "/my-roles")).body).toMatchObject({ isTravelDesk: false, hasTravelDeskGrant: false });
    const row: any = await col("csteptraveldeskgrants").findOne({ userId: U.desk });
    expect(row).toMatchObject({ revokedBy: U.admin });

    ok(await post(ACT.admin, "/travel-desk", { userId: String(U.desk) }));
    ok(await post(ACT.desk, `/requests/${id}/start-arranging`));
    expect((await col("csteptraveldeskgrants").findOne({ userId: U.desk }))!.revokedAt).toBeUndefined();
  });
});

describe("unchanged — Admin-only powers, and the #3 / #5 gates", () => {
  it("the Travel Desk gets none of the Admin's own powers", async () => {
    expect((await get(ACT.desk, "/sequences")).status).toBe(403);
    expect(ok(await get(ACT.desk, "/claim-verification-queue")).body.requests).toEqual([]);
    expect((await get(ACT.desk, "/travel-desk")).status).toBe(403);
    // filing on behalf: a non-admin files for themselves only — the travellerProfileId is not honoured
    const before = await col("csteptravelrequests").countDocuments({ travelerProfileId: TP_B });
    expect((await post(ACT.desk, "/requests", { ...TOUR, travelerProfileId: String(TP_B) })).status).toBe(400);
    expect(await col("csteptravelrequests").countDocuments({ travelerProfileId: TP_B })).toBe(before);
  });

  it("#3 — the Travel Desk can't approve, nor see the Manager's queue; with a Manager assigned an Admin can't either", async () => {
    const id = String(ok(await post(ACT.travellerB, "/requests", { ...TOUR, purpose: "QC #3" })).body.request._id);
    expect(ok(await get(ACT.desk, "/approvals")).body.requests ?? []).toEqual([]);
    expect(ok(await get(ACT.approver, "/approvals")).body.requests.map((r: any) => String(r._id))).toContain(id);
    expect((await post(ACT.desk, `/requests/${id}/approve`)).status).toBe(403);
    expect((await post(ACT.admin, `/requests/${id}/approve`)).status).toBe(403);
    ok(await post(ACT.approver, `/requests/${id}/approve`));
  });

  it("#5 — the Travel Desk can't record the reimbursement; only the assigned Finance user can", async () => {
    const id = await runDesk(ACT.desk, ACT.travellerB, "QC #5");
    expect((await post(ACT.desk, `/requests/${id}/finance/settle`, { reference: "UTR-NO" })).status).toBe(403);
    expect((await post(ACT.admin, `/requests/${id}/finance/settle`, { reference: "UTR-NO" })).status).toBe(403);
    expect(ok(await post(ACT.finance, `/requests/${id}/finance/settle`, { reference: "UTR-QC" })).body.request.status).toBe("REIMBURSED");
  });
});
