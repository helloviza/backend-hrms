// apps/backend/src/routes/manualBookings.summary.test.ts
//
// Manual Bookings Team Summary (services/manualBookingTeamSummary.ts):
// bucket maths (Cancelled outside Total / Completion % / GMV), "Open now"
// pending ignoring dates, ageing, the Unassigned row, assignee vs creator,
// scope ALL / TEAM / OWN, export = table — and that every count matches what
// the LIST route returns for the same filters (the click-through promise).
//
// Real: manual-bookings router, models, in-memory Mongo. Stubbed: the caller.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
for (const [k, v] of Object.entries({
  MONGO_URI: "mongodb://127.0.0.1:1/unused",
  JWT_SECRET: "jwt-secret-for-tests",
  JWT_REFRESH_SECRET: "refresh-secret-for-tests",
  FRONTEND_ORIGIN: "http://localhost:5173",
  AWS_REGION: "ap-south-1",
  S3_BUCKET: "test-bucket",
  GEMINI_API_KEY: "test",
})) process.env[k] ||= v;

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (_req: any, _res: any, next: any) => next();
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../utils/mailer.js", () => ({ sendMail: async () => ({ messageId: "test" }) }));
vi.mock("../utils/s3Upload.js", () => ({ uploadBufferToS3: async () => ({}), getObjectBuffer: async () => Buffer.from("") }));
vi.mock("../services/documentExtraction.service.js", async (orig) => ({ ...(await orig<any>()), enqueueExtraction: async () => undefined }));
vi.mock("../services/location.service.js", async (orig) => ({ ...(await orig<any>()), resolveActorFromRequest: async () => null }));

const { default: manualBookingsRouter } = await import("./manualBookings.js");
const { EXPORT_COLUMNS } = await import("../services/manualBookingTeamSummary.js");

const oid = () => new mongoose.Types.ObjectId();
const HOUSE_WS = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const CLIENT = oid();
const OTHER_CLIENT = oid();
const U = { MGR: oid(), R1: oid(), R1A: oid(), PEER: oid() };

let caller = { id: U.MGR, scope: "ALL", roles: ["EMPLOYEE"], house: true };
const app = express();
app.use(express.json());
app.use("/api/admin/manual-bookings", (req: any, _res, next) => {
  req.user = { _id: String(caller.id), sub: String(caller.id), roles: caller.roles, email: "x@plumtrips.com", name: "X" };
  if (caller.house) {
    req.workspace = { customerId: "PLUMTRIPS-HOUSE" };
    req.workspaceObjectId = HOUSE_WS;
  } else {
    req.workspace = { customerId: String(CLIENT) };
  }
  req.permissionScope = caller.scope;
  next();
}, manualBookingsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("manual-bookings-summary-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

const NOW = Date.now();
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000);
// Range used by every request: the whole of Nov 2026 (IST).
const RANGE = "dateFrom=2026-11-01&dateTo=2026-11-30";
const IN = new Date("2026-11-10T06:00:00Z");
const BEFORE = new Date("2026-09-10T06:00:00Z");

let seq = 0;
async function bk(over: Record<string, any>) {
  await col("manualbookings").insertOne({
    bookingRef: `MB-SUM-${String(++seq).padStart(3, "0")}`,
    workspaceId: CLIENT,
    type: "FLIGHT",
    status: "PENDING",
    source: "MANUAL",
    bookingDate: IN,
    travelDate: new Date("2027-01-18T06:00:00Z"),
    passengers: [{ name: "Riya Sen", type: "ADULT" }],
    pricing: { actualPrice: 0, quotedPrice: 0 },
    isActive: true,
    isDemo: false,
    bookedBy: U.PEER,
    createdBy: String(U.PEER),
    assignmentStatus: over.assignPerson ? "ASSIGNED" : "PENDING_TO_ASSIGN",
    createdAt: daysAgo(0.1),
    updatedAt: new Date(),
    ...over,
  });
}

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  seq = 0;
  caller = { id: U.MGR, scope: "ALL", roles: ["EMPLOYEE"], house: true };
  await col("users").insertMany([
    { _id: U.MGR, name: "Meera Manager", designation: "Team Lead", email: "m@plumtrips.com", workspaceId: HOUSE_WS },
    { _id: U.R1, name: "Ravi One", hrmsAccessRole: "EMPLOYEE", email: "r1@plumtrips.com", workspaceId: HOUSE_WS, managerId: U.MGR },
    { _id: U.R1A, name: "Asha Below", email: "r1a@plumtrips.com", workspaceId: HOUSE_WS, managerId: U.R1, roles: ["EMPLOYEE"] },
    { _id: U.PEER, name: "Pia Peer", email: "p@plumtrips.com", workspaceId: HOUSE_WS },
  ]);
  // R1 (assignee): 2 open (one WIP, one 5 days old created by MGR), 2 completed in range, 1 completed out of range,
  // 1 cancelled in range (with a price — must NOT reach GMV), 1 pending booked long ago (still open now).
  await bk({ assignPerson: U.R1, status: "PENDING", createdAt: daysAgo(2) });
  await bk({ assignPerson: U.R1, status: "WIP", createdAt: daysAgo(5), createdBy: String(U.MGR) });
  await bk({ assignPerson: U.R1, status: "CONFIRMED", pricing: { quotedPrice: 1000, grandTotal: 1180 } });
  await bk({ assignPerson: U.R1, status: "INVOICED", pricing: { quotedPrice: 500, totalWithGST: 590 } });
  await bk({ assignPerson: U.R1, status: "CONFIRMED", bookingDate: BEFORE, pricing: { grandTotal: 9999 } });
  await bk({ assignPerson: U.R1, status: "CANCELLED", pricing: { grandTotal: 7777 } });
  await bk({ assignPerson: U.R1, status: "PENDING", bookingDate: BEFORE, createdAt: daysAgo(70) });
  // R1A (R1's reportee): one completed, quotedPrice only (GMV fallback)
  await bk({ assignPerson: U.R1A, status: "CONFIRMED", pricing: { quotedPrice: 300 }, createdBy: String(U.R1A) });
  // PEER: one open, other client
  await bk({ assignPerson: U.PEER, status: "PENDING", workspaceId: OTHER_CLIENT, type: "HOTEL" });
  // Unassigned: one open, one deleted (never counted)
  await bk({ status: "PENDING", createdAt: daysAgo(4), createdBy: String(U.MGR) });
  await bk({ status: "PENDING", isActive: false });
});

const base = "/api/admin/manual-bookings";
const get = async (qs: string) => {
  const r = await request(app).get(`${base}/summary?${RANGE}&${qs}`);
  expect(r.status).toBe(200);
  return r.body;
};
const row = (s: any, name: string) => s.rows.find((r: any) => r.name === name);

describe("bucket maths", () => {
  it("Completed = CONFIRMED+INVOICED in range; Cancelled excluded from Total, Completion %, GMV", async () => {
    const s = await get("");
    const r = row(s, "Ravi One");
    expect(r).toMatchObject({ pending: 3, pendingOnly: 2, wip: 1, completed: 2, cancelled: 1, total: 5 });
    expect(r.completionPct).toBe(40);
    // grandTotal 1180 + totalWithGST 590 (the list's Gross sales rule); not 7777, not 9999
    expect(r.gmv).toBe(1770);
    expect(row(s, "Asha Below").gmv).toBe(300); // quotedPrice fallback
  });

  it('"Open now": a pending case booked long before the range still counts', async () => {
    const s = (await request(app).get(`${base}/summary?dateFrom=2026-11-20&dateTo=2026-11-21`)).body;
    expect(s.range).toEqual({ from: "2026-11-20", to: "2026-11-21" });
    const r = row(s, "Ravi One");
    expect(r.pending).toBe(3);
    expect(r.completed).toBe(0);
  });

  it("ageing since createdAt: > 1 day, > 3 days, oldest", async () => {
    const r = row(await get(""), "Ravi One");
    expect(r.olderThan1d).toBe(3); // 2d, 5d, 70d
    expect(r.olderThan3d).toBe(2); // 5d, 70d
    expect(Math.round((NOW - new Date(r.oldestPendingAt).getTime()) / 86_400_000)).toBe(70);
  });

  it("cards, donut and top-5 all sum from the table rows; soft-deleted never counted", async () => {
    const s = await get("");
    const sum = (f: string) => s.rows.reduce((a: number, r: any) => a + r[f], 0);
    expect(s.cards).toMatchObject({ completed: sum("completed"), pending: sum("pending"), cancelled: sum("cancelled") });
    expect(s.cards.total).toBe(s.cards.completed + s.cards.pending);
    expect(s.cards).toMatchObject({ total: 8, completed: 3, pending: 5, cancelled: 1, gmv: 2070 });
    expect(s.statusDonut.reduce((a: number, d: any) => a + d.count, 0)).toBe(s.cards.total + s.cards.cancelled);
    expect(s.top5[0]).toMatchObject({ name: "Ravi One", completed: 2, pending: 3 });
    expect(s.top5.find((t: any) => t.name === "Unassigned")).toBeUndefined();
  });

  it("trend: completed per booking day, pending per created day, zero-filled across the range", async () => {
    const s = await get("");
    expect(s.trend).toHaveLength(30);
    expect(s.trend.reduce((a: number, d: any) => a + d.completed, 0)).toBe(3);
    expect(s.trend.find((d: any) => d.date === "2026-11-10").completed).toBe(3);
  });
});

describe("grouping", () => {
  it("Unassigned row is first and holds the cases with no assignee", async () => {
    const s = await get("");
    expect(s.rows[0]).toMatchObject({ key: null, name: "Unassigned", pending: 1 });
  });

  it("created-by toggle regroups by creator", async () => {
    const s = await get("groupBy=creator");
    expect(s.groupBy).toBe("creator");
    expect(row(s, "Meera Manager").pending).toBe(2); // R1's WIP + the unassigned one, both created by MGR
    expect(row(s, "Meera Manager").role).toBe("Team Lead");
    expect(row(s, "Unassigned")).toBeUndefined();
  });

  it("type / client / source filters narrow every bucket", async () => {
    const s = await get(`type=HOTEL`);
    expect(s.cards.total).toBe(1);
    expect(row(s, "Pia Peer").pending).toBe(1);
    const c = await get(`workspaceId=${OTHER_CLIENT}`);
    expect(c.cards.total).toBe(1);
  });
});

describe("scope", () => {
  it("ALL: everyone", async () => {
    const s = await get("");
    expect(s.scope.everyone).toBe(true);
    expect(s.rows.map((r: any) => r.name).sort()).toEqual(["Asha Below", "Pia Peer", "Ravi One", "Unassigned"]);
  });

  it("TEAM: the manager, reportee and reportee's reportee — never the peer", async () => {
    caller = { ...caller, scope: "TEAM" };
    const s = await get("");
    expect(s.scope.everyone).toBe(false);
    const names = s.rows.map((r: any) => r.name).sort();
    expect(names).toEqual(["Asha Below", "Meera Manager", "Ravi One", "Unassigned"]);
    expect(row(s, "Meera Manager").total).toBe(0); // in scope with no cases → still listed
  });

  it("OWN: only their own row — no Unassigned row even when HOUSE intake rows are visible to them", async () => {
    // An unassigned HOUSE intake row: OWN users see it in the LIST (triage carve-out)…
    await bk({ status: "PENDING", workspaceId: new mongoose.Types.ObjectId("6a4e0d2ea90c293c9e129f48") });
    caller = { ...caller, id: U.R1, scope: "OWN" };
    const s = await get("");
    // …but the summary shows only their own row.
    expect(s.rows.map((r: any) => r.name)).toEqual(["Ravi One"]);
    expect(s.cards.pending).toBe(row(s, "Ravi One").pending);
  });

  it("TEAM keeps the Unassigned row for the triage rows", async () => {
    await bk({ status: "PENDING", workspaceId: new mongoose.Types.ObjectId("6a4e0d2ea90c293c9e129f48") });
    caller = { ...caller, scope: "TEAM" };
    expect(row(await get(""), "Unassigned").pending).toBe(2);
  });

  it("non-HOUSE callers get 403", async () => {
    caller = { ...caller, house: false };
    expect((await request(app).get(`${base}/summary`)).status).toBe(403);
    expect((await request(app).get(`${base}/summary/export`)).status).toBe(403);
  });
});

describe("click-through: every count = what the list shows for the same filters", () => {
  const list = async (qs: string) => {
    const r = await request(app).get(`${base}?limit=200&${qs}`);
    expect(r.status).toBe(200);
    return r.body;
  };
  for (const scope of ["ALL", "TEAM"]) {
    it(`scope ${scope}: pending / completed / cancelled / >1d / GMV per row`, async () => {
      caller = { ...caller, scope };
      const s = await get("");
      for (const r of s.rows) {
        const who = `assignPerson=${r.key ?? "none"}`;
        expect((await list(`${who}&status=PENDING,WIP`)).total, `${r.name} pending`).toBe(r.pending);
        const done = await list(`${who}&status=CONFIRMED,INVOICED&${RANGE}`);
        expect(done.total, `${r.name} completed`).toBe(r.completed);
        expect(done.stats.grossSales, `${r.name} GMV`).toBe(r.gmv);
        expect((await list(`${who}&status=CANCELLED&${RANGE}`)).total, `${r.name} cancelled`).toBe(r.cancelled);
        const before = new Date(new Date(s.generatedAt).getTime() - 86_400_000).toISOString();
        expect((await list(`${who}&status=PENDING,WIP&createdBefore=${before}`)).total, `${r.name} >1d`).toBe(r.olderThan1d);
      }
    });
  }
});

describe("export", () => {
  it("rows and values = the table (incl. the person search)", async () => {
    const s = await get("");
    const res = await request(app).get(`${base}/summary/export?${RANGE}&person=ravi`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.worksheets[0];
    const header = (ws.getRow(5).values as any[]).slice(1);
    expect(header).toEqual(EXPORT_COLUMNS.map((c) => c.header));
    const data: any[][] = [];
    ws.eachRow((r, n) => { if (n > 5) data.push((r.values as any[]).slice(1)); });
    expect(data).toHaveLength(1);
    const r = row(s, "Ravi One");
    const at = (h: string) => data[0][EXPORT_COLUMNS.findIndex((c) => c.header === h)];
    expect([at("Person"), at("Total"), at("Completed"), at("Pending (open now)"), at("Cancelled"), at("Completion %"), at("GMV (incl. GST)")])
      .toEqual([r.name, r.total, r.completed, r.pending, r.cancelled, r.completionPct, r.gmv]);
    expect([at("Pending > 1 day"), at("Pending > 3 days"), at("Oldest pending (days)")]).toEqual([3, 2, 70]);
    expect(String(at("Last booking"))).toMatch(/ IST$/);
  });

  it("no search → every table row, in table order", async () => {
    const s = await get("");
    const res = await request(app).get(`${base}/summary/export?${RANGE}`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const names: string[] = [];
    wb.worksheets[0].eachRow((r, n) => { if (n > 5) names.push(String((r.values as any[])[1])); });
    expect(names).toEqual(s.rows.map((r: any) => r.name));
  });
});
