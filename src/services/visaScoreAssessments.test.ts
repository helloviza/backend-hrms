// apps/backend/src/services/visaScoreAssessments.test.ts
//
// PHASE A — the persistence capability, and the DPDP boundary it has to
// hold.
//
// The important test in this file is the last one. Everything above it
// establishes that the write path works; the DPDP block establishes that
// what it wrote is safe, using the same serialise-and-grep discipline
// routes/public.visaScore.lead.test.ts applies to the ops ticket — assert
// the sensitive material EXISTS in the engine's output first, then assert
// it is absent from everything persisted. A test that only did the second
// half would pass just as happily against an engine that had stopped
// producing sensitive factors at all.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/visa-score-assessment-test";
process.env.JWT_SECRET ||= "b2b-test-secret";
process.env.CONSUMER_JWT_SECRET ||= "consumer-distinct-test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: VisaScoreAssessment } = await import("../models/VisaScoreAssessment.js");
const { recordAssessment, latestAssessmentFor, listAssessments, latestPerDestination } =
  await import("./visaScoreAssessments.js");
const { toSafeBreakdown, SENSITIVE_ANSWER_KEYS, isSensitiveQuestion } = await import(
  "./visaScoreSafeBreakdown.js"
);
const { computeVisaProfileScore } = await import("./visaProfileScore.js");
const { VISA_SCORE_RULESET: R } = await import("../config/visaScoreRuleset.js");

let mongod: MongoMemoryServer;
const CONSUMER_A = new mongoose.Types.ObjectId();
const CONSUMER_B = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await VisaScoreAssessment.deleteMany({});
});

/* ── The assessments used throughout ──────────────────────────────────
 * WEAK is deliberately a DISCLOSING applicant, and the two choices that
 * make it one are load-bearing:
 *
 *   travel: 1      not 0 — option 0 is the first-timer trigger, which makes
 *                  the server SKIP the compliance question entirely. The
 *                  DPDP assertions would then pass for the wrong reason.
 *   compliance: 3  "Deported / misrepresentation finding" — a hard stop
 *                  that caps the score at 449.
 *   character: 3   "Custodial sentence 12 months or more" — the other cap.
 */
const WEAK: Record<string, number> = {
  residence: 0, age: 2, travel: 1, purpose: 0, staylen: 1, companions: 1,
  family: 1, assets: 1, employment: 3, payer: 0, finproof: 1, refusals: 0,
  compliance: 3, character: 3,
};

/** A clean profile — nothing sensitive disclosed. */
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

/** Every string the two sensitive questions could contribute to a row. */
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

/* ═══════════════════════════════════════════════════════════════════════
 * THE SHARED FILTER — one rule, and the cap it also has to close
 * ═══════════════════════════════════════════════════════════════════════ */

describe("toSafeBreakdown", () => {
  it("drops every factor and flag belonging to a sensitive question", () => {
    const result = score(WEAK);

    // THE PREMISE. If the engine stopped emitting these, everything below
    // would pass while proving nothing.
    const rawSensitive = [
      ...result.factors.helping,
      ...result.factors.holdingBack,
      ...result.flags,
    ].filter((f) => isSensitiveQuestion(f.questionId));
    expect(rawSensitive.length).toBeGreaterThan(0);

    const safe = toSafeBreakdown(result);
    for (const f of [...safe.helping, ...safe.holdingBack, ...safe.flags]) {
      expect(isSensitiveQuestion(f.questionId)).toBe(false);
    }
  });

  it("keeps the factors that are safe — it is a filter, not a blanket", () => {
    const result = score(WEAK);
    const safe = toSafeBreakdown(result);
    expect(safe.helping.length + safe.holdingBack.length).toBeGreaterThan(0);
    // employment is the objection the brief exists to surface, and it is
    // not sensitive.
    const all = [...safe.helping, ...safe.holdingBack].map((f) => f.questionId);
    expect(all).toContain("employment");
  });

  it("nulls the cap, which would name the sensitive fact by elimination", () => {
    const result = score(WEAK);
    // The engine really did cap this profile, and the code really does
    // name a sensitive question.
    expect(result.build.capped).toBeTruthy();
    const causing = result.flags.find((f) => f.code === result.build.capped)!;
    expect(isSensitiveQuestion(causing.questionId)).toBe(true);

    expect(toSafeBreakdown(result).capped).toBeNull();
  });

  it("passes a clean profile through with nothing removed", () => {
    const result = score(CLEAN);
    const safe = toSafeBreakdown(result);
    expect(safe.helping.length).toBe(result.factors.helping.length);
    expect(safe.holdingBack.length).toBe(result.factors.holdingBack.length);
    expect(safe.flags.length).toBe(result.flags.length);
    expect(safe.capped).toBe(result.build.capped);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * THE WRITE PATH
 * ═══════════════════════════════════════════════════════════════════════ */

describe("recordAssessment", () => {
  it("stores the score, the band, the route and the baseline", async () => {
    const result = score(CLEAN);
    const row: any = await recordAssessment({ consumerId: CONSUMER_A, result });

    expect(String(row.consumerId)).toBe(String(CONSUMER_A));
    expect(row.destination).toBe("US");
    expect(row.passport).toBe("IN");
    expect(row.score).toBe(result.score);
    expect(row.band.name).toBe(result.band!.name);
    expect(row.baseScore).toBe(result.build.baseScore);
    expect(row.profileStrength).toBe(result.profileStrength);
    expect(row.rulesetVersion).toBe(result.rulesetVersion);
    expect(row.source).toBe("gate");
  });

  it("APPENDS — a retake is a new row, so the history survives", async () => {
    await recordAssessment({ consumerId: CONSUMER_A, result: score(WEAK) });
    await recordAssessment({
      consumerId: CONSUMER_A,
      result: score(CLEAN),
      source: "retake",
    });

    const rows = await listAssessments(CONSUMER_A);
    expect(rows.length).toBe(2);
    // Newest first, and the two scores genuinely differ — "you were at X,
    // you are at Y now" is readable off this collection.
    expect(rows[0].source).toBe("retake");
    expect(rows[0].score).not.toBe(rows[1].score);
  });

  it("stores only the FILTERED explanation", async () => {
    const result = score(WEAK);
    const safe = toSafeBreakdown(result);
    const row: any = await recordAssessment({ consumerId: CONSUMER_A, result });

    expect(row.factors.helping.length).toBe(safe.helping.length);
    expect(row.factors.holdingBack.length).toBe(safe.holdingBack.length);
    expect(row.flags.length).toBe(safe.flags.length);
    expect(row.capped).toBeNull();

    // And strictly fewer than the engine produced — the filter did work.
    const rawCount =
      result.factors.helping.length + result.factors.holdingBack.length + result.flags.length;
    const storedCount =
      row.factors.helping.length + row.factors.holdingBack.length + row.flags.length;
    expect(storedCount).toBeLessThan(rawCount);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * THE READ PATH — own-scoped by construction
 * ═══════════════════════════════════════════════════════════════════════ */

describe("reads", () => {
  it("latestAssessmentFor returns the newest row for that corridor", async () => {
    await recordAssessment({ consumerId: CONSUMER_A, result: score(WEAK, "US") });
    const second = await recordAssessment({
      consumerId: CONSUMER_A,
      result: score(CLEAN, "US"),
      source: "retake",
    });

    const latest = await latestAssessmentFor(CONSUMER_A, "US");
    expect(String(latest!._id)).toBe(String((second as any)._id));
  });

  it("is case-insensitive on the corridor code", async () => {
    await recordAssessment({ consumerId: CONSUMER_A, result: score(CLEAN, "GB") });
    expect(await latestAssessmentFor(CONSUMER_A, "gb")).not.toBeNull();
  });

  it("never returns another consumer's assessments", async () => {
    await recordAssessment({ consumerId: CONSUMER_A, result: score(CLEAN, "US") });
    await recordAssessment({ consumerId: CONSUMER_B, result: score(CLEAN, "US") });

    const mine = await listAssessments(CONSUMER_A);
    expect(mine.length).toBe(1);
    expect(String(mine[0].consumerId)).toBe(String(CONSUMER_A));
    expect(await latestAssessmentFor(CONSUMER_B, "GB")).toBeNull();
  });

  it("latestPerDestination collapses a history to one row per corridor", async () => {
    await recordAssessment({ consumerId: CONSUMER_A, result: score(WEAK, "US") });
    await recordAssessment({ consumerId: CONSUMER_A, result: score(CLEAN, "US"), source: "retake" });
    await recordAssessment({ consumerId: CONSUMER_A, result: score(CLEAN, "GB") });

    const rows = await latestPerDestination(CONSUMER_A);
    expect(rows.map((r) => r.destination).sort()).toEqual(["GB", "US"]);
    expect(rows.find((r) => r.destination === "US")!.source).toBe("retake");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * DPDP §12.7 — WHAT IS ON DISK
 * ═══════════════════════════════════════════════════════════════════════ */

describe("DPDP — the persisted row", () => {
  it("contains nothing about the compliance or character answers", async () => {
    const result = score(WEAK);

    /* THE PREMISE FIRST — the material this test guards against has to
     * genuinely exist in what the engine handed us. */
    const sensitiveFactors = [...result.factors.helping, ...result.factors.holdingBack].filter(
      (f) => isSensitiveQuestion(f.questionId),
    );
    const sensitiveFlags = result.flags.filter((f) => isSensitiveQuestion(f.questionId));
    expect(sensitiveFactors.length + sensitiveFlags.length).toBeGreaterThan(0);
    expect(result.build.capped).toBeTruthy();

    await recordAssessment({
      consumerId: CONSUMER_A,
      result,
      submissionId: "11111111-1111-4111-8111-111111111111",
    });

    /* EVERYTHING PERSISTED, serialised whole — not the fields this test
     * happens to know about. A path added by a later edit is covered by
     * this without anyone remembering to extend the assertions. */
    const persisted = JSON.stringify(await VisaScoreAssessment.find({}).lean());

    for (const needle of sensitiveStrings()) {
      expect(persisted).not.toContain(needle);
    }
    // The question ids themselves, in any shape — no "compliance": 3.
    for (const key of SENSITIVE_ANSWER_KEYS) {
      expect(persisted).not.toContain(key);
    }
    // The cap code, which would name the finding by elimination.
    expect(persisted).not.toContain("misrep");
    expect(persisted).not.toContain("custodial");
  });

  it("has no schema path that could hold a raw answer", () => {
    /* THE STRUCTURAL HALF of the guarantee. The filter closes what is
     * written; this closes what COULD be written. A future edit that adds
     * an `answers` or a free-form bag fails here, at the schema, rather
     * than silently starting to store them. */
    const paths = Object.keys(VisaScoreAssessment.schema.paths);
    for (const banned of ["answers", "responses", "rawAnswers", "payload", "meta", "input"]) {
      expect(paths).not.toContain(banned);
    }
    // Nothing of Mixed type either — that is the shape a bag would take.
    for (const [name, def] of Object.entries(VisaScoreAssessment.schema.paths)) {
      expect((def as any).instance).not.toBe("Mixed");
      expect(name).not.toMatch(/answer/i);
    }
  });

  it("still stores the useful half — this is a filter, not an erasure", async () => {
    const result = score(WEAK);
    await recordAssessment({ consumerId: CONSUMER_A, result });
    const persisted = JSON.stringify(await VisaScoreAssessment.find({}).lean());

    // The score and the band survive — the row is worth keeping.
    expect(persisted).toContain(String(result.score));
    expect(persisted).toContain(result.band!.name);
    // And the non-sensitive objection the desk actually acts on.
    expect(persisted).toContain("employment");
  });
});
