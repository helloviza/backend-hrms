// PlumConnect Slice 1 — resolveIdentity + the single waId writer, against
// real collections (mongodb-memory-server): hard needs an ACTIVE exact waId;
// soft only when hard misses, each source capped; bind refuses INACTIVE;
// unbind $unsets (never null); and a grep over src/ that no other file writes
// User.waId.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-identity-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { resolveIdentity, bindWaId, unbindWaId } = await import("./resolveIdentity.js");
const { default: User } = await import("../../models/User.js");
const { default: TravellerProfile } = await import("../../models/TravellerProfile.js");
const { default: Consumer } = await import("../../models/Consumer.js");
const { default: CRMContact } = await import("../../models/CRMContact.js");

let mongod: MongoMemoryServer;
const WS = new mongoose.Types.ObjectId();
const WS2 = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([User.syncIndexes(), TravellerProfile.syncIndexes(), Consumer.syncIndexes(), CRMContact.syncIndexes()]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), TravellerProfile.deleteMany({}), Consumer.deleteMany({}), CRMContact.deleteMany({})]);
});

let seq = 0;
async function user(over: Record<string, any> = {}) {
  seq += 1;
  return User.create({
    email: `u${seq}@x.test`,
    passwordHash: "x",
    workspaceId: WS,
    name: `User ${seq}`,
    ...over,
  });
}

async function traveller(mobile: string, over: Record<string, any> = {}) {
  seq += 1;
  return TravellerProfile.create({
    workspaceId: WS2,
    travelerId: `TRV-${seq}`,
    firstName: "Trav",
    lastName: `${seq}`,
    mobile,
    createdBy: new mongoose.Types.ObjectId(),
    source: "MANUAL",
    ...over,
  });
}

async function consumer(verifiedPhone: string) {
  seq += 1;
  return Consumer.create({ email: `c${seq}@x.test`, name: `Consumer ${seq}`, verifiedPhone });
}

async function crmContact(phone: string) {
  seq += 1;
  return CRMContact.create({ firstName: `Crm${seq}`, phone });
}

const CANON = "919876543210";

/* ─────────────────────────── resolveIdentity ─────────────────────────── */

describe("resolveIdentity — hard", () => {
  it("returns hard for an ACTIVE user whose waId equals the canonical phone, in any input spelling", async () => {
    const u = await user({ waId: CANON, status: "ACTIVE" });
    for (const spelling of [CANON, "+91 98765 43210", "9876543210", "09876543210"]) {
      const r = await resolveIdentity(spelling);
      expect(r.canonical).toBe(CANON);
      expect(r.hard).not.toBeNull();
      expect(String(r.hard!.userId)).toBe(String(u._id));
      expect(String(r.hard!.workspaceId)).toBe(String(WS));
      expect(r.hard!.waId).toBe(CANON);
      expect(r.identityState).toBe("verified_employee");
      // soft is not consulted when hard hits
      expect(r.soft).toEqual({ users: [], travellerProfiles: [], consumers: [], crmContacts: [] });
    }
  });

  it("treats an absent status as active (canonical rule)", async () => {
    await user({ waId: CANON });
    await User.updateOne({ waId: CANON }, { $unset: { status: "" } });
    const r = await resolveIdentity(CANON);
    expect(r.hard).not.toBeNull();
  });

  it("an INACTIVE user with the matching waId is a MISS, not a hard hit", async () => {
    await user({ waId: CANON, status: "INACTIVE" });
    const r = await resolveIdentity(CANON);
    expect(r.hard).toBeNull();
    expect(r.identityState).toBe("unknown");
  });

  it("waId must match exactly — a near-miss is not hard", async () => {
    await user({ waId: "919876543211" });
    const r = await resolveIdentity(CANON);
    expect(r.hard).toBeNull();
  });

  it("unusable input is an all-miss with canonical null, never a throw", async () => {
    await user({ waId: CANON });
    for (const bad of ["abc", "", null, undefined, "12"]) {
      const r = await resolveIdentity(bad);
      expect(r).toEqual({
        canonical: null,
        hard: null,
        soft: { users: [], travellerProfiles: [], consumers: [], crmContacts: [] },
        identityState: "unknown",
      });
    }
  });
});

describe("resolveIdentity — soft (only when hard misses)", () => {
  it("User.phone loose-matches in free-text spellings, ACTIVE only → soft_employee", async () => {
    const a = await user({ phone: "98765 43210" });
    const b = await user({ phone: "+91-98765-43210" });
    await user({ phone: "9876543210", status: "INACTIVE" }); // excluded
    await user({ phone: "9876543211" }); // different number

    const r = await resolveIdentity("+919876543210");
    expect(r.hard).toBeNull();
    expect(r.soft.users.map((u) => String(u.userId)).sort()).toEqual([String(a._id), String(b._id)].sort());
    expect(r.identityState).toBe("soft_employee");
  });

  it("TravellerProfile.mobile loose-matches across workspaces → soft_employee", async () => {
    const t = await traveller("9876543210");
    const r = await resolveIdentity(CANON);
    expect(r.soft.travellerProfiles).toHaveLength(1);
    expect(String(r.soft.travellerProfiles[0].travellerProfileId)).toBe(String(t._id));
    expect(String(r.soft.travellerProfiles[0].workspaceId)).toBe(String(WS2));
    expect(r.identityState).toBe("soft_employee");
  });

  it("Consumer.verifiedPhone matches via the India-national view → soft_consumer", async () => {
    const c = await consumer("9876543210");
    const r = await resolveIdentity(CANON);
    expect(r.soft.consumers).toEqual([{ consumerId: c._id, verifiedPhone: "9876543210" }]);
    expect(r.identityState).toBe("soft_consumer");
  });

  it("a foreign number never queries Consumer (no national view) and cannot match it", async () => {
    await consumer("4155552671"); // a 10-digit US-looking number stored as if national
    const r = await resolveIdentity("+14155552671");
    expect(r.canonical).toBe("14155552671");
    expect(r.soft.consumers).toEqual([]);
  });

  it("CRMContact.phone loose-matches → soft_crm", async () => {
    const c = await crmContact("+91 98765 43210");
    const r = await resolveIdentity(CANON);
    expect(r.soft.crmContacts).toHaveLength(1);
    expect(String(r.soft.crmContacts[0].crmContactId)).toBe(String(c._id));
    expect(r.identityState).toBe("soft_crm");
  });

  it("label precedence: employee > consumer > crm when several sources hit", async () => {
    await crmContact("9876543210");
    expect((await resolveIdentity(CANON)).identityState).toBe("soft_crm");
    await consumer("9876543210");
    expect((await resolveIdentity(CANON)).identityState).toBe("soft_consumer");
    await traveller("9876543210");
    expect((await resolveIdentity(CANON)).identityState).toBe("soft_employee");
    // and a hard hit outranks everything
    await user({ waId: CANON });
    expect((await resolveIdentity(CANON)).identityState).toBe("verified_employee");
  });

  it("each soft source is capped at 3", async () => {
    for (let i = 0; i < 5; i++) {
      await user({ phone: "9876543210" });
      await traveller("9876543210", { workspaceId: new mongoose.Types.ObjectId() });
      await crmContact("9876543210");
    }
    const r = await resolveIdentity(CANON);
    expect(r.soft.users).toHaveLength(3);
    expect(r.soft.travellerProfiles).toHaveLength(3);
    expect(r.soft.crmContacts).toHaveLength(3);
  });

  it("soft hits never carry a waId and are never reported as hard", async () => {
    await user({ phone: "9876543210" });
    const r = await resolveIdentity(CANON);
    expect(r.hard).toBeNull();
    for (const u of r.soft.users) expect(u).not.toHaveProperty("waId");
  });
});

/* ─────────────────────────── bindWaId / unbindWaId ───────────────────────── */

describe("bindWaId — the single writer", () => {
  it("stamps waId on an ACTIVE user and the resolver then returns hard", async () => {
    const u = await user({ status: "ACTIVE" });
    const res = await bindWaId(u._id, CANON);
    expect(res).toEqual({ ok: true, userId: String(u._id), waId: CANON });
    expect((await User.findById(u._id).lean())!.waId).toBe(CANON);
    expect(String((await resolveIdentity(CANON)).hard!.userId)).toBe(String(u._id));
  });

  it("refuses an INACTIVE user and writes nothing", async () => {
    const u = await user({ status: "INACTIVE" });
    const res = await bindWaId(u._id, CANON);
    expect(res).toEqual({ ok: false, reason: "user_inactive_or_missing" });
    expect((await User.findById(u._id).lean())).not.toHaveProperty("waId");
  });

  it("refuses a missing user and an invalid id", async () => {
    expect(await bindWaId(new mongoose.Types.ObjectId(), CANON)).toEqual({ ok: false, reason: "user_inactive_or_missing" });
    expect(await bindWaId("not-an-id", CANON)).toEqual({ ok: false, reason: "user_inactive_or_missing" });
  });

  it("refuses a non-canonical phone (the caller must normalise first)", async () => {
    const u = await user();
    for (const bad of ["+919876543210", "9876543210", "98765 43210", "", "abc"]) {
      expect(await bindWaId(u._id, bad)).toEqual({ ok: false, reason: "invalid_phone" });
    }
    expect((await User.findById(u._id).lean())).not.toHaveProperty("waId");
  });

  it("reports waid_taken once the unique index exists (the Slice-1 script builds it)", async () => {
    // Build the same index the script builds, on this test's collection.
    await User.collection.createIndex({ waId: 1 }, { unique: true, sparse: true, name: "waId_1_unique_test" });
    try {
      const a = await user();
      const b = await user();
      expect((await bindWaId(a._id, CANON)).ok).toBe(true);
      expect(await bindWaId(b._id, CANON)).toEqual({ ok: false, reason: "waid_taken" });
      expect((await User.findById(b._id).lean())).not.toHaveProperty("waId");
    } finally {
      await User.collection.dropIndex("waId_1_unique_test");
    }
  });
});

describe("unbindWaId — $unset, never null", () => {
  it("removes the field entirely (absent on disk, not null, not empty)", async () => {
    const u = await user({ waId: CANON });
    const res = await unbindWaId(u._id);
    expect(res).toEqual({ ok: true, matched: 1 });
    const raw = await User.collection.findOne({ _id: u._id });
    expect(raw).not.toHaveProperty("waId");
    expect((await resolveIdentity(CANON)).hard).toBeNull();
  });

  it("works on an INACTIVE user too (off-boarding must be able to revoke)", async () => {
    const u = await user({ waId: CANON, status: "INACTIVE" });
    expect(await unbindWaId(u._id)).toEqual({ ok: true, matched: 1 });
    expect(await User.collection.findOne({ _id: u._id })).not.toHaveProperty("waId");
  });

  it("is idempotent and safe on a missing user", async () => {
    const u = await user();
    expect(await unbindWaId(u._id)).toEqual({ ok: true, matched: 1 });
    expect(await unbindWaId(new mongoose.Types.ObjectId())).toEqual({ ok: false, matched: 0 });
    expect(await unbindWaId("nope")).toEqual({ ok: false, matched: 0 });
  });

  it("keeps a sparse unique index sparse: two unbound users do not collide", async () => {
    await User.collection.createIndex({ waId: 1 }, { unique: true, sparse: true, name: "waId_1_unique_test" });
    try {
      const a = await user({ waId: CANON });
      const b = await user({ waId: "919876543211" });
      await unbindWaId(a._id);
      await unbindWaId(b._id); // would throw E11000 if unbind stored null
      expect(await User.countDocuments({ waId: { $exists: false } })).toBe(2);
    } finally {
      await User.collection.dropIndex("waId_1_unique_test");
    }
  });
});

/* ─────────────────────────── single-writer grep ──────────────────────── */

describe("User.waId has exactly the allow-listed writers", () => {
  const SRC = join(process.cwd(), "src");
  const ALLOWED = new Set([
    "services/plumconnect/resolveIdentity.ts", // bindWaId / unbindWaId
    "scripts/set-waid.ts", // legacy operator CLI
    "scripts/plumconnect-waid-cleanup.ts", // contingency $unset (raw collection)
  ]);
  // A write to waId, not a read or a log line: $set/$unset with waId inside,
  // or a property assignment. (`$setOnInsert: { waId }` on the Expense*
  // job rows is a different collection and a different pattern.)
  const WRITE_PATTERNS = [
    /\$set\s*:\s*\{[^}]*\bwaId\b/,
    /\$unset\s*:\s*\{[^}]*\bwaId\b/,
    /\.waId\s*=[^=]/,
  ];

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) out.push(p);
    }
    return out;
  }

  it("no file outside the allow-list writes waId", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split("\\").join("/");
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
      const hits = lines.filter((l) => WRITE_PATTERNS.some((re) => re.test(l)));
      if (hits.length && !ALLOWED.has(rel)) offenders.push(`${rel}: ${hits[0].trim()}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the allow-listed writers do write it (so the grep is not vacuous)", () => {
    for (const rel of ["services/plumconnect/resolveIdentity.ts", "scripts/set-waid.ts"]) {
      const text = readFileSync(join(SRC, rel), "utf8");
      expect(WRITE_PATTERNS.some((re) => re.test(text))).toBe(true);
    }
  });
});
