// PlumConnect Slice 2 — readExpenseInFlow: the chain's two mid-flow signals,
// the freshness window, and the D3 promise that this reader never writes
// the chain's collections (fingerprinted around every call).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createHash } from "node:crypto";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-inflow-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { readExpenseInFlow, isExpenseFlowFresh, expenseFlowTtlMs, EXPENSE_FLOW_TTL_ENV, DEFAULT_EXPENSE_FLOW_TTL_MS } =
  await import("./expenseInFlow.js");
const { default: ExpenseCapture } = await import("../../models/ExpenseCapture.js");
const { default: ExpenseWaSession } = await import("../../models/ExpenseWaSession.js");

let mongod: MongoMemoryServer;
const WA = "919876543210";
const H = 60 * 60 * 1000;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await ExpenseCapture.deleteMany({});
  await ExpenseWaSession.deleteMany({});
});

afterEach(() => {
  delete process.env[EXPENSE_FLOW_TTL_ENV];
});

/** Raw inserts with an explicit updatedAt — timestamps would otherwise be "now". */
async function capture(status: string, updatedAt: Date, waId = WA) {
  await ExpenseCapture.collection.insertOne({
    messageId: `wamid.${Math.random()}`,
    mediaId: "m",
    mime: "image/jpeg",
    mediaType: "image",
    waId,
    status,
    attempts: 0,
    extractionAttempts: 0,
    createdAt: updatedAt,
    updatedAt,
  });
}
async function session(state: string, updatedAt: Date, waId = WA) {
  await ExpenseWaSession.collection.insertOne({ waId, state, createdAt: updatedAt, updatedAt });
}

async function fingerprint() {
  const a = await ExpenseCapture.collection.find({}).sort({ _id: 1 }).toArray();
  const b = await ExpenseWaSession.collection.find({}).sort({ _id: 1 }).toArray();
  return createHash("sha256").update(JSON.stringify([a, b])).digest("hex");
}

/** Every read below is wrapped so a write to either collection fails the test. */
async function readNoWrite(waId: string, now: Date) {
  const before = await fingerprint();
  const r = await readExpenseInFlow(waId, now);
  expect(await fingerprint()).toBe(before);
  return r;
}

describe("window", () => {
  it("defaults to 24h and is env-tunable", () => {
    expect(expenseFlowTtlMs()).toBe(DEFAULT_EXPENSE_FLOW_TTL_MS);
    process.env[EXPENSE_FLOW_TTL_ENV] = String(2 * H);
    expect(expenseFlowTtlMs()).toBe(2 * H);
    process.env[EXPENSE_FLOW_TTL_ENV] = "nonsense";
    expect(expenseFlowTtlMs()).toBe(DEFAULT_EXPENSE_FLOW_TTL_MS);
  });

  it("isExpenseFlowFresh: inside the window is fresh, at/after the edge is stale, absent is stale", () => {
    const now = new Date("2026-09-20T12:00:00Z");
    expect(isExpenseFlowFresh(new Date(now.getTime() - 23 * H), now)).toBe(true);
    expect(isExpenseFlowFresh(new Date(now.getTime() - 24 * H), now)).toBe(false);
    expect(isExpenseFlowFresh(new Date(now.getTime() - 25 * H), now)).toBe(false);
    expect(isExpenseFlowFresh(null, now)).toBe(false);
    expect(isExpenseFlowFresh(undefined, now)).toBe(false);
  });
});

describe("readExpenseInFlow", () => {
  const now = new Date("2026-09-20T12:00:00Z");

  it("no signal → not in flow", async () => {
    expect(await readNoWrite(WA, now)).toEqual({ inFlow: false, source: null, updatedAt: null, stale: false });
    expect(await readNoWrite("", now)).toEqual({ inFlow: false, source: null, updatedAt: null, stale: false });
  });

  it("a fresh awaiting_confirmation capture → in flow (source capture)", async () => {
    const t = new Date(now.getTime() - 1 * H);
    await capture("awaiting_confirmation", t);
    expect(await readNoWrite(WA, now)).toEqual({ inFlow: true, source: "capture", updatedAt: t, stale: false });
  });

  it("a fresh awaiting_correction capture → in flow", async () => {
    await capture("awaiting_correction", new Date(now.getTime() - 5 * H));
    expect((await readNoWrite(WA, now)).inFlow).toBe(true);
  });

  it("a STALE capture (older than the window) → NOT in flow, reported as stale, row untouched", async () => {
    const t = new Date(now.getTime() - 30 * H);
    await capture("awaiting_confirmation", t);
    expect(await readNoWrite(WA, now)).toEqual({ inFlow: false, source: "capture", updatedAt: t, stale: true });
    // the chain's row is exactly as it was — no status flip, no touch
    const row = await ExpenseCapture.collection.findOne({ waId: WA });
    expect(row!.status).toBe("awaiting_confirmation");
    expect(row!.updatedAt).toEqual(t);
  });

  it("captures in other statuses are not signals (queued / captured / confirmed / unregistered / cancelled)", async () => {
    for (const s of ["queued", "processing", "captured", "extracting", "confirmed", "cancelled", "unregistered", "failed"]) {
      await capture(s, new Date(now.getTime() - 1 * H));
    }
    expect((await readNoWrite(WA, now)).inFlow).toBe(false);
  });

  it("a fresh non-idle session → in flow (source session); an idle one is not a signal", async () => {
    await session("idle", new Date(now.getTime() - 1 * H));
    expect((await readNoWrite(WA, now)).inFlow).toBe(false);
    await ExpenseWaSession.deleteMany({});
    const t = new Date(now.getTime() - 2 * H);
    await session("open_claim", t);
    expect(await readNoWrite(WA, now)).toEqual({ inFlow: true, source: "session", updatedAt: t, stale: false });
  });

  it("a stale session → not in flow", async () => {
    await session("post_confirm", new Date(now.getTime() - 48 * H));
    const r = await readNoWrite(WA, now);
    expect(r.inFlow).toBe(false);
    expect(r.stale).toBe(true);
  });

  it("the most recent signal decides: fresh session beats a stale capture and vice versa", async () => {
    await capture("awaiting_confirmation", new Date(now.getTime() - 40 * H));
    const ts = new Date(now.getTime() - 1 * H);
    await session("open_claim", ts);
    expect(await readNoWrite(WA, now)).toEqual({ inFlow: true, source: "session", updatedAt: ts, stale: false });

    await ExpenseWaSession.deleteMany({});
    await ExpenseCapture.deleteMany({});
    const tc = new Date(now.getTime() - 30 * 60 * 1000);
    await capture("awaiting_correction", tc);
    await session("open_claim", new Date(now.getTime() - 40 * H));
    expect(await readNoWrite(WA, now)).toEqual({ inFlow: true, source: "capture", updatedAt: tc, stale: false });
  });

  it("is keyed on the sender — another sender's flow is invisible", async () => {
    await capture("awaiting_confirmation", new Date(now.getTime() - 1 * H), "919999999999");
    expect((await readNoWrite(WA, now)).inFlow).toBe(false);
  });

  it("honours a tuned window", async () => {
    process.env[EXPENSE_FLOW_TTL_ENV] = String(2 * H);
    await capture("awaiting_confirmation", new Date(now.getTime() - 3 * H));
    expect((await readNoWrite(WA, now)).inFlow).toBe(false);
    await ExpenseCapture.deleteMany({});
    await capture("awaiting_confirmation", new Date(now.getTime() - 1 * H));
    expect((await readNoWrite(WA, now)).inFlow).toBe(true);
  });
});
