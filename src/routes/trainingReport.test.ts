// GET /api/training/report (+ /export) — the org-wide Learning Hub progress
// report. Real Mongo (memory server), the real router, the REAL requireHouse
// and the REAL requirePermission("people","READ"); only authentication is
// stubbed (x-test-user picks the session). Pins:
//   • a person with NO progress row appears, Not started, in every module
//   • completed / in progress / % derive from real rows
//   • columns = LIVE registry modules only (the real hub file; plus a fixture
//     registry proving a newly-published deck appears with no backend change)
//   • department filter, normalisation and the Unassigned bucket
//   • per-module counts + completion rate
//   • row population: active HOUSE staff only
//   • the gate: people:READ + HOUSE (employee 403, tenant 403, HR 200, SUPERADMIN 200)
//   • the XLSX export carries the grid
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import ExcelJS from "exceljs";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/training-report-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: TrainingProgress } = await import("../models/TrainingProgress.js");
const { default: User } = await import("../models/User.js");
const { default: Department } = await import("../models/Department.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { default: trainingReportRouter } = await import("./trainingReport.js");
const { requireHouse } = await import("../middleware/requireHouse.js");
const { requirePermission } = await import("../middleware/requirePermission.js");
const { buildTrainingReport, normalizeDepartment, cellFor, UNASSIGNED } = await import("../services/trainingReport.js");
const { parsePathsRegistry, HUB_FILE } = await import("../services/trainingModules.js");

const HOUSE = "69679a7628330a58d29f2254";
const TENANT = new mongoose.Types.ObjectId();
const oid = () => new mongoose.Types.ObjectId();

// People in the HOUSE workspace.
const P = {
  never: oid(),     // no progress rows at all — the case the report exists for
  done: oid(),      // completed CRM, part-way through expense
  started: oid(),   // opened CRM only
  noDept: oid(),    // blank department → Unassigned
  inactive: oid(),  // INACTIVE — must not appear
  customer: oid(),  // a CUSTOMER account in the HOUSE workspace — not staff
  hr: oid(),        // HR with people:READ — the report's reader
  employee: oid(),  // ordinary employee, people:NONE
};
const TENANT_USER = oid();

const SESSIONS: Record<string, any> = {
  super: { id: oid().toHexString(), roles: ["SUPERADMIN"], workspaceId: HOUSE },
  hr: { id: P.hr.toHexString(), roles: ["HR"], workspaceId: HOUSE },
  employee: { id: P.employee.toHexString(), roles: ["EMPLOYEE"], workspaceId: HOUSE },
  noperm: { id: P.never.toHexString(), roles: ["EMPLOYEE"], workspaceId: HOUSE },
  tenant: { id: TENANT_USER.toHexString(), roles: ["HR"], workspaceId: TENANT.toHexString() },
};

const app = express();
app.use(
  "/api/training/report",
  (req: any, _res, next) => {
    req.user = SESSIONS[String(req.headers["x-test-user"] || "super")];
    req.workspaceId = req.user.workspaceId;
    req.workspaceObjectId = new mongoose.Types.ObjectId(req.user.workspaceId);
    next();
  },
  requireHouse,
  requirePermission("people", "READ"),
  trainingReportRouter,
);
const get = (who: string, qs = "") => request(app).get(`/api/training/report${qs}`).set("x-test-user", who);

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const house = new mongoose.Types.ObjectId(HOUSE);
  const u = (id: mongoose.Types.ObjectId, o: Record<string, any>) => ({ _id: id, workspaceId: house, passwordHash: "x", roles: ["EMPLOYEE"], status: "ACTIVE", ...o });
  await User.collection.insertMany([
    u(P.never, { name: "Asha Never", email: "asha@plumtrips.com", department: "Tech & Product" }),
    u(P.done, { name: "Bala Done", email: "bala@plumtrips.com", department: "  tech  &  product " }),
    u(P.started, { name: "Chitra Started", email: "chitra@plumtrips.com", department: "Ops & Service Delivery" }),
    u(P.noDept, { name: "Dev Blank", email: "dev@plumtrips.com", department: "" }),
    u(P.inactive, { name: "Esha Gone", email: "esha@plumtrips.com", department: "Tech & Product", status: "INACTIVE" }),
    u(P.customer, { name: "Farah Customer", email: "farah@client.com", roles: ["CUSTOMER"] }),
    u(P.hr, { name: "Gita HR", email: "gita@plumtrips.com", roles: ["HR"], department: "People & Culture" }),
    { _id: P.employee, workspaceId: house, passwordHash: "x", roles: ["EMPLOYEE"], firstName: "Hari", lastName: "Employee", email: "hari@plumtrips.com" }, // no status, no department
    { _id: TENANT_USER, workspaceId: TENANT, passwordHash: "x", roles: ["HR"], status: "ACTIVE", name: "Ivy Tenant", email: "ivy@tenant.com" },
  ] as any[]);
  await Department.collection.insertMany([
    { workspaceId: house, name: "Tech & Product" },
    { workspaceId: house, name: "Ops & Service Delivery" },
    { workspaceId: house, name: "People & Culture" },
  ] as any[]);
  const perm = (userId: mongoose.Types.ObjectId, access: string) => ({
    userId: userId.toHexString(), email: `${userId}@x`, workspaceId: HOUSE, universe: "STAFF",
    level: { code: access === "NONE" ? "L1" : "L5", name: "x" }, modules: { people: { access, scope: "ALL" } }, grantedBy: "test",
  });
  await UserPermission.create([perm(P.hr, "READ"), perm(P.employee, "NONE")] as any);
  await TrainingProgress.collection.insertMany([
    { userId: P.done, module: "crm", total: 63, maxSlide: 62, lastSlide: 62, completed: true, completedAt: new Date("2026-09-20T06:00:00Z"), updatedAt: new Date("2026-09-20T06:00:00Z") },
    { userId: P.done, module: "expense", total: 133, maxSlide: 65, lastSlide: 65, completed: false, updatedAt: new Date("2026-09-22T06:00:00Z") },
    { userId: P.started, module: "crm", total: 63, maxSlide: 0, lastSlide: 0, completed: false, updatedAt: new Date("2026-09-23T06:00:00Z") },
    { userId: P.inactive, module: "crm", total: 63, maxSlide: 62, completed: true },
    { userId: P.never, module: "helloviza", total: 10, maxSlide: 3, completed: false }, // a "soon" module — must not surface
  ] as any[]);
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const rowOf = (report: any, id: mongoose.Types.ObjectId) => report.rows.find((r: any) => r.userId === id.toHexString());

describe("the never-started case", () => {
  it("a person with NO progress rows appears, Not started in every live module", async () => {
    const r = await get("super");
    expect(r.status).toBe(200);
    const asha = rowOf(r.body, P.never);
    expect(asha, "the never-started person must be in the report").toBeTruthy();
    expect(asha.cells.crm).toEqual({ status: "not_started", pct: 0, slide: null, total: 63, lastActivity: null, completedAt: null });
    expect(asha.cells.expense.status).toBe("not_started");
    expect(asha.cells.expense.total).toBe(133);
    const hari = rowOf(r.body, P.employee); // no status field, no department
    expect(hari).toMatchObject({ name: "Hari Employee", department: UNASSIGNED });
    expect(hari.cells.crm.status).toBe("not_started");
  });
});

describe("cells derive from real rows", () => {
  it("completed / in progress / percentages", async () => {
    const r = await get("super");
    const bala = rowOf(r.body, P.done);
    expect(bala.cells.crm).toMatchObject({ status: "completed", pct: 100, slide: 63, completedAt: "2026-09-20T06:00:00.000Z" });
    expect(bala.cells.expense).toMatchObject({ status: "in_progress", pct: 50, slide: 66, total: 133, completedAt: null, lastActivity: "2026-09-22T06:00:00.000Z" });
    const chitra = rowOf(r.body, P.started);
    expect(chitra.cells.crm).toMatchObject({ status: "in_progress", pct: 2, slide: 1 }); // opened = in progress
    expect(chitra.cells.expense.status).toBe("not_started");
  });

  it("cellFor matches the hub's %: completed 100, otherwise capped at 99", () => {
    expect(cellFor({ total: 63, maxSlide: 62, completed: false }, { total: 63 }).pct).toBe(99);
    expect(cellFor({ total: 0, maxSlide: 5 }, { total: 20 }).pct).toBe(30); // registry total as fallback
    expect(cellFor(null, { total: 20 }).status).toBe("not_started");
  });
});

describe("columns come from the registry — live modules only", () => {
  it("the real hub: CRM and Expense; the coming-soon HRMS / Helloviza never appear", async () => {
    const r = await get("super");
    expect(r.body.modules.map((m: any) => m.id)).toEqual(["crm", "expense"]);
    expect(r.body.modules.find((m: any) => m.id === "crm")).toMatchObject({ title: "CRM & Sales", total: 63 });
    for (const row of r.body.rows) expect(Object.keys(row.cells)).toEqual(["crm", "expense"]);
    expect(Object.keys(r.body.counts)).toEqual(["crm", "expense"]);
  });

  it("a deck newly marked live in PATHS appears as a column with no backend change", async () => {
    const real = fs.readFileSync(HUB_FILE, "utf8");
    const withNewDeck = real.replace(/\{id:"hrms",(\s*)icon:"[^"]*", title:"HRMS Essentials",\s*status:"soon"/, (m) => m.replace('status:"soon"', 'status:"live", href:"hrms-walkthrough.html", meta:"40 slides · ~15 min"'));
    expect(withNewDeck).not.toBe(real);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hub-")), "learning-hub.html");
    fs.writeFileSync(file, withNewDeck);
    const report = await buildTrainingReport({ hubFile: file });
    expect(report.modules.map((m) => m.id)).toEqual(["crm", "hrms", "expense"]);
    expect(report.modules[1]).toMatchObject({ title: "HRMS Essentials", total: 40 });
    expect(rowOf(report, P.never).cells.hrms.status).toBe("not_started");
  });

  it("parsePathsRegistry reads the real file (4 entries, 2 live)", () => {
    const all = parsePathsRegistry(fs.readFileSync(HUB_FILE, "utf8"));
    expect(all.map((m) => `${m.id}:${m.status}`)).toEqual(["crm:live", "hrms:soon", "expense:live", "helloviza:soon"]);
  });
});

describe("rows and departments", () => {
  it("active HOUSE staff only — no inactive, customer or other-workspace users", async () => {
    const r = await get("super");
    const ids = r.body.rows.map((x: any) => x.userId);
    expect(ids).not.toContain(P.inactive.toHexString());
    expect(ids).not.toContain(P.customer.toHexString());
    expect(ids).not.toContain(TENANT_USER.toHexString());
    expect(ids.sort()).toEqual([P.never, P.done, P.started, P.noDept, P.hr, P.employee].map((x) => x.toHexString()).sort());
  });

  it("departments are normalised (spacing + casing from the Department list) and blanks bucket as Unassigned", async () => {
    const r = await get("super");
    expect(rowOf(r.body, P.done).department).toBe("Tech & Product");
    expect(r.body.departments).toEqual([
      { name: "Ops & Service Delivery", count: 1 },
      { name: "People & Culture", count: 1 },
      { name: "Tech & Product", count: 2 },
      { name: UNASSIGNED, count: 2 },
    ]);
    expect(normalizeDepartment("  ", new Map())).toBe(UNASSIGNED);
    expect(normalizeDepartment("Product & Growth", new Map())).toBe("Product & Growth");
  });

  it("the department filter narrows rows AND counts; Unassigned is filterable", async () => {
    const tech = await get("super", "?department=Tech%20%26%20Product");
    expect(tech.body.rows.map((x: any) => x.name)).toEqual(["Asha Never", "Bala Done"]);
    expect(tech.body.counts.crm).toEqual({ completed: 1, inProgress: 0, notStarted: 1, total: 2, completionRate: 50 });
    const un = await get("super", "?department=Unassigned");
    expect(un.body.rows.map((x: any) => x.name).sort()).toEqual(["Dev Blank", "Hari Employee"]);
    const two = await get("super", "?department=Unassigned,Ops%20%26%20Service%20Delivery");
    expect(two.body.rows).toHaveLength(3);
    expect(two.body.filter.departments).toEqual(["Unassigned", "Ops & Service Delivery"]);
    expect(two.body.departments).toHaveLength(4); // filter options always cover everyone
  });
});

describe("per-module counts", () => {
  it("completed / in progress / not started / completion rate over everyone", async () => {
    const r = await get("super");
    expect(r.body.counts.crm).toEqual({ completed: 1, inProgress: 1, notStarted: 4, total: 6, completionRate: 16.7 });
    expect(r.body.counts.expense).toEqual({ completed: 0, inProgress: 1, notStarted: 5, total: 6, completionRate: 0 });
  });
});

describe("the gate — HOUSE + people:READ", () => {
  it("HR with people:READ gets the report", async () => {
    expect((await get("hr")).status).toBe(200);
  });
  it("SUPERADMIN gets the report", async () => {
    expect((await get("super")).status).toBe(200);
  });
  it("an ordinary employee with people:NONE is refused", async () => {
    const r = await get("employee");
    expect(r.status).toBe(403);
    expect(r.body.rows).toBeUndefined();
  });
  it("an employee with no permission record at all is refused", async () => {
    expect((await get("noperm")).status).toBe(403);
  });
  it("a tenant user is refused even with an HR role", async () => {
    expect((await get("tenant")).status).toBe(403);
  });
  it("the export is behind the same gate", async () => {
    expect((await get("employee", "/export")).status).toBe(403);
  });
});

describe("XLSX export", () => {
  it("carries the grid (status + % per live module) and the summary", async () => {
    const res = await request(app)
      .get("/api/training/report/export?department=Tech%20%26%20Product")
      .set("x-test-user", "hr")
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as any);
    const grid = wb.getWorksheet("Progress")!;
    const header = (grid.getRow(1).values as any[]).slice(1);
    expect(header.slice(0, 5)).toEqual(["Name", "Email", "Department", "CRM & Sales — status", "CRM & Sales — %"]);
    expect(header).toContain("Expense Management — status");
    expect(header.join("|")).not.toMatch(/HRMS|Helloviza/);
    const rows = [2, 3].map((n) => (grid.getRow(n).values as any[]).slice(1));
    expect(rows.map((r) => r[0])).toEqual(["Asha Never", "Bala Done"]);
    expect(rows[0].slice(3, 5)).toEqual(["Not started", 0]);
    expect(rows[1].slice(3, 5)).toEqual(["Completed", 100]);
    expect(grid.rowCount).toBe(3);
    const summary = wb.getWorksheet("Summary")!;
    expect((summary.getRow(2).values as any[]).slice(1)).toEqual(["CRM & Sales", 1, 0, 1, 2, 50]);
  });
});
