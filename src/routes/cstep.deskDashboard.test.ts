// apps/backend/src/routes/cstep.deskDashboard.test.ts
//
// #13 — the Travel Desk dashboard (GET /desk-dashboard). Upcoming travels =
// APPROVED / ARRANGING / ARRANGED trips departing today or later, soonest
// first. Pending bookings = APPROVED (awaiting arrangement) and ARRANGING
// (services pending, or every service arranged but not yet marked
// arranged), nearest departure first, past/near departures flagged. Scoping is the Processing board's: an Admin or the Travel Desk
// grant holder sees every traveller, an Official only theirs, a plain user
// nothing. Claims, other statuses and other workspaces never appear.
//
// Real: cstep router, models, in-memory Mongo on a fresh database,
//   cstep_qc_deskdash. Requests and arrangement lines are inserted raw so
//   each status / date is exact.
// Stubbed: mail, S3 + PDF helpers, auth (x-test-user) and the workspace
//   resolver.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_deskdash";
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
const { buildDeskDashboard, daysUntil } = await import("../utils/cstepDeskDashboard.js");
const { todayIST } = await import("../utils/dateIST.js");

const DB = "cstep_qc_deskdash";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
const OTHER_WS = oid();
const U = { official: oid(), desk: oid(), revoked: oid(), plain: oid(), admin: oid() };
const TP_A = oid(); // Official = U.official
const TP_B = oid(); // no Official
const TP_X = oid(); // another workspace

const app = express();
app.use(express.json());
app.use((req: any, _res: any, next: any) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  req.workspaceObjectId = WS;
  next();
});
app.use("/api/cstep", cstepRouter);

const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"]) => ({
  _id: String(id), id: String(id), sub: String(id), email: `${String(id)}@qc.local`, roles, workspaceId: String(WS),
});
const ACT = {
  official: who(U.official),
  desk: who(U.desk),
  revoked: who(U.revoked),
  plain: who(U.plain),
  admin: who(U.admin, ["ADMIN"]),
};
const dash = async (as: any) => {
  const r = await request(app).get("/api/cstep/desk-dashboard").set("x-test-user", JSON.stringify(as));
  if (r.status !== 200) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

// Departures relative to today in IST, the same clock the route uses.
const TODAY = todayIST();
const day = (offset: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

const R = {
  a1: oid(), // A APPROVED +10            -> upcoming + pending
  a2: oid(), // A ARRANGING +2, 1 pending -> upcoming + pending DUE_SOON
  a3: oid(), // A ARRANGING +5, all lines arranged, not marked -> upcoming + pending READY_TO_MARK_ARRANGED
  a4: oid(), // A ARRANGED +1             -> upcoming only
  a5: oid(), // A APPROVED -3             -> pending OVERDUE only
  a6: oid(), // A REPORT_PENDING +4       -> neither
  a7: oid(), // A LOCAL_TRAVEL_CLAIM APPROVED +1 -> neither
  a8: oid(), // A ARRANGED -1 (already gone) -> neither
  b1: oid(), // B ARRANGING today, legacy line w/o status -> upcoming + pending DUE_SOON
  b2: oid(), // B SUBMITTED +6            -> neither
  x1: oid(), // other workspace APPROVED +1 -> never
};
const tour = (_id: mongoose.Types.ObjectId, tp: mongoose.Types.ObjectId, status: string, offset: number, extra: any = {}) => ({
  _id, workspaceId: tp === TP_X ? OTHER_WS : WS, travelerProfileId: tp, formType: "TOUR_PROPOSAL", type: "DOMESTIC",
  purpose: `QC ${String(_id).slice(-4)}`, stations: [{ from: "Bengaluru", to: "Delhi" }], countries: [],
  departureDate: day(offset), returnDate: day(offset + 2), status, createdAt: new Date(), updatedAt: new Date(), ...extra,
});
const line = (requestId: mongoose.Types.ObjectId, status?: string) => ({
  _id: oid(), workspaceId: WS, requestId, source: "REQUESTED", requestedType: "FLIGHT", arrangedType: "FLIGHT",
  ...(status ? { status } : {}), createdAt: new Date(),
});

const ids = (rows: any[]) => rows.map((r) => String(r._id));
const S = (...xs: mongoose.Types.ObjectId[]) => xs.map(String);

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri(DB);
  const host = new URL(uri.replace(/^mongodb:\/\//, "http://")).hostname;
  if (host !== "127.0.0.1") throw new Error(`Step 0: refusing to seed — host is ${host}, not 127.0.0.1`);
  await mongoose.connect(uri, { autoIndex: false });
  if (mongoose.connection.db!.databaseName !== DB) throw new Error("Step 0: wrong database");
  const existing = await mongoose.connection.db!.listCollections().toArray();
  if (existing.length) throw new Error(`Step 0: refusing to seed — ${DB} is not empty (${existing.length} collections)`);

  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany(
    (Object.keys(U) as Array<keyof typeof U>).map((k) => ({
      _id: U[k], email: `${String(U[k])}@qc.local`, firstName: k, roles: ["REQUESTER"], workspaceId: WS,
    })) as any[],
  );
  await col("travellerprofiles").insertMany([
    { _id: TP_A, workspaceId: WS, travelerId: "CSTEP-001", firstName: "Asha", lastName: "QC", isActive: true, officialUserId: U.official },
    { _id: TP_B, workspaceId: WS, travelerId: "CSTEP-002", firstName: "Bala", lastName: "QC", isActive: true },
    { _id: TP_X, workspaceId: OTHER_WS, travelerId: "CSTEP-X", firstName: "Xen", lastName: "QC", isActive: true, officialUserId: U.official },
  ] as any[]);
  await col("csteptraveldeskgrants").insertMany([
    { workspaceId: WS, userId: U.desk, grantedBy: U.admin, grantedAt: new Date() },
    { workspaceId: WS, userId: U.revoked, grantedBy: U.admin, grantedAt: new Date(), revokedAt: new Date(), revokedBy: U.admin },
  ] as any[]);
  await col("csteptravelrequests").insertMany([
    tour(R.a1, TP_A, "APPROVED", 10),
    tour(R.a2, TP_A, "ARRANGING", 2),
    tour(R.a3, TP_A, "ARRANGING", 5),
    tour(R.a4, TP_A, "ARRANGED", 1),
    tour(R.a5, TP_A, "APPROVED", -3),
    tour(R.a6, TP_A, "REPORT_PENDING", 4),
    tour(R.a7, TP_A, "APPROVED", 1, { formType: "LOCAL_TRAVEL_CLAIM", type: undefined }),
    tour(R.a8, TP_A, "ARRANGED", -1),
    tour(R.b1, TP_B, "ARRANGING", 0),
    tour(R.b2, TP_B, "SUBMITTED", 6),
    tour(R.x1, TP_X, "APPROVED", 1),
  ] as any[]);
  await col("csteparrangements").insertMany([
    line(R.a2, "PENDING"),
    line(R.a2, "ARRANGED"),
    line(R.a3, "ARRANGED"),
    line(R.a3, "ARRANGED"),
    line(R.b1), // made before status existed — reads as the schema default, PENDING
  ] as any[]);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

const ALL_UPCOMING = S(R.b1, R.a4, R.a2, R.a3, R.a1);
const ALL_PENDING = S(R.a5, R.b1, R.a2, R.a3, R.a1);

describe("GET /desk-dashboard — what lands where", () => {
  it("upcoming: approved / arranging / arranged trips departing today or later, soonest first", async () => {
    const body = await dash(ACT.admin);
    expect(body.today).toBe(TODAY);
    expect(ids(body.upcoming)).toEqual(ALL_UPCOMING);
    expect(body.upcoming.map((r: any) => r.daysToDeparture)).toEqual([0, 1, 2, 5, 10]);
    // traveller name comes along, like the queue rows
    expect(body.upcoming[0].travellerName).toBe("Bala QC");
  });

  it("pending: APPROVED and every ARRANGING case, nearest departure first", async () => {
    const body = await dash(ACT.admin);
    expect(ids(body.pending)).toEqual(ALL_PENDING);
    const byId = new Map(body.pending.map((r: any) => [String(r._id), r]));
    expect((byId.get(String(R.a2)) as any).pendingServices).toBe(1);
    expect((byId.get(String(R.a2)) as any).totalServices).toBe(2);
    expect((byId.get(String(R.b1)) as any).pendingServices).toBe(1);
  });

  it("labels each pending case with what the desk still has to do", async () => {
    const body = await dash(ACT.admin);
    const action = Object.fromEntries(body.pending.map((r: any) => [String(r._id), r.deskAction]));
    expect(action).toEqual({
      [String(R.a5)]: "AWAITING_ARRANGEMENT",
      [String(R.b1)]: "PENDING_SERVICES",
      [String(R.a2)]: "PENDING_SERVICES",
      [String(R.a3)]: "READY_TO_MARK_ARRANGED",
      [String(R.a1)]: "AWAITING_ARRANGEMENT",
    });
  });

  it("flags a passed departure as OVERDUE and one within the near window as DUE_SOON", async () => {
    const body = await dash(ACT.admin);
    const urgency = Object.fromEntries(body.pending.map((r: any) => [String(r._id), r.urgency]));
    expect(urgency).toEqual({
      [String(R.a5)]: "OVERDUE",
      [String(R.b1)]: "DUE_SOON",
      [String(R.a2)]: "DUE_SOON",
      [String(R.a3)]: null,
      [String(R.a1)]: null,
    });
    expect(body.nearDays).toBe(3);
  });

  it("never lists claims, other statuses, past arranged trips or another workspace's cases", async () => {
    const body = await dash(ACT.admin);
    const seen = new Set([...ids(body.upcoming), ...ids(body.pending)]);
    for (const id of S(R.a6, R.a7, R.a8, R.b2, R.x1)) expect(seen.has(id)).toBe(false);
  });
});

describe("GET /desk-dashboard — scoping, same as the Processing board", () => {
  it("the Travel Desk grant holder sees every traveller", async () => {
    const body = await dash(ACT.desk);
    expect(ids(body.upcoming)).toEqual(ALL_UPCOMING);
    expect(ids(body.pending)).toEqual(ALL_PENDING);
  });

  it("an Official sees only the travellers assigned to them", async () => {
    const body = await dash(ACT.official);
    expect(ids(body.upcoming)).toEqual(S(R.a4, R.a2, R.a3, R.a1));
    expect(ids(body.pending)).toEqual(S(R.a5, R.a2, R.a3, R.a1));
  });

  it("a plain user — and a revoked desk grant — gets empty lists, not a 403", async () => {
    for (const as of [ACT.plain, ACT.revoked]) {
      const body = await dash(as);
      expect(body.upcoming).toEqual([]);
      expect(body.pending).toEqual([]);
    }
  });

  it("matches the Processing board's own scope for each caller", async () => {
    for (const as of [ACT.admin, ACT.desk, ACT.official, ACT.plain]) {
      const q = await request(app).get("/api/cstep/official-queue").set("x-test-user", JSON.stringify(as));
      const board = new Set(ids(q.body.requests));
      const body = await dash(as);
      for (const id of [...ids(body.upcoming), ...ids(body.pending)]) expect(board.has(id)).toBe(true);
    }
  });
});

describe("buildDeskDashboard — pure", () => {
  const T = "2026-10-24";
  const r = (id: string, status: string, departureDate?: string) => ({ _id: id, status, departureDate, createdAt: "2026-10-01" });

  it("daysUntil counts calendar days and ignores non-dates", () => {
    expect(daysUntil(T, "2026-10-24")).toBe(0);
    expect(daysUntil(T, "2026-10-27")).toBe(3);
    expect(daysUntil(T, "2026-11-01")).toBe(8);
    expect(daysUntil(T, "2026-10-20")).toBe(-4);
    expect(daysUntil(T, "")).toBeNull();
    expect(daysUntil(T, undefined)).toBeNull();
  });

  it("an approved case with no departure date is still pending, sorted last; never upcoming", () => {
    const out = buildDeskDashboard([r("nodate", "APPROVED"), r("soon", "APPROVED", "2026-10-26")], new Map(), T);
    expect(out.upcoming.map((x) => x._id)).toEqual(["soon"]);
    expect(out.pending.map((x) => x._id)).toEqual(["soon", "nodate"]);
    expect(out.pending[1].urgency).toBeNull();
  });

  it("the near window ends at DESK_NEAR_DAYS", () => {
    const out = buildDeskDashboard([r("d3", "APPROVED", "2026-10-27"), r("d4", "APPROVED", "2026-10-28")], new Map(), T);
    expect(out.pending.map((x) => [x._id, x.urgency])).toEqual([["d3", "DUE_SOON"], ["d4", null]]);
  });

  it("an ARRANGING case with nothing pending — even no lines at all — is ready to mark arranged", () => {
    const out = buildDeskDashboard(
      [r("empty", "ARRANGING", "2026-10-30"), r("done", "ARRANGING", "2026-10-31"), r("open", "ARRANGING", "2026-11-01")],
      new Map([["done", { pending: 0, total: 2 }], ["open", { pending: 1, total: 2 }]]),
      T,
    );
    expect(out.pending.map((x) => [x._id, x.deskAction])).toEqual([
      ["empty", "READY_TO_MARK_ARRANGED"],
      ["done", "READY_TO_MARK_ARRANGED"],
      ["open", "PENDING_SERVICES"],
    ]);
  });

  it("ARRANGED is never pending", () => {
    const out = buildDeskDashboard([r("arr", "ARRANGED", "2026-10-25")], new Map(), T);
    expect(out.pending).toEqual([]);
    expect(out.upcoming.map((x) => x._id)).toEqual(["arr"]);
  });
});
