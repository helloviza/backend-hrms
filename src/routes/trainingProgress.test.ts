// PUT /api/training/progress/:module — the learner's own Learning Hub row.
// Real Mongo (memory server), the real router and the REAL requireHouse; only
// authentication is stubbed (x-test-user picks the session). Pins:
//   • own row only — keyed by the session's user id, body userId ignored
//   • never backwards (maxSlide / total / viewed union / updatedAt)
//   • never un-completed (completed + earliest completedAt survive)
//   • lastSlide follows the NEWER record; re-PUT is idempotent
//   • concurrent first saves collapse into one row
//   • HOUSE-only gate; bad module ids rejected without writing
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/training-progress-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: TrainingProgress } = await import("../models/TrainingProgress.js");
const { default: trainingProgressRouter, cleanProgress } = await import("./trainingProgress.js");
const { requireHouse } = await import("../middleware/requireHouse.js");

const HOUSE = "69679a7628330a58d29f2254";
const TENANT = new mongoose.Types.ObjectId().toHexString();
const A = new mongoose.Types.ObjectId().toHexString();
const B = new mongoose.Types.ObjectId().toHexString();
const USERS: Record<string, any> = {
  a: { id: A, sub: A, roles: ["EMPLOYEE"], workspaceId: HOUSE },
  b: { id: B, sub: B, roles: ["EMPLOYEE"], workspaceId: HOUSE },
  tenant: { id: new mongoose.Types.ObjectId().toHexString(), roles: ["EMPLOYEE"], workspaceId: TENANT },
};

const app = express();
app.use(express.json());
// Stand-ins for requireAuth + requireWorkspace (what they attach), then the real HOUSE gate.
app.use("/api/training/progress", (req: any, _res, next) => {
  req.user = USERS[String(req.headers["x-test-user"] || "a")];
  req.workspaceId = req.user.workspaceId;
  req.workspaceObjectId = new mongoose.Types.ObjectId(req.user.workspaceId);
  next();
}, requireHouse, trainingProgressRouter);

const put = (who: string, module: string, body: any) =>
  request(app).put(`/api/training/progress/${module}`).set("x-test-user", who).send(body);
const row = (uid: string, module: string) =>
  TrainingProgress.collection.findOne({ userId: new mongoose.Types.ObjectId(uid), module });

const T = (min: number) => new Date(Date.UTC(2026, 8, 23, 9, 0) + min * 60_000).toISOString();
const rec = (o: Record<string, any> = {}) => ({
  module: "crm", total: 63, maxSlide: 10, lastSlide: 10, viewed: 3,
  viewedIdx: { 0: 1, 5: 1, 10: 1 }, completed: false,
  startedAt: T(0), updatedAt: T(10), completedAt: null, ...o,
});

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await TrainingProgress.syncIndexes();
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await TrainingProgress.deleteMany({});
});

describe("own row only", () => {
  it("stores the caller's row, keyed by the session user and workspace", async () => {
    const r = await put("a", "crm", rec());
    expect(r.status).toBe(200);
    expect(r.body.progress).toMatchObject({ module: "crm", total: 63, maxSlide: 10, lastSlide: 10, viewed: 3, completed: false });
    const doc: any = await row(A, "crm");
    expect(String(doc.workspaceId)).toBe(HOUSE);
    expect(doc.viewedSlides).toEqual([0, 5, 10]);
    expect(await TrainingProgress.countDocuments({})).toBe(1);
  });

  it("a userId in the body is ignored — B cannot write A's progress", async () => {
    await put("a", "crm", rec({ maxSlide: 5, lastSlide: 5 }));
    const r = await put("b", "crm", rec({ userId: A, maxSlide: 60, lastSlide: 60, completed: true, updatedAt: T(20) }));
    expect(r.status).toBe(200);
    expect((await row(A, "crm") as any).maxSlide).toBe(5);
    expect((await row(A, "crm") as any).completed).toBe(false);
    expect((await row(B, "crm") as any).maxSlide).toBe(60);
    expect(await TrainingProgress.countDocuments({})).toBe(2);
  });
});

describe("invariants", () => {
  it("never moves backwards: an older/shorter record changes nothing but can add newly seen slides", async () => {
    await put("a", "crm", rec({ maxSlide: 40, lastSlide: 40, viewedIdx: { 38: 1, 39: 1, 40: 1 }, updatedAt: T(30) }));
    const r = await put("a", "crm", rec({ maxSlide: 12, lastSlide: 12, total: 50, viewedIdx: { 12: 1 }, updatedAt: T(5) }));
    const doc: any = await row(A, "crm");
    expect(doc.maxSlide).toBe(40);
    expect(doc.total).toBe(63);
    expect(doc.lastSlide).toBe(40); // the resume point follows the NEWER record
    expect(doc.viewedSlides).toEqual([12, 38, 39, 40]);
    expect(doc.viewed).toBe(4);
    expect(new Date(doc.updatedAt).toISOString()).toBe(T(30));
    expect(r.body.progress.maxSlide).toBe(40);
  });

  it("a newer record moves the resume point even to an earlier slide (reviewing) without lowering maxSlide", async () => {
    await put("a", "crm", rec({ maxSlide: 40, lastSlide: 40, updatedAt: T(30) }));
    await put("a", "crm", rec({ maxSlide: 40, lastSlide: 3, updatedAt: T(45) }));
    const doc: any = await row(A, "crm");
    expect(doc.lastSlide).toBe(3);
    expect(doc.maxSlide).toBe(40);
  });

  it("never un-completes: completed stays true and the earliest completedAt is kept", async () => {
    await put("a", "crm", rec({ maxSlide: 62, lastSlide: 62, completed: true, completedAt: T(50), updatedAt: T(50) }));
    await put("a", "crm", rec({ maxSlide: 62, lastSlide: 62, completed: true, completedAt: T(90), updatedAt: T(90) }));
    await put("a", "crm", rec({ completed: false, completedAt: null, maxSlide: 2, lastSlide: 2, updatedAt: T(120) }));
    const doc: any = await row(A, "crm");
    expect(doc.completed).toBe(true);
    expect(new Date(doc.completedAt).toISOString()).toBe(T(50));
    expect(doc.maxSlide).toBe(62);
    expect(doc.lastSlide).toBe(2);
  });

  it("an older device completing still completes (completion is not tied to recency)", async () => {
    await put("a", "crm", rec({ maxSlide: 20, lastSlide: 20, updatedAt: T(200) }));
    await put("a", "crm", rec({ maxSlide: 62, lastSlide: 62, completed: true, completedAt: T(100), updatedAt: T(100) }));
    const doc: any = await row(A, "crm");
    expect(doc.completed).toBe(true);
    expect(doc.maxSlide).toBe(62);
    expect(doc.lastSlide).toBe(20);
    expect(new Date(doc.startedAt).toISOString()).toBe(T(0));
  });

  it("re-PUT of the same record is idempotent (the sync button can be pressed repeatedly)", async () => {
    const body = rec({ maxSlide: 30, lastSlide: 30, completed: true, completedAt: T(60), updatedAt: T(60) });
    await put("a", "crm", body);
    const first: any = await row(A, "crm");
    await put("a", "crm", body);
    await put("a", "crm", body);
    const again: any = await row(A, "crm");
    const strip = ({ syncedAt, ...r }: any) => r;
    expect(strip(again)).toEqual(strip(first));
    expect(await TrainingProgress.countDocuments({})).toBe(1);
  });

  it("concurrent first saves collapse into one row holding the furthest progress", async () => {
    const results = await Promise.all([5, 20, 11, 33, 2].map((s, i) => put("a", "expense", rec({ module: "expense", total: 133, maxSlide: s, lastSlide: s, updatedAt: T(i) }))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await TrainingProgress.countDocuments({ module: "expense" })).toBe(1);
    expect((await row(A, "expense") as any).maxSlide).toBe(33);
  });

  it("modules are separate rows", async () => {
    await put("a", "crm", rec());
    await put("a", "expense", rec({ module: "expense", total: 133 }));
    expect(await TrainingProgress.countDocuments({ userId: new mongoose.Types.ObjectId(A) })).toBe(2);
  });
});

describe("gate and validation", () => {
  it("HOUSE only — a tenant user is refused and nothing is written", async () => {
    const r = await put("tenant", "crm", rec());
    expect(r.status).toBe(403);
    expect(await TrainingProgress.countDocuments({})).toBe(0);
  });

  it("rejects a bad module id without writing", async () => {
    for (const m of ["CRM", "-x", "a b", "x".repeat(41), "$set"]) {
      const r = await put("a", encodeURIComponent(m), rec());
      expect(r.status, m).toBe(400);
    }
    expect(await TrainingProgress.countDocuments({})).toBe(0);
  });
});

describe("cleanProgress", () => {
  const now = new Date(T(1000));
  it("clamps slides to the deck, drops junk indices, caps a future clock at now", () => {
    const c = cleanProgress({ total: 10, maxSlide: 99, lastSlide: -3, viewedIdx: { 1: 1, 9: 1, 10: 1, x: 1 }, updatedAt: "2099-01-01T00:00:00Z", completed: "yes" }, now);
    expect(c.maxSlide).toBe(9);
    expect(c.lastSlide).toBe(0);
    expect(c.viewedSlides).toEqual([1, 9]);
    expect(c.updatedAt?.toISOString()).toBe(now.toISOString());
    expect(c.completed).toBe(false); // only a real boolean true completes
    expect(c.completedAt).toBeNull();
  });
  it("a completed record without completedAt gets its updatedAt", () => {
    expect(cleanProgress({ total: 5, maxSlide: 4, completed: true, updatedAt: T(7) }, now).completedAt?.toISOString()).toBe(T(7));
  });
});
