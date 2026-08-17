// apps/backend/src/routes/consumer.profile.test.ts
//
// ══════════════════════════════════════════════════════════════════════
// THE SECURITY GATE FOR THE CONSUMER PROFILE.
//
// A leak here is a passport number, a date of birth and a home address
// belonging to a real person. These tests exist to prove that consumer A
// cannot reach consumer B's data through ANY endpoint in the router — not
// by asking nicely, not by passing B's id in a body, and not by guessing
// B's document id.
// ══════════════════════════════════════════════════════════════════════
//
// Real router, real requireConsumer, real tokens, real Mongo
// (mongodb-memory-server). No mocks — a mocked guard would prove nothing,
// because the guard IS the thing under test.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

// Secrets must exist BEFORE any import that reads them — see the identical
// preamble in consumer.auth.test.ts.
const B2B_SECRET = "b2b-jwt-secret-for-tests";
const CONSUMER_SECRET = "consumer-jwt-secret-for-tests";
process.env.JWT_SECRET = B2B_SECRET;
process.env.CONSUMER_JWT_SECRET = CONSUMER_SECRET;
process.env.NODE_ENV = "test";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/consumer-profile-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.OPENAI_API_KEY ||= "test-openai-key";

const { default: Consumer } = await import("../models/Consumer.js");
const { default: ConsumerProfile } = await import("../models/ConsumerProfile.js");
const { default: ConsumerDocument } = await import("../models/ConsumerDocument.js");
const { default: consumerProfileRouter } = await import("./consumer.profile.js");
const { signConsumerAccessToken } = await import("../utils/consumerJwt.js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/consumer/profile", consumerProfileRouter);

let mongod: MongoMemoryServer;

/**
 * Collects a binary response body. supertest only populates res.text for
 * textual content types; an application/pdf response needs the chunks
 * gathered by hand or the assertion silently compares against undefined.
 */
function binaryParser(res: any, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

/**
 * Every consumer id this run created, so afterAll can remove the document
 * directories the local-disk driver wrote. .devdata/ is gitignored, so this
 * is tidiness rather than safety — but a test suite that grows a directory
 * per run forever is its own small problem.
 */
const createdConsumerIds: string[] = [];

/** A real consumer plus a real token for them. */
async function makeConsumer(email: string, name: string) {
  const consumer = await Consumer.create({
    email,
    name,
    passwordHash: "not-used-in-these-tests",
  });
  createdConsumerIds.push(String(consumer._id));
  const token = signConsumerAccessToken({
    consumerId: String(consumer._id),
    tokenVersion: (consumer as any).tokenVersion,
  });
  return { consumer, token, auth: `Bearer ${token}` };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();

  // Remove only the per-consumer directories this run created — never the
  // whole upload root, which may hold a developer's own dev data.
  const { rm } = await import("node:fs/promises");
  const path = (await import("node:path")).default;
  const { CONSUMER_DOCUMENT_LOCAL_ROOT } = await import(
    "../services/consumerDocumentStorage.js"
  );
  await Promise.all(
    createdConsumerIds.map((id) =>
      rm(path.join(CONSUMER_DOCUMENT_LOCAL_ROOT, id), { recursive: true, force: true }),
    ),
  );
});

beforeEach(async () => {
  await Promise.all([
    Consumer.deleteMany({}),
    ConsumerProfile.deleteMany({}),
    ConsumerDocument.deleteMany({}),
  ]);
});

/* ══════════════════════════════════════════════════════════════════════
 * THE ISOLATION SUITE
 * ══════════════════════════════════════════════════════════════════════ */

describe("OWN-scope isolation — consumer A must never reach consumer B", () => {
  it("GET / returns each consumer's OWN profile, never the other's", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");
    const b = await makeConsumer("b@helloviza.test", "Consumer B");

    await request(app)
      .patch("/api/consumer/profile/personal")
      .set("Authorization", a.auth)
      .send({ firstName: "Aisha", lastName: "Alpha", nationality: "Indian" })
      .expect(200);

    await request(app)
      .patch("/api/consumer/profile/personal")
      .set("Authorization", b.auth)
      .send({ firstName: "Bruno", lastName: "Beta", nationality: "Brazilian" })
      .expect(200);

    const seenByA = await request(app)
      .get("/api/consumer/profile")
      .set("Authorization", a.auth)
      .expect(200);
    const seenByB = await request(app)
      .get("/api/consumer/profile")
      .set("Authorization", b.auth)
      .expect(200);

    expect(seenByA.body.profile.personal.firstName).toBe("Aisha");
    expect(seenByB.body.profile.personal.firstName).toBe("Bruno");

    // The decisive assertion: A's response contains nothing of B's.
    expect(JSON.stringify(seenByA.body)).not.toContain("Bruno");
    expect(JSON.stringify(seenByA.body)).not.toContain("Beta");
    expect(seenByA.body.profile.consumerId).toBe(String(a.consumer._id));
    expect(seenByA.body.profile.consumerId).not.toBe(String(b.consumer._id));
  });

  it("ignores a consumerId supplied in the PATCH body — it cannot reassign ownership", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");
    const b = await makeConsumer("b@helloviza.test", "Consumer B");

    // A tries to write into B's row by naming B in the payload.
    await request(app)
      .patch("/api/consumer/profile/personal")
      .set("Authorization", a.auth)
      .send({
        firstName: "Attacker",
        consumerId: String(b.consumer._id),
        workspaceId: new mongoose.Types.ObjectId().toString(),
      })
      .expect(200);

    const aProfile: any = await ConsumerProfile.findOne({ consumerId: a.consumer._id }).lean();
    const bProfile: any = await ConsumerProfile.findOne({ consumerId: b.consumer._id }).lean();

    // A's own row was updated; B's row was never created or touched.
    expect(aProfile.personal.firstName).toBe("Attacker");
    expect(String(aProfile.consumerId)).toBe(String(a.consumer._id));
    expect(bProfile).toBeNull();

    // Exactly one profile exists — the write did not fan out.
    expect(await ConsumerProfile.countDocuments({})).toBe(1);
  });

  it("404s when A addresses B's passport by id, and leaves it intact", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");
    const b = await makeConsumer("b@helloviza.test", "Consumer B");

    const created = await request(app)
      .post("/api/consumer/profile/passports")
      .set("Authorization", b.auth)
      .send({ number: "Z9999999", issuingCountry: "IN", expiryDate: "2030-01-01" })
      .expect(201);

    const bPassportId = created.body.profile.passports[0].id;

    await request(app)
      .patch(`/api/consumer/profile/passports/${bPassportId}`)
      .set("Authorization", a.auth)
      .send({ number: "HACKED01" })
      .expect(404);

    await request(app)
      .post(`/api/consumer/profile/passports/${bPassportId}/primary`)
      .set("Authorization", a.auth)
      .expect(404);

    await request(app)
      .delete(`/api/consumer/profile/passports/${bPassportId}`)
      .set("Authorization", a.auth)
      .expect(404);

    // B's passport number is unchanged and still present.
    const stillThere = await request(app)
      .get("/api/consumer/profile")
      .set("Authorization", b.auth)
      .expect(200);
    expect(stillThere.body.profile.passports).toHaveLength(1);
    expect(stillThere.body.profile.passports[0].number).toBe("Z9999999");
  });

  it("404s when A addresses B's co-traveller by id", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");
    const b = await makeConsumer("b@helloviza.test", "Consumer B");

    const created = await request(app)
      .post("/api/consumer/profile/co-travellers")
      .set("Authorization", b.auth)
      .send({ fullName: "Bea Beta", relationship: "Spouse", passportNumber: "Z1111111" })
      .expect(201);

    const id = created.body.profile.coTravellers[0].id;

    await request(app)
      .patch(`/api/consumer/profile/co-travellers/${id}`)
      .set("Authorization", a.auth)
      .send({ fullName: "Hacked" })
      .expect(404);

    await request(app)
      .delete(`/api/consumer/profile/co-travellers/${id}`)
      .set("Authorization", a.auth)
      .expect(404);

    const bView = await request(app)
      .get("/api/consumer/profile")
      .set("Authorization", b.auth)
      .expect(200);
    expect(bView.body.profile.coTravellers[0].fullName).toBe("Bea Beta");
  });

  it("never lists another consumer's documents", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");
    const b = await makeConsumer("b@helloviza.test", "Consumer B");

    await request(app)
      .post("/api/consumer/profile/documents")
      .set("Authorization", b.auth)
      .field("category", "IDENTITY")
      .attach("file", Buffer.from("%PDF-1.4 b-secret-passport"), {
        filename: "b-passport.pdf",
        contentType: "application/pdf",
      })
      .expect(201);

    const aList = await request(app)
      .get("/api/consumer/profile/documents")
      .set("Authorization", a.auth)
      .expect(200);

    expect(aList.body.documents).toHaveLength(0);

    const bList = await request(app)
      .get("/api/consumer/profile/documents")
      .set("Authorization", b.auth)
      .expect(200);
    expect(bList.body.documents).toHaveLength(1);
  });

  it("404s when A fetches or deletes B's document BYTES by id", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");
    const b = await makeConsumer("b@helloviza.test", "Consumer B");

    const uploaded = await request(app)
      .post("/api/consumer/profile/documents")
      .set("Authorization", b.auth)
      .field("category", "IDENTITY")
      .attach("file", Buffer.from("%PDF-1.4 b-secret-passport"), {
        filename: "b-passport.pdf",
        contentType: "application/pdf",
      })
      .expect(201);

    const docId = uploaded.body.document.id;

    // The bytes — the actual passport scan.
    await request(app)
      .get(`/api/consumer/profile/documents/${docId}/file`)
      .set("Authorization", a.auth)
      .expect(404);

    await request(app)
      .delete(`/api/consumer/profile/documents/${docId}`)
      .set("Authorization", a.auth)
      .expect(404);

    // B can still read their own, and it was not soft-deleted by A's attempt.
    // The response is application/pdf, so supertest leaves res.text undefined
    // and the bytes have to be collected explicitly.
    const own = await request(app)
      .get(`/api/consumer/profile/documents/${docId}/file`)
      .set("Authorization", b.auth)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    expect(Buffer.from(own.body).toString()).toContain("b-secret-passport");

    const row: any = await ConsumerDocument.findById(docId).lean();
    expect(row.deletedAt).toBeNull();
  });

  it("rejects every endpoint outright with no token", async () => {
    await request(app).get("/api/consumer/profile").expect(401);
    await request(app).get("/api/consumer/profile/completion").expect(401);
    await request(app).patch("/api/consumer/profile/personal").send({}).expect(401);
    await request(app).post("/api/consumer/profile/passports").send({}).expect(401);
    await request(app).get("/api/consumer/profile/documents").expect(401);
    await request(app).post("/api/consumer/profile/account/logout-all").expect(401);
    await request(app).get("/api/consumer/profile/account/export").expect(401);
  });

  it("rejects a B2B token — the wall holds on this router too", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    // A well-formed B2B token for a real-looking staff user.
    const b2bToken = jwt.sign(
      { sub: new mongoose.Types.ObjectId().toString(), roles: ["SUPERADMIN"] },
      B2B_SECRET,
      { expiresIn: "30m" },
    );

    await request(app)
      .get("/api/consumer/profile")
      .set("Authorization", `Bearer ${b2bToken}`)
      .expect(401);
  });

  it("does not leak another consumer's data through the DPDP export", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");
    const b = await makeConsumer("b@helloviza.test", "Consumer B");

    await request(app)
      .patch("/api/consumer/profile/personal")
      .set("Authorization", b.auth)
      .send({ firstName: "Bruno", lastName: "Beta" })
      .expect(200);

    const exported = await request(app)
      .get("/api/consumer/profile/account/export")
      .set("Authorization", a.auth)
      .expect(200);

    expect(exported.text).not.toContain("Bruno");
    expect(exported.text).not.toContain("b@helloviza.test");
    expect(exported.text).toContain("a@helloviza.test");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * BEHAVIOUR — the profile does what the UI will rely on
 * ══════════════════════════════════════════════════════════════════════ */

describe("profile behaviour", () => {
  it("creates an empty profile on first read, at 0%", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    const res = await request(app)
      .get("/api/consumer/profile")
      .set("Authorization", a.auth)
      .expect(200);

    expect(res.body.completion.completedCount).toBe(0);
    expect(res.body.completion.totalCount).toBe(6);
    expect(res.body.completion.percent).toBe(0);
    // The email badge comes from the login identity, not from stored state.
    expect(res.body.profile.contact.email).toBe("a@helloviza.test");
    expect(res.body.profile.contact.emailVerified).toBe(true);
  });

  it("drops fields that are not on the section whitelist", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    await request(app)
      .patch("/api/consumer/profile/personal")
      .set("Authorization", a.auth)
      .send({ firstName: "Aisha", isAdmin: true, tokenVersion: 999 })
      .expect(200);

    const stored: any = await ConsumerProfile.findOne({ consumerId: a.consumer._id }).lean();
    expect(stored.personal.firstName).toBe("Aisha");
    expect(stored.personal.isAdmin).toBeUndefined();
    expect(stored.tokenVersion).toBeUndefined();
  });

  it("keeps exactly one primary passport across add and re-designate", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    const first = await request(app)
      .post("/api/consumer/profile/passports")
      .set("Authorization", a.auth)
      .send({ number: "A1111111", expiryDate: "2031-05-01" })
      .expect(201);
    expect(first.body.profile.passports[0].isPrimary).toBe(true);

    const second = await request(app)
      .post("/api/consumer/profile/passports")
      .set("Authorization", a.auth)
      .send({ number: "A2222222", expiryDate: "2033-05-01" })
      .expect(201);

    // Adding a second must not create a second primary.
    expect(second.body.profile.passports.filter((p: any) => p.isPrimary)).toHaveLength(1);

    const secondId = second.body.profile.passports[1].id;
    const promoted = await request(app)
      .post(`/api/consumer/profile/passports/${secondId}/primary`)
      .set("Authorization", a.auth)
      .expect(200);

    const primaries = promoted.body.profile.passports.filter((p: any) => p.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].id).toBe(secondId);
  });

  it("promotes a survivor when the primary passport is deleted", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    const first = await request(app)
      .post("/api/consumer/profile/passports")
      .set("Authorization", a.auth)
      .send({ number: "A1111111", expiryDate: "2031-05-01" })
      .expect(201);
    await request(app)
      .post("/api/consumer/profile/passports")
      .set("Authorization", a.auth)
      .send({ number: "A2222222", expiryDate: "2033-05-01" })
      .expect(201);

    const primaryId = first.body.profile.passports[0].id;
    const after = await request(app)
      .delete(`/api/consumer/profile/passports/${primaryId}`)
      .set("Authorization", a.auth)
      .expect(200);

    expect(after.body.profile.passports).toHaveLength(1);
    expect(after.body.profile.passports[0].isPrimary).toBe(true);
  });

  it("copies the current address into permanent when 'same as' is set", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    await request(app)
      .patch("/api/consumer/profile/contact")
      .set("Authorization", a.auth)
      .send({
        currentAddress: { line1: "12 MG Road", city: "Bengaluru", country: "India" },
        permanentSameAsCurrent: true,
      })
      .expect(200);

    const stored: any = await ConsumerProfile.findOne({ consumerId: a.consumer._id }).lean();
    expect(stored.contact.permanentAddress.line1).toBe("12 MG Road");
    expect(stored.contact.permanentAddress.city).toBe("Bengaluru");
  });

  it("strips unknown keys from a nested address object", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    await request(app)
      .patch("/api/consumer/profile/contact")
      .set("Authorization", a.auth)
      .send({ currentAddress: { line1: "12 MG Road", evil: "payload" } })
      .expect(200);

    const stored: any = await ConsumerProfile.findOne({ consumerId: a.consumer._id }).lean();
    expect(stored.contact.currentAddress.line1).toBe("12 MG Road");
    expect(stored.contact.currentAddress.evil).toBeUndefined();
  });

  it("counts 'no prior refusal' as an ANSWER, not as missing", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    const before = await request(app)
      .get("/api/consumer/profile/completion")
      .set("Authorization", a.auth)
      .expect(200);
    const travelBefore = before.body.completion.tabs.find((t: any) => t.key === "travel");
    expect(travelBefore.missing).toContain("Previous visa refusals (yes/no)");

    await request(app)
      .patch("/api/consumer/profile/travel")
      .set("Authorization", a.auth)
      .send({ occupation: "Designer", employmentType: "SALARIED", hasPriorVisaRefusal: false })
      .expect(200);

    const after = await request(app)
      .get("/api/consumer/profile/completion")
      .set("Authorization", a.auth)
      .expect(200);
    const travelAfter = after.body.completion.tabs.find((t: any) => t.key === "travel");
    expect(travelAfter.complete).toBe(true);
  });

  it("does not count a passport row with no number as a usable passport", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    await request(app)
      .post("/api/consumer/profile/passports")
      .set("Authorization", a.auth)
      .send({ issuingCountry: "IN" })
      .expect(201);

    const res = await request(app)
      .get("/api/consumer/profile/completion")
      .set("Authorization", a.auth)
      .expect(200);

    const passportTab = res.body.completion.tabs.find((t: any) => t.key === "passport");
    expect(passportTab.complete).toBe(false);
  });

  it("round-trips every contact field and leaks no Mongoose internals", async () => {
    // Regression: `{ ...subdoc }` copies a Mongoose subdocument's INTERNALS
    // ($__, $__parent, $isNew, _doc) and none of its data — so a saved
    // mobile and address serialised as undefined and rendered as "—", while
    // the internals went out on the wire. Both halves are asserted.
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    await request(app)
      .patch("/api/consumer/profile/contact")
      .set("Authorization", a.auth)
      .send({
        mobile: "+919000000001",
        alternateEmail: "personal@example.com",
        currentAddress: { line1: "402 Prestige", city: "Bengaluru", country: "India" },
      })
      .expect(200);

    const res = await request(app)
      .get("/api/consumer/profile")
      .set("Authorization", a.auth)
      .expect(200);

    const contact = res.body.profile.contact;
    expect(contact.mobile).toBe("+919000000001");
    expect(contact.alternateEmail).toBe("personal@example.com");
    expect(contact.currentAddress.city).toBe("Bengaluru");
    // The login identity is still merged in.
    expect(contact.email).toBe("a@helloviza.test");

    for (const leaked of ["$__", "$__parent", "$isNew", "_doc"]) {
      expect(Object.keys(contact)).not.toContain(leaked);
    }
    expect(JSON.stringify(res.body)).not.toContain("$__");
  });

  it("never exposes the storage key or bucket on the wire", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    const uploaded = await request(app)
      .post("/api/consumer/profile/documents")
      .set("Authorization", a.auth)
      .field("category", "FINANCIAL")
      .attach("file", Buffer.from("%PDF-1.4 bank statement"), {
        filename: "statement.pdf",
        contentType: "application/pdf",
      })
      .expect(201);

    expect(uploaded.body.document.storageKey).toBeUndefined();
    expect(uploaded.body.document.bucket).toBeUndefined();
    expect(uploaded.body.document.driver).toBeUndefined();
  });

  it("soft-deletes a document and clears it from any passport that referenced it", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    const uploaded = await request(app)
      .post("/api/consumer/profile/documents")
      .set("Authorization", a.auth)
      .field("category", "IDENTITY")
      .attach("file", Buffer.from("%PDF-1.4 passport scan"), {
        filename: "scan.pdf",
        contentType: "application/pdf",
      })
      .expect(201);
    const docId = uploaded.body.document.id;

    const passport = await request(app)
      .post("/api/consumer/profile/passports")
      .set("Authorization", a.auth)
      .send({ number: "A1111111", expiryDate: "2031-05-01", frontDocumentId: docId })
      .expect(201);
    expect(passport.body.profile.passports[0].frontDocumentId).toBe(docId);

    await request(app)
      .delete(`/api/consumer/profile/documents/${docId}`)
      .set("Authorization", a.auth)
      .expect(200);

    // Row survives (an application may reference it) but is hidden…
    const row: any = await ConsumerDocument.findById(docId).lean();
    expect(row).not.toBeNull();
    expect(row.deletedAt).not.toBeNull();

    // …and the passport no longer points at a document the consumer deleted.
    const after = await request(app)
      .get("/api/consumer/profile")
      .set("Authorization", a.auth)
      .expect(200);
    expect(after.body.profile.passports[0].frontDocumentId).toBeNull();
    expect(after.body.documents).toBeUndefined();
  });

  it("rejects a disallowed file type and an unknown category", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    await request(app)
      .post("/api/consumer/profile/documents")
      .set("Authorization", a.auth)
      .field("category", "IDENTITY")
      .attach("file", Buffer.from("MZ executable"), {
        filename: "virus.exe",
        contentType: "application/x-msdownload",
      })
      .expect(400);

    await request(app)
      .post("/api/consumer/profile/documents")
      .set("Authorization", a.auth)
      .field("category", "NOT_A_CATEGORY")
      .attach("file", Buffer.from("%PDF-1.4 x"), {
        filename: "x.pdf",
        contentType: "application/pdf",
      })
      .expect(400);
  });

  it("logout-all bumps tokenVersion, revoking the caller's own token too", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    await request(app)
      .post("/api/consumer/profile/account/logout-all")
      .set("Authorization", a.auth)
      .expect(200);

    const row: any = await Consumer.findById(a.consumer._id).lean();
    expect(row.tokenVersion).toBe(1);

    // The token minted at version 0 is now dead — real revocation.
    await request(app).get("/api/consumer/profile").set("Authorization", a.auth).expect(401);
  });
});
