// PATCH /api/admin/invoices/:id compares due dates by IST calendar day, the day
// the Edit Invoice drawer shows. Comparing UTC days dropped a real edit: a due
// date stored at 2 AM IST on 1 Dec is 30 Nov in UTC, so changing it to 30 Nov in
// the drawer looked like no change and was silently not saved.
//
// Real: invoices router, models, mongodb-memory-server. Stubbed: requireAuth,
// requirePermission.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireAnyPermission: () => (_req: any, _res: any, next: any) => next(),
}));

const { default: invoicesRouter } = await import("./invoices.js");

const app = express();
app.use(express.json());
app.use("/api/admin/invoices", invoicesRouter);

let mongod: MongoMemoryReplSet;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const SA_ID = oid();
const SA = JSON.stringify({ _id: String(SA_ID), id: String(SA_ID), sub: String(SA_ID), roles: ["SUPERADMIN"] });

async function draft(dueDate: string) {
  const _id = oid();
  await col("invoices").insertOne({
    _id, invoiceNo: `INV-${_id}`, workspaceId: oid(), status: "DRAFT",
    bookingIds: [], lineItems: [], subtotal: 0, totalGST: 0, grandTotal: 0, supplyType: "IGST",
    dueDate: new Date(dueDate), editHistory: [],
  } as any);
  return _id;
}

const patchDue = (id: any, dueDate: string) =>
  request(app).patch(`/api/admin/invoices/${id}`).set("x-test-user", SA).send({ dueDate });
const stored = async (id: any) => (await col("invoices").findOne({ _id: id })) as any;

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(mongod.getUri("invoice-patch-due-date-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => { await col("invoices").deleteMany({}); });

describe("PATCH due date on a date stored inside 00:00-05:30 IST on the 1st", () => {
  const twoAmIstOn1Dec = "2026-11-30T20:30:00.000Z";

  it("changing it to the previous day, which is the same UTC day, is saved", async () => {
    const id = await draft(twoAmIstOn1Dec);
    const res = await patchDue(id, "2026-11-30");
    expect(res.status).toBe(200);
    expect((await stored(id)).dueDate.toISOString()).toBe("2026-11-30T00:00:00.000Z");
  });

  it("sending the day the drawer shows is no change", async () => {
    const id = await draft(twoAmIstOn1Dec);
    const res = await patchDue(id, "2026-12-01");
    expect(res.status).toBe(200);
    const inv = await stored(id);
    expect(inv.dueDate.toISOString()).toBe(twoAmIstOn1Dec);
    expect(inv.editHistory ?? []).toHaveLength(0);
  });
});

describe("PATCH due date against the invoice date", () => {
  // As generate stores 1 Dec on an IST server (00:00 IST) and on a UTC one.
  const stores = [["00:00 IST", "2026-11-30T18:30:00.000Z"], ["00:00 UTC", "2026-12-01T00:00:00.000Z"]];
  const dated = async (invoiceDate: string, dueDate = "2026-12-16T00:00:00.000Z") => {
    const id = await draft(dueDate);
    await col("invoices").updateOne({ _id: id }, { $set: { invoiceDate: new Date(invoiceDate) } });
    return id;
  };

  it.each(stores)("the day before is refused with a clear message (%s)", async (_label, invoiceDate) => {
    const id = await dated(invoiceDate);
    const res = await patchDue(id, "2026-11-30");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Due date can't be before the invoice date (01 Dec 2026).");
    const inv = await stored(id);
    expect(inv.dueDate.toISOString()).toBe("2026-12-16T00:00:00.000Z");
    expect(inv.editHistory ?? []).toHaveLength(0);
  });

  it.each(stores)("the invoice date itself is allowed (%s)", async (_label, invoiceDate) => {
    const id = await dated(invoiceDate);
    const res = await patchDue(id, "2026-12-01");
    expect(res.status).toBe(200);
    expect((await stored(id)).dueDate.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("a later date is allowed", async () => {
    const id = await dated("2026-12-01T00:00:00.000Z");
    expect((await patchDue(id, "2026-12-31")).status).toBe(200);
  });

  it("an old due date before the invoice date doesn't block other edits", async () => {
    const id = await dated("2026-12-01T00:00:00.000Z", "2026-11-21T00:00:00.000Z");
    const res = await request(app).patch(`/api/admin/invoices/${id}`).set("x-test-user", SA).send({ notes: "still editable" });
    expect(res.status).toBe(200);
    expect((await stored(id)).notes).toBe("still editable");
    expect((await patchDue(id, "2026-11-21")).status).toBe(200); // unchanged, so not a new edit
  });

  it("an old due date before the invoice date can be corrected", async () => {
    const id = await dated("2026-12-01T00:00:00.000Z", "2026-11-21T00:00:00.000Z");
    expect((await patchDue(id, "2026-12-16")).status).toBe(200);
  });

  it("a draft with no stored invoice date isn't compared with today", async () => {
    const id = await draft("2026-12-16T00:00:00.000Z");
    expect((await patchDue(id, "2020-01-01")).status).toBe(200);
  });

  it("the check lives on this route, not in Generate", async () => {
    const { readFileSync } = await import("node:fs");
    const code = readFileSync(new URL("../services/invoiceGeneration.service.ts", import.meta.url), "utf8");
    expect(code).not.toMatch(/before the invoice date/);
  });
});

describe("PATCH due date on a date stored at UTC midnight", () => {
  it("changing the day is saved", async () => {
    const id = await draft("2026-12-01T00:00:00.000Z");
    const res = await patchDue(id, "2026-12-05");
    expect(res.status).toBe(200);
    expect((await stored(id)).dueDate.toISOString()).toBe("2026-12-05T00:00:00.000Z");
  });

  it("the same day is no change", async () => {
    const id = await draft("2026-12-01T00:00:00.000Z");
    const res = await patchDue(id, "2026-12-01");
    expect(res.status).toBe(200);
    expect((await stored(id)).editHistory ?? []).toHaveLength(0);
  });
});
