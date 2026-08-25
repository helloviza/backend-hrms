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

/* ══════════════════════════════════════════════════════════════════════
 * THE PROFILE PHOTO
 *
 * The avatar shares the byte store with the document locker and NOTHING
 * else — see the block comment above the routes. The assertions that
 * matter most here are the NON-events: no ConsumerDocument row, no move
 * in completion, no move in readiness. Those are what stop an account
 * picture from telling a consumer they are ready to apply for a visa.
 * ══════════════════════════════════════════════════════════════════════ */

describe("profile photo", () => {
  /** A real, decodable image — sharp has to be able to read what we send. */
  async function makeImage(
    width: number,
    height: number,
    format: "png" | "jpeg" = "png",
  ): Promise<Buffer> {
    const { default: sharp } = await import("sharp");
    const img = sharp({
      create: { width, height, channels: 3, background: { r: 20, g: 90, b: 200 } },
    });
    return format === "png" ? img.png().toBuffer() : img.jpeg().toBuffer();
  }

  it("401s without a consumer token — every photo route is gated", async () => {
    await request(app)
      .post("/api/consumer/profile/photo")
      .attach("file", await makeImage(80, 80), {
        filename: "me.png",
        contentType: "image/png",
      })
      .expect(401);

    await request(app).get("/api/consumer/profile/photo").expect(401);
    await request(app).delete("/api/consumer/profile/photo").expect(401);
  });

  it("uploads, squares the image, and serves it back as WEBP", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    // Deliberately NOT square, and deliberately landscape — the crop is
    // the thing under test, not the round trip.
    const uploaded = await request(app)
      .post("/api/consumer/profile/photo")
      .set("Authorization", a.auth)
      .attach("file", await makeImage(600, 300), {
        filename: "me.png",
        contentType: "image/png",
      })
      .expect(200);

    // The wire carries a version token, never the storage key.
    expect(uploaded.body.profile.photoUpdatedAt).toBeTruthy();
    expect(uploaded.body.profile.personal.photoStorageKey).toBeUndefined();
    expect(uploaded.body.profile.personal.photoDriver).toBeUndefined();
    expect(JSON.stringify(uploaded.body)).not.toContain("consumer-documents/");

    const bytes = await request(app)
      .get("/api/consumer/profile/photo")
      .set("Authorization", a.auth)
      .buffer()
      .parse(binaryParser)
      .expect(200);

    expect(bytes.headers["content-type"]).toBe("image/webp");
    // No shared cache may hold a consumer's face.
    expect(bytes.headers["cache-control"]).toContain("private");

    const { default: sharp } = await import("sharp");
    const meta = await sharp(bytes.body).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
  });

  it("404s the bytes route when no photo has been set", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");
    await request(app)
      .get("/api/consumer/profile/photo")
      .set("Authorization", a.auth)
      .expect(404);
  });

  it("is OWN-scoped — B's photo is unreachable from A's session", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");
    const b = await makeConsumer("b@helloviza.test", "Consumer B");

    await request(app)
      .post("/api/consumer/profile/photo")
      .set("Authorization", b.auth)
      .attach("file", await makeImage(300, 300), {
        filename: "b.png",
        contentType: "image/png",
      })
      .expect(200);

    // A has no photo of their own, and there is no request shape that
    // reaches B's — the route takes no id at all.
    await request(app)
      .get("/api/consumer/profile/photo")
      .set("Authorization", a.auth)
      .expect(404);

    const aProfile = await request(app)
      .get("/api/consumer/profile")
      .set("Authorization", a.auth)
      .expect(200);
    expect(aProfile.body.profile.photoUpdatedAt).toBeNull();

    const bProfile = await request(app)
      .get("/api/consumer/profile")
      .set("Authorization", b.auth)
      .expect(200);
    expect(bProfile.body.profile.photoUpdatedAt).toBeTruthy();
  });

  it("rejects a non-image file type", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    // A PDF is accepted by the DOCUMENT uploader and must not be here.
    await request(app)
      .post("/api/consumer/profile/photo")
      .set("Authorization", a.auth)
      .attach("file", Buffer.from("%PDF-1.4 x"), {
        filename: "scan.pdf",
        contentType: "application/pdf",
      })
      .expect(400);

    await request(app)
      .post("/api/consumer/profile/photo")
      .set("Authorization", a.auth)
      .attach("file", Buffer.from("MZ executable"), {
        filename: "virus.exe",
        contentType: "application/x-msdownload",
      })
      .expect(400);
  });

  it("rejects a file that claims an image type but does not decode", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    const res = await request(app)
      .post("/api/consumer/profile/photo")
      .set("Authorization", a.auth)
      .attach("file", Buffer.from("this is not a png"), {
        filename: "liar.png",
        contentType: "image/png",
      })
      .expect(400);

    expect(res.body.error).toMatch(/could not be read as an image/i);
  });

  it("rejects an oversized image with 413", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    // Over the 5MB ceiling. Random bytes so nothing compresses it away.
    const { randomBytes } = await import("node:crypto");
    await request(app)
      .post("/api/consumer/profile/photo")
      .set("Authorization", a.auth)
      .attach("file", randomBytes(6 * 1024 * 1024), {
        filename: "huge.png",
        contentType: "image/png",
      })
      .expect(413);
  });

  it("does NOT create a locker row, and does NOT move completion or readiness", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    const before = await request(app)
      .get("/api/consumer/profile")
      .set("Authorization", a.auth)
      .expect(200);

    const after = await request(app)
      .post("/api/consumer/profile/photo")
      .set("Authorization", a.auth)
      .attach("file", await makeImage(400, 400, "jpeg"), {
        filename: "me.jpg",
        contentType: "image/jpeg",
      })
      .expect(200);

    // THE POINT OF THE WHOLE SPLIT. An account picture is not a visa
    // artefact and not a locker file, so neither number may move.
    expect(after.body.completion.percent).toBe(before.body.completion.percent);
    expect(after.body.readiness.percent).toBe(before.body.readiness.percent);
    expect(after.body.readiness.items.find((i: any) => i.key === "photograph").ready).toBe(false);

    // And no ConsumerDocument was created — nothing appears in the locker.
    expect(await ConsumerDocument.countDocuments({})).toBe(0);

    const docs = await request(app)
      .get("/api/consumer/profile/documents")
      .set("Authorization", a.auth)
      .expect(200);
    expect(docs.body.documents).toHaveLength(0);
  });

  it("replaces an existing photo, moving the version token", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    const first = await request(app)
      .post("/api/consumer/profile/photo")
      .set("Authorization", a.auth)
      .attach("file", await makeImage(200, 200), {
        filename: "one.png",
        contentType: "image/png",
      })
      .expect(200);

    const firstRow: any = await ConsumerProfile.findOne({
      consumerId: a.consumer._id,
    }).lean();
    const firstKey = firstRow.personal.photoStorageKey;
    expect(firstKey).toBeTruthy();

    const second = await request(app)
      .post("/api/consumer/profile/photo")
      .set("Authorization", a.auth)
      .attach("file", await makeImage(240, 240), {
        filename: "two.png",
        contentType: "image/png",
      })
      .expect(200);

    const secondRow: any = await ConsumerProfile.findOne({
      consumerId: a.consumer._id,
    }).lean();

    // A NEW object, so the ?v= token the client hangs on the <img> URL
    // actually changes and the browser re-fetches.
    expect(secondRow.personal.photoStorageKey).not.toBe(firstKey);
    expect(new Date(second.body.profile.photoUpdatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.body.profile.photoUpdatedAt).getTime(),
    );

    // Still serves, and still exactly one photo.
    await request(app)
      .get("/api/consumer/profile/photo")
      .set("Authorization", a.auth)
      .expect(200);
  });

  it("removes the photo and its pointer", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    await request(app)
      .post("/api/consumer/profile/photo")
      .set("Authorization", a.auth)
      .attach("file", await makeImage(150, 150), {
        filename: "me.png",
        contentType: "image/png",
      })
      .expect(200);

    const removed = await request(app)
      .delete("/api/consumer/profile/photo")
      .set("Authorization", a.auth)
      .expect(200);

    expect(removed.body.profile.photoUpdatedAt).toBeNull();

    const row: any = await ConsumerProfile.findOne({ consumerId: a.consumer._id }).lean();
    expect(row.personal.photoStorageKey).toBeUndefined();

    await request(app)
      .get("/api/consumer/profile/photo")
      .set("Authorization", a.auth)
      .expect(404);
  });
});

/*
 * ══════════════════════════════════════════════════════════════════════
 * THE SIGNUP NUMBER REACHES THE FIELD THE OTP FLOW READS.
 * ══════════════════════════════════════════════════════════════════════
 * Signup writes Consumer.phone; everything else reads
 * ConsumerProfile.contact.mobile. Before the seed, a consumer who gave us
 * a number at signup was still told "Add your mobile number to your
 * profile first" when they tried to verify it — the two fields had never
 * been connected. These pin the connection AND its limits.
 */
describe("contact.mobile is seeded from the signup number", () => {
  it("seeds the profile's mobile from Consumer.phone, UNVERIFIED, on first touch", async () => {
    const c = await makeConsumer("seed-me@helloviza.test", "Seed Me");
    await Consumer.updateOne({ _id: c.consumer._id }, { $set: { phone: "+919000000123" } });

    // No profile row exists yet — this GET is what mints it.
    expect(await ConsumerProfile.countDocuments({ consumerId: c.consumer._id })).toBe(0);

    const res = await request(app)
      .get("/api/consumer/profile")
      .set("Authorization", c.auth)
      .expect(200);

    // Normalised to bare ten digits, not the "+91…" the signup form carried.
    expect(res.body.profile.contact.mobile).toBe("9000000123");
    // The whole point: a number typed at signup is a claim, not a fact.
    expect(res.body.profile.contact.mobileVerified).toBe(false);
  });

  it("stores the seeded number ENCRYPTED, like any other write to that field", async () => {
    const c = await makeConsumer("seed-enc@helloviza.test", "Seed Enc");
    await Consumer.updateOne({ _id: c.consumer._id }, { $set: { phone: "9000000124" } });

    await request(app).get("/api/consumer/profile").set("Authorization", c.auth).expect(200);

    // Straight to the driver, bypassing the decryption hook: what is ON DISK
    // must be an envelope. A raw update operator would have left plaintext
    // here and every reader would then decrypt garbage.
    const raw: any = await mongoose.connection.db
      .collection("consumerprofiles")
      .findOne({ consumerId: c.consumer._id });
    expect(typeof raw.contact.mobile).toBe("string");
    expect(raw.contact.mobile.startsWith("penc.")).toBe(true);
    expect(raw.contact.mobile).not.toContain("9000000124");
  });

  it("does NOT clobber a number the consumer already set — nor its verified state", async () => {
    const c = await makeConsumer("seed-skip@helloviza.test", "Seed Skip");
    await Consumer.updateOne({ _id: c.consumer._id }, { $set: { phone: "+919000000125" } });

    // Mint the profile and put a DIFFERENT number on it, verified.
    await request(app).get("/api/consumer/profile").set("Authorization", c.auth).expect(200);
    const profile: any = await ConsumerProfile.findOne({ consumerId: c.consumer._id });
    profile.contact.mobile = "9876500000";
    profile.contact.mobileVerified = true;
    await profile.save();

    // Every subsequent load must leave both alone.
    const res = await request(app)
      .get("/api/consumer/profile")
      .set("Authorization", c.auth)
      .expect(200);

    expect(res.body.profile.contact.mobile).toBe("9876500000");
    expect(res.body.profile.contact.mobileVerified).toBe(true);
  });

  it("seeds NOTHING when the signup phone is absent or not an Indian mobile", async () => {
    const none = await makeConsumer("seed-none@helloviza.test", "No Phone");
    const foreign = await makeConsumer("seed-foreign@helloviza.test", "Foreign Phone");
    await Consumer.updateOne({ _id: foreign.consumer._id }, { $set: { phone: "+1 555 0100" } });

    for (const who of [none, foreign]) {
      const res = await request(app)
        .get("/api/consumer/profile")
        .set("Authorization", who.auth)
        .expect(200);
      // Absent, NOT an empty string: MSG91's OTP product is India-only, so
      // there is no code we could send — the contact tab's own prompt is the
      // honest next step.
      expect(res.body.profile.contact.mobile ?? "").toBe("");
      expect(res.body.profile.contact.mobileVerified).toBe(false);
    }
  });

  it("does not resurrect a number the consumer deliberately cleared", async () => {
    const c = await makeConsumer("seed-cleared@helloviza.test", "Cleared");
    await Consumer.updateOne({ _id: c.consumer._id }, { $set: { phone: "+919000000126" } });

    await request(app).get("/api/consumer/profile").set("Authorization", c.auth).expect(200);

    const profile: any = await ConsumerProfile.findOne({ consumerId: c.consumer._id });
    profile.contact.mobile = "";
    await profile.save();

    // The seed fires on INSERT only, so a later load must not put it back.
    const res = await request(app)
      .get("/api/consumer/profile")
      .set("Authorization", c.auth)
      .expect(200);

    expect(res.body.profile.contact.mobile ?? "").toBe("");
  });
});
