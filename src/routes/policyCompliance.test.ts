// apps/backend/src/routes/policyCompliance.test.ts
//
// GET /admin/unified/policy-compliance + /export: real router, in-memory
// mongod. Scoping, request-date source, version at date, the off / not
// configured states, demo isolation both ways, exports.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    req.workspace = { tenantType: "CORPORATE" };
    next();
  };
  return { requireAuth, default: requireAuth };
});

const { default: unified } = await import("./admin.unified.billing.js");
await import("../models/User.js");

const oid = () => new mongoose.Types.ObjectId();
const ACME = "6a00000000000000000000f1";
const BETA = "6a00000000000000000000f2";
const WS_ACME = new mongoose.Types.ObjectId("6a00000000000000000000a1");
const WS_BETA = new mongoose.Types.ObjectId("6a00000000000000000000a2");
const STAFF = oid();
const DEPT = oid();
const ASHA = oid();
const acmeLeader = { _id: String(oid()), roles: ["WORKSPACE_LEADER"], customerId: ACME };
const betaLeader = { _id: String(oid()), roles: ["WORKSPACE_LEADER"], customerId: BETA };
const superadmin = { _id: String(oid()), roles: ["SUPERADMIN"] };

const app = express();
app.use("/api/admin/unified", unified);
const get = (u: any, p: string) => request(app).get(`/api/admin/unified${p}`).set("x-test-user", JSON.stringify(u));
const col = (n: string) => mongoose.connection.db!.collection(n);
const day = (s: string) => new Date(`${s}T00:00:00Z`);

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("policy_compliance_test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

const tier = (tierKey: string, band: number) => ({ tierKey, name: tierKey, code: "", description: "", sortOrder: band, active: true, designationIds: [], bandNumbers: [band] });
const rule = (tierKey: string, d: number, i: number) => ({
  ruleKey: `${tierKey}-f`, category: "FLIGHT", tierKey, scope: { kind: "DEFAULT", value: null }, currency: "INR", notes: "",
  params: { allowedCabins: [], minAdvanceDaysDomestic: d, minAdvanceDaysInternational: i },
});
const version = (workspaceId: any, n: number, from: string, to: string | null, rules: any[]) => ({
  workspaceId, status: "PUBLISHED", versionNumber: n, effectiveFrom: from, effectiveTo: to, tiers: [tier("std", 1), tier("exec", 9)], rules,
  createdBy: { id: "x", kind: "PLUMTRIPS_STAFF" },
});
const row = (over: any) => ({
  _id: oid(), tenantId: ACME, workspaceId: WS_ACME, userId: STAFF, service: "FLIGHT", status: "CONFIRMED", amount: 1000, paymentMode: "OFFICIAL", source: "CONCIERGE",
  referenceModel: "ManualBooking", reference: oid(), travellerName: "Asha Rao", travellerEmail: "asha@acme.test", isInternational: false, destinationCountry: "IN",
  destinationCity: "Mumbai", metadata: { originCity: "Delhi" }, bookedAt: day("2026-11-10"), travelDate: day("2026-11-15"), ...over,
});
const Q = "?from=2026-09-01&to=2026-11-30";

beforeEach(async () => {
  for (const c of ["travelbookings", "customerworkspaces", "travelpolicyversions", "travellerprofiles", "departments", "manualbookings", "approvalrequests", "sbtbookings", "sbtrequests", "users"]) await col(c).deleteMany({});
  await col("customerworkspaces").insertMany([
    { _id: WS_ACME, customerId: ACME, companyName: "Acme", config: { features: { travelPolicyEnabled: true } } },
    { _id: WS_BETA, customerId: BETA, companyName: "Beta", config: { features: { travelPolicyEnabled: false } } },
  ]);
  await col("departments").insertOne({ _id: DEPT, workspaceId: WS_ACME, name: "Sales" });
  await col("travellerprofiles").insertMany([
    { _id: ASHA, workspaceId: WS_ACME, firstName: "Asha", lastName: "Rao", email: "asha@acme.test", employeeId: "E-1", bandNumber: 1, departmentId: DEPT, workLocation: "Sydney, Australia", isActive: true },
    { _id: oid(), workspaceId: WS_ACME, firstName: "No", lastName: "Band", email: "noband@acme.test", isActive: true },
  ]);
  await col("travelpolicyversions").insertMany([
    version(WS_ACME, 1, "2026-09-01", "2026-10-31", [rule("std", 3, 3), rule("exec", 3, 3)]),
    version(WS_ACME, 2, "2026-11-01", null, [rule("std", 10, 14), rule("exec", 5, 7)]),
    version(WS_BETA, 1, "2026-09-01", null, [rule("std", 10, 10), rule("exec", 10, 10)]),
  ]);
});

describe("GET /flight-insights: what domestic means", () => {
  const setBasis = (basis: string | null, enabled = true) =>
    col("customerworkspaces").updateOne({ _id: WS_ACME }, { $set: { "config.features.travelPolicyEnabled": enabled, "config.policyDomesticBasis": basis } });
  const panel = async (u: any) => {
    const r = await get(u, `/flight-insights${Q}`);
    expect(r.status).toBe(200);
    const pick = (x: any) => [x.domestic.count, x.international.count, x.unknown.count];
    return { basis: r.body.domesticBasis, flights: pick(r.body.domesticInternational.FLIGHT), hotels: pick(r.body.domesticInternational.HOTEL), body: r.body };
  };
  // Asha works in Sydney; No Band has no work location (India).
  const seed = () =>
    col("travelbookings").insertMany([
      row({ origin: "Sydney", destinationCity: "Melbourne", destinationCountry: "AU", isInternational: true, metadata: { originCity: "Sydney" }, amount: 300 }), // at home in Australia
      row({ amount: 100 }), // Delhi to Mumbai: abroad for Asha
      row({ origin: "Sydney", destinationCity: "London", destinationCountry: "GB", isInternational: true, metadata: { originCity: "Sydney" } }),
      row({ origin: "Sydney", destinationCity: null, destinationCountry: null, isInternational: true, metadata: { originCity: "Sydney" } }), // other end unknown
      row({ travellerName: "No Band", travellerEmail: "noband@acme.test" }), // India
      row({ travellerName: "Stranger", travellerEmail: "", isInternational: true, destinationCountry: "AU", destinationCity: "Sydney" }), // no profile: India rule
      row({ service: "HOTEL", isInternational: true, destinationCountry: "AU", destinationCity: "Melbourne", metadata: { hotelName: "Crown" } }),
      row({ service: "HOTEL", metadata: { hotelName: "Taj" } }), // Mumbai
      row({ tenantId: BETA, isInternational: true, destinationCountry: "AU" }),
      row({ status: "PENDING" }), row({ isTest: true }), row({ isDemo: true }),
    ]);

  it("a company view follows its setting; India is the default", async () => {
    await seed();
    expect(await panel(acmeLeader)).toMatchObject({ basis: "INDIA", flights: [2, 4, 0], hotels: [1, 1, 0] });
    await setBasis("WORK_COUNTRY");
    const after = await panel(acmeLeader);
    expect(after).toMatchObject({ basis: "WORK_COUNTRY", flights: [2, 3, 1], hotels: [1, 1, 0] });
    expect(after.body.domesticInternational.FLIGHT.domestic.spend).toBe(1300); // Sydney to Melbourne + No Band
    await setBasis("INDIA");
    expect((await panel(acmeLeader)).flights).toEqual([2, 4, 0]);
  });

  it("agrees with Policy Compliance, trip for trip", async () => {
    await seed();
    await setBasis("WORK_COUNTRY");
    const split = async (p: string) => (await get(acmeLeader, p)).body;
    const pc = await split(`/policy-compliance${Q}&service=FLIGHT`);
    const { FLIGHT } = (await split(`/flight-insights${Q}`)).domesticInternational;
    // Every seeded flight is a trip of its own: each goes somewhere else, or with someone else.
    expect([pc.split.DOMESTIC.trips, pc.split.INTERNATIONAL.trips, pc.split.UNKNOWN.trips]).toEqual([FLIGHT.domestic.count, FLIGHT.international.count, FLIGHT.unknown.count]);
  });

  it("works before any policy version is published", async () => {
    await seed();
    await setBasis("WORK_COUNTRY");
    await col("travelpolicyversions").deleteMany({ workspaceId: WS_ACME });
    expect((await panel(acmeLeader)).flights).toEqual([2, 3, 1]);
  });

  it("staff across companies keep the India rule, whatever a company chose", async () => {
    await seed();
    await setBasis("WORK_COUNTRY");
    expect(await panel(superadmin)).toMatchObject({ basis: "INDIA", flights: [2, 5, 0], hotels: [1, 1, 0] });
  });

  it("another company, and a company with the module off, keep the India rule", async () => {
    await seed();
    await setBasis("WORK_COUNTRY");
    expect(await panel(betaLeader)).toMatchObject({ basis: "INDIA", flights: [0, 1, 0] });
    await setBasis("WORK_COUNTRY", false);
    expect(await panel(acmeLeader)).toMatchObject({ basis: "INDIA", flights: [2, 4, 0] });
  });

  it("a traveller who sees only their own bookings gets their company's rule", async () => {
    await seed();
    await setBasis("WORK_COUNTRY");
    const me = { _id: String(STAFF), roles: ["REQUESTER"], customerId: ACME };
    // STAFF booked every row here, Beta's too: that one keeps the India rule.
    expect(await panel(me)).toMatchObject({ basis: "WORK_COUNTRY", flights: [2, 4, 1] });
  });

  it("only the domestic split changes: airlines, times and cabins are the same", async () => {
    await seed();
    const before = (await panel(acmeLeader)).body;
    await setBasis("WORK_COUNTRY");
    const after = (await panel(acmeLeader)).body;
    for (const k of ["airlines", "departureSlots", "cabins"]) expect(after[k]).toEqual(before[k]);
  });
});

describe("GET /policy-compliance", () => {
  it("evaluates against the version in force on the request date, with the traveller's details", async () => {
    await col("travelbookings").insertMany([
      row({}), // v2: 5 of 10
      row({ service: "HOTEL", amount: 700, travelDateEnd: day("2026-11-17"), metadata: { hotelName: "Taj" } }), // same trip
      row({ bookedAt: day("2026-10-31"), travelDate: day("2026-11-05") }), // v1: 5 of 3
      row({ isInternational: true, destinationCountry: "GB", destinationCity: "London", travelDate: day("2026-11-23"), amount: 5000 }), // v2: 13 of 14
      row({ travellerName: "No Band", travellerEmail: "noband@acme.test" }),
      row({ travellerName: "Stranger", travellerEmail: "" }),
      row({ bookedAt: day("2026-09-01"), travelDate: null }),
      row({ status: "PENDING" }), row({ isTest: true }), row({ isActive: false }), row({ service: "VISA" }), row({ tenantId: BETA }),
    ]);
    const r = await get(acmeLeader, `/policy-compliance${Q}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configured: true, showCompany: false, regionBy: "work" });
    expect(r.body.totals).toEqual({ trips: 6, evaluated: 3, compliant: 1, violations: 2, violationPct: 66.7, avgDaysShort: 3, violators: 1 });
    expect(r.body.notEvaluated).toMatchObject({ UNMAPPED: 2, BAD_DATES: 1 });
    expect(r.body.violations.map((v: any) => [v.requiredDays, v.actualDays, v.versionNumber])).toEqual([[10, 5, 2], [14, 13, 2]]);
    expect(r.body.violations[0]).toMatchObject({ employee: "Asha Rao", employeeId: "E-1", department: "Sales", workRegion: "APAC", sector: "Delhi → Mumbai", requestedOn: "2026-11-10", travelOn: "2026-11-15", amount: 1700 });
    // The hotel has no hotel rule: it is part of the trip, not a second one.
    expect(r.body.violations[0].services).toMatchObject([{ service: "FLIGHT", late: true }, { service: "HOTEL", sector: "Taj, Mumbai", late: false, requiredDays: null }]);
    expect(r.body.regions[0]).toMatchObject({ region: "APAC", violations: 2 });
    const d = await get(acmeLeader, `/policy-compliance${Q}&regionBy=destination`);
    expect(d.body.regions.filter((x: any) => x.violations).map((x: any) => x.region)).toEqual(["India", "Europe"]);
  });

  it("the approval request's submitted date beats the booking date", async () => {
    const [mb, ap, sb, sr] = [oid(), oid(), oid(), oid()];
    await col("manualbookings").insertOne({ _id: mb, source: "ADMIN_QUEUE", sourceBookingId: ap });
    await col("approvalrequests").insertOne({ _id: ap, createdAt: new Date("2026-11-02T20:00:00Z") }); // 3 Nov IST
    await col("sbtbookings").insertOne({ _id: sb, sbtRequestId: sr });
    await col("sbtrequests").insertOne({ _id: sr, requestedAt: day("2026-11-04") });
    await col("travelbookings").insertMany([
      row({ reference: mb, travelDate: day("2026-11-12") }), // 9 from 3 Nov
      row({ reference: sb, referenceModel: "SBTBooking", source: "SBT", travelDate: day("2026-11-11") }), // 7 from 4 Nov
    ]);
    const r = await get(acmeLeader, `/policy-compliance${Q}`);
    expect(r.body.violations.map((v: any) => [v.requestedOn, v.actualDays])).toEqual([["2026-11-04", 7], ["2026-11-03", 9]]);

    // Two bookings of one approval request are one trip, wherever they go.
    const mb2 = oid();
    await col("manualbookings").insertOne({ _id: mb2, source: "ADMIN_QUEUE", sourceBookingId: ap });
    await col("travelbookings").insertOne(row({ reference: mb2, destinationCity: "Pune", travelDate: day("2026-11-20") }));
    const again = await get(acmeLeader, `/policy-compliance${Q}`);
    expect(again.body.totals).toMatchObject({ trips: 2, violations: 2 });
  });

  it("a traveller profile id wins over email and name; SBT rows match the account holder", async () => {
    const u = oid();
    await col("users").insertOne({ _id: u, name: "Asha Rao", email: "asha@acme.test" });
    await col("travelbookings").insertMany([
      row({ destinationCity: "Goa", travellerName: "Wrong Name", travellerEmail: "noband@acme.test", metadata: { travellerProfileId: String(ASHA) } }),
      row({ travellerName: "", travellerEmail: "", userId: u, source: "SBT", referenceModel: "SBTBooking" }),
    ]);
    const r = await get(acmeLeader, `/policy-compliance${Q}`);
    expect(r.body.totals.violations).toBe(2);
    expect(new Set(r.body.violations.map((v: any) => v.employeeId))).toEqual(new Set(["E-1"]));
  });

  it("module off: nothing to show; on with no published version: not configured; configured with no trips", async () => {
    await col("travelbookings").insertOne(row({ tenantId: BETA, workspaceId: WS_BETA }));
    expect((await get(betaLeader, `/policy-compliance${Q}`)).body).toEqual({ ok: true, enabled: false, configured: false });
    expect((await get({ _id: String(oid()), roles: ["EMPLOYEE"] }, `/policy-compliance${Q}`)).body.enabled).toBe(false);
    expect((await get(betaLeader, `/policy-compliance/export${Q}&format=csv`)).text.split("\n")).toHaveLength(1);
    expect((await get(acmeLeader, `/policy-compliance${Q}`)).body).toMatchObject({ enabled: true, configured: true, domesticBasis: "INDIA", totals: { trips: 0 } });
    await col("travelpolicyversions").updateMany({ workspaceId: WS_ACME }, { $set: { status: "ARCHIVED" } });
    expect((await get(acmeLeader, `/policy-compliance${Q}`)).body).toMatchObject({ enabled: true, configured: false });
  });

  it("domestic = work country: the setting changes the class and the days asked for; staff across companies see no change", async () => {
    // Asha works in Australia (band 1 → std: 10 domestic, 14 international).
    await col("travelbookings").insertMany([
      row({ isInternational: true, origin: "Sydney", destinationCity: "Melbourne", destinationCountry: "AU", travelDate: day("2026-11-22"), metadata: { originCity: "Sydney" } }), // 12 days
      row({ origin: "Delhi", travelDate: day("2026-11-23") }), // within India, 13 days
    ]);
    const look = async () => {
      const b = (await get(acmeLeader, `/policy-compliance${Q}`)).body;
      return { dom: b.split.DOMESTIC.trips, intl: b.split.INTERNATIONAL.trips, late: b.violations.map((v: any) => [v.sector, v.requiredDays]) };
    };
    const before = (await get(superadmin, `/flight-insights${Q}`)).body;
    expect(await look()).toEqual({ dom: 1, intl: 1, late: [["Sydney → Melbourne", 14]] });
    await col("customerworkspaces").updateOne({ _id: WS_ACME }, { $set: { "config.policyDomesticBasis": "WORK_COUNTRY" } });
    expect(await look()).toEqual({ dom: 1, intl: 1, late: [["Delhi → Mumbai", 14]] });
    expect((await get(superadmin, `/flight-insights${Q}`)).body).toEqual(before);
    // No work location → India.
    await col("travellerprofiles").updateMany({}, { $unset: { workLocation: 1 } });
    expect(await look()).toEqual({ dom: 1, intl: 1, late: [["Sydney → Melbourne", 14]] });
  });

  it("staff see every company with its name; a requester sees only their own rows", async () => {
    const me = oid();
    await col("travelbookings").insertMany([row({}), row({ tenantId: BETA }), row({ userId: me })]);
    const all = await get(superadmin, `/policy-compliance${Q}`);
    // Beta's module is off, so Beta is not measured at all.
    expect(all.body).toMatchObject({ showCompany: true, enabled: true, domesticBasis: null, totals: { trips: 1, violations: 1 }, notEvaluated: { NOT_CONFIGURED: 0 } });
    expect(all.body.violations[0].company).toBe("Acme");
    const own = await get({ _id: String(me), roles: ["REQUESTER"], customerId: ACME }, `/policy-compliance${Q}`);
    expect(own.body.totals.trips).toBe(1);
  });

  it("staff: a demo workspace alone does not switch the section on", async () => {
    await col("customerworkspaces").updateOne({ _id: WS_ACME }, { $set: { isDemo: true } });
    expect((await get(superadmin, `/policy-compliance${Q}`)).body.enabled).toBe(false);
    expect((await get(acmeLeader, `/policy-compliance${Q}`)).body.enabled).toBe(true);
  });

  it("page filters apply: payment mode, service, travel-date range", async () => {
    await col("travelbookings").insertMany([row({}), row({ paymentMode: "PERSONAL" }), row({ travelDate: day("2026-12-05"), bookedAt: day("2026-11-28") })]);
    expect((await get(acmeLeader, `/policy-compliance${Q}&paymentMode=PERSONAL`)).body.totals.trips).toBe(1);
    expect((await get(acmeLeader, `/policy-compliance${Q}&service=VISA`)).body.totals.trips).toBe(0);
    expect((await get(acmeLeader, "/policy-compliance?from=2026-12-01&to=2026-12-31&dateField=travelDate")).body.totals.trips).toBe(1);
  });
});

describe("demo isolation", () => {
  const demoLeader = { ...acmeLeader, isDemoUser: true };
  beforeEach(async () => {
    await col("travelbookings").insertMany([row({ amount: 1 }), row({ amount: 2, isDemo: true }), row({ amount: 4, isDemo: true, tenantId: BETA })]);
  });
  it("a demo login sees its own company's demo rows only; everyone else never sees them", async () => {
    const spend = async (u: any) => (await get(u, `/summary${Q}`)).body.totalSpend;
    expect(await spend(demoLeader)).toBe(2);
    expect(await spend(acmeLeader)).toBe(1);
    expect(await spend(superadmin)).toBe(1);
    expect((await get(demoLeader, `/policy-compliance${Q}`)).body.totals.trips).toBe(1);
    expect((await get(superadmin, `/policy-compliance${Q}`)).body.totals.trips).toBe(1);
  });
  it("a demo flag on a GLOBAL session does not open demo rows across companies", async () => {
    expect((await get({ ...superadmin, isDemoUser: true }, `/summary${Q}`)).body.totalSpend).toBe(1);
  });
});

describe("GET /policy-compliance/export", () => {
  beforeEach(async () => {
    await col("travelbookings").insertMany([row({}), row({ destinationCity: "Goa", metadata: { originCity: "=HYPERLINK(1)" } }), row({ travelDate: day("2026-11-29") })]);
  });
  it("csv: every violation, headed, formula text neutralised", async () => {
    const r = await get(acmeLeader, `/policy-compliance/export${Q}&format=csv`);
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    const lines = r.text.replace(/^﻿/, "").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"Employee ID","Employee","Department"');
    expect(lines[0]).not.toContain("Company");
    expect(r.text).toContain('"\'=HYPERLINK(1) → Goa"');
    expect((await get(superadmin, `/policy-compliance/export${Q}&format=csv`)).text).toContain('"Company"');
  });
  it("xlsx: numbers stay numbers", async () => {
    const r = await get(acmeLeader, `/policy-compliance/export${Q}&format=xlsx`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body);
    const sh = wb.worksheets[0];
    expect(sh.rowCount).toBe(3);
    const head = (sh.getRow(1).values as any[]).map(String);
    expect(sh.getRow(2).getCell(head.indexOf("Required days")).value).toBe(10);
  });
});
