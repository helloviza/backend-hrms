// CSTEP Training — the deck files, PUT/GET /progress and the Team Training
// report (+ export). Real Mongo (memory server), the real routers and the
// REAL requireFeature("cstepEnabled"), mounted in server.ts's order; only
// requireAuth + requireWorkspace are stubbed (x-test-user picks the session
// and the workspace it resolves). Pins:
//   • files: allowlist only, no-store, HOUSE hub/decks not reachable here
//   • progress: own row only, keyed {workspaceId, userId, module}; body ids
//     ignored; never backwards; never un-completed; lastSlide follows the
//     newer record; re-PUT idempotent; only LIVE CSTEP decks accepted
//   • CSTEP-scoped: a workspace without cstepEnabled is refused everywhere
//   • the report: every active user of THIS workspace × live decks, no row =
//     Not started, role tags + role filter, counts, XLSX; open to CSTEP
//     Admin and the mapped Finance user only
//   • the registry: the real CSTEP hub's live decks
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import ExcelJS from "exceljs";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/cstep-training-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: CstepTrainingProgress } = await import("../models/cstep/CstepTrainingProgress.js");
const { default: User } = await import("../models/User.js");
const { default: TravellerProfile } = await import("../models/TravellerProfile.js");
const { default: cstepTrainingRouter } = await import("./cstep.training.js");
const { default: cstepTrainingReportRouter } = await import("./cstep.trainingReport.js");
const { requireFeature } = await import("../middleware/requireFeature.js");
const { liveCstepTrainingModules, loadCstepTrainingModules } = await import("../services/cstepTrainingModules.js");

const oid = () => new mongoose.Types.ObjectId();
const WS = oid(); // CSTEP on
const WS2 = oid(); // another CSTEP workspace
const OFF = oid(); // CSTEP off
const U = { admin: oid(), finance: oid(), approver: oid(), requester: oid(), plain: oid(), inactive: oid(), other: oid(), off: oid() };

const WORKSPACES: Record<string, any> = {
  [String(WS)]: { _id: WS, status: "ACTIVE", config: { features: { cstepEnabled: true } } },
  [String(WS2)]: { _id: WS2, status: "ACTIVE", config: { features: { cstepEnabled: true } } },
  [String(OFF)]: { _id: OFF, status: "ACTIVE", config: { features: { cstepEnabled: false } } },
};
const SESSIONS: Record<string, { id: mongoose.Types.ObjectId; roles: string[]; ws: mongoose.Types.ObjectId }> = {
  admin: { id: U.admin, roles: ["CUSTOMER", "WORKSPACE_LEADER"], ws: WS },
  finance: { id: U.finance, roles: ["CUSTOMER"], ws: WS },
  approver: { id: U.approver, roles: ["CUSTOMER"], ws: WS },
  requester: { id: U.requester, roles: ["CUSTOMER"], ws: WS },
  plain: { id: U.plain, roles: ["CUSTOMER"], ws: WS },
  other: { id: U.other, roles: ["CUSTOMER", "WORKSPACE_LEADER"], ws: WS2 },
  off: { id: U.off, roles: ["CUSTOMER", "WORKSPACE_LEADER"], ws: OFF },
  // The same person signed in to a second workspace — a separate progress row.
  requesterWs2: { id: U.requester, roles: ["CUSTOMER"], ws: WS2 },
};

const app = express();
app.use(express.json());
// Stand-ins for requireAuth + requireWorkspace (what they attach).
const stub = (req: any, _res: any, next: any) => {
  const s = SESSIONS[String(req.headers["x-test-user"] || "requester")];
  req.user = { id: String(s.id), sub: String(s.id), roles: s.roles };
  req.workspaceId = String(s.ws);
  req.workspaceObjectId = s.ws;
  req.workspace = WORKSPACES[String(s.ws)];
  next();
};
app.use("/api/cstep/training/report", stub, requireFeature("cstepEnabled"), cstepTrainingReportRouter);
app.use("/api/cstep/training", stub, requireFeature("cstepEnabled"), cstepTrainingRouter);

const DECK = "cstep-setup";
// The decks published so far, registry order — extend as each one goes live.
const LIVE = ["cstep-setup", "cstep-request", "cstep-approve", "cstep-process", "cstep-finance"];
const put = (who: string, module: string, body: any) =>
  request(app).put(`/api/cstep/training/progress/${module}`).set("x-test-user", who).send(body);
const T = (min: number) => new Date(Date.UTC(2026, 9, 18, 9, 0) + min * 60_000).toISOString();
const rec = (o: Record<string, any> = {}) => ({
  module: DECK, total: 30, maxSlide: 10, lastSlide: 10, viewed: 3,
  viewedIdx: { 0: 1, 5: 1, 10: 1 }, completed: false,
  startedAt: T(0), updatedAt: T(10), completedAt: null, ...o,
});
const rowsOf = (uid: mongoose.Types.ObjectId) => CstepTrainingProgress.collection.find({ userId: uid }).toArray();

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await CstepTrainingProgress.syncIndexes();
  const now = new Date();
  const user = (_id: mongoose.Types.ObjectId, name: string, ws: mongoose.Types.ObjectId, roles: string[], status = "ACTIVE") => ({
    _id, name, email: `${name.toLowerCase().replace(/ /g, ".")}@cstep-train.test`, roles, workspaceId: ws, status, createdAt: now, updatedAt: now,
  });
  await User.collection.insertMany([
    user(U.admin, "Asha Admin", WS, ["CUSTOMER", "WORKSPACE_LEADER"]),
    user(U.finance, "Farah Finance", WS, ["CUSTOMER"]),
    user(U.approver, "Arjun Approver", WS, ["CUSTOMER"]),
    user(U.requester, "Rhea Requester", WS, ["CUSTOMER"]),
    user(U.plain, "Paul Plain", WS, ["CUSTOMER"]),
    user(U.inactive, "Ivy Inactive", WS, ["CUSTOMER"], "INACTIVE"),
    user(U.other, "Otto Other", WS2, ["CUSTOMER", "WORKSPACE_LEADER"]),
    user(U.off, "Olive Off", OFF, ["CUSTOMER", "WORKSPACE_LEADER"]),
  ]);
  await TravellerProfile.collection.insertMany([
    { workspaceId: WS, travelerId: "T1", employeeId: "T1", firstName: "Rhea", lastName: "Requester", email: "rhea.requester@cstep-train.test", isActive: true, claimedBy: U.requester, tourApproverId: U.approver, financeUserId: U.finance, createdAt: now, updatedAt: now },
    // A Finance mapping in ANOTHER workspace confers nothing here.
    { workspaceId: WS2, travelerId: "T2", employeeId: "T2", firstName: "X", lastName: "Y", email: "x@cstep-train.test", isActive: true, financeUserId: U.plain, createdAt: now, updatedAt: now },
  ]);
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await CstepTrainingProgress.deleteMany({ workspaceId: { $in: [WS, WS2, OFF] } });
});

describe("the registry", () => {
  it("the real CSTEP hub: all five decks registered; every live one has its file in the allowlist dir", () => {
    const all = loadCstepTrainingModules();
    expect(all.map((m) => m.id)).toEqual(["cstep-setup", "cstep-request", "cstep-approve", "cstep-process", "cstep-finance"]);
    const live = liveCstepTrainingModules();
    expect(live.map((m) => m.id)).toEqual(LIVE);
    for (const m of live) expect(m.total, m.id).toBeGreaterThan(0);
  });
});

describe("files", () => {
  it("serves the hub and the deck from the allowlist, private and no-store", async () => {
    for (const f of ["cstep-training-hub.html", ...LIVE.map((m) => `${m}.html`)]) {
      const r = await request(app).get(`/api/cstep/training/${f}`).set("x-test-user", "requester");
      expect(r.status, f).toBe(200);
      expect(r.headers["content-type"]).toMatch(/text\/html/);
      expect(r.headers["cache-control"]).toBe("private, no-store");
      expect(r.text).toContain("Plumtrips Learning · shared progress storage");
    }
  });
  it("anything else is a 404 — the HOUSE Learning Hub files are not reachable here", async () => {
    for (const f of ["learning-hub.html", "crm-walkthrough.html", "spendbox-walkthrough.html", "..%2Fserver.ts", "nope.html"]) {
      const r = await request(app).get(`/api/cstep/training/${f}`).set("x-test-user", "requester");
      expect(r.status, f).toBe(404);
    }
  });
});

describe("CSTEP-scoped: a workspace without cstepEnabled is refused", () => {
  it("files, progress and the report all 403", async () => {
    expect((await request(app).get("/api/cstep/training/cstep-training-hub.html").set("x-test-user", "off")).status).toBe(403);
    expect((await request(app).get("/api/cstep/training/progress").set("x-test-user", "off")).status).toBe(403);
    expect((await put("off", DECK, rec())).status).toBe(403);
    expect((await request(app).get("/api/cstep/training/report").set("x-test-user", "off")).status).toBe(403);
    expect((await request(app).get("/api/cstep/training/report/export").set("x-test-user", "off")).status).toBe(403);
    expect(await rowsOf(U.off)).toHaveLength(0);
  });
});

describe("progress — own row only", () => {
  it("stores the caller's row keyed by workspace + session user; body ids are ignored", async () => {
    const r = await put("requester", DECK, rec({ userId: String(U.admin), workspaceId: String(WS2) }));
    expect(r.status).toBe(200);
    expect(r.body.progress).toMatchObject({ module: DECK, total: 30, maxSlide: 10, lastSlide: 10, viewed: 3, completed: false, viewedSlides: [0, 5, 10] });
    const rows = await rowsOf(U.requester);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].workspaceId)).toBe(String(WS));
    expect(await rowsOf(U.admin)).toHaveLength(0);
  });
  it("the same person in another workspace gets a separate row", async () => {
    await put("requester", DECK, rec());
    await put("requesterWs2", DECK, rec({ maxSlide: 2, lastSlide: 2, viewedIdx: { 2: 1 } }));
    const rows = await rowsOf(U.requester);
    expect(rows.map((x) => String(x.workspaceId)).sort()).toEqual([String(WS), String(WS2)].sort());
    const mine = await request(app).get("/api/cstep/training/progress").set("x-test-user", "requester");
    expect(mine.body.progress).toHaveLength(1);
    expect(mine.body.progress[0].maxSlide).toBe(10);
  });
  it("GET /progress returns only the caller's rows", async () => {
    await put("requester", DECK, rec());
    await put("admin", DECK, rec({ maxSlide: 29, lastSlide: 29, completed: true, completedAt: T(20), updatedAt: T(20) }));
    const r = await request(app).get("/api/cstep/training/progress").set("x-test-user", "requester");
    expect(r.status).toBe(200);
    expect(r.body.progress).toHaveLength(1);
    expect(r.body.progress[0]).toMatchObject({ module: DECK, maxSlide: 10, completed: false });
  });
});

describe("progress — the merge invariants", () => {
  it("never backwards: an older / smaller record changes nothing; viewed slides are a union", async () => {
    await put("requester", DECK, rec());
    const r = await put("requester", DECK, rec({ maxSlide: 4, lastSlide: 4, viewed: 1, viewedIdx: { 4: 1 }, updatedAt: T(5) }));
    expect(r.body.progress).toMatchObject({ maxSlide: 10, lastSlide: 10, viewed: 4, viewedSlides: [0, 4, 5, 10] });
    expect(new Date(r.body.progress.updatedAt).toISOString()).toBe(T(10));
  });
  it("never un-completed: a later incomplete record keeps completed + the earliest completedAt", async () => {
    await put("requester", DECK, rec({ maxSlide: 29, lastSlide: 29, completed: true, completedAt: T(20), updatedAt: T(20) }));
    const r = await put("requester", DECK, rec({ maxSlide: 3, lastSlide: 3, completed: false, updatedAt: T(40) }));
    expect(r.body.progress.completed).toBe(true);
    expect(new Date(r.body.progress.completedAt).toISOString()).toBe(T(20));
    // lastSlide follows the NEWER record (the resume point), maxSlide does not.
    expect(r.body.progress).toMatchObject({ lastSlide: 3, maxSlide: 29 });
  });
  it("re-PUT of the same record is idempotent", async () => {
    const a = await put("requester", DECK, rec());
    const b = await put("requester", DECK, rec());
    const strip = (p: any) => ({ ...p, updatedAt: String(p.updatedAt) });
    expect(strip(b.body.progress)).toEqual(strip(a.body.progress));
    expect(await rowsOf(U.requester)).toHaveLength(1);
  });
  it("concurrent first saves collapse into one row", async () => {
    await Promise.all([put("requester", DECK, rec()), put("requester", DECK, rec({ maxSlide: 12, lastSlide: 12, updatedAt: T(12) }))]);
    const rows = await rowsOf(U.requester);
    expect(rows).toHaveLength(1);
    expect(rows[0].maxSlide).toBe(12);
  });
  it("only a LIVE CSTEP deck: a coming-soon / unregistered deck, a HOUSE module and a bad id are refused without writing", async () => {
    const notLive = loadCstepTrainingModules().find((m) => m.status !== "live")?.id ?? "cstep-overview";
    expect((await put("requester", notLive, rec())).status).toBe(400);
    expect((await put("requester", "cstep-overview", rec())).status).toBe(400);
    expect((await put("requester", "crm", rec())).status).toBe(400);
    expect((await put("requester", "Bad_Id!", rec())).status).toBe(400);
    expect(await rowsOf(U.requester)).toHaveLength(0);
  });
});

describe("Team Training report", () => {
  const get = (who: string, qs = "") => request(app).get(`/api/cstep/training/report${qs}`).set("x-test-user", who);

  it("CSTEP Admin: every active user of THIS workspace × live decks; no row = Not started", async () => {
    await put("requester", DECK, rec());
    await put("admin", DECK, rec({ maxSlide: 29, lastSlide: 29, completed: true, completedAt: T(20), updatedAt: T(20) }));
    const r = await get("admin");
    expect(r.status).toBe(200);
    expect(r.body.modules.map((m: any) => m.id)).toEqual(LIVE);
    const names = r.body.rows.map((x: any) => x.name);
    expect(names).toEqual(["Arjun Approver", "Asha Admin", "Farah Finance", "Paul Plain", "Rhea Requester"]);
    expect(names).not.toContain("Ivy Inactive");
    expect(names).not.toContain("Otto Other");
    expect(names).not.toContain("Olive Off");
    const cell = (n: string) => r.body.rows.find((x: any) => x.name === n).cells[DECK];
    expect(cell("Asha Admin")).toMatchObject({ status: "completed", pct: 100 });
    expect(cell("Rhea Requester")).toMatchObject({ status: "in_progress", slide: 11, total: 30, pct: 37 });
    expect(cell("Paul Plain")).toMatchObject({ status: "not_started", pct: 0, slide: null });
    expect(r.body.counts[DECK]).toEqual({ completed: 1, inProgress: 1, notStarted: 3, total: 5, completionRate: 20 });
  });

  it("role tags from role + mappings, and the role filter narrows rows and counts", async () => {
    const r = await get("admin");
    const roles = (n: string) => r.body.rows.find((x: any) => x.name === n).roles;
    expect(roles("Asha Admin")).toEqual(["ADMIN"]);
    expect(roles("Arjun Approver")).toEqual(["APPROVER"]);
    expect(roles("Farah Finance")).toEqual(["FINANCE"]);
    expect(roles("Rhea Requester")).toEqual(["REQUESTER"]);
    expect(roles("Paul Plain")).toEqual([]); // his Finance mapping is in another workspace
    expect(r.body.roles).toEqual([
      { name: "ADMIN", count: 1 }, { name: "APPROVER", count: 1 }, { name: "FINANCE", count: 1 }, { name: "REQUESTER", count: 1 }, { name: "NONE", count: 1 },
    ]);
    const f = await get("admin", "?role=FINANCE,NONE");
    expect(f.body.rows.map((x: any) => x.name)).toEqual(["Farah Finance", "Paul Plain"]);
    expect(f.body.counts[DECK].total).toBe(2);
    expect(f.body.filter.roles).toEqual(["FINANCE", "NONE"]);
  });

  it("the mapped Finance user gets it too", async () => {
    expect((await get("finance")).status).toBe(200);
  });

  it("an Approver, a Requester and a plain user are refused — report and export", async () => {
    for (const who of ["approver", "requester", "plain"]) {
      expect((await get(who)).status, who).toBe(403);
      expect((await request(app).get("/api/cstep/training/report/export").set("x-test-user", who)).status, who).toBe(403);
    }
  });

  it("another workspace's admin sees only their own workspace", async () => {
    await put("requester", DECK, rec());
    const r = await get("other");
    expect(r.status).toBe(200);
    expect(r.body.rows.map((x: any) => x.name)).toEqual(["Otto Other"]);
  });

  it("the XLSX export carries the grid and a summary", async () => {
    await put("requester", DECK, rec());
    const r = await request(app).get("/api/cstep/training/report/export").set("x-test-user", "admin").buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body);
    const grid = wb.getWorksheet("Progress")!;
    expect(grid.getRow(1).getCell(3).value).toBe("CSTEP roles");
    const names = [] as string[];
    grid.eachRow((row, i) => { if (i > 1) names.push(String(row.getCell(1).value)); });
    expect(names).toEqual(["Arjun Approver", "Asha Admin", "Farah Finance", "Paul Plain", "Rhea Requester"]);
    const rhea = grid.getRow(names.indexOf("Rhea Requester") + 2);
    expect(rhea.getCell(4).value).toBe("In progress");
    expect(wb.getWorksheet("Summary")!.getRow(2).getCell(1).value).toBe(liveCstepTrainingModules()[0].title);
  });
});
