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
//   1. THE LEAD LANDS AS A TICKET, through services/consumerSupport.ts,
//      with an ops brief the visa desk can act on — destination, score,
//      band, and the FACTORS HOLDING THE APPLICANT BACK.
//   2. THE SENSITIVE ANSWERS NEVER GET THERE. compliance and character are
//      sensitive personal data under DPDP §12.7. They are answered in the
//      requests below at their most disclosing options, and every
//      persisted document is then searched for any trace of them — the
//      question text, the option label, the hard-stop message and the cap
//      itself. Real documents on a real (in-memory) server, never
//      fixtures: a literal object would prove nothing about what was
//      actually written.
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

const { default: visaScoreRouter, buildScoreBrief, SCORE_LEAD_TAG, SENSITIVE_ANSWER_KEYS } =
  await import("./public.visaScore.js");
const { default: Consumer } = await import("../models/Consumer.js");
const { default: Ticket } = await import("../models/Ticket.js");
const { default: TicketMessage } = await import("../models/TicketMessage.js");
const {
  CONSUMER_SUPPORT_SUBJECTS,
  CONSUMER_SUPPORT_TAG,
  UNVERIFIED_LEAD_TAG,
} = await import("../services/consumerSupport.js");
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
  await Promise.all([Consumer.deleteMany({}), Ticket.deleteMany({}), TicketMessage.deleteMany({})]);
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

describe("POST /visa-score/lead — the ticket", () => {
  it("files exactly one ticket with a minted ref and its first inbound message", async () => {
    const res = await postLead(leadBody());

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.outcome).toBe("filed");
    expect(res.body.ticketRef).toBeTruthy();

    const tickets = await Ticket.find({}).lean();
    expect(tickets).toHaveLength(1);

    const ticket: any = tickets[0];
    // ticketRef is minted by the model's pre("save") hook — its presence is
    // the proof the case went through .create() and not some other writer.
    expect(ticket.ticketRef).toBe(res.body.ticketRef);
    expect(ticket.fromEmail).toBe("lead@example.com");
    expect(ticket.fromName).toBe("Test Applicant");
    expect(ticket.sourceChannel).toBe("WEB");

    const messages = await TicketMessage.find({ ticketId: ticket._id }).lean();
    expect(messages).toHaveLength(1);
    expect(messages[0].direction).toBe("INBOUND");
  });

  it("uses an allowlisted subject and carries the channel as a tag", async () => {
    await postLead(leadBody());
    const ticket: any = await Ticket.findOne({}).lean();

    /* The subject is NOT a new one invented for this door — the allowlist
     * in consumerSupport.ts is what a consumer picks from in
     * /account/support and this endpoint does not get to widen it. */
    expect(CONSUMER_SUPPORT_SUBJECTS).toContain(ticket.subject);
    expect(ticket.subject).toBe("Visa application help");

    // The channel rides on tags, which is what ops filter on.
    expect(ticket.tags).toContain(CONSUMER_SUPPORT_TAG);
    expect(ticket.tags).toContain(SCORE_LEAD_TAG);
  });

  it("dedupes on submissionId, so a retry files one ticket and not two", async () => {
    const body = leadBody();

    const first = await postLead(body);
    const second = await postLead(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.outcome).toBe("duplicate");
    expect(second.body.ticketRef).toBe(first.body.ticketRef);
    expect(await Ticket.countDocuments({})).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * THE OPS BRIEF — what the visa desk actually opens
 * ═══════════════════════════════════════════════════════════════════════ */

describe("POST /visa-score/lead — the ops brief", () => {
  async function bodyText(): Promise<string> {
    const ticket: any = await Ticket.findOne({}).lean();
    const message: any = await TicketMessage.findOne({ ticketId: ticket._id }).lean();
    return String(message.bodyText);
  }

  it("names the destination, the score and the band", async () => {
    await postLead(leadBody({ answers: MODAL }));
    const text = await bodyText();

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
    await postLead(leadBody({ answers: MODAL }));
    const text = await bodyText();

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
    await postLead(leadBody({ answers: MODAL }));
    const text = await bodyText();

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
    /* Every one of these is a field a caller might hope to inject into an
     * ops queue. None of them is read by the endpoint. */
    await postLead(
      leadBody({
        answers: MODAL,
        score: 900,
        band: "Exceptional",
        factors: { holdingBack: [{ questionText: "INJECTED", answerLabel: "INJECTED" }] },
        message: "INJECTED FREE TEXT",
      }),
    );
    const text = await bodyText();

    expect(text).not.toContain("INJECTED");
    expect(text).not.toContain("Score 900");
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
    ]);

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

    const ticket: any = await Ticket.findOne({}).lean();
    expect(ticket.consumerId).toBeNull();
    // Tagged, so an agent knows the address is a claim and not an identity.
    expect(ticket.tags).toContain(UNVERIFIED_LEAD_TAG);
  });

  it("issues no session — the response carries no token and sets no cookie", async () => {
    const res = await postLead(leadBody());

    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.consumer).toBeUndefined();
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("files against an EXISTING consumer, so the case shows on their support page", async () => {
    const consumer = await Consumer.create({
      email: "known@example.com",
      name: "Known Person",
      passwordHash: "x".repeat(20),
    });

    const res = await postLead(leadBody({ email: "Known@Example.com " }));
    expect(res.status).toBe(201);

    const ticket: any = await Ticket.findOne({}).lean();
    expect(String(ticket.consumerId)).toBe(String(consumer._id));
    // The identity came from the DATABASE, not from the request body.
    expect(ticket.fromEmail).toBe("known@example.com");
    expect(ticket.fromName).toBe("Known Person");
    expect(ticket.tags).not.toContain(UNVERIFIED_LEAD_TAG);

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
  it("swallows a honeypot submission with a plausible success and no ticket", async () => {
    const res = await postLead(leadBody({ hpField: "https://spam.example" }));

    // A bot must not learn which field gave it away.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(await Ticket.countDocuments({})).toBe(0);
    expect(await Consumer.countDocuments({})).toBe(0);
  });

  it("rate-limits at the shipped ceiling — a sixth attempt in the window is refused", async () => {
    for (let i = 0; i < 5; i += 1) {
      const ok = await postLead(leadBody());
      expect(ok.status).toBe(201);
    }

    const blocked = await postLead(leadBody());
    expect(blocked.status).toBe(429);

    // Five tickets, not six: the limiter refused before the writer ran.
    expect(await Ticket.countDocuments({})).toBe(5);
  });
});
