// apps/backend/src/routes/consumer.visaScore.test.ts
//
// PHASE B — the read side of the account's Visa Score section.
//
// Two things need proving and only one of them is about rendering:
//
//   1. The endpoint is OWN-SCOPED. A consumer reads their own rows and
//      cannot reach anyone else's, including by asking for them — the
//      only consumer id in the handler comes from the session, so there
//      is no parameter to attack, and this test demonstrates that by
//      trying the two shapes an attacker would reach for first.
//   2. What comes back is the SAFE stored data. Phase A guarantees the
//      rows contain nothing sensitive; this asserts the read path does
//      not somehow reconstruct any of it, using the same
//      serialise-and-grep discipline the persistence and lead tests use.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

// Secrets must exist BEFORE any import that reads them.
process.env.JWT_SECRET = "b2b-jwt-secret-for-tests";
process.env.CONSUMER_JWT_SECRET = "consumer-jwt-secret-for-tests";
process.env.NODE_ENV = "test";
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/consumer-visa-score-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.OPENAI_API_KEY ||= "test-openai-key";

const { default: Consumer } = await import("../models/Consumer.js");
const { signConsumerAccessToken } = await import("../utils/consumerJwt.js");
const { default: VisaScoreAssessment } = await import("../models/VisaScoreAssessment.js");
const { recordAssessment } = await import("../services/visaScoreAssessments.js");
const { SENSITIVE_ANSWER_KEYS, isSensitiveQuestion } = await import(
  "../services/visaScoreSafeBreakdown.js"
);
const { computeVisaProfileScore } = await import("../services/visaProfileScore.js");
const { VISA_SCORE_RULESET: R } = await import("../config/visaScoreRuleset.js");
const { default: consumerVisaScoreRouter } = await import("./consumer.visaScore.js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/consumer/visa-score", consumerVisaScoreRouter);

let mongod: MongoMemoryServer;

/** A real consumer plus a real token for them. */
async function makeConsumer(email: string, name: string) {
  const consumer = await Consumer.create({
    email,
    name,
    passwordHash: "not-used-in-these-tests",
  });
  const token = signConsumerAccessToken({
    consumerId: String(consumer._id),
    tokenVersion: (consumer as any).tokenVersion,
  });
  return { id: consumer._id as any, auth: `Bearer ${token}` };
}

/** The two people every test in this file is about. */
let alice: { id: any; auth: string };
let bob: { id: any; auth: string };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([Consumer.deleteMany({}), VisaScoreAssessment.deleteMany({})]);
  alice = await makeConsumer("alice@example.com", "Alice");
  bob = await makeConsumer("bob@example.com", "Bob");
});

/** A disclosing applicant — see the note in visaScoreAssessments.test.ts. */
const WEAK: Record<string, number> = {
  residence: 0, age: 2, travel: 1, purpose: 0, staylen: 1, companions: 1,
  family: 1, assets: 1, employment: 3, payer: 0, finproof: 1, refusals: 0,
  compliance: 3, character: 3,
};
const CLEAN: Record<string, number> = { ...WEAK, employment: 1, compliance: 0, character: 0 };

function score(answers: Record<string, number>, destination = "US") {
  return computeVisaProfileScore({
    passportIso2: "IN",
    destinationIso2: destination,
    answers,
    mode: R.baseRate.defaultMode,
    generatedAt: new Date().toISOString(),
  });
}

function sensitiveStrings(): string[] {
  const out: string[] = [];
  for (const id of SENSITIVE_ANSWER_KEYS) {
    const q = (R.questions as any[]).find((x) => x.id === id)!;
    out.push(q.text, ...q.options.map((o: any) => o.label));
  }
  for (const hs of R.hardStops as any[]) {
    if (SENSITIVE_ANSWER_KEYS.includes(hs.question)) out.push(hs.message, hs.code);
  }
  return out.filter((s) => typeof s === "string" && s.length > 0);
}

const get = (auth: string, q = "") =>
  request(app).get(`/api/consumer/visa-score/assessments${q}`).set("Authorization", auth);

/* ═══════════════════════════════════════════════════════════════════════
 * THE OVERVIEW
 * ═══════════════════════════════════════════════════════════════════════ */

describe("GET /assessments", () => {
  it("is empty for a consumer who has never assessed — a real zero, not an error", async () => {
    const res = await get(alice.auth);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.assessments).toEqual([]);
  });

  it("returns one row per corridor, newest first, with the name resolved", async () => {
    await recordAssessment({ consumerId: alice.id, result: score(CLEAN, "US") });
    await recordAssessment({ consumerId: alice.id, result: score(CLEAN, "GB") });

    const res = await get(alice.auth);
    expect(res.status).toBe(200);
    const codes = res.body.assessments.map((a: any) => a.destination).sort();
    expect(codes).toEqual(["GB", "US"]);

    const gb = res.body.assessments.find((a: any) => a.destination === "GB");
    // Enriched server-side from the same seed the map is built from.
    expect(gb.destinationName).toBe("United Kingdom");
    expect(gb.score).toBeTypeOf("number");
    expect(gb.band.name).toBeTruthy();
  });

  it("collapses a retake history to the latest per corridor", async () => {
    await recordAssessment({ consumerId: alice.id, result: score(WEAK, "US") });
    await recordAssessment({ consumerId: alice.id, result: score(CLEAN, "US"), source: "retake" });

    const res = await get(alice.auth);
    expect(res.body.assessments.length).toBe(1);
    expect(res.body.assessments[0].source).toBe("retake");
  });

  it("?destination= returns that corridor's full history, newest first", async () => {
    await recordAssessment({ consumerId: alice.id, result: score(WEAK, "US") });
    await recordAssessment({ consumerId: alice.id, result: score(CLEAN, "US"), source: "retake" });
    await recordAssessment({ consumerId: alice.id, result: score(CLEAN, "GB") });

    const res = await get(alice.auth, "?destination=us");
    expect(res.status).toBe(200);
    expect(res.body.destination).toBe("US");
    expect(res.body.assessments.length).toBe(2);
    expect(res.body.assessments[0].source).toBe("retake");
    // The progression the account page renders is readable off this.
    expect(res.body.assessments[0].score).not.toBe(res.body.assessments[1].score);
  });

  it("does not leak the internal row shape", async () => {
    await recordAssessment({ consumerId: alice.id, result: score(CLEAN, "US") });
    const a = (await get(alice.auth)).body.assessments[0];
    for (const k of ["workspaceId", "consumerId", "submissionId", "__v", "_id"]) {
      expect(a).not.toHaveProperty(k);
    }
    expect(a.id).toBeTruthy();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * OWN-SCOPED — the half that matters
 * ═══════════════════════════════════════════════════════════════════════ */

describe("own-scoping", () => {
  it("refuses a caller with no session at all", async () => {
    const res = await request(app).get("/api/consumer/visa-score/assessments");
    expect(res.status).toBe(401);
  });

  it("never returns another consumer's assessments", async () => {
    await recordAssessment({ consumerId: alice.id, result: score(CLEAN, "US") });
    await recordAssessment({ consumerId: bob.id, result: score(CLEAN, "GB") });

    const mine = await get(alice.auth);
    expect(mine.body.assessments.map((a: any) => a.destination)).toEqual(["US"]);

    const theirs = await get(bob.auth);
    expect(theirs.body.assessments.map((a: any) => a.destination)).toEqual(["GB"]);
  });

  it("cannot be redirected at another consumer by a query or a body field", async () => {
    await recordAssessment({ consumerId: bob.id, result: score(CLEAN, "GB") });

    /* The two shapes an attacker reaches for first. Neither is read: the
     * handler's only consumer id comes from req.consumer.id, so these are
     * inert rather than rejected — there is no parameter to reject. */
    const byQuery = await get(alice.auth, `?consumerId=${bob.id}`);
    expect(byQuery.body.assessments).toEqual([]);

    const byBody = await request(app)
      .get("/api/consumer/visa-score/assessments")
      .set("Authorization", alice.auth)
      .send({ consumerId: String(bob.id) } as any);
    expect(byBody.body.assessments).toEqual([]);
  });

  it("an unknown destination is an empty list, not someone else's row", async () => {
    await recordAssessment({ consumerId: bob.id, result: score(CLEAN, "GB") });
    const res = await get(alice.auth, "?destination=GB");
    expect(res.status).toBe(200);
    expect(res.body.assessments).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * DPDP — what a read can put on the wire
 * ═══════════════════════════════════════════════════════════════════════ */

describe("DPDP — the response", () => {
  it("carries no sensitive factor, flag, label, hard-stop message or cap", async () => {
    const result = score(WEAK, "US");

    /* THE PREMISE. The engine really did produce sensitive material for
     * this profile — otherwise the assertions below prove nothing. */
    const sensitive = [
      ...result.factors.helping,
      ...result.factors.holdingBack,
      ...result.flags,
    ].filter((f) => isSensitiveQuestion(f.questionId));
    expect(sensitive.length).toBeGreaterThan(0);
    expect(result.build.capped).toBeTruthy();

    await recordAssessment({ consumerId: alice.id, result });

    const res = await get(alice.auth, "?destination=US");
    const wire = JSON.stringify(res.body);

    for (const needle of sensitiveStrings()) {
      expect(wire).not.toContain(needle);
    }
    for (const key of SENSITIVE_ANSWER_KEYS) {
      expect(wire).not.toContain(key);
    }
    expect(wire).not.toContain("misrep");
    expect(wire).not.toContain("custodial");
  });

  it("still carries the useful half — the score, the band and the safe objection", async () => {
    const result = score(WEAK, "US");
    await recordAssessment({ consumerId: alice.id, result });

    const a = (await get(alice.auth)).body.assessments[0];
    expect(a.score).toBe(result.score);
    expect(a.band.name).toBe(result.band!.name);
    const shown = [...a.factors.helping, ...a.factors.holdingBack].map((f: any) => f.questionId);
    expect(shown).toContain("employment");
  });
});
