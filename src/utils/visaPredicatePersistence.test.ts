// Round-trip coverage for applicant-predicate logic — the ONE thing the
// rest of the visa suite structurally cannot catch.
//
// WHY THIS FILE EXISTS
// --------------------
// visaAttributes.test.ts and visaChecklistResolver.test.ts build their
// conditions as plain object literals:
//
//     { field: "employmentStatus", equals: "SELF_EMPLOYED" }
//
// A condition that has actually been through Mongoose is not that object.
// VisaApplicantPredicateConditionSchema declares `in` as an array-type path
// (`in: { type: [Schema.Types.Mixed] }`) with no `default: undefined`, and
// Mongoose gives every array path an implicit `[]` default. So the same
// condition, saved and read back, is:
//
//     { field: "employmentStatus", equals: "SELF_EMPLOYED", in: [] }
//
// Every production read of a predicate — VisaRule.applicability,
// VisaRule.documentGroups[].appliesWhen, VisaApplication.ruleSnapshot
// .documentGroups[].appliesWhen — sees the second shape. Every test saw the
// first. That gap hid two separate `cond.in !== undefined`-ordering bugs
// (one in evaluateApplicantCondition, one in the resolver's describeExpected)
// from 800+ otherwise-passing tests, because `in: []` is not `undefined` and
// `[].includes(x)` is never true.
//
// So these tests deliberately never hand-write a condition object. Each one
// persists a real model and reads it back — hydrated AND lean, since routes
// use both — and asserts on what came out of the database.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import VisaRule from "../models/VisaRule.js";
import VisaApplication from "../models/VisaApplication.js";
import { evaluateApplicantCondition, evaluateApplicantPredicate } from "../models/visaAttributes.js";
import { resolveVisaChecklistItems, resolveVisaChecklistWithExclusions } from "./visaChecklistResolver.js";

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

// A rule whose ITR group is gated by `equals` (the shape the bugs broke) and
// whose bank-statement group is gated by `in` (the shape that always worked)
// — so every assertion below can show the two behaving consistently rather
// than only proving the broken one now works.
async function persistRule(variantKey: string) {
  const rule = await VisaRule.create({
    nationality: "IN",
    destinationIso2: "DE",
    purpose: "TOURIST",
    entryType: "SINGLE",
    serviceTier: "STANDARD",
    variantKey,
    destinationName: "Germany",
    productClass: "VISA",
    effectiveFrom: new Date("2026-01-01"),
    applicability: [{ field: "maritalStatus", equals: "MARRIED" }],
    documentGroups: [
      { key: "PASSPORT", label: "Passport", requirement: "REQUIRED", docTypeCodes: ["PASSPORT_ORIGINAL"] },
      {
        key: "ITR",
        label: "Income Tax Return",
        requirement: "CONDITIONAL",
        appliesWhen: [{ field: "employmentStatus", equals: "SELF_EMPLOYED" }],
        docTypeCodes: ["INCOME_TAX_RETURN"],
      },
      {
        key: "BANK",
        label: "Bank Statement",
        requirement: "CONDITIONAL",
        appliesWhen: [{ field: "employmentStatus", in: ["EMPLOYED", "SELF_EMPLOYED"] }],
        docTypeCodes: ["BANK_STATEMENT"],
      },
    ],
  });
  return rule._id;
}

describe("the persistence hazard itself", () => {
  it("gives an equals-only condition an `in: []` it was never written with — hydrated and lean alike", async () => {
    const id = await persistRule("HAZARD");

    const hydrated: any = await VisaRule.findById(id);
    const lean: any = await VisaRule.findById(id).lean();

    for (const [shape, doc] of [
      ["hydrated", hydrated],
      ["lean", lean],
    ] as const) {
      const cond = doc.documentGroups.find((g: any) => g.key === "ITR").appliesWhen[0];
      expect(cond.equals, shape).toBe("SELF_EMPLOYED");
      // The whole reason this file exists. If a future schema change adds
      // `default: undefined` to VisaApplicantPredicateConditionSchema's `in`,
      // THIS is the assertion that should fail and send you here — the
      // behavioural tests below would keep passing either way.
      expect(cond.in, `${shape}: Mongoose array default`).toEqual([]);
      expect(cond.in, `${shape}: not undefined`).not.toBeUndefined();
    }
  });
});

describe("evaluateApplicantCondition / evaluateApplicantPredicate — persisted conditions", () => {
  it("matches an equals-gated condition read back from the DB (regression: `in: []` used to defeat it)", async () => {
    const id = await persistRule("EVAL_EQUALS");
    const lean: any = await VisaRule.findById(id).lean();
    const itrCond = lean.documentGroups.find((g: any) => g.key === "ITR").appliesWhen[0];

    expect(evaluateApplicantCondition(itrCond, { employmentStatus: "SELF_EMPLOYED" })).toBe(true);
    expect(evaluateApplicantCondition(itrCond, { employmentStatus: "EMPLOYED" })).toBe(false);
    expect(evaluateApplicantCondition(itrCond, {})).toBe(false);
  });

  it("matches an in-gated condition read back from the DB", async () => {
    const id = await persistRule("EVAL_IN");
    const lean: any = await VisaRule.findById(id).lean();
    const bankCond = lean.documentGroups.find((g: any) => g.key === "BANK").appliesWhen[0];

    expect(evaluateApplicantCondition(bankCond, { employmentStatus: "EMPLOYED" })).toBe(true);
    expect(evaluateApplicantCondition(bankCond, { employmentStatus: "SELF_EMPLOYED" })).toBe(true);
    expect(evaluateApplicantCondition(bankCond, { employmentStatus: "RETIRED" })).toBe(false);
  });

  it("evaluates a persisted rule-level `applicability` predicate (the selectMostSpecificRule input)", async () => {
    const id = await persistRule("EVAL_APPLICABILITY");
    const lean: any = await VisaRule.findById(id).lean();

    expect(evaluateApplicantPredicate(lean.applicability, { maritalStatus: "MARRIED" })).toBe(true);
    expect(evaluateApplicantPredicate(lean.applicability, { maritalStatus: "SINGLE" })).toBe(false);
  });

  it("agrees with the same condition as a plain literal — persistence must not change the verdict", async () => {
    const id = await persistRule("EVAL_PARITY");
    const lean: any = await VisaRule.findById(id).lean();
    const persisted = lean.documentGroups.find((g: any) => g.key === "ITR").appliesWhen[0];
    const literal = { field: "employmentStatus" as const, equals: "SELF_EMPLOYED" };

    for (const status of ["SELF_EMPLOYED", "EMPLOYED", "RETIRED", "STUDENT"] as const) {
      expect(evaluateApplicantCondition(persisted, { employmentStatus: status }), status).toBe(
        evaluateApplicantCondition(literal, { employmentStatus: status }),
      );
    }
  });
});

describe("resolveVisaChecklistItems — persisted documentGroups", () => {
  it("includes an equals-gated group for a matching applicant (the five-day production bug)", async () => {
    const id = await persistRule("RESOLVE_MATCH");
    const lean: any = await VisaRule.findById(id).lean();

    const keys = resolveVisaChecklistItems(lean, { employmentStatus: "SELF_EMPLOYED" }).map((i) => i.key);
    expect(keys).toEqual(["PASSPORT", "ITR", "BANK"]);
  });

  it("excludes the equals-gated group for a non-matching applicant, keeping the in-gated one", async () => {
    const id = await persistRule("RESOLVE_PARTIAL");
    const lean: any = await VisaRule.findById(id).lean();

    const keys = resolveVisaChecklistItems(lean, { employmentStatus: "EMPLOYED" }).map((i) => i.key);
    expect(keys).toEqual(["PASSPORT", "BANK"]);
  });

  it("resolves identically from a hydrated document and a lean one", async () => {
    const id = await persistRule("RESOLVE_SHAPES");
    const hydrated: any = await VisaRule.findById(id);
    const lean: any = await VisaRule.findById(id).lean();
    const profile = { employmentStatus: "SELF_EMPLOYED" as const };

    expect(resolveVisaChecklistItems(hydrated, profile).map((i) => i.key)).toEqual(
      resolveVisaChecklistItems(lean, profile).map((i) => i.key),
    );
  });
});

// The concierge console path: admin.visa.ts's hydrateAdminRuleSnapshot feeds
// VisaApplication.ruleSnapshot straight into resolveVisaChecklistWithExclusions,
// and the `expected`/`reason` strings it returns are what an agent reads to
// understand why a requirement was dropped.
async function persistApplication(label: string) {
  const ruleId = await persistRule(`APP_${label}`);
  const rule: any = await VisaRule.findById(ruleId).lean();

  const app = await VisaApplication.create({
    requestId: new mongoose.Types.ObjectId(),
    nationalityUnresolved: false,
    workspaceId: new mongoose.Types.ObjectId(),
    applicantProfile: { employmentStatus: "EMPLOYED" },
    ruleSnapshot: {
      ruleId,
      capturedAt: new Date("2026-08-07"),
      destinationName: "Germany",
      isSchengen: true,
      productClass: "VISA",
      visaCategory: "STICKER",
      purpose: "TOURIST",
      entryType: "SINGLE",
      serviceTier: "STANDARD",
      documentGroups: rule.documentGroups,
    },
    indicativeCostSnapshot: { displayMode: "ITEMISED", totalInr: 12000 },
  });
  return app._id;
}

describe("resolveVisaChecklistWithExclusions — persisted ruleSnapshot (concierge console)", () => {
  it("renders an equals-gated exclusion as the value the rule wanted, not a dangling 'one of '", async () => {
    const id = await persistApplication("REQ-EXPECTED");
    const app: any = await VisaApplication.findById(id).lean();

    const { excluded } = resolveVisaChecklistWithExclusions(app.ruleSnapshot, app.applicantProfile);
    const itr = excluded.find((e) => e.key === "ITR");

    expect(itr).toBeDefined();
    // Before the fix this was the string "one of " — `in: []` won the
    // ordering check and `[].join(", ")` contributed nothing.
    expect(itr!.excludedBy[0].expected).toBe("SELF_EMPLOYED");
    expect(itr!.reason).toBe("traveller's employment status is EMPLOYED, not SELF_EMPLOYED");
    expect(itr!.reason).not.toContain("one of ");
    expect(itr!.reason).not.toMatch(/not\s*$/);
  });

  it("still renders a genuinely in-gated exclusion as 'one of ...' with its values", async () => {
    const id = await persistApplication("REQ-IN-GATED");
    const app: any = await VisaApplication.findById(id).lean();

    // RETIRED matches neither group, so BANK (in-gated) is excluded too.
    const { excluded } = resolveVisaChecklistWithExclusions(app.ruleSnapshot, { employmentStatus: "RETIRED" });
    const bank = excluded.find((e) => e.key === "BANK");

    expect(bank).toBeDefined();
    expect(bank!.excludedBy[0].expected).toBe("one of EMPLOYED, SELF_EMPLOYED");
    expect(bank!.reason).toBe("traveller's employment status is RETIRED, not one of EMPLOYED, SELF_EMPLOYED");
  });

  it("keeps included/excluded consistent with the evaluator over a persisted snapshot", async () => {
    const id = await persistApplication("REQ-CONSISTENCY");
    const app: any = await VisaApplication.findById(id).lean();

    const { included, excluded } = resolveVisaChecklistWithExclusions(app.ruleSnapshot, app.applicantProfile);
    expect(included.map((i) => i.key)).toEqual(["PASSPORT", "BANK"]);
    expect(excluded.map((e) => e.key)).toEqual(["ITR"]);
    // No group may appear on both sides, and every group must land on one.
    expect([...included.map((i) => i.key), ...excluded.map((e) => e.key)].sort()).toEqual(["BANK", "ITR", "PASSPORT"]);
  });

  it("produces no dangling 'not <empty>' reason for ANY applicant over a persisted snapshot", async () => {
    const id = await persistApplication("REQ-SWEEP");
    const app: any = await VisaApplication.findById(id).lean();

    for (const status of ["EMPLOYED", "SELF_EMPLOYED", "RETIRED", "STUDENT", "UNEMPLOYED"] as const) {
      const { excluded } = resolveVisaChecklistWithExclusions(app.ruleSnapshot, { employmentStatus: status });
      for (const e of excluded) {
        expect(e.excludedBy[0].expected.trim(), `${status}/${e.key}`).not.toBe("");
        expect(e.excludedBy[0].expected, `${status}/${e.key}`).not.toBe("one of ");
        expect(e.reason, `${status}/${e.key}`).not.toMatch(/not\s*$/);
      }
    }
  });
});
