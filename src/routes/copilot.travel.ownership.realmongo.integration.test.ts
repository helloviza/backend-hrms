// Conversation OWNERSHIP against a real mongod (mongodb-memory-server): real
// unique {workspaceId, conversationId} index, real upserts, real Itinerary.
//
// Owner = the user who created the conversation (or itinerary). Another user
// in the SAME workspace who presents its id gets a fresh state / a 404, and can
// never overwrite it. No role bypass (SUPERADMIN included). A legacy doc with
// no recorded owner is nobody's. Unconditional: every route below is checked
// with PLUTO_STATE_V2 off AND on.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

vi.hoisted(() => { process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"; });
// The tenant is set by the test app below; the real middleware resolves it
// from the DB, which is not what this file tests.
vi.mock("../middleware/requireWorkspace.js", () => ({ requireWorkspace: (_req: any, _res: any, next: any) => next() }));
// The model is the only stub on the turn path (so a turn reaches the AI path,
// which both reads and saves the conversation).
vi.mock("../utils/plutoInvoke.js", () => ({
  invokePluto: vi.fn().mockResolvedValue({ title: "Packing", context: "Light layers.", tripType: "holiday", nextSteps: [], handoff: false }),
  reaskRetryInstruction: () => "",
}));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import express from "express";
import request from "supertest";
import PlutoConversation from "../models/PlutoConversation.js";
import Itinerary from "../models/Itinerary.js";
import { saveConversationContext, loadConversationForUser, getConversationContext } from "../utils/plutoMemory.js";
import router from "./copilot.travel.js";
import feedbackRouter from "./pluto.feedback.js";

let mongod: MongoMemoryServer;
const WS = new mongoose.Types.ObjectId();
const OTHER_WS = new mongoose.Types.ObjectId();
const USER_A = new mongoose.Types.ObjectId();
const USER_B = new mongoose.Types.ObjectId();

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  const who = req.headers["x-test-user"] === "B" ? USER_B : USER_A;
  req.user = { _id: who, email: "t@plumtrips.com", name: "T", roles: String(req.headers["x-test-roles"] || "EMPLOYEE").split(",") };
  req.workspaceObjectId = req.headers["x-test-ws"] === "other" ? OTHER_WS : WS;
  next();
});
app.use("/feedback", feedbackRouter);
app.use("/", router);

const A_CONTEXT = { id: "conv-A", locked: { destination: { name: "Dubai", source: "user" }, dates: { start: "2026-11-16", source: "user" } }, state: "DISCOVERY" };
const seedA = () => saveConversationContext({ workspaceObjectId: WS, userId: USER_A, conversationId: "conv-A", context: A_CONTEXT });
const docA = async () => PlutoConversation.findOne({ conversationId: "conv-A" }).lean() as any;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await PlutoConversation.syncIndexes();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await PlutoConversation.deleteMany({});
  await Itinerary.deleteMany({});
});

describe("plutoMemory — owner-scoped read / write", () => {
  it("owned / foreign / missing / no-owner", async () => {
    await seedA();
    expect(await loadConversationForUser({ workspaceObjectId: WS, userId: USER_A, conversationId: "conv-A" }))
      .toEqual({ status: "owned", context: A_CONTEXT });
    expect(await loadConversationForUser({ workspaceObjectId: WS, userId: USER_B, conversationId: "conv-A" })).toEqual({ status: "foreign" });
    expect(await loadConversationForUser({ workspaceObjectId: OTHER_WS, userId: USER_A, conversationId: "conv-A" })).toEqual({ status: "missing" });
    expect(await loadConversationForUser({ workspaceObjectId: WS, userId: USER_A, conversationId: "nope" })).toEqual({ status: "missing" });
    // getConversationContext is owner-scoped too.
    expect(await getConversationContext({ workspaceObjectId: WS, userId: USER_A, conversationId: "conv-A" })).toEqual(A_CONTEXT);
    expect(await getConversationContext({ workspaceObjectId: WS, userId: USER_B, conversationId: "conv-A" })).toBeNull();
    // A legacy doc with no recorded owner is nobody's.
    await PlutoConversation.create({ workspaceId: WS, conversationId: "legacy", userId: null, context: { x: 1 } });
    expect(await loadConversationForUser({ workspaceObjectId: WS, userId: USER_A, conversationId: "legacy" })).toEqual({ status: "foreign" });
    expect(await getConversationContext({ workspaceObjectId: WS, userId: USER_A, conversationId: "legacy" })).toBeNull();
  });

  it("a write by another user never touches the owner's doc; a legacy ownerless doc is never written either", async () => {
    await seedA();
    await saveConversationContext({ workspaceObjectId: WS, userId: USER_B, conversationId: "conv-A", context: { hijack: true } });
    const docs = await PlutoConversation.find({ workspaceId: WS }).lean();
    expect(docs).toHaveLength(1);
    expect(String(docs[0].userId)).toBe(String(USER_A));
    expect(docs[0].context).toEqual(A_CONTEXT);

    await PlutoConversation.create({ workspaceId: WS, conversationId: "legacy", userId: null, context: { x: 1 } });
    await saveConversationContext({ workspaceObjectId: WS, userId: USER_A, conversationId: "legacy", context: { y: 2 } });
    expect((await PlutoConversation.findOne({ conversationId: "legacy" }).lean() as any).context).toEqual({ x: 1 });
  });

  it("the owner's own concurrent first writes land on one doc", async () => {
    await Promise.all([1, 2, 3].map((n) =>
      saveConversationContext({ workspaceObjectId: WS, userId: USER_A, conversationId: "race", context: { n } })));
    const docs = await PlutoConversation.find({ workspaceId: WS, conversationId: "race" }).lean();
    expect(docs).toHaveLength(1);
    expect(String(docs[0].userId)).toBe(String(USER_A));
  });
});

for (const mode of ["off", "on"] as const) {
  describe(`routes — PLUTO_STATE_V2 ${mode}`, () => {
    beforeEach(() => { process.env.PLUTO_STATE_V2 = mode === "on" ? "on" : ""; });
    afterEach(() => { delete process.env.PLUTO_STATE_V2; });

    it("turn start: B presenting A's conversationId gets a fresh conversation under a new id; A's doc is untouched", async () => {
      await seedA();
      const before = await docA();
      // An AI-path turn: legacy reads AND saves the conversation on this path.
      const b = await request(app).post("/").set("x-test-user", "B")
        .send({ prompt: "what should I pack?", context: { id: "conv-A" }, conversationId: "conv-A" });
      expect(b.status).toBe(200);
      expect(b.body.context.id).not.toBe("conv-A");
      expect(JSON.stringify(b.body)).not.toMatch(/Dubai|2026-11-16/);
      expect((await docA()).context).toEqual(before.context);
      const bDoc: any = await PlutoConversation.findOne({ conversationId: b.body.context.id }).lean();
      expect(String(bDoc.userId)).toBe(String(USER_B));
    });

    it("turn start: SUPERADMIN gets no bypass; a legacy ownerless doc is a fresh state for everyone", async () => {
      await seedA();
      const admin = await request(app).post("/").set("x-test-user", "B").set("x-test-roles", "SUPERADMIN")
        .send({ prompt: "what should I pack?", context: { id: "conv-A" }, conversationId: "conv-A" });
      expect(admin.body.context.id).not.toBe("conv-A");
      expect(JSON.stringify(admin.body)).not.toMatch(/Dubai/);

      await PlutoConversation.create({ workspaceId: WS, conversationId: "legacy", userId: null, context: { locked: { destination: { name: "Goa" } } } });
      const a = await request(app).post("/").send({ prompt: "what should I pack?", context: { id: "legacy" }, conversationId: "legacy" });
      expect(a.body.context.id).not.toBe("legacy");
      expect(JSON.stringify(a.body)).not.toMatch(/Goa/);
      expect((await PlutoConversation.findOne({ conversationId: "legacy" }).lean() as any).context).toEqual({ locked: { destination: { name: "Goa" } } });
    });

    it("turn start: the owner's own follow-up keeps the id and reads the stored state", async () => {
      await seedA();
      const a = await request(app).post("/").send({ prompt: "what should I pack?", context: { id: "conv-A" }, conversationId: "conv-A" });
      expect(a.body.context.id).toBe("conv-A");
      expect(a.body.context.locked.destination.name).toBe("Dubai");
    });

    it("GET /conversation/:id — owner 200; another user, SUPERADMIN, another workspace, ownerless → 404", async () => {
      await seedA();
      const own = await request(app).get("/conversation/conv-A");
      expect(own.status).toBe(200);
      expect(own.body.context.locked.destination.name).toBe("Dubai");
      expect((await request(app).get("/conversation/conv-A").set("x-test-user", "B")).status).toBe(404);
      expect((await request(app).get("/conversation/conv-A").set("x-test-user", "B").set("x-test-roles", "SUPERADMIN")).status).toBe(404);
      expect((await request(app).get("/conversation/conv-A").set("x-test-ws", "other")).status).toBe(404);
      await PlutoConversation.create({ workspaceId: WS, conversationId: "legacy", userId: null, context: { x: 1 } });
      expect((await request(app).get("/conversation/legacy")).status).toBe(404);
    });

    it("pluto.feedback — B on A's conversation is a 404 and writes nothing; A's own feedback applies", async () => {
      await seedA();
      const before = await docA();
      const b = await request(app).post("/feedback").set("x-test-user", "B").send({ conversationId: "conv-A", destination: "Goa", notes: "hijack" });
      expect(b.status).toBe(404);
      expect((await docA()).context).toEqual(before.context);

      const a = await request(app).post("/feedback").send({ conversationId: "conv-A", notes: "client prefers aisle" });
      expect(a.status).toBe(200);
      expect((await docA()).context.locked.lastRmNote).toBe("client prefers aisle");
    });

    it("POST /itinerary — B never reuses (overwrites) A's DRAFT for the same conversationId", async () => {
      const a = await request(app).post("/itinerary").send({ conversationId: "conv-A", title: "A's trip" });
      expect(a.status).toBe(200);
      const b = await request(app).post("/itinerary").set("x-test-user", "B").send({ conversationId: "conv-A", title: "B's trip" });
      expect(b.status).toBe(200);
      expect(String(b.body.itinerary._id)).not.toBe(String(a.body.itinerary._id));
      const aDoc: any = await Itinerary.findById(a.body.itinerary._id).lean();
      expect(aDoc.title).toBe("A's trip");
      expect(String(aDoc.createdByUserId)).toBe(String(USER_A));
      // A's own second call still reuses A's draft (idempotent per owner).
      const a2 = await request(app).post("/itinerary").send({ conversationId: "conv-A", title: "A's trip v2" });
      expect(String(a2.body.itinerary._id)).toBe(String(a.body.itinerary._id));
    });

    it("GET /itinerary/:id — owner 200; another user and SUPERADMIN → 404", async () => {
      const a = await request(app).post("/itinerary").send({ conversationId: "conv-A", title: "A's trip" });
      const id = a.body.itinerary._id;
      expect((await request(app).get(`/itinerary/${id}`)).status).toBe(200);
      expect((await request(app).get(`/itinerary/${id}`).set("x-test-user", "B")).status).toBe(404);
      expect((await request(app).get(`/itinerary/${id}`).set("x-test-user", "B").set("x-test-roles", "SUPERADMIN")).status).toBe(404);
    });

    it("POST /raise-request — B cannot submit A's itinerary (404; A's itinerary stays DRAFT)", async () => {
      const a = await request(app).post("/itinerary").send({ conversationId: "conv-A", title: "A's trip" });
      const id = a.body.itinerary._id;
      const b = await request(app).post("/raise-request").set("x-test-user", "B").send({ itineraryId: id, passengers: [] });
      expect(b.status).toBe(404);
      const aDoc: any = await Itinerary.findById(id).lean();
      expect(aDoc.status).toBe("DRAFT");
      expect(aDoc.sbtRequestId).toBeNull();
    });
  });
}
