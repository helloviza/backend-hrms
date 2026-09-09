// apps/backend/src/routes/public.visaScore.lead.test.ts
//
// POST /api/public/visa-score/lead — the email gate on the breakdown.
//
// Split from public.visaScore.test.ts on purpose: that suite's opening line
// is "no Mongo here, unlike public.visa.test.ts — these routes touch no
// model at all, which is itself one of the things worth asserting", and
// that claim is still true of the other three endpoints. This one writes,
// so it needs the in-memory server, and keeping it in its own file leaves
// the other suite's property intact rather than quietly retiring it.
//
// ── WHAT THIS FILE IS REALLY FOR ──────────────────────────────────────
// Two things, and the second matters more than the first:
//
//   1. THE LEAD LANDS IN models/VisaScoreLead — AND NOT AS A TICKET.
//      A score check is a marketing signal, not a support request; it
//      filed into the agent queue for a release and must not again, so
//      "no ticket" is asserted as hard as the row itself.
//   2. THE SENSITIVE ANSWERS NEVER GET THERE. compliance and character are
//      sensitive personal data under DPDP §12.7. They are answered in the
//      requests below at their most disclosing options, and every
//      persisted document is then searched for any trace of them — the
//      question text, the option label, the hard-stop message and the cap
//      itself. Real documents on a real (in-memory) server, never
//      fixtures: a literal object would prove nothing about what was
//      actually written. The lead row has no answers path at all, which
//      is the schema-level half of the same guarantee.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/visa-score-lead-test";
process.env.JWT_SECRET ||= "b2b-test-secret";
process.env.CONSUMER_JWT_SECRET ||= "consumer-distinct-test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: visaScoreRouter, buildScoreBrief, SENSITIVE_ANSWER_KEYS } =
  await import("./public.visaScore.js");
const { default: Consumer } = await import("../models/Consumer.js");
const { default: VisaScoreAssessment } = await import("../models/VisaScoreAssessment.js");
const { default: Ticket } = await import("../models/Ticket.js");
const { default: VisaScoreLead } = await import("../models/VisaScoreLead.js");
const { default: TicketMessage } = await import("../models/TicketMessage.js");
const { visaScoreLeadLimiter } = await import("../middleware/rateLimit.js");
const { VISA_SCORE_RULESET: R } = await import("../config/visaScoreRuleset.js");
const { computeVisaProfileScore } = await import("../services/visaProfileScore.js");

const app = express();
app.use(express.json());
app.use("/api/public", visaScoreRouter);

/** The REAL shipped limiter (15 min / 5 per IP), reset between tests for
 *  the reason public.visa.test.ts records: its counter is process-global
 *  and every supertest request arrives from the same loopback address, so
 *  without this the fifth test onward would 429. Its own enforcement is
 *  proven explicitly in the rate-limit block below. */
async function resetRateLimiter() {
  const anyLimiter = visaScoreLeadLimiter as any;
  for (const key of ["::ffff:127.0.0.1", "127.0.0.1", "::1"]) {
    await anyLimiter.resetKey?.(key);
  }
}

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    Consumer.deleteMany({}),
    Ticket.deleteMany({}),
    TicketMessage.deleteMany({}),
    VisaScoreAssessment.deleteMany({}),
    VisaScoreLead.deleteMany({}),
  ]);
  await resetRateLimiter();
});

/* ── The assessment used throughout ───────────────────────────────────
 * A DELIBERATELY WEAK applicant, and deliberately a disclosing one:
 *
 *   travel: 1      not 0 — option 0 is the first-timer trigger, which makes
 *                  the server SKIP the compliance question entirely. The
 *                  DPDP assertions would then pass for the wrong reason.
 *   employment: 3  "Employed under 1 year" — the objection the brief exists
 *                  to surface.
 *   compliance: 3  "Deported / misrepresentation finding" — a hard stop.
 *   character: 3   "Custodial sentence 12 months or more" — a hard stop.
 */
const WEAK: Record<string, number> = {
  residence: 0, age: 2, travel: 1, purpose: 0, staylen: 1, companions: 1,
  family: 1, assets: 1, employment: 3, payer: 0, finproof: 1, refusals: 0,
  compliance: 3, character: 3,
};

/** A clean profile — nothing sensitive disclosed. */
const MODAL: Record<string, number> = { ...WEAK, employment: 1, compliance: 0, character: 0 };

/** Every string the two sensitive questions could contribute to a body. */
function sensitiveStrings(): string[] {
  const out: string[] = [];
  for (const id of SENSITIVE_ANSWER_KEYS) {
    const q = R.questions.find((x: any) => x.id === id)!;
    out.push(q.text, ...q.options.map((o: any) => o.label));
  }
  for (const hs of R.hardStops as any[]) {
    if (SENSITIVE_ANSWER_KEYS.includes(hs.question)) out.push(hs.message);
  }
  return out.filter((s) => typeof s === "string" && s.length > 0);
}

function leadBody(over: Record<string, unknown> = {}) {
  return {
    email: "lead@example.com",
    name: "Test Applicant",
    passport: "IN",
    destination: "US",
    answers: WEAK,
    submissionId: randomUUID(),
    ...over,
  };
}

const postLead = (body: unknown) =>
  request(app).post("/api/public/visa-score/lead").send(body as any);

/* ═══════════════════════════════════════════════════════════════════════
 * IT FILES A TICKET — through the shared service, in the shared queue
 * ═══════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════
 * THE LEAD ROW — what this door writes now
 * ═══════════════════════════════════════════════════════════════════════
 *
 * This describe used to be called "the ticket" and asserted that a
 * support case was filed. It no longer is, and that is the change these
 * tests now pin: a Visa Score check is a MARKETING signal, not a support
 * request, so it lands in models/VisaScoreLead and NOT in the agent
 * queue. The "no ticket" assertions below are the load-bearing half —
 * without them a future edit could quietly reinstate the old behaviour
 * and every other test here would still pass.
 */
describe("POST /visa-score/lead — the lead row", () => {
  it("writes exactly one score-lead row and NO support ticket", async () => {
    const res = await postLead(leadBody());

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.outcome).toBe("filed");

    /* THE REGRESSION GUARD. The agent queue must stay empty: this door
     * filed into it for a whole release and must never do so again. */
    expect(await Ticket.countDocuments({})).toBe(0);
    expect(await TicketMessage.countDocuments({})).toBe(0);
    expect(res.body.ticketRef).toBeUndefined();

    const rows = await VisaScoreLead.find({}).lean();
    expect(rows).toHaveLength(1);

    const row: any = rows[0];
    expect(row.email).toBe("lead@example.com");
    expect(row.name).toBe("Test Applicant");
    expect(row.destinationIso2).toBe("US");
    expect(typeof row.destinationName).toBe("string");
    expect(typeof row.score).toBe("number");
    expect(row.checkCount).toBe(1);
  });

  it("stamps the consent basis and the disclosure timestamp", async () => {
    await postLead(leadBody());
    const row: any = await VisaScoreLead.findOne({}).lean();

    /* The row exists because a disclosure was on screen when the address
     * was typed. Storing WHICH disclosure is what stops a later copy
     * change retroactively re-characterising rows captured under the
     * old wording. */
    expect(row.consentBasis).toBe("GATE_DISCLOSURE_V1");
    expect(row.disclosureShownAt).toBeTruthy();
  });

  it("upserts on (email, destination): a retry is one lead that checked twice", async () => {
    const body = leadBody();

    const first = await postLead(body);
    const second = await postLead(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    /* ONE row, not two — the collection is keyed so a re-check cannot
     * inflate the sheet. The re-check is not lost: checkCount carries
     * it, which is the number adoption actually wants. */
    expect(await VisaScoreLead.countDocuments({})).toBe(1);
    const row: any = await VisaScoreLead.findOne({}).lean();
    expect(row.checkCount).toBe(2);

    // And still no ticket, on either pass.
    expect(await Ticket.countDocuments({})).toBe(0);
  });

  it("keeps first-touch attribution and firstCheckedAt across a re-check", async () => {
    await postLead(leadBody({ utm: { utm_source: "google" } }));
    const before: any = await VisaScoreLead.findOne({}).lean();

    // A later, untagged visit must not erase the campaign that introduced
    // them — the same rule VisaD2CLead applies to its own attribution.
    await postLead(leadBody({ submissionId: randomUUID() }));
    const after: any = await VisaScoreLead.findOne({}).lean();

    expect(after.utm.source).toBe("google");
    expect(new Date(after.firstCheckedAt).getTime()).toBe(
      new Date(before.firstCheckedAt).getTime(),
    );
    expect(new Date(after.lastCheckedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before.lastCheckedAt).getTime(),
    );
  });

  it("stores the RESULT and never the answers", async () => {
    await postLead(leadBody());
    const row: any = await VisaScoreLead.findOne({}).lean();

    /* DPDP §12.7 at the schema level: there is no answers path on this
     * collection, so the sensitive replies cannot be here even by
     * accident. Asserted against the serialised row so a future field
     * addition that smuggles them in fails. */
    const serialised = JSON.stringify(row);
    for (const needle of sensitiveStrings()) {
      expect(serialised).not.toContain(needle);
    }
    expect(row.answers).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * THE OPS BRIEF — buildScoreBrief(), exercised directly
 * ═══════════════════════════════════════════════════════════════════════
 *
 * These used to read the brief out of the ticket message body. There is
 * no ticket any more, so they call the builder instead. THE FUNCTION NOW
 * HAS NO PRODUCTION CALLER — it is kept because the brief is what an ops
 * "call this lead" view would render off the sheet, and because its
 * sensitive-factor stripping (asserted under DPDP below) is the rule any
 * such view has to inherit. If that view is never built, the function and
 * this describe should go together; leaving it half-alive is the worse
 * outcome.
 */
describe("buildScoreBrief — the ops brief", () => {
  function brief(answers: Record<string, number>): string {
    return buildScoreBrief({
      result: computeVisaProfileScore({
        passportIso2: "IN",
        destinationIso2: "US",
        answers,
        mode: R.baseRate.defaultMode,
        generatedAt: new Date().toISOString(),
      }),
      scoreMode: "score",
      destinationName: "United States",
      destinationIso2: "US",
      mode: R.baseRate.defaultMode,
    });
  }

  it("names the destination, the score and the band", async () => {
    const text = brief(MODAL);

    // The route, spelled out rather than left as an iso2 an agent decodes.
    expect(text).toContain("United States");
    expect(text).toContain("(US)");

    /* The number in the brief is the SERVER's, recomputed from the answers
     * — so it is checked against the engine rather than against whatever a
     * client might have claimed. */
    const expected = computeVisaProfileScore({
      passportIso2: "IN",
      destinationIso2: "US",
      answers: MODAL,
      mode: R.baseRate.defaultMode,
      generatedAt: new Date().toISOString(),
    });
    expect(text).toContain(`Score ${expected.score}`);
    expect(text).toContain(`Band: ${expected.band!.name}`);
  });

  it("surfaces the weak factors — the objections, on the first screen", async () => {
    const text = brief(MODAL);

    expect(text).toContain("HOLDING THEM BACK");

    const expected = computeVisaProfileScore({
      passportIso2: "IN",
      destinationIso2: "US",
      answers: MODAL,
      mode: R.baseRate.defaultMode,
      generatedAt: new Date().toISOString(),
    });
    const nonSensitive = expected.factors.holdingBack.filter(
      (f) => !SENSITIVE_ANSWER_KEYS.includes(f.questionId),
    );
    // The premise of the assertion — if this profile stopped having weak
    // factors the test below would pass vacuously.
    expect(nonSensitive.length).toBeGreaterThan(0);

    for (const f of nonSensitive.slice(0, 6)) {
      expect(text).toContain(f.questionText);
      expect(text).toContain(f.answerLabel);
      // The consular rule, so the desk can quote it back.
      expect(text).toContain(f.cite);
    }
  });

  it("prints the corridor rate as a percentage, not as the raw probability", async () => {
    const text = brief(MODAL);

    /* build.baseRate is a PROBABILITY (0..1) — the engine's scale
     * throughout. Rendering it raw put "0.7333%" in front of an agent,
     * which reads as a corridor nobody clears. Found on the local run
     * against the dev database, before review. */
    const line = text.split("\n").find((l) => l.startsWith("Corridor approval rate"))!;
    expect(line).toBeTruthy();
    expect(line).not.toMatch(/rate 0\.\d/);

    const pct = Number(line.match(/rate ([\d.]+)%/)![1]);
    expect(pct).toBeGreaterThan(1);
    expect(pct).toBeLessThanOrEqual(99);
  });

  it("is built entirely server-side — a client-claimed score never appears", async () => {
    /* The builder takes a typed VisaScoreResult, so injection can only be
     * attempted at the DOOR. Asserted there instead: every one of these is
     * a field a caller might hope to push into a sheet ops will act on,
     * and none of them is read by the endpoint. */
    await postLead(
      leadBody({
        answers: MODAL,
        score: 900,
        band: "Exceptional",
        factors: { holdingBack: [{ questionText: "INJECTED", answerLabel: "INJECTED" }] },
        message: "INJECTED FREE TEXT",
      }),
    );

    const row: any = await VisaScoreLead.findOne({}).lean();
    const expected = computeVisaProfileScore({
      passportIso2: "IN",
      destinationIso2: "US",
      answers: MODAL,
      mode: R.baseRate.defaultMode,
      generatedAt: new Date().toISOString(),
    });

    expect(row.score).toBe(expected.score);
    expect(row.score).not.toBe(900);
    expect(row.band).toBe(expected.band!.name);
    expect(JSON.stringify(row)).not.toContain("INJECTED");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * DPDP §12.7 — THE SENSITIVE ANSWERS NEVER REACH THE QUEUE OR THE DB
 * ═══════════════════════════════════════════════════════════════════════ */

describe("POST /visa-score/lead — DPDP", () => {
  it("writes nothing about the compliance or character answers, anywhere", async () => {
    const res = await postLead(leadBody({ answers: WEAK }));
    expect(res.status).toBe(201);

    /* THE PREMISE FIRST. If the engine stopped producing sensitive factors
     * for these answers, every assertion below would pass while proving
     * nothing — so assert that the material this test is guarding against
     * genuinely exists in the engine's output. */
    const engine = computeVisaProfileScore({
      passportIso2: "IN",
      destinationIso2: "US",
      answers: WEAK,
      mode: R.baseRate.defaultMode,
      generatedAt: new Date().toISOString(),
    });
    const sensitiveFactors = [...engine.factors.holdingBack, ...engine.factors.helping].filter(
      (f) => SENSITIVE_ANSWER_KEYS.includes(f.questionId),
    );
    const sensitiveFlags = engine.flags.filter((f) =>
      SENSITIVE_ANSWER_KEYS.includes(f.questionId),
    );
    expect(sensitiveFactors.length + sensitiveFlags.length).toBeGreaterThan(0);
    expect(engine.build.capped).toBeTruthy();

    /* EVERYTHING PERSISTED, serialised whole — not just the body. A field
     * added to either document by a later edit is covered by this without
     * anyone remembering to extend the test. */
    const persisted = JSON.stringify([
      await Ticket.find({}).lean(),
      await TicketMessage.find({}).lean(),
      await Consumer.find({}).lean(),
      /* THE COLLECTION THE WRITE ACTUALLY LANDS IN NOW. Without this line
       * the sweep reads three empty arrays and passes for the wrong
       * reason — the ticket it was written against no longer exists. */
      await VisaScoreLead.find({}).lean(),
      await VisaScoreAssessment.find({}).lean(),
    ]);

    // The premise for THAT, too: there is a row to search.
    expect(await VisaScoreLead.countDocuments({})).toBe(1);

    for (const needle of sensitiveStrings()) {
      expect(persisted).not.toContain(needle);
    }

    // The raw answer values, too — no "compliance: 3" in any shape.
    for (const key of SENSITIVE_ANSWER_KEYS) {
      expect(persisted).not.toContain(key);
    }
  });

  it("does not disclose the cap, which would name the sensitive fact by elimination", async () => {
    await postLead(leadBody({ answers: WEAK }));
    const persisted = JSON.stringify([
      await Ticket.find({}).lean(),
      await TicketMessage.find({}).lean(),
      await VisaScoreLead.find({}).lean(),
    ]);

    /* The ruleset's only two caps are the misrepresentation and custodial
     * hard stops, so "capped" is a one-bit disclosure of one of exactly
     * two sensitive facts. The band already tells ops the profile is weak;
     * WHY it is weak is the applicant's to tell. */
    expect(persisted.toLowerCase()).not.toContain("capped");
    for (const hs of R.hardStops as any[]) {
      if (SENSITIVE_ANSWER_KEYS.includes(hs.question)) expect(persisted).not.toContain(hs.code);
    }
  });

  it("buildScoreBrief drops sensitive factors and flags at the source", async () => {
    const result = computeVisaProfileScore({
      passportIso2: "IN",
      destinationIso2: "US",
      answers: WEAK,
      mode: R.baseRate.defaultMode,
      generatedAt: new Date().toISOString(),
    });

    const brief = buildScoreBrief({
      result,
      scoreMode: "score",
      destinationName: "United States",
      destinationIso2: "US",
      mode: R.baseRate.defaultMode,
    });

    for (const needle of sensitiveStrings()) {
      expect(brief).not.toContain(needle);
    }
    // And it is not simply empty — the non-sensitive brief survived.
    expect(brief).toContain("Visa Profile Score enquiry — United States (US)");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * THE ACCOUNT DECISION — a lead, not a signup
 * ═══════════════════════════════════════════════════════════════════════ */

describe("POST /visa-score/lead — identity", () => {
  it("creates NO consumer account for an unknown address", async () => {
    await postLead(leadBody());

    expect(await Consumer.countDocuments({})).toBe(0);

    /* The row records the address WITHOUT claiming it is an identity:
     * consumerId stays null and hadAccount stays false, which is what the
     * UNVERIFIED_LEAD_TAG used to say on the ticket. It is also the field
     * the sheet's "No account" column reads — the marketable population. */
    const row: any = await VisaScoreLead.findOne({}).lean();
    expect(row.consumerId).toBeNull();
    expect(row.hadAccount).toBe(false);
  });

  it("issues no session — the response carries no token and sets no cookie", async () => {
    const res = await postLead(leadBody());

    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.consumer).toBeUndefined();
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("links an EXISTING consumer to the row, matched case-insensitively", async () => {
    const consumer = await Consumer.create({
      email: "known@example.com",
      name: "Known Person",
      passwordHash: "x".repeat(20),
    });

    const res = await postLead(leadBody({ email: "Known@Example.com " }));
    expect(res.status).toBe(201);

    const row: any = await VisaScoreLead.findOne({}).lean();
    expect(String(row.consumerId)).toBe(String(consumer._id));
    expect(row.hadAccount).toBe(true);
    // The address is stored normalised, so the sheet and the erasure
    // cascade can both find it by a plain lowercase lookup.
    expect(row.email).toBe("known@example.com");

    // Still no account created — the existing one was found, not remade.
    expect(await Consumer.countDocuments({})).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * VALIDATION AND ABUSE CONTROL
 * ═══════════════════════════════════════════════════════════════════════ */

describe("POST /visa-score/lead — validation", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["a missing email", { email: undefined }],
    ["an email with no @", { email: "not-an-email" }],
    ["an email with no domain dot", { email: "someone@localhost" }],
    ["a blank email", { email: "   " }],
    ["a missing submissionId", { submissionId: undefined }],
    ["a submissionId that is not a uuid", { submissionId: "abc123" }],
    ["a malformed destination", { destination: "U" }],
    ["a malformed passport", { passport: "INDIA" }],
    ["an out-of-range answer index", { answers: { ...WEAK, employment: 99 } }],
    ["an unknown question id", { answers: { ...WEAK, nonsense: 0 } }],
    ["answers as an array", { answers: [1, 2] }],
  ];

  it.each(cases)("rejects %s with a 400 and writes nothing", async (_label, over) => {
    const res = await postLead(leadBody(over));

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(await Ticket.countDocuments({})).toBe(0);
    expect(await TicketMessage.countDocuments({})).toBe(0);
    expect(await VisaScoreLead.countDocuments({})).toBe(0);
  });

  it("never names a sensitive answer in a validation error", async () => {
    const res = await postLead(leadBody({ email: "bad", answers: { ...WEAK, character: 99 } }));

    expect(res.status).toBe(400);
    const serialised = JSON.stringify(res.body);
    for (const needle of sensitiveStrings()) {
      expect(serialised).not.toContain(needle);
    }
  });
});

describe("POST /visa-score/lead — abuse control", () => {
  it("swallows a honeypot submission with a plausible success and no row", async () => {
    const res = await postLead(leadBody({ hpField: "https://spam.example" }));

    // A bot must not learn which field gave it away.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(await Ticket.countDocuments({})).toBe(0);
    expect(await VisaScoreLead.countDocuments({})).toBe(0);
    expect(await Consumer.countDocuments({})).toBe(0);
  });

  it("rate-limits at the shipped ceiling — a sixth attempt in the window is refused", async () => {
    for (let i = 0; i < 5; i += 1) {
      const ok = await postLead(leadBody());
      expect(ok.status).toBe(201);
    }

    const blocked = await postLead(leadBody());
    expect(blocked.status).toBe(429);

    /* The five accepted attempts all carry the SAME email and
     * destination, so they collapse into one row that counted five checks
     * — and the sixth left no trace at all, because the limiter refused
     * before the writer ran. */
    expect(await VisaScoreLead.countDocuments({})).toBe(1);
    const row: any = await VisaScoreLead.findOne({}).lean();
    expect(row.checkCount).toBe(5);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * PHASE C (b) — AN EMAIL WE RECOGNISE ALSO GETS THE ASSESSMENT
 * ═══════════════════════════════════════════════════════════════════════
 *
 * The account page links straight to the PUBLIC calculator, so the
 * commonest way an account holder assesses is signed out: they reach the
 * gate, type the address their account already uses, and unlock. Before
 * this, their case was filed against their account and the assessment it
 * was about was discarded — leaving /account/visa-score empty for someone
 * who had just done the work.
 *
 * The fork is the one the ticket already used. Nothing changes for an
 * address we do not know.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("lead — Phase C (b): persist when the email matches an account", () => {
  it("a MATCHING email gets an assessment row, source 'gate'", async () => {
    const consumer = await Consumer.create({
      email: "known@example.com",
      name: "Known Person",
      passwordHash: "x".repeat(20),
    });

    const res = await postLead(leadBody({ email: "Known@Example.com " }));
    expect(res.status).toBe(201);

    const rows = await VisaScoreAssessment.find({ consumerId: consumer._id }).lean();
    expect(rows).toHaveLength(1);
    const row: any = rows[0];
    expect(row.source).toBe("gate");
    expect(row.destination).toBe("US");
    expect(typeof row.score).toBe("number");
  });

  it("a NON-matching email writes NO assessment — today's flow, unchanged", async () => {
    const res = await postLead(leadBody({ email: "stranger@example.com" }));
    expect(res.status).toBe(201);

    // The lead row is still written — the anonymous funnel is untouched.
    expect(await VisaScoreLead.countDocuments({})).toBe(1);
    // But nothing is persisted to any account, because there is no account.
    expect(await VisaScoreAssessment.countDocuments({})).toBe(0);
  });

  it("the persisted score is RECOMPUTED, not taken from the request", async () => {
    const consumer = await Consumer.create({
      email: "known2@example.com", name: "K2", passwordHash: "x".repeat(20),
    });
    const expected = computeVisaProfileScore({
      passportIso2: "IN", destinationIso2: "US", answers: WEAK as any,
      generatedAt: new Date().toISOString(),
    });

    await postLead(leadBody({ email: "known2@example.com", score: 870, band: { name: "Perfect" } }));

    const row: any = await VisaScoreAssessment.findOne({ consumerId: consumer._id }).lean();
    expect(row.score).toBe(expected.score);
    expect(row.score).not.toBe(870);
    expect(row.band?.name).not.toBe("Perfect");
  });

  it("stores NO raw answers — the sensitive pair included", async () => {
    const consumer = await Consumer.create({
      email: "known3@example.com", name: "K3", passwordHash: "x".repeat(20),
    });
    await postLead(leadBody({ email: "known3@example.com" }));

    const row: any = await VisaScoreAssessment.findOne({ consumerId: consumer._id }).lean();
    expect(row.answers).toBeUndefined();
    expect(JSON.stringify(row)).not.toMatch(/"answers"|"responses"/);
    const ids = [...(row.factors?.helping ?? []), ...(row.factors?.holdingBack ?? [])]
      .map((f: any) => f.questionId);
    expect(ids).not.toContain("compliance");
    expect(ids).not.toContain("character");
  });

  it("a persistence failure does NOT break the unlock — the breakdown is what they waited for", async () => {
    /* The assessment is a convenience, not a precondition. With the ticket
     * gone, the thing the reader is actually waiting for is the 201 that
     * opens their breakdown — so that is what this pins: the door still
     * succeeds when no assessment is written (the non-matching branch
     * above proves the same code path completes without one). */
    const res = await postLead(leadBody({ email: "nobody@example.com" }));
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.outcome).toBe("filed");
  });
});
