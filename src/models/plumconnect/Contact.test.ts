// PlumConnect Slice 0 — Contact against a real collection (mongodb-memory-server):
// persist-and-read of the reference-only shape, the canonical-phone unique
// index, and the enum/default posture nothing writes yet.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-contact-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: Contact, CONTACT_IDENTITY_STATES } = await import("./Contact.js");

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Contact.syncIndexes();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Contact.deleteMany({});
});

describe("PlumConnectContact", () => {
  it("mounts on its own collection, apart from every existing model", () => {
    expect(Contact.collection.name).toBe("plumconnectcontacts");
    expect(mongoose.modelNames()).toContain("PlumConnectContact");
  });

  it("persists a minimal row with reference-only defaults and reads it back", async () => {
    const created = await Contact.create({ phone: "919876543210" });
    const row = await Contact.findById(created._id).lean();

    expect(row).toBeTruthy();
    expect(row!.phone).toBe("919876543210");
    expect(row!.displayName).toBe("");
    expect(row!.identityState).toBe("unknown");
    // refs are pointers, never copied data
    expect(row!.refs).toEqual({ userId: null, consumerId: null, crmContactId: null, leadIds: [] });
    expect(row!.consent).toEqual({
      expenseBindAskedAt: null,
      expenseBindAnsweredAt: null,
      expenseBindAnswer: null,
    });
    expect(row!.firstSeenAt).toBeNull();
    expect(row!.lastSeenAt).toBeNull();
    // no tenant on a person
    expect(row).not.toHaveProperty("workspaceId");
  });

  it("stores references as ObjectIds and appends leadIds", async () => {
    const userId = new mongoose.Types.ObjectId();
    const leadA = new mongoose.Types.ObjectId();
    const leadB = new mongoose.Types.ObjectId();

    const created = await Contact.create({
      phone: "919876543211",
      displayName: "Priya",
      refs: { userId, leadIds: [leadA] },
      identityState: "verified_employee",
    });
    await Contact.updateOne({ _id: created._id }, { $push: { "refs.leadIds": leadB } });

    const row = await Contact.findById(created._id).lean();
    expect(String(row!.refs.userId)).toBe(String(userId));
    expect(row!.refs.leadIds.map(String)).toEqual([String(leadA), String(leadB)]);
    expect(row!.displayName).toBe("Priya");
  });

  it("phone is unique — a second row with the same canonical phone is rejected", async () => {
    await Contact.create({ phone: "919876543212" });
    await expect(Contact.create({ phone: "919876543212" })).rejects.toMatchObject({ code: 11000 });
    expect(await Contact.countDocuments({ phone: "919876543212" })).toBe(1);
  });

  it("phone is required", async () => {
    await expect(Contact.create({ displayName: "no phone" })).rejects.toThrow(/phone/);
  });

  it("rejects an identityState outside the enum and a consent answer outside yes/no", async () => {
    await expect(
      Contact.create({ phone: "919876543213", identityState: "hard_employee" as any }),
    ).rejects.toThrow(/identityState/);
    await expect(
      Contact.create({ phone: "919876543214", consent: { expenseBindAnswer: "maybe" as any } }),
    ).rejects.toThrow(/expenseBindAnswer/);
    expect(CONTACT_IDENTITY_STATES).toEqual([
      "unknown",
      "soft_employee",
      "soft_consumer",
      "soft_crm",
      "verified_employee",
    ]);
  });

  it("declares the unique phone index and the identityState index", async () => {
    const indexes = await Contact.collection.indexes();
    const byKey = (k: Record<string, number>) =>
      indexes.find((i) => JSON.stringify(i.key) === JSON.stringify(k));
    expect(byKey({ phone: 1 })?.unique).toBe(true);
    expect(byKey({ identityState: 1 })).toBeTruthy();
  });
});
