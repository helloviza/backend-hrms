// apps/backend/src/routes/cstep.changeRequests.test.ts
//
// CSTEP change requests (cancel / rebook on an arranged service) through the
// real CSTEP router: raise / list / resolve, who may raise and resolve, the
// line reopened for the Official while a change is OPEN (and closed again once
// it is resolved), and the two notifications — CHANGE_RAISED to the Official,
// CHANGE_RESOLVED to the traveller — each exactly once, and never from the
// open-and-start routes.
//
// Real: cstep router, notifyCstep, enqueueEmail + EmailOutbox, models,
//   in-memory Mongo REPLICA SET (approve runs in a transaction) on a fresh
//   database, cstep_qc_change.
// Stubbed: the SMTP send (utils/mailer), S3 + PDF helpers, auth (x-test-user)
//   and the workspace resolver (x-test-ws), as requireWorkspace sets them.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
// config/env.ts requires these at import; none of them is ever used here.
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_change";
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

const { default: cstepRouter } = await import("./cstep.js");
const { encryptCstepSmtpPass } = await import("../services/cstepMailTransport.js");
const { default: CstepNotificationSettings } = await import("../models/cstep/CstepNotificationSettings.js");

const DB = "cstep_qc_change";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
const WS_OTHER = oid();
const QC_PROJECT = oid();
const U = { traveller: oid(), approver: oid(), official: oid(), finance: oid(), admin: oid(), official2: oid(), stranger: oid() };
const EMAIL = {
  traveller: "traveller@qc.local",
  approver: "approver@qc.local",
  official: "official@qc.local",
  finance: "finance@qc.local",
  admin: "admin@qc.local",
  official2: "official2@qc.local",
  stranger: "stranger@qc.local",
};
const TP = { main: oid(), second: oid() };

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
  official2: who(U.official2, EMAIL.official2),
  stranger: who(U.stranger, EMAIL.stranger),
};
const send = (method: "get" | "post" | "patch", as: any, path: string, body?: any, ws = WS) => {
  const r = request(app)[method](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(ws));
  if (method === "get") return r;
  const b = path === "/requests" && body && body.projectId === undefined ? { ...body, projectId: String(QC_PROJECT) } : body;
  return r.send(b || {});
};
const get = (as: any, path: string, ws = WS) => send("get", as, path, undefined, ws);
const post = (as: any, path: string, body?: any, ws = WS) => send("post", as, path, body, ws);
const patch = (as: any, path: string, body?: any) => send("patch", as, path, body);

// AIR seeds a Flight line, transportRequired a Cab, accommodationRequired a Hotel.
const TOUR = {
  type: "DOMESTIC",
  purpose: "QC change requests",
  departureDate: "2026-11-02",
  returnDate: "2026-11-04",
  stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }],
  modesRequested: ["AIR"],
  transportRequired: true,
  accommodationRequired: true,
  sponsored: false,
};

let seen = 0;
async function delta(): Promise<Array<[string, string]>> {
  const rows = await col("emailoutboxes").find({}).sort({ _id: 1 }).toArray();
  const fresh = rows.slice(seen);
  seen = rows.length;
  return fresh.map((r: any) => [r.event, (r.to || []).join(",")]);
}
async function lastOutbox(): Promise<any> {
  return (await col("emailoutboxes").find({}).sort({ _id: -1 }).limit(1).toArray())[0];
}
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};

/** A Tour taken through approval and arranging to ARRANGED, every seeded line marked arranged. */
async function arrangedTrip(as = ACT.traveller, purpose = TOUR.purpose): Promise<{ id: string; lines: Record<string, string> }> {
  const id = String(ok(await post(as, "/requests", { ...TOUR, purpose })).body.request._id);
  ok(await post(ACT.approver, `/requests/${id}/approve`));
  const arr = ok(await post(ACT.official, `/requests/${id}/start-arranging`)).body.arrangements as any[];
  const lines: Record<string, string> = {};
  for (const l of arr) {
    lines[l.arrangedType] = String(l._id);
    ok(await patch(ACT.official, `/requests/${id}/arrangements/${l._id}`, { status: "ARRANGED", amount: 4000, currency: "INR" }));
  }
  ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
  await delta();
  return { id, lines };
}

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
    smtpHost: "smtp.cstep-qc.local", smtpPort: 587, smtpPassEnc: encryptCstepSmtpPass("qc-app-password", WS),
  });
  await col("cstepprojects").insertOne({ _id: QC_PROJECT, workspaceId: WS, projectCode: "PRJ-QC", projectName: "QC Project", tallyProjectCC: "100 QC 01", isActive: true } as any);
  await col("customerworkspaces").insertMany([
    { _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } },
    { _id: WS_OTHER, customerId: String(oid()), companyName: "QC other tenant", config: { features: { cstepEnabled: true } } },
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
    // official2's own traveller — so official2 is an Official, just not this one's.
    profile(TP.second, "CSTEP-002", { email: "second@qc.local", tourApproverId: U.approver, officialUserId: U.official2 }),
  ] as any[]);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("CSTEP change requests — raise, list, resolve", () => {
  let id = "";
  let lines: Record<string, string> = {};
  let changeId = "";

  it("arranging a trip sends no change email (start-arranging is an auto-open route)", async () => {
    ({ id, lines } = await arrangedTrip());
    expect(Object.keys(lines).sort()).toEqual(["CAB", "FLIGHT", "HOTEL"]);
    const events = (await col("emailoutboxes").find({}).toArray()).map((r: any) => r.event);
    expect(events.filter((e: string) => e.startsWith("cstep_change"))).toEqual([]);
  });

  it("GET /requests/:id tells the traveller they may raise, and the Official they handle changes", async () => {
    const t = ok(await get(ACT.traveller, `/requests/${id}`)).body;
    expect(t.canRequestChange).toBe(true);
    expect(t.canHandleChanges).toBe(false);
    expect(t.changeRequests).toEqual([]);
    const o = ok(await get(ACT.official, `/requests/${id}`)).body;
    expect(o.canRequestChange).toBe(true);
    expect(o.canHandleChanges).toBe(true);
    const a = ok(await get(ACT.approver, `/requests/${id}`)).body;
    expect(a.canRequestChange).toBe(false);
    expect(a.canHandleChanges).toBe(false);
  });

  it("the Approver, the Finance user, another Official and a stranger cannot raise", async () => {
    const body = { arrangementId: lines.FLIGHT, kind: "REBOOK", details: "Move to 3 Nov", reason: "Meeting moved" };
    for (const as of [ACT.approver, ACT.finance, ACT.official2, ACT.stranger]) {
      expect((await post(as, `/requests/${id}/change-requests`, body)).status).toBe(403);
    }
    expect(await col("cstepchangerequests").countDocuments({})).toBe(0);
    expect(await delta()).toEqual([]);
  });

  it("refuses a bad kind, missing details / reason, a missing line, and a non-flight/cab line", async () => {
    const base = { arrangementId: lines.FLIGHT, kind: "REBOOK", details: "Move to 3 Nov", reason: "Meeting moved" };
    const cases: Array<[any, number]> = [
      [{ ...base, kind: "UPGRADE" }, 400],
      [{ ...base, details: "  " }, 400],
      [{ ...base, reason: "" }, 400],
      [{ ...base, arrangementId: "nope" }, 400],
      [{ ...base, arrangementId: String(oid()) }, 404],
      [{ ...base, arrangementId: lines.HOTEL }, 400],
    ];
    for (const [body, status] of cases) {
      expect((await post(ACT.traveller, `/requests/${id}/change-requests`, body)).status).toBe(status);
    }
    expect(await delta()).toEqual([]);
  });

  it("the traveller raises a rebook → OPEN, logged, and CHANGE_RAISED goes to the Official only", async () => {
    const r = await post(ACT.traveller, `/requests/${id}/change-requests`, {
      arrangementId: lines.FLIGHT, kind: "REBOOK", details: "Move to 3 Nov, same sector", reason: "Meeting moved",
    });
    expect(r.status).toBe(201);
    const cr = r.body.changeRequest;
    changeId = String(cr._id);
    expect(cr).toMatchObject({ status: "OPEN", kind: "REBOOK", serviceType: "FLIGHT", raisedBy: String(U.traveller) });
    expect(await delta()).toEqual([["cstep_change_raised", EMAIL.official]]);

    const entry = await col("cstepapprovals").findOne({ entityId: new mongoose.Types.ObjectId(id), action: "CHANGE_REQUEST" });
    expect(entry!.comment).toContain("Rebook Flight: Move to 3 Nov, same sector");
    expect(String(cr.raisedLogId)).toBe(String(entry!._id));
    const n = await col("cstepnotifications").findOne({ event: "CHANGE_RAISED" });
    expect(String(n!.logEntryId)).toBe(String(entry!._id));
    const mail = await lastOutbox();
    expect(mail.subject).toContain("Change requested — rebook flight");
    expect(mail.html).toContain("Move to 3 Nov, same sector");
    expect(mail.html).toContain("Meeting moved");
  });

  it("a second open change on the same line is refused (409) and sends nothing", async () => {
    const r = await post(ACT.official, `/requests/${id}/change-requests`, {
      arrangementId: lines.FLIGHT, kind: "CANCEL", details: "Cancel it", reason: "Trip off",
    });
    expect(r.status).toBe(409);
    expect(await delta()).toEqual([]);
  });

  it("the traveller and the trip's viewers see it on the request; a stranger does not", async () => {
    for (const as of [ACT.traveller, ACT.approver, ACT.official, ACT.finance]) {
      const rows = ok(await get(as, `/requests/${id}/change-requests`)).body.changeRequests;
      expect(rows.map((c: any) => String(c._id))).toEqual([changeId]);
    }
    expect((await get(ACT.stranger, `/requests/${id}/change-requests`)).status).toBe(403);
    expect(ok(await get(ACT.traveller, `/requests/${id}`)).body.changeRequests).toHaveLength(1);
  });

  it("the queue: the Official and an Admin see it, with the trip; another Official and the traveller get none", async () => {
    for (const as of [ACT.official, ACT.admin]) {
      const rows = ok(await get(as, "/change-requests")).body.changeRequests;
      expect(rows).toHaveLength(1);
      expect(rows[0].request).toMatchObject({ _id: id, purpose: TOUR.purpose, status: "ARRANGED", travellerName: "Asha CSTEP-001" });
    }
    expect(ok(await get(ACT.official2, "/change-requests")).body.changeRequests).toEqual([]);
    expect(ok(await get(ACT.traveller, "/change-requests")).body.changeRequests).toEqual([]);
    expect((await get(ACT.admin, "/change-requests?status=BOGUS")).status).toBe(400);
  });

  it("the open change reopens ITS line for the Official, past ARRANGING — and no other line", async () => {
    const r = await patch(ACT.official, `/requests/${id}/arrangements/${lines.FLIGHT}`, { details: "6E-201 3 Nov 07:10", amount: 5200, currency: "INR" });
    expect(r.status).toBe(200);
    expect(r.body.line).toMatchObject({ details: "6E-201 3 Nov 07:10", amountInr: 5200 });
    const entry = (await col("cstepapprovals").find({ entityId: new mongoose.Types.ObjectId(id), action: "ARRANGE_SERVICE" }).sort({ _id: -1 }).limit(1).toArray())[0];
    expect(entry.comment).toMatch(/^Change request — /);
    expect((await patch(ACT.official, `/requests/${id}/arrangements/${lines.CAB}`, { details: "x" })).status).toBe(409);
    // The traveller can't edit it, open change or not.
    expect((await patch(ACT.traveller, `/requests/${id}/arrangements/${lines.FLIGHT}`, { details: "x" })).status).toBe(403);
    expect(ok(await get(ACT.official, `/requests/${id}/vendor-options`)).body.ok).toBe(true);
    expect(await delta()).toEqual([]);
  });

  it("only the Official / an Admin may resolve; a note and DONE / DECLINED are required", async () => {
    for (const as of [ACT.traveller, ACT.approver, ACT.finance, ACT.official2]) {
      expect((await post(as, `/change-requests/${changeId}/resolve`, { status: "DONE", note: "x" })).status).toBe(403);
    }
    expect((await post(ACT.official, `/change-requests/${changeId}/resolve`, { status: "DONE", note: " " })).status).toBe(400);
    expect((await post(ACT.official, `/change-requests/${changeId}/resolve`, { status: "OPEN", note: "x" })).status).toBe(400);
    // Another tenant can't see it at all.
    expect((await post(ACT.admin, `/change-requests/${changeId}/resolve`, { status: "DONE", note: "x" }, WS_OTHER)).status).toBe(404);
    expect(await delta()).toEqual([]);
  });

  it("the Official marks it DONE → CHANGE_RESOLVED to the traveller, once; the line closes again", async () => {
    const r = ok(await post(ACT.official, `/change-requests/${changeId}/resolve`, { status: "DONE", note: "Rebooked on 6E-201" }));
    expect(r.body.changeRequest).toMatchObject({ status: "DONE", handledBy: String(U.official), resolutionNote: "Rebooked on 6E-201" });
    expect(await delta()).toEqual([["cstep_change_resolved", EMAIL.traveller]]);
    const mail = await lastOutbox();
    expect(mail.subject).toContain("Your flight rebooking is done");
    expect(mail.html).toContain("Rebooked on 6E-201");
    const entry = await col("cstepapprovals").findOne({ entityId: new mongoose.Types.ObjectId(id), action: "CHANGE_RESOLVE" });
    expect(entry!.comment).toBe("Rebook Flight — Done: Rebooked on 6E-201");
    const stored = await col("cstepchangerequests").findOne({ _id: new mongoose.Types.ObjectId(changeId) });
    expect(String(stored!.resolvedLogId)).toBe(String(entry!._id));

    expect((await post(ACT.admin, `/change-requests/${changeId}/resolve`, { status: "DECLINED", note: "again" })).status).toBe(409);
    expect((await patch(ACT.official, `/requests/${id}/arrangements/${lines.FLIGHT}`, { details: "after" })).status).toBe(409);
    expect((await get(ACT.official, `/requests/${id}/vendor-options`)).status).toBe(409);
    expect(ok(await get(ACT.official, "/change-requests")).body.changeRequests).toEqual([]);
    expect(ok(await get(ACT.official, "/change-requests?status=DONE")).body.changeRequests).toHaveLength(1);
    expect(await delta()).toEqual([]);
  });

  it("an Admin raises a cab cancel on the traveller's behalf → the Official; DECLINED → the traveller", async () => {
    const r = ok(await post(ACT.admin, `/requests/${id}/change-requests`, {
      arrangementId: lines.CAB, kind: "CANCEL", details: "Cancel the airport drop", reason: "Colleague is driving",
    }));
    expect(await delta()).toEqual([["cstep_change_raised", EMAIL.official]]);
    const crId = String(r.body.changeRequest._id);
    ok(await post(ACT.official, `/change-requests/${crId}/resolve`, { status: "DECLINED", note: "Non-refundable, keeping it" }));
    expect(await delta()).toEqual([["cstep_change_resolved", EMAIL.traveller]]);
    expect((await lastOutbox()).subject).toContain("Your cab cancellation request was declined");
  });

  it("report/start (auto-open) sends nothing, and a change can still be raised at REPORT_PENDING", async () => {
    ok(await post(ACT.traveller, `/requests/${id}/report/start`));
    ok(await post(ACT.traveller, `/requests/${id}/report/start`));
    expect(await delta()).toEqual([]);
    ok(await post(ACT.traveller, `/requests/${id}/change-requests`, {
      arrangementId: lines.FLIGHT, kind: "CANCEL", details: "Cancel the return", reason: "Staying on",
    }));
    expect(await delta()).toEqual([["cstep_change_raised", EMAIL.official]]);
  });

  it("no change on a trip that isn't arranged yet", async () => {
    const r = ok(await post(ACT.traveller, "/requests", { ...TOUR, purpose: "QC not arranged" }));
    const other = String(r.body.request._id);
    await delta();
    const g = ok(await get(ACT.traveller, `/requests/${other}`)).body;
    expect(g.canRequestChange).toBe(false);
    const res = await post(ACT.traveller, `/requests/${other}/change-requests`, {
      arrangementId: lines.FLIGHT, kind: "CANCEL", details: "x", reason: "y",
    });
    expect(res.status).toBe(409);
    expect(await delta()).toEqual([]);
  });

  it("a line from another request can't be named", async () => {
    const other = await arrangedTrip(ACT.traveller, "QC second trip");
    const res = await post(ACT.traveller, `/requests/${other.id}/change-requests`, {
      arrangementId: lines.CAB, kind: "CANCEL", details: "x", reason: "y",
    });
    expect(res.status).toBe(404);
    expect(await delta()).toEqual([]);
  });
});
