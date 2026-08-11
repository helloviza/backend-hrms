// Route-level coverage for routes/admin.visa.ts's GET /queue — the ops
// worklist.
//
// WHY THIS FILE USES A REAL DATABASE (and admin.visa.test.ts's queue tests
// moved here)
// --------------------------------------------------------------------
// As of 2026-08-12 the queue matches, bands, sorts and paginates IN THE
// DATABASE — one $match/$addFields/$switch/$sort/$skip/$limit pipeline over
// fields denormalised onto VisaApplication. The rest of the visa suite backs
// its models with hand-rolled in-memory collections, and that approach
// structurally cannot test this route any more: an aggregation emulator
// written by the same hand as the pipeline would agree with the pipeline by
// construction and prove nothing.
//
// Concretely, it would hide the exact trap this pipeline is written to avoid:
// in BSON collation `null` sorts BELOW every date, so a null
// processingDeadlineAt satisfies `{$lt: now}` and a case with NO travel date
// would be banded AT-RISK purely for having no date. Only a real MongoDB
// shows that. Same for `$sort` on a boolean (false before true), for
// `{outcome: null}` matching missing fields, and for whether $skip/$limit
// actually bound the work.
//
// So: mongodb-memory-server, real models, real router. requirePermission is
// NOT mocked (UserPermission is, to control access per test) — same posture
// as admin.visa.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

// The router mounts requireAuth itself; the test app injects req.user
// directly, same as admin.visa.test.ts.
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

// requirePermission itself is NOT mocked — only the record it reads, so the
// READ gate on this route is genuinely exercised.
let permissionRecord: any = null;
vi.mock("../models/UserPermission.js", () => ({
  UserPermission: {
    findOne: (_f: any) => ({ lean: () => Promise.resolve(permissionRecord) }),
    find: (_f: any) => ({ select: () => ({ lean: () => Promise.resolve([]) }) }),
  },
  hasAccess: (actual: string, required: string) => {
    const order = ["NONE", "READ", "WRITE", "FULL"];
    return order.indexOf(actual) >= order.indexOf(required);
  },
}));

// The queue never calls these, but the router imports them at module load.
vi.mock("../services/visaBillingSync.js", () => ({
  syncVisaApplicationBilling: vi.fn().mockResolvedValue({ action: "noop" }),
  createVisaWorkStartBooking: vi.fn().mockResolvedValue({ action: "noop" }),
}));

import router from "./admin.visa.js";
import VisaApplication from "../models/VisaApplication.js";
import VisaRequest from "../models/VisaRequest.js";
import VisaDocument from "../models/VisaDocument.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import TravellerProfile from "../models/TravellerProfile.js";
import User from "../models/User.js";
import { assessProcessingRisk, computeProcessingDeadline } from "../utils/visaEta.js";

let mongod: MongoMemoryServer;
const CALLER_ID = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

function setAccess(access: "NONE" | "READ" | "WRITE" | "FULL" | null) {
  permissionRecord = access ? { modules: { visaApplication: { access } }, status: "active" } : null;
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(CALLER_ID), roles: ["OPS"], email: "concierge@plumtrips.com" };
    next();
  });
  app.use("/", router);
  return app;
}

const DAY = 86_400_000;
// Pinned so "days until travel" arithmetic in the fixtures is readable and
// never depends on when the suite runs. A Wednesday, so business-day maths
// below is easy to reason about.
const NOW = new Date("2026-08-12T00:00:00.000Z");

function daysFromNow(n: number): Date {
  return new Date(NOW.getTime() + n * DAY);
}

let workspaceId: mongoose.Types.ObjectId;

/**
 * Creates a real VisaRequest + VisaApplication pair, denormalising exactly
 * as routes/visa.ts's POST /requests does. Everything the queue reads is a
 * genuine persisted document, so schema defaults and casting are real.
 */
async function seedCase(opts: {
  travelInDays?: number | null; // null/undefined => no travel date at all
  etaMaxDays?: number | null;
  etaBasis?: "BUSINESS" | "CALENDAR";
  status?: string;
  outcome?: string | null;
  customerRespondedAt?: Date | null;
  destinationIso2?: string;
  ref?: string;
  travellerErasedAt?: Date | null;
  billingSyncSkippedAt?: Date | null;
  servicePartnerName?: string | null;
  assignedConciergeUserId?: mongoose.Types.ObjectId | null;
  assignedScreeningOfficerId?: mongoose.Types.ObjectId | null;
  workspaceId?: mongoose.Types.ObjectId;
}) {
  const ws = opts.workspaceId ?? workspaceId;
  const travelDateFrom = opts.travelInDays == null ? null : daysFromNow(opts.travelInDays);
  const destinationIso2 = opts.destinationIso2 ?? "FR";
  const etaMaxDays = opts.etaMaxDays === undefined ? 10 : opts.etaMaxDays;
  const etaBasis = opts.etaBasis ?? "CALENDAR";

  const traveller = await TravellerProfile.create({
    workspaceId: ws,
    travelerId: `T-${opts.ref ?? Math.random().toString(36).slice(2)}`,
    firstName: "Test",
    lastName: opts.ref ?? "Traveller",
    createdBy: CALLER_ID,
    source: "MANUAL",
  });

  const req = await VisaRequest.create({
    workspaceId: ws,
    raisedByUserId: CALLER_ID,
    destinationIso2,
    purpose: "BUSINESS",
    travelDateFrom,
    applicationIds: [],
  });

  const ruleSnapshot = {
    ruleId: new mongoose.Types.ObjectId(),
    capturedAt: NOW,
    destinationName: destinationIso2 === "FR" ? "France" : destinationIso2,
    isSchengen: destinationIso2 === "FR",
    productClass: "VISA",
    visaCategory: "STICKER",
    purpose: "BUSINESS",
    entryType: "SINGLE",
    serviceTier: "STANDARD",
    appointmentRequired: false,
    biometricsRequired: false,
    documentRequirements: [],
    ...(etaMaxDays == null ? {} : { etaMaxDays, etaBasis }),
  };

  const app = await VisaApplication.create({
    workspaceId: ws,
    requestId: req._id,
    travellerProfileId: traveller._id,
    ruleSnapshot,
    indicativeCostSnapshot: { displayMode: "ITEMISED", totalInr: 1000 },
    status: opts.status ?? "submitted",
    outcome: opts.outcome ?? undefined,
    customerRespondedAt: opts.customerRespondedAt ?? null,
    travellerErasedAt: opts.travellerErasedAt ?? null,
    billingSyncSkippedAt: opts.billingSyncSkippedAt ?? null,
    servicePartnerName: opts.servicePartnerName ?? null,
    assignedConciergeUserId: opts.assignedConciergeUserId ?? null,
    assignedScreeningOfficerId: opts.assignedScreeningOfficerId ?? null,
    // The denormalised trio, written exactly as POST /requests writes it.
    travelDateFrom,
    destinationIso2,
    processingDeadlineAt: computeProcessingDeadline(travelDateFrom, etaMaxDays, etaBasis),
  });

  await VisaRequest.findByIdAndUpdate(req._id, { $set: { applicationIds: [app._id] } });
  return { request: req, application: app, ref: opts.ref };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setAccess("READ");
  await Promise.all([
    VisaApplication.deleteMany({}),
    VisaRequest.deleteMany({}),
    VisaDocument.deleteMany({}),
    CustomerWorkspace.deleteMany({}),
    TravellerProfile.deleteMany({}),
    User.deleteMany({}),
  ]);
  const ws = await CustomerWorkspace.create({ companyName: "Acme Corp India", customerId: "acme" });
  workspaceId = ws._id as mongoose.Types.ObjectId;
});

afterAll(() => {
  vi.useRealTimers();
});

async function queue(qs = ""): Promise<any> {
  const res = await request(makeApp()).get(`/queue${qs}`);
  expect(res.status).toBe(200);
  return res.body;
}

/* ═══════════════════════════════════════════════════════════════════════
 * 1. PRIORITY BANDS — the new sort
 * ═══════════════════════════════════════════════════════════════════════ */

describe("GET /queue — priority bands (At-Risk > Responded > Awaiting > Proximity)", () => {
  it("orders the four bands, and At-Risk outranks a responded action_required row", async () => {
    // Band 4: plenty of runway, nothing outstanding.
    await seedCase({ ref: "calm", travelInDays: 200, status: "submitted" });
    // Band 3: awaiting the customer.
    await seedCase({ ref: "awaiting", travelInDays: 180, status: "action_required" });
    // Band 2: customer came back — we are the bottleneck.
    await seedCase({
      ref: "responded",
      travelInDays: 190,
      status: "action_required",
      customerRespondedAt: new Date(NOW.getTime() - DAY),
    });
    // Band 1: deadline already passed (travel in 2 days, needs 10).
    await seedCase({ ref: "atrisk", travelInDays: 2, status: "submitted", etaMaxDays: 10 });

    const body = await queue();
    const order = body.applications.map((a: any) => a.traveller.name.split(" ")[1]);
    expect(order).toEqual(["atrisk", "responded", "awaiting", "calm"]);
  });

  it("At-Risk preempts even an at-risk-free responded row — the deadline wins", async () => {
    await seedCase({
      ref: "responded",
      travelInDays: 300,
      status: "action_required",
      customerRespondedAt: new Date(NOW.getTime() - DAY),
    });
    await seedCase({ ref: "atrisk", travelInDays: 1, etaMaxDays: 10, status: "submitted" });

    const body = await queue();
    expect(body.applications[0].traveller.name).toContain("atrisk");
  });

  it("an action_required row that is ALSO at-risk lands in band 1, not band 2", async () => {
    await seedCase({
      ref: "responded",
      travelInDays: 300,
      status: "action_required",
      customerRespondedAt: new Date(NOW.getTime() - DAY),
    });
    await seedCase({ ref: "both", travelInDays: 1, etaMaxDays: 10, status: "action_required" });

    const body = await queue();
    expect(body.applications[0].traveller.name).toContain("both");
  });

  it("within a band, sooner travel sorts first", async () => {
    await seedCase({ ref: "later", travelInDays: 120, status: "submitted" });
    await seedCase({ ref: "sooner", travelInDays: 60, status: "submitted" });

    const body = await queue();
    const order = body.applications.map((a: any) => a.traveller.name.split(" ")[1]);
    expect(order).toEqual(["sooner", "later"]);
  });

  it("bands 2 and 3 keep their previous relative order (Phase 9f preserved, not collapsed)", async () => {
    // Neither is at-risk, so band 1 is empty and the old top-two ordering
    // must be exactly what it always was.
    await seedCase({ ref: "awaiting", travelInDays: 100, status: "action_required" });
    await seedCase({
      ref: "responded",
      travelInDays: 300,
      status: "action_required",
      customerRespondedAt: new Date(NOW.getTime() - DAY),
    });
    await seedCase({ ref: "plain", travelInDays: 50, status: "submitted" });

    const body = await queue();
    const order = body.applications.map((a: any) => a.traveller.name.split(" ")[1]);
    // responded above awaiting, despite travelling much later; both above
    // the non-action_required row, despite it travelling soonest.
    expect(order).toEqual(["responded", "awaiting", "plain"]);
  });

  it("a decided or closed case is never banded at-risk, however long its deadline has passed", async () => {
    // Both terminal rows have deadlines FURTHER in the past than the live
    // one, so if either were banded at-risk it would sort ahead of it.
    await seedCase({
      ref: "decided",
      travelInDays: -30,
      etaMaxDays: 10,
      status: "decision_received",
      outcome: "APPROVED",
    });
    await seedCase({ ref: "closedcase", travelInDays: -30, etaMaxDays: 10, status: "closed" });
    await seedCase({ ref: "live", travelInDays: 2, etaMaxDays: 10, status: "submitted" });

    const body = await queue();
    // Only the live case is at-risk — nothing left to risk on the other two.
    expect(body.applications[0].traveller.name).toContain("live");
    const terminal = body.applications.filter((a: any) => !a.traveller.name.includes("live"));
    expect(terminal.every((a: any) => a.risk === null)).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 2. DATELESS — unassessable, never "safe", never at-risk by absence
 * ═══════════════════════════════════════════════════════════════════════ */

describe("GET /queue — dateless cases are unassessable, not safe", () => {
  it("a case with no travel date is NEVER banded at-risk (the BSON null<date trap)", async () => {
    await seedCase({ ref: "dateless", travelInDays: null, status: "submitted" });
    await seedCase({ ref: "atrisk", travelInDays: 2, etaMaxDays: 10, status: "submitted" });

    const body = await queue();
    // If the pipeline's $ne-null guard were missing, `null < now` would be
    // TRUE in BSON and "dateless" would sort first.
    expect(body.applications[0].traveller.name).toContain("atrisk");
  });

  it("sorts last within its band, behind every dated row", async () => {
    await seedCase({ ref: "dateless", travelInDays: null, status: "submitted" });
    await seedCase({ ref: "faraway", travelInDays: 900, status: "submitted" });

    const body = await queue();
    const order = body.applications.map((a: any) => a.traveller.name.split(" ")[1]);
    expect(order).toEqual(["faraway", "dateless"]);
  });

  it("is flagged travelDateMissing, and its risk is null — not a computed atRisk:false", async () => {
    await seedCase({ ref: "dateless", travelInDays: null, status: "submitted" });
    const body = await queue();
    const row = body.applications[0];
    expect(row.travelDateMissing).toBe(true);
    // null means "nothing to assess"; atRisk:false would be a claim we have
    // no evidence for.
    expect(row.risk).toBeNull();
  });

  it("a dated row is not flagged", async () => {
    await seedCase({ ref: "dated", travelInDays: 30, status: "submitted" });
    const body = await queue();
    expect(body.applications[0].travelDateMissing).toBe(false);
    expect(body.applications[0].risk).not.toBeNull();
  });

  it("a snapshot with no etaMaxDays is unassessable too — never at-risk by absence", async () => {
    // Travelling TOMORROW, but nothing says how long processing takes, so
    // there is no verdict to give. It must not enter band 1 — the genuinely
    // at-risk row (travelling later!) has to outrank it.
    await seedCase({ ref: "noeta", travelInDays: 1, etaMaxDays: null, status: "submitted" });
    await seedCase({ ref: "atrisk", travelInDays: 3, etaMaxDays: 10, status: "submitted" });

    const body = await queue();
    expect(body.applications[0].traveller.name).toContain("atrisk");

    const noeta = body.applications.find((a: any) => a.traveller.name.includes("noeta"));
    expect(noeta.risk).toBeNull();
    // It still has a travel date — it is the ETA that is missing, so this
    // is unassessable for a different reason than the dateless bucket.
    expect(noeta.travelDateMissing).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 3. THE ≤1-DAY BOUNDARY SHIFT — pinned, not a surprise
 * ═══════════════════════════════════════════════════════════════════════ */

describe("at-risk boundary — the deadline is authoritative (≤1-day shift, pinned)", () => {
  // assessProcessingRisk used to compute atRisk as `marginDays < 0` with
  // availableDays = Math.round((travel-now)/day). That put the CALENDAR flip
  // at travel-(etaMax-0.5) days — half a day LATER than the exact deadline.
  // The deadline is now THE definition, so a case flips to at-risk up to
  // ~12h earlier than it used to. This test records that difference rather
  // than letting someone rediscover it.
  it("EXACTLY enough runway is NOT at risk — the deadline day is still yours", () => {
    const travel = new Date("2026-08-22T12:00:00.000Z");
    const deadline = computeProcessingDeadline(travel, 10, "CALENDAR")!;

    // margin 0. Compared as raw instants this would flip to at-risk a
    // millisecond into the deadline day, which is not what "short by a day"
    // means — hence the day-granularity comparison.
    const atDeadline = assessProcessingRisk(travel, 10, "CALENDAR", deadline);
    expect(atDeadline!.marginDays).toBe(0);
    expect(atDeadline!.atRisk).toBe(false);

    // Still not at risk later the SAME day.
    const laterSameDay = new Date(deadline.getTime() + 6 * 3600_000);
    expect(assessProcessingRisk(travel, 10, "CALENDAR", laterSameDay)!.atRisk).toBe(false);
  });

  it("flips once the deadline DAY has passed", () => {
    const travel = new Date("2026-08-22T12:00:00.000Z");
    const deadline = computeProcessingDeadline(travel, 10, "CALENDAR")!;

    const nextDay = new Date(deadline.getTime() + DAY);
    const after = assessProcessingRisk(travel, 10, "CALENDAR", nextDay);
    expect(after!.atRisk).toBe(true);
    expect(after!.marginDays).toBe(-1);
  });

  it("the residual ≤1-day shift from the old Math.round rule, pinned", () => {
    // RECORDED DECISION. availableDays is Math.round()ed, so the OLD
    // `marginDays < 0` rule flipped at travel-(etaMax-0.5) days. The
    // deadline rule flips at the start of the day AFTER travel-etaMax days.
    // Those are not identical, and this is the window where they differ:
    // half a day into the deadline day, the old rule had already rounded
    // availableDays DOWN to 9 (margin -1 => at risk), while the deadline
    // rule still says the deadline day is yours.
    const travel = new Date("2026-08-22T00:00:00.000Z");
    const deadline = computeProcessingDeadline(travel, 10, "CALENDAR")!;
    const midDeadlineDay = new Date(deadline.getTime() + 13 * 3600_000);

    const assessed = assessProcessingRisk(travel, 10, "CALENDAR", midDeadlineDay)!;
    expect(assessed.marginDays).toBe(-1); // the OLD verdict would be: at risk
    expect(assessed.atRisk).toBe(false); // the NEW verdict: the day is still yours
  });

  it("BUSINESS basis walks back over weekends, so its deadline is earlier than calendar", () => {
    const travel = new Date("2026-08-24T00:00:00.000Z"); // a Monday
    const cal = computeProcessingDeadline(travel, 5, "CALENDAR")!;
    const bus = computeProcessingDeadline(travel, 5, "BUSINESS")!;
    expect(cal.toISOString()).toBe("2026-08-19T00:00:00.000Z");
    // 5 business days back from Mon 24th skips Sat/Sun → Mon 17th.
    expect(bus.toISOString()).toBe("2026-08-17T00:00:00.000Z");
    expect(bus.getTime()).toBeLessThan(cal.getTime());
  });

  it("an absent basis is treated as CALENDAR, the wider reading", () => {
    const travel = new Date("2026-08-24T00:00:00.000Z");
    expect(computeProcessingDeadline(travel, 5, undefined)!.toISOString()).toBe(
      computeProcessingDeadline(travel, 5, "CALENDAR")!.toISOString(),
    );
  });

  it("returns null — never a guessed deadline — with no travel date or no etaMaxDays", () => {
    expect(computeProcessingDeadline(null, 10, "CALENDAR")).toBeNull();
    expect(computeProcessingDeadline(new Date(), null, "CALENDAR")).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 4. FILTER PARITY — the query-side filters match the old in-memory result
 * ═══════════════════════════════════════════════════════════════════════ */

describe("GET /queue — filters (query-side, parity with the previous in-memory pass)", () => {
  it("GATE: excludes draft and pending_approval by default", async () => {
    await seedCase({ ref: "draftcase", travelInDays: 30, status: "draft" });
    await seedCase({ ref: "pending", travelInDays: 30, status: "pending_approval" });
    await seedCase({ ref: "live", travelInDays: 30, status: "submitted" });

    const body = await queue();
    expect(body.applications).toHaveLength(1);
    expect(body.applications[0].traveller.name).toContain("live");
  });

  it("GATE: refuses ?status=pending_approval — not one query param deep", async () => {
    const res = await request(makeApp()).get("/queue?status=pending_approval");
    expect(res.status).toBe(400);
  });

  it("GATE: ?status=draft still works — drafts are uninteresting, not withheld", async () => {
    await seedCase({ ref: "draftcase", travelInDays: 30, status: "draft" });
    const body = await queue("?status=draft");
    expect(body.applications).toHaveLength(1);
  });

  it("?destination= narrows on the denormalised copy", async () => {
    await seedCase({ ref: "fr", travelInDays: 30, destinationIso2: "FR" });
    await seedCase({ ref: "gb", travelInDays: 30, destinationIso2: "GB" });

    const body = await queue("?destination=gb");
    expect(body.applications).toHaveLength(1);
    expect(body.applications[0].traveller.name).toContain("gb");
    expect(body.pagination.total).toBe(1);
  });

  it("?atRisk=true narrows to applications whose runway no longer fits etaMaxDays", async () => {
    await seedCase({ ref: "tight", travelInDays: 2, etaMaxDays: 10 });
    await seedCase({ ref: "roomy", travelInDays: 90, etaMaxDays: 10 });

    const body = await queue("?atRisk=true");
    expect(body.applications).toHaveLength(1);
    expect(body.applications[0].traveller.name).toContain("tight");
    expect(body.pagination.total).toBe(1);
  });

  it("?atRisk=true excludes decided, closed and draft rows even when their dates would flag", async () => {
    await seedCase({ ref: "decided", travelInDays: -5, etaMaxDays: 10, status: "decision_received", outcome: "APPROVED" });
    await seedCase({ ref: "closedcase", travelInDays: -5, etaMaxDays: 10, status: "closed" });
    await seedCase({ ref: "draftcase", travelInDays: -5, etaMaxDays: 10, status: "draft" });
    await seedCase({ ref: "live", travelInDays: -5, etaMaxDays: 10, status: "submitted" });

    const body = await queue("?atRisk=true");
    expect(body.applications).toHaveLength(1);
    expect(body.applications[0].traveller.name).toContain("live");
  });

  it("agrees with the row marker both ways: every risk.atRisk===true row appears under the filter, and only those", async () => {
    await seedCase({ ref: "a", travelInDays: 1, etaMaxDays: 10 });
    await seedCase({ ref: "b", travelInDays: 9, etaMaxDays: 10 });
    await seedCase({ ref: "c", travelInDays: 30, etaMaxDays: 10 });
    await seedCase({ ref: "d", travelInDays: null, etaMaxDays: 10 });
    await seedCase({ ref: "e", travelInDays: 5, etaMaxDays: 10, status: "closed" });

    const all = await queue("?limit=100");
    const markedAtRisk = all.applications
      .filter((r: any) => r.risk?.atRisk === true)
      .map((r: any) => r.id)
      .sort();

    const filtered = await queue("?atRisk=true&limit=100");
    const underFilter = filtered.applications.map((r: any) => r.id).sort();

    expect(underFilter).toEqual(markedAtRisk);
    expect(markedAtRisk.length).toBeGreaterThan(0);
  });

  it("?customerResponded composes with an explicit status filter rather than clobbering it", async () => {
    await seedCase({ ref: "respondedAR", status: "action_required", travelInDays: 30, customerRespondedAt: NOW });
    await seedCase({ ref: "quietAR", status: "action_required", travelInDays: 30 });
    await seedCase({ ref: "respondedSub", status: "submitted", travelInDays: 30, customerRespondedAt: NOW });

    const body = await queue("?status=action_required&customerResponded=true");
    expect(body.applications).toHaveLength(1);
    expect(body.applications[0].traveller.name).toContain("respondedAR");
  });

  it("?billingSyncSkipped=true composes with ?customerResponded=true without either clobbering the other", async () => {
    await seedCase({ ref: "both", travelInDays: 30, customerRespondedAt: NOW, billingSyncSkippedAt: NOW });
    await seedCase({ ref: "skippedonly", travelInDays: 30, billingSyncSkippedAt: NOW });
    await seedCase({ ref: "respondedonly", travelInDays: 30, customerRespondedAt: NOW });

    const body = await queue("?billingSyncSkipped=true&customerResponded=true");
    expect(body.applications).toHaveLength(1);
    expect(body.applications[0].traveller.name).toContain("both");
  });

  it("?atRisk=true composes with an explicit status filter", async () => {
    await seedCase({ ref: "arSub", travelInDays: 1, etaMaxDays: 10, status: "submitted" });
    await seedCase({ ref: "arReview", travelInDays: 1, etaMaxDays: 10, status: "docs_under_review" });

    const body = await queue("?status=docs_under_review&atRisk=true");
    expect(body.applications).toHaveLength(1);
    expect(body.applications[0].traveller.name).toContain("arReview");
  });

  it("?destination= composes with ?atRisk=true", async () => {
    await seedCase({ ref: "frRisk", travelInDays: 1, etaMaxDays: 10, destinationIso2: "FR" });
    await seedCase({ ref: "gbRisk", travelInDays: 1, etaMaxDays: 10, destinationIso2: "GB" });

    const body = await queue("?destination=FR&atRisk=true");
    expect(body.applications).toHaveLength(1);
    expect(body.applications[0].traveller.name).toContain("frRisk");
  });

  it("excludes an erased-traveller application by default, and ?includeErased=true surfaces it marked", async () => {
    await seedCase({ ref: "erased", travelInDays: 30, travellerErasedAt: NOW });
    await seedCase({ ref: "live", travelInDays: 30 });

    const def = await queue();
    expect(def.applications).toHaveLength(1);
    expect(def.applications[0].traveller.name).toContain("live");

    const inc = await queue("?includeErased=true");
    expect(inc.applications).toHaveLength(2);
    expect(inc.applications.some((a: any) => a.travellerErasedAt)).toBe(true);
  });

  it("?servicePartnerName= narrows to an exact match", async () => {
    await seedCase({ ref: "vfs", travelInDays: 30, servicePartnerName: "VFS Global Delhi" });
    await seedCase({ ref: "bls", travelInDays: 30, servicePartnerName: "BLS Mumbai" });

    const body = await queue("?servicePartnerName=VFS%20Global%20Delhi");
    expect(body.applications).toHaveLength(1);
    expect(body.applications[0].traveller.name).toContain("vfs");
  });

  it("assignment filters: by concierge, by screening officer, and ?unassigned=true", async () => {
    const concierge = new mongoose.Types.ObjectId();
    const officer = new mongoose.Types.ObjectId();
    await seedCase({ ref: "mineC", travelInDays: 30, assignedConciergeUserId: concierge });
    await seedCase({ ref: "mineS", travelInDays: 30, assignedScreeningOfficerId: officer });
    await seedCase({ ref: "nobody", travelInDays: 30 });

    const byC = await queue(`?assignedConciergeUserId=${concierge}`);
    expect(byC.applications.map((a: any) => a.traveller.name.split(" ")[1])).toEqual(["mineC"]);

    const byS = await queue(`?assignedScreeningOfficerId=${officer}`);
    expect(byS.applications.map((a: any) => a.traveller.name.split(" ")[1])).toEqual(["mineS"]);

    const un = await queue("?unassigned=true");
    expect(un.applications.map((a: any) => a.traveller.name.split(" ")[1])).toEqual(["nobody"]);
  });

  it("returns rows from more than one workspace in a single response, and ?workspaceId narrows", async () => {
    const other = await CustomerWorkspace.create({ companyName: "Other Ltd", customerId: "other" });
    await seedCase({ ref: "here", travelInDays: 30 });
    await seedCase({ ref: "there", travelInDays: 30, workspaceId: other._id as mongoose.Types.ObjectId });

    const all = await queue();
    expect(all.applications).toHaveLength(2);

    const narrowed = await queue(`?workspaceId=${other._id}`);
    expect(narrowed.applications).toHaveLength(1);
    expect(narrowed.applications[0].traveller.name).toContain("there");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 5. PAGINATION — bounded in the database
 * ═══════════════════════════════════════════════════════════════════════ */

describe("GET /queue — pagination is bounded in the DB", () => {
  it("returns only the page, with the full total, and never overlaps or skips a row across pages", async () => {
    for (let i = 0; i < 7; i += 1) {
      await seedCase({ ref: `c${i}`, travelInDays: 10 + i });
    }

    const p1 = await queue("?page=1&limit=3");
    const p2 = await queue("?page=2&limit=3");
    const p3 = await queue("?page=3&limit=3");

    expect(p1.applications).toHaveLength(3);
    expect(p2.applications).toHaveLength(3);
    expect(p3.applications).toHaveLength(1);
    expect(p1.pagination.total).toBe(7);
    expect(p1.pagination.totalPages).toBe(3);

    const seen = [...p1.applications, ...p2.applications, ...p3.applications].map((a: any) => a.id);
    expect(new Set(seen).size).toBe(7); // no duplicates => stable total order
  });

  it("issues a bounded pipeline — $limit is pushed to the database, not applied in Node", async () => {
    for (let i = 0; i < 5; i += 1) await seedCase({ ref: `c${i}`, travelInDays: 10 + i });

    const spy = vi.spyOn(VisaApplication, "aggregate");
    await queue("?page=1&limit=2");

    expect(spy).toHaveBeenCalled();
    const pipeline = spy.mock.calls[0][0] as any[];
    const stages = pipeline.map((s) => Object.keys(s)[0]);
    expect(stages).toContain("$match");
    expect(stages).toContain("$sort");
    expect(stages).toContain("$skip");
    expect(stages).toContain("$limit");
    expect(pipeline.find((s) => s.$limit)!.$limit).toBe(2);
    spy.mockRestore();
  });

  it("the page-only join means enrichment scales with the page, not the queue", async () => {
    for (let i = 0; i < 6; i += 1) await seedCase({ ref: `c${i}`, travelInDays: 10 + i });

    const spy = vi.spyOn(VisaRequest, "find");
    await queue("?page=1&limit=2");

    // The request join must have been issued for the 2 rows on the page,
    // not for all 6 matching applications.
    const firstCallFilter = (spy.mock.calls[0] as any[])[0];
    expect(firstCallFilter._id.$in).toHaveLength(2);
    spy.mockRestore();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 6. DENORMALISATION IS WRITTEN AT CREATION, and cannot be null-by-accident
 * ═══════════════════════════════════════════════════════════════════════ */

describe("denormalised fields", () => {
  it("a persisted application carries travelDateFrom, destinationIso2 and processingDeadlineAt", async () => {
    const { application } = await seedCase({ ref: "x", travelInDays: 20, etaMaxDays: 10, destinationIso2: "GB" });
    const fresh: any = await VisaApplication.findById(application._id).lean();

    expect(fresh.destinationIso2).toBe("GB");
    expect(new Date(fresh.travelDateFrom).toISOString()).toBe(daysFromNow(20).toISOString());
    expect(new Date(fresh.processingDeadlineAt).toISOString()).toBe(daysFromNow(10).toISOString());
  });

  it("matches the parent request exactly — the copy cannot disagree at birth", async () => {
    const { request: parent, application } = await seedCase({ ref: "x", travelInDays: 20, destinationIso2: "FR" });
    const app: any = await VisaApplication.findById(application._id).lean();
    const req: any = await VisaRequest.findById(parent._id).lean();

    expect(new Date(app.travelDateFrom).getTime()).toBe(new Date(req.travelDateFrom).getTime());
    expect(app.destinationIso2).toBe(req.destinationIso2);
  });

  it("a dateless request yields explicit nulls, not missing fields", async () => {
    const { application } = await seedCase({ ref: "x", travelInDays: null });
    const fresh: any = await VisaApplication.findById(application._id).lean();

    expect(fresh.travelDateFrom).toBeNull();
    expect(fresh.processingDeadlineAt).toBeNull();
    // "$exists: true" is what stops the backfill re-selecting it forever.
    const stillPending = await VisaApplication.countDocuments({
      _id: application._id,
      processingDeadlineAt: { $exists: false },
    });
    expect(stillPending).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 7. PERMISSION GATE on the queue (moved with the queue tests)
 * ═══════════════════════════════════════════════════════════════════════ */

describe("GET /queue — permission gate", () => {
  it("READ is sufficient to view the queue", async () => {
    setAccess("READ");
    const res = await request(makeApp()).get("/queue");
    expect(res.status).toBe(200);
  });

  it("403s with no permission record at all, and with an explicit NONE", async () => {
    setAccess(null);
    expect((await request(makeApp()).get("/queue")).status).toBe(403);
    setAccess("NONE");
    expect((await request(makeApp()).get("/queue")).status).toBe(403);
  });
});
