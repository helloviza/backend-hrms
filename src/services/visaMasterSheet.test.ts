// Coverage for the unified Master Sheet — against REAL collections on
// mongodb-memory-server, never literal fixtures.
//
// That is not a style preference here, it is the only way these assertions
// mean anything. Every claim under test is a claim about what MONGO does to
// STORED documents: whether $addToSet on a $$REMOVE'd field contributes a
// null, whether $max across a union picks the right rung, whether a $facet
// branch sees the filtered set. A literal fixture fed to a hand-rolled
// grouper would assert my mental model of the aggregation, which is exactly
// the thing that can be wrong.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/visa-master-sheet-test";
process.env.JWT_SECRET ||= "b2b-test-secret";
process.env.JWT_REFRESH_SECRET ||= "b2b-test-refresh";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: Consumer } = await import("../models/Consumer.js");
const { default: VisaD2CLead } = await import("../models/VisaD2CLead.js");
const { default: VisaScoreLead } = await import("../models/VisaScoreLead.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { holdsCapability } = await import("./capabilityProbe.js");
const { RUNG, rungForLead, rungLabel } = await import("../models/visaMasterSheetRungs.js");
const {
  runMasterSheet,
  buildMasterSheetPipeline,
  applyEmailSearch,
  applyPageDerivations,
  aggregationCapabilities,
  resetAggregationCapabilities,
  toCsv,
} = await import("./visaMasterSheet.js");
const { backfillVisaD2CLeadEmail } = await import(
  "../migrations/2026-09-10-backfill-visa-d2c-lead-email.js"
);

let mongod: MongoMemoryServer;

const WS = new mongoose.Types.ObjectId("d2c00000000000000000d2c1");

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  resetAggregationCapabilities();
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    Consumer.deleteMany({}),
    VisaD2CLead.deleteMany({}),
    VisaScoreLead.deleteMany({}),
    UserPermission.deleteMany({}),
  ]);
});

/* ── Fixture builders — every one PERSISTS ─────────────────────────── */

const EMPTY_UTM = { source: "", medium: "", campaign: "", content: "", term: "" };

async function makeConsumer(email: string, over: Record<string, any> = {}) {
  return Consumer.create({
    email,
    name: over.name ?? "Test Person",
    phone: over.phone ?? "+919876500000",
    createdAt: over.createdAt ?? new Date("2026-01-01T00:00:00Z"),
    ...over,
  });
}

async function makeScoreLead(email: string, iso2: string, over: Record<string, any> = {}) {
  return VisaScoreLead.create({
    email,
    name: over.name ?? null,
    destinationIso2: iso2,
    destinationName: over.destinationName ?? iso2,
    score: over.score ?? 700,
    band: over.band ?? "Good",
    firstCheckedAt: over.firstCheckedAt ?? new Date("2026-02-01T00:00:00Z"),
    lastCheckedAt: over.lastCheckedAt ?? new Date("2026-02-01T00:00:00Z"),
    utm: over.utm ?? EMPTY_UTM,
    ...over,
  });
}

async function makeLead(
  consumerId: mongoose.Types.ObjectId,
  email: string | undefined,
  iso2: string,
  over: Record<string, any> = {},
) {
  return VisaD2CLead.create({
    consumerId,
    ...(email ? { email } : {}),
    workspaceId: WS,
    destinationIso2: iso2,
    destinationName: over.destinationName ?? iso2,
    stage: over.stage ?? "DOC_SUBMISSION_IN_PROGRESS",
    status: over.status ?? "IN_PROGRESS",
    paymentStatus: over.paymentStatus ?? "PENDING",
    startedAt: over.startedAt ?? new Date("2026-03-01T00:00:00Z"),
    utm: over.utm ?? EMPTY_UTM,
    ...over,
  });
}

/** A staff caller with a persisted grant, as requirePermission would see it. */
async function makeStaff(modules: Record<string, { access: string; scope: string }>) {
  const userId = new mongoose.Types.ObjectId();
  await UserPermission.create({
    userId: String(userId),
    email: `staff-${userId}@plumtrips.com`,
    workspaceId: String(WS),
    universe: "STAFF",
    level: { code: "L6", name: "Admin", designation: "" },
    modules,
    grantedBy: "test",
    grantedAt: new Date(),
  });
  return { user: { _id: String(userId), roles: ["ADMIN"] } };
}

const FULL = { access: "FULL", scope: "ALL" };
const NONE = { access: "NONE", scope: "NONE" };

const UNMASKED = { canSeeContacts: true };
const MASKED = { canSeeContacts: false };

/* ═════════════════════════════════════════════════════════════════════
 * THE LADDER
 * ═════════════════════════════════════════════════════════════════════ */

describe("the furthest-progress ladder", () => {
  it("takes the MAX across corridors, not the latest — three funnels, one row", async () => {
    const c = await makeConsumer("max@example.com");
    await makeScoreLead("max@example.com", "AU");
    await makeLead(c._id as any, "max@example.com", "TH", { stage: "DOC_SUBMITTED" });
    // The PAID corridor is the oldest, so a "latest wins" bug reports rung 2.
    await makeLead(c._id as any, "max@example.com", "VN", {
      stage: "PAYMENT_DONE",
      paymentStatus: "PAID",
      status: "VISA_FEES_PAID",
      startedAt: new Date("2026-02-15T00:00:00Z"),
    });

    const { rows, total } = await runMasterSheet({}, UNMASKED);

    expect(total).toBe(1);
    expect(rows[0].rung).toBe(RUNG.VISA_FEES_PAID);
    expect(rows[0].rungLabel).toBe("Visa fees paid");
    expect(rows[0].furthest?.iso2).toBe("VN");
    expect(rows[0].scoreCount).toBe(1);
    expect(rows[0].applyCount).toBe(2);
  });

  it("redraws to rung 3 when a corridor stalls at payment above its doc stage", async () => {
    const c = await makeConsumer("stall@example.com");
    await makeLead(c._id as any, "stall@example.com", "TH", { stage: "DOC_SUBMITTED" });
    await makeLead(c._id as any, "stall@example.com", "AE", {
      stage: "PAYMENT_FAILED",
      paymentStatus: "FAILED",
    });

    const { rows } = await runMasterSheet({}, UNMASKED);

    expect(rows[0].rung).toBe(RUNG.PAYMENT_STALLED);
    expect(rows[0].rungLabel).toBe("Payment stalled");
    // The winner must be the corridor that JUSTIFIES the rung, not merely
    // the newest row — that is the whole claim the cell makes.
    expect(rows[0].furthest?.iso2).toBe("AE");
    expect(rows[0].furthest?.stage).toBe("PAYMENT_FAILED");
  });

  it("breaks winner ties deterministically (same rung, same instant -> iso2 asc)", async () => {
    const c = await makeConsumer("tie@example.com");
    const at = new Date("2026-04-01T00:00:00Z");
    await makeLead(c._id as any, "tie@example.com", "TH", {
      stage: "PAYMENT_DONE",
      paymentStatus: "PAID",
      startedAt: at,
      submittedAt: at,
    });
    await makeLead(c._id as any, "tie@example.com", "AE", {
      stage: "PAYMENT_DONE",
      paymentStatus: "PAID",
      startedAt: at,
      submittedAt: at,
    });

    const first = await runMasterSheet({}, UNMASKED);
    const second = await runMasterSheet({}, UNMASKED);

    expect(first.rows[0].furthest?.iso2).toBe("AE");
    expect(second.rows[0].furthest?.iso2).toBe(first.rows[0].furthest?.iso2);
  });

  it("agrees with rungForLead(), so the Mongo expression and the TS cannot drift", async () => {
    const cases = [
      { stage: "DOC_SUBMISSION_IN_PROGRESS", status: "IN_PROGRESS", paymentStatus: "PENDING" },
      { stage: "DOC_SUBMITTED", status: "IN_PROGRESS", paymentStatus: "PENDING" },
      { stage: "PAYMENT_FAILED", status: "IN_PROGRESS", paymentStatus: "FAILED" },
      { stage: "PAYMENT_DROPPED", status: "DROPPED", paymentStatus: "PENDING" },
      { stage: "PAYMENT_DONE", status: "VISA_FEES_PAID", paymentStatus: "PAID" },
      // The disagreeing-axes case: the fee is in but ops still says in-progress.
      { stage: "PAYMENT_DONE", status: "IN_PROGRESS", paymentStatus: "PAID" },
      // COMPLETED must NOT imply a high rung — it is the ops axis.
      { stage: "DOC_SUBMITTED", status: "COMPLETED", paymentStatus: "PENDING" },
    ] as const;

    for (const [i, c] of cases.entries()) {
      await VisaD2CLead.deleteMany({});
      await VisaScoreLead.deleteMany({});
      const consumer = await makeConsumer(`agree${i}@example.com`);
      await makeLead(consumer._id as any, `agree${i}@example.com`, "TH", c);

      const { rows } = await runMasterSheet({ rungMin: 0 }, UNMASKED);
      expect(rows[0].rung, JSON.stringify(c)).toBe(rungForLead(c as any));
      await Consumer.deleteMany({});
    }
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * CORRIDORS — including the null trap
 * ═════════════════════════════════════════════════════════════════════ */

describe("corridors", () => {
  it("counts the same corridor reached through BOTH funnels once", async () => {
    const c = await makeConsumer("both@example.com");
    await makeScoreLead("both@example.com", "AU");
    await makeLead(c._id as any, "both@example.com", "AU", { stage: "DOC_SUBMITTED" });

    const { rows } = await runMasterSheet({}, UNMASKED);

    expect(rows[0].corridors).toEqual(["AU"]);
    expect(rows[0].corridorCount).toBe(1);
    // ONE corridor, but THREE signals — registration, the check and the
    // application. The drill-down shows every one of them; only the
    // corridor SET collapses, which is exactly the distinction the sheet
    // has to keep straight.
    expect(rows[0].signals).toHaveLength(3);
    expect(rows[0].signals.map((s: any) => s.funnel).sort()).toEqual([
      "APPLY",
      "REGISTERED",
      "SCORE",
    ]);
  });

  it("gives a registered-only person ZERO corridors (the $$REMOVE trap)", async () => {
    await makeConsumer("idle@example.com");

    const { rows, total } = await runMasterSheet({}, UNMASKED);

    expect(total).toBe(1);
    expect(rows[0].rung).toBe(RUNG.REGISTERED);
    expect(rows[0].rungLabel).toBe("Registered");
    // If the consumer arm projected `iso2: null` instead of $$REMOVE, this
    // is 1 — a corridor they never touched, on a sheet built to count them.
    expect(rows[0].corridorCount).toBe(0);
    expect(rows[0].corridors).toEqual([]);
    expect(rows[0].furthest?.iso2 ?? null).toBeNull();
  });

  it("resolves registered-and-checked to rung 0 with first-seen at REGISTRATION", async () => {
    await makeConsumer("early@example.com", { createdAt: new Date("2026-01-05T00:00:00Z") });
    await makeScoreLead("early@example.com", "GB", {
      firstCheckedAt: new Date("2026-06-01T00:00:00Z"),
      lastCheckedAt: new Date("2026-06-02T00:00:00Z"),
    });

    const { rows, total } = await runMasterSheet({}, UNMASKED);

    expect(total).toBe(1);
    expect(rows[0].rung).toBe(RUNG.CHECKED_SCORE);
    // The registration is the earliest thing known about them, and the
    // consumer arm is the ONLY arm that carries it.
    expect(rows[0].firstSeen?.toISOString()).toBe("2026-01-05T00:00:00.000Z");
    expect(rows[0].lastActivity?.toISOString()).toBe("2026-06-02T00:00:00.000Z");
    expect(rows[0].corridorCount).toBe(1);
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * FIRST-TOUCH ATTRIBUTION
 * ═════════════════════════════════════════════════════════════════════ */

describe("first-touch UTM", () => {
  it("skips an EARLIER empty UTM and takes the earliest one that carries tags", async () => {
    const c = await makeConsumer("utm@example.com");
    // Chronologically first — and untagged. A naive $min-by-time picks this.
    await makeScoreLead("utm@example.com", "AU", {
      firstCheckedAt: new Date("2026-02-01T00:00:00Z"),
      utm: EMPTY_UTM,
    });
    await makeLead(c._id as any, "utm@example.com", "TH", {
      startedAt: new Date("2026-03-01T00:00:00Z"),
      utm: { source: "google", medium: "cpc", campaign: "visa-au", content: "", term: "" },
    });
    // Later still, and also tagged — must NOT win over the March one.
    await makeLead(c._id as any, "utm@example.com", "VN", {
      startedAt: new Date("2026-05-01T00:00:00Z"),
      utm: { source: "meta", medium: "paid", campaign: "later", content: "", term: "" },
    });

    const { rows } = await runMasterSheet({}, UNMASKED);

    expect(rows[0].firstTouchUtm?.source).toBe("google");
    expect(rows[0].firstTouchUtm?.campaign).toBe("visa-au");
  });

  it("reports null when nothing was ever tagged", async () => {
    await makeScoreLead("untagged@example.com", "AU");
    const { rows } = await runMasterSheet({}, UNMASKED);
    expect(rows[0].firstTouchUtm).toBeNull();
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * FILTERS, FACET, PAGING
 * ═════════════════════════════════════════════════════════════════════ */

describe("post-group filters and the facet", () => {
  async function threePeople() {
    await makeConsumer("idle@example.com");
    const checker = await makeConsumer("checker@example.com");
    await makeScoreLead("checker@example.com", "AU");
    const payer = await makeConsumer("payer@example.com");
    await makeLead(payer._id as any, "payer@example.com", "TH", {
      stage: "PAYMENT_DONE",
      paymentStatus: "PAID",
    });
    return { checker, payer };
  }

  it("filters on the PERSON's furthest rung, not on individual signals", async () => {
    await threePeople();

    const all = await runMasterSheet({}, UNMASKED);
    expect(all.total).toBe(3);

    const acted = await runMasterSheet({ rungMin: 0 }, UNMASKED);
    expect(acted.total).toBe(2);
    expect(acted.rows.map((r) => r.email).sort()).toEqual([
      "checker@example.com",
      "payer@example.com",
    ]);

    const paid = await runMasterSheet({ rungMin: RUNG.VISA_FEES_PAID }, UNMASKED);
    expect(paid.total).toBe(1);
    expect(paid.rows[0].email).toBe("payer@example.com");

    const registeredOnly = await runMasterSheet({ rungMax: RUNG.REGISTERED }, UNMASKED);
    expect(registeredOnly.total).toBe(1);
    expect(registeredOnly.rows[0].email).toBe("idle@example.com");
  });

  it("filters by corridor and by funnel", async () => {
    await threePeople();

    expect((await runMasterSheet({ destination: "au" }, UNMASKED)).total).toBe(1);
    expect((await runMasterSheet({ destination: "TH" }, UNMASKED)).total).toBe(1);
    expect((await runMasterSheet({ destination: "ZZ" }, UNMASKED)).total).toBe(0);

    expect((await runMasterSheet({ funnel: "SCORE" }, UNMASKED)).total).toBe(1);
    expect((await runMasterSheet({ funnel: "APPLY" }, UNMASKED)).total).toBe(1);
    expect((await runMasterSheet({ funnel: "REGISTERED" }, UNMASKED)).total).toBe(1);
  });

  it("omits the Consumer arm when the filter floor is rung >= 0", async () => {
    await threePeople();

    const withArm = await runMasterSheet({}, UNMASKED);
    expect(withArm.meta.consumerArmIncluded).toBe(true);

    const withoutArm = await runMasterSheet({ rungMin: 0 }, UNMASKED);
    expect(withoutArm.meta.consumerArmIncluded).toBe(false);
    // Skipping the arm must not change the ANSWER — only the cost. A
    // registered-only person cannot satisfy rung >= 0 either way.
    expect(withoutArm.total).toBe(2);
  });

  it("produces a funnel histogram that sums to the filtered row count", async () => {
    await threePeople();

    const all = await runMasterSheet({}, UNMASKED);
    expect(all.funnel.reduce((n, f) => n + f.count, 0)).toBe(all.total);
    expect(all.funnel.map((f) => f.rung).sort((a, b) => a - b)).toEqual([-1, 0, 4]);
    expect(all.funnel.find((f) => f.rung === -1)?.label).toBe("Registered");

    // And it must follow the FILTER, not the collection — the classic
    // $facet mistake is a branch that quietly sees everything.
    const acted = await runMasterSheet({ rungMin: 0 }, UNMASKED);
    expect(acted.funnel.reduce((n, f) => n + f.count, 0)).toBe(acted.total);
    expect(acted.funnel.some((f) => f.rung === -1)).toBe(false);
  });

  it("pages stably, with the email as the tiebreaker", async () => {
    for (let i = 0; i < 5; i += 1) {
      await makeScoreLead(`p${i}@example.com`, "AU", {
        lastCheckedAt: new Date("2026-02-01T00:00:00Z"), // identical, on purpose
      });
    }
    const p1 = await runMasterSheet({ page: 1, pageSize: 2 }, UNMASKED);
    const p2 = await runMasterSheet({ page: 2, pageSize: 2 }, UNMASKED);

    expect(p1.total).toBe(5);
    expect(p1.rows).toHaveLength(2);
    const seen = [...p1.rows, ...p2.rows].map((r) => r.email);
    expect(new Set(seen).size).toBe(4);
  });

  it("excludes lead rows with no email and reports them as legacy work", async () => {
    const c = await makeConsumer("legacy@example.com");
    // Inserted through the raw driver so the field is genuinely absent —
    // exactly the pre-backfill shape.
    await mongoose.connection.collection(VisaD2CLead.collection.name).insertOne({
      consumerId: c._id,
      workspaceId: WS,
      destinationIso2: "TH",
      destinationName: "Thailand",
      stage: "DOC_SUBMITTED",
      status: "IN_PROGRESS",
      paymentStatus: "PENDING",
      startedAt: new Date("2026-03-01T00:00:00Z"),
      utm: EMPTY_UTM,
    });

    const { rows, legacyUnkeyedLeads } = await runMasterSheet({}, UNMASKED);

    expect(legacyUnkeyedLeads).toBe(1);
    // The person is still on the sheet via their Consumer row, at rung -1 —
    // the unkeyable LEAD is what is excluded, not the human.
    expect(rows).toHaveLength(1);
    expect(rows[0].rung).toBe(RUNG.REGISTERED);
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * MASKING AND THE GRANT
 * ═════════════════════════════════════════════════════════════════════ */

describe("contact masking", () => {
  beforeEach(async () => {
    await makeConsumer("reveal@example.com", { name: "Ada Lovelace", phone: "+919876544417" });
    await makeScoreLead("reveal@example.com", "AU");
  });

  it("masks by default for a reader holding visaApplication at FULL", async () => {
    const req = await makeStaff({ visaApplication: FULL, consumerContactPII: NONE });
    expect(await holdsCapability(req, "consumerContactPII")).toBe(false);

    const { rows, contactsMasked } = await runMasterSheet({}, { canSeeContacts: false });

    expect(contactsMasked).toBe(true);
    expect(rows[0].email).toBe("r•••@example.com");
    expect(rows[0].phone).toBe("+91 •••••• 4417");
    // The NAME is not a contact channel and stays readable — the sheet has
    // to remain usable, and the grant is about reachability.
    expect(rows[0].name).toBe("Ada Lovelace");
  });

  it("unmasks for a reader granted consumerContactPII", async () => {
    const req = await makeStaff({ visaApplication: FULL, consumerContactPII: { access: "READ", scope: "ALL" } });
    expect(await holdsCapability(req, "consumerContactPII")).toBe(true);

    const { rows, contactsMasked } = await runMasterSheet({}, { canSeeContacts: true });
    expect(contactsMasked).toBe(false);
    expect(rows[0].email).toBe("reveal@example.com");
    expect(rows[0].phone).toBe("+919876544417");
  });

  it("unmasks for SUPERADMIN with no UserPermission row at all", async () => {
    const req = { user: { _id: String(new mongoose.Types.ObjectId()), roles: ["SUPERADMIN"] } };
    expect(await holdsCapability(req, "consumerContactPII")).toBe(true);
  });

  it("does NOT unmask a SUPERADMIN who is impersonating a demo user", async () => {
    const req = {
      user: { _id: String(new mongoose.Types.ObjectId()), roles: ["SUPERADMIN"], _demoImpersonation: true },
    };
    expect(await holdsCapability(req, "consumerContactPII")).toBe(false);
  });

  it("does not honour a SUSPENDED grant", async () => {
    const req = await makeStaff({ consumerContactPII: FULL });
    await UserPermission.updateOne({ userId: req.user._id }, { $set: { status: "suspended" } });
    expect(await holdsCapability(req, "consumerContactPII")).toBe(false);
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * THE SEARCH ORACLE
 * ═════════════════════════════════════════════════════════════════════ */

describe("search", () => {
  beforeEach(async () => {
    await makeConsumer("secret.person@example.com", { name: "Grace Hopper" });
    await makeScoreLead("secret.person@example.com", "AU", { destinationName: "Australia" });
    await makeConsumer("other@example.com", { name: "Someone Else" });
  });

  it("does NOT let a masked reader confirm an address through q", async () => {
    const masked = await runMasterSheet({ q: "secret.person@example.com" }, MASKED);
    // A hit here would turn the sheet into a membership oracle: type an
    // address, read the row count, recover exactly what the mask withholds.
    expect(masked.total).toBe(0);

    // The local part alone must not leak either.
    expect((await runMasterSheet({ q: "secret.person" }, MASKED)).total).toBe(0);
  });

  it("still searches name and destination for a masked reader", async () => {
    expect((await runMasterSheet({ q: "Grace" }, MASKED)).total).toBe(1);
    expect((await runMasterSheet({ q: "Australia" }, MASKED)).total).toBe(1);
    expect((await runMasterSheet({ q: "AU" }, MASKED)).total).toBe(1);
  });

  it("searches email for a reader entitled to read addresses", async () => {
    const unmasked = await runMasterSheet({ q: "secret.person@example.com" }, UNMASKED);
    expect(unmasked.total).toBe(1);
    expect(unmasked.rows[0].email).toBe("secret.person@example.com");
  });

  it("never even BUILDS an email clause for a masked reader", async () => {
    const caps = await aggregationCapabilities();
    const pipeline = buildMasterSheetPipeline({ q: "secret.person@example.com" }, caps);
    applyEmailSearch(pipeline, { q: "secret.person@example.com" }, MASKED);

    const stage = pipeline.find((s: any) => s?.$match?.$or);
    expect(stage).toBeTruthy();
    // Structural, not behavioural: prove the clause is absent from the
    // pipeline rather than only that it returned nothing this time.
    expect(JSON.stringify(stage.$match.$or)).not.toContain("_id");
  });

  it("treats a regex metacharacter in q as a literal", async () => {
    // ".*" must not become "match everything" — an unescaped q would return
    // every row and, for an unmasked reader, dump the whole contact list.
    expect((await runMasterSheet({ q: ".*" }, UNMASKED)).total).toBe(0);
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * EXPORT
 * ═════════════════════════════════════════════════════════════════════ */

describe("CSV export", () => {
  beforeEach(async () => {
    await makeConsumer("csv@example.com", { name: "Ada Lovelace", phone: "+919876544417" });
    await makeScoreLead("csv@example.com", "AU", { destinationName: "Australia" });
  });

  it("honours the grant — a masked run exports masked contacts", async () => {
    const { rows } = await runMasterSheet({}, MASKED);
    const csv = toCsv(rows);

    expect(csv).toContain("a•••@example.com".replace("a", "c"));
    expect(csv).not.toContain("csv@example.com");
    expect(csv).not.toContain("+919876544417");
    // The row is still USEFUL — that is the point of masking over refusing.
    expect(csv).toContain("Ada Lovelace");
    expect(csv).toContain("Australia");
  });

  it("exports full contacts for a granted reader", async () => {
    const { rows } = await runMasterSheet({}, UNMASKED);
    const csv = toCsv(rows);
    expect(csv).toContain("csv@example.com");
    expect(csv).toContain("+919876544417");
  });

  it("neutralises a formula-shaped value so a spreadsheet cannot execute it", async () => {
    await Consumer.updateOne({ email: "csv@example.com" }, { $set: { name: "=HYPERLINK(\"evil\")" } });
    const { rows } = await runMasterSheet({}, UNMASKED);
    const csv = toCsv(rows);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toMatch(/(^|,)"?=HYPERLINK/m);
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * THE NODE FALLBACK
 * ═════════════════════════════════════════════════════════════════════ */

describe("the $sortArray fallback", () => {
  it("computes the same winner and first-touch as the pipeline does", async () => {
    const c = await makeConsumer("fallback@example.com");
    await makeScoreLead("fallback@example.com", "AU", {
      firstCheckedAt: new Date("2026-02-01T00:00:00Z"),
      utm: EMPTY_UTM,
    });
    await makeLead(c._id as any, "fallback@example.com", "TH", {
      stage: "PAYMENT_DONE",
      paymentStatus: "PAID",
      startedAt: new Date("2026-03-01T00:00:00Z"),
      utm: { source: "google", medium: "cpc", campaign: "k", content: "", term: "" },
    });

    // What Mongo produced.
    const viaMongo = await runMasterSheet({}, UNMASKED);

    // The same grouped rows, WITHOUT the $set — then derived in Node.
    const caps = await aggregationCapabilities();
    const pipeline = buildMasterSheetPipeline({}, { hasSortArray: false });
    const [facet] = await VisaScoreLead.aggregate(pipeline).allowDiskUse(true);
    const derived = (facet?.rows ?? []).map(applyPageDerivations);

    expect(caps.hasSortArray).toBe(true); // the pipeline path really did run
    expect(derived[0].winner.iso2).toBe(viaMongo.rows[0].furthest?.iso2);
    expect(derived[0].winner.iso2).toBe("TH");
    expect(derived[0].firstTouchUtm.source).toBe("google");
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * THE BACKFILL (B2) — built now, run at deploy time
 * ═════════════════════════════════════════════════════════════════════ */

describe("VisaD2CLead.email backfill", () => {
  async function insertLegacyLead(consumerId: mongoose.Types.ObjectId, iso2: string) {
    const res = await mongoose.connection.collection(VisaD2CLead.collection.name).insertOne({
      consumerId,
      workspaceId: WS,
      destinationIso2: iso2,
      destinationName: iso2,
      stage: "DOC_SUBMITTED",
      status: "IN_PROGRESS",
      paymentStatus: "PENDING",
      startedAt: new Date("2026-03-01T00:00:00Z"),
      utm: EMPTY_UTM,
    });
    return res.insertedId;
  }

  it("dry run counts without writing", async () => {
    const c = await makeConsumer("bf@example.com");
    await insertLegacyLead(c._id as any, "TH");

    const summary = await backfillVisaD2CLeadEmail(true);

    expect(summary).toMatchObject({ scanned: 1, resolved: 1, backfilled: 0, unresolved: 0 });
    expect(await VisaD2CLead.countDocuments({ email: { $exists: false } })).toBe(1);
  });

  it("apply writes the consumer's address and is idempotent", async () => {
    const c = await makeConsumer("bf@example.com");
    await insertLegacyLead(c._id as any, "TH");

    const first = await backfillVisaD2CLeadEmail(false);
    expect(first).toMatchObject({ scanned: 1, resolved: 1, backfilled: 1, unresolved: 0 });

    const row = await VisaD2CLead.findOne({ destinationIso2: "TH" }).lean();
    expect((row as any).email).toBe("bf@example.com");

    // A second run finds nothing left to do — $exists is a true marker
    // because the field has no schema default.
    const second = await backfillVisaD2CLeadEmail(false);
    expect(second).toMatchObject({ scanned: 0, resolved: 0, backfilled: 0, unresolved: 0 });
  });

  it("leaves an unresolvable row untouched rather than writing null", async () => {
    // A consumerId pointing at nobody — an erased consumer.
    await insertLegacyLead(new mongoose.Types.ObjectId(), "AE");

    const summary = await backfillVisaD2CLeadEmail(false);

    expect(summary).toMatchObject({ scanned: 1, resolved: 0, backfilled: 0, unresolved: 1 });
    // Still $exists:false, so a LATER run (after the consumer is restored,
    // or after a data fix) can still find it. A null would have hidden it.
    expect(await VisaD2CLead.countDocuments({ email: { $exists: false } })).toBe(1);
  });

  it("backfilled rows then appear on the sheet keyed to the right person", async () => {
    const c = await makeConsumer("bf@example.com");
    await insertLegacyLead(c._id as any, "TH");
    await makeScoreLead("bf@example.com", "AU");

    const before = await runMasterSheet({}, UNMASKED);
    expect(before.rows[0].rung).toBe(RUNG.CHECKED_SCORE);
    expect(before.legacyUnkeyedLeads).toBe(1);

    await backfillVisaD2CLeadEmail(false);

    const after = await runMasterSheet({}, UNMASKED);
    expect(after.total).toBe(1);
    expect(after.rows[0].rung).toBe(RUNG.DOCS_SUBMITTED);
    expect(after.rows[0].corridors.sort()).toEqual(["AU", "TH"]);
    expect(after.legacyUnkeyedLeads).toBe(0);
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * PRE-FLIGHT
 * ═════════════════════════════════════════════════════════════════════ */

describe("aggregation capabilities pre-flight", () => {
  it("reports a version and the two features the sheet depends on", async () => {
    const caps = await aggregationCapabilities(true);
    expect(caps.version).toMatch(/^\d+\.\d+/);
    expect(caps.hasUnionWith).toBe(true);
    expect(caps.hasSortArray).toBe(true);
  });

  it("labels every rung on the ladder", () => {
    expect(rungLabel(RUNG.REGISTERED)).toBe("Registered");
    expect(rungLabel(RUNG.CHECKED_SCORE)).toBe("Checked score");
    expect(rungLabel(RUNG.STARTED)).toBe("Started");
    expect(rungLabel(RUNG.DOCS_SUBMITTED)).toBe("Docs submitted");
    expect(rungLabel(RUNG.PAYMENT_STALLED)).toBe("Payment stalled");
    expect(rungLabel(RUNG.VISA_FEES_PAID)).toBe("Visa fees paid");
  });
});
