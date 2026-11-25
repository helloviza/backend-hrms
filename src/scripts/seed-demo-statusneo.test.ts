// The StatusNeo Demo seed: dry run writes nothing, re-runs change no counts,
// the dashboard reads it for a demo login only, and --remove leaves nothing.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
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
vi.setConfig({ testTimeout: 60_000 });
const seed = await import("./seed-demo-statusneo.js");
const { default: unified } = await import("../routes/admin.unified.billing.js");

const ASOF = "2026-11-25";
const opts = (over: any = {}) => ({ apply: true, asOf: ASOF, password: "a-long-test-password", log: () => {}, ...over });
const col = (n: string) => mongoose.connection.db!.collection(n);
const COLS = ["customers", "customerworkspaces", "users", "customermembers", "workspacememberships", "departments", "designations", "travellerprofiles", "travelpolicyversions", "travelpolicycities", "travelpolicyaudits", "travelbookings"];
const counts = async () => Object.fromEntries(await Promise.all(COLS.map(async (c) => [c, await col(c).countDocuments()] as const)));
const app = express();
app.use("/u", unified);
const get = (u: any, p: string) => request(app).get(`/u${p}`).set("x-test-user", JSON.stringify(u));
const leader = { _id: "x", roles: ["CUSTOMER", "WORKSPACE_LEADER"], customerId: String(seed.CUSTOMER_ID) };
const Q = "?from=2026-08-01&to=2026-11-30";

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("statusneo_seed_test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

describe("seed-demo-statusneo", () => {
  it("dry run writes nothing; apply refuses a short password", async () => {
    await seed.seedStatusNeoDemo(opts({ apply: false }));
    expect(Object.values(await counts()).every((n) => n === 0)).toBe(true);
    await expect(seed.seedStatusNeoDemo(opts({ password: "short" }))).rejects.toThrow(/12\+/);
    expect((await counts()).users).toBe(0);
  });

  it("seeds once; a re-run on another day keeps every count and the password", async () => {
    await seed.seedStatusNeoDemo(opts());
    const first = await counts();
    expect(first).toMatchObject({ customers: 1, customerworkspaces: 1, users: 7, customermembers: 7, departments: 6, designations: 5, travellerprofiles: 40, travelpolicyversions: 1 });
    expect(first.travelbookings).toBeGreaterThan(seed.TRIPS + 30); // flights + some hotels
    await seed.seedStatusNeoDemo(opts({ asOf: "2026-11-27", password: "another-long-password" }));
    expect(await counts()).toEqual(first);
    const u = await col("users").findOne({ email: seed.DEMO_LOGIN });
    expect(await bcrypt.compare("a-long-test-password", u!.passwordHash)).toBe(true);
    expect(await col("departments").countDocuments({ managerId: null })).toBe(0);
    expect(await col("travelbookings").countDocuments({ isDemo: { $ne: true } })).toBe(0);
    expect(await col("users").countDocuments({ isDemoUser: { $ne: true } })).toBe(0);
    await seed.seedStatusNeoDemo(opts());
  });

  it("the dashboard for the demo login: every region, a believable violation rate, Unmapped counted apart", async () => {
    const r = (await get({ ...leader, isDemoUser: true }, `/policy-compliance${Q}`)).body;
    expect(r.configured).toBe(true);
    expect(r.totals.trips).toBe(seed.TRIPS);
    expect(r.totals.violationPct).toBeGreaterThan(25);
    expect(r.totals.violationPct).toBeLessThan(55);
    expect(r.notEvaluated.UNMAPPED).toBeGreaterThan(0);
    expect(r.notEvaluated).toMatchObject({ BAD_DATES: 0, NOT_IN_FORCE: 0, NOT_CONFIGURED: 0, NO_RULE: 0, UNKNOWN_DESTINATION: 0 });
    expect(new Set(r.regions.map((x: any) => x.region))).toEqual(new Set(["India", "Americas", "APAC", "Africa"]));
    expect(r.regions.every((x: any) => x.violations > 0)).toBe(true);
    expect(r.domesticBasis).toBe("WORK_COUNTRY");
    // A flight within the US / Australia / South Africa is domestic for someone who works there.
    const abroadHome = r.violations.filter((v: any) => v.isInternational === false && v.workRegion !== "India");
    expect(abroadHome.length).toBeGreaterThan(0);
    expect(r.violations.some((v: any) => v.services.length === 2)).toBe(true);
    expect(r.split.DOMESTIC.trips).toBeGreaterThan(20);
    expect(r.split.INTERNATIONAL.trips).toBeGreaterThan(20);
    expect(r.violations.every((v: any) => v.department && v.employeeId && v.daysShort > 0)).toBe(true);
    // The month the page opens on has data too.
    expect((await get({ ...leader, isDemoUser: true }, "/policy-compliance?from=2026-11-01&to=2026-11-30")).body.totals.violations).toBeGreaterThan(5);
  });

  it("is invisible to SuperAdmin and to a non-demo session", async () => {
    expect((await get({ _id: "s", roles: ["SUPERADMIN"] }, `/summary${Q}`)).body.confirmedTrips).toBe(0);
    expect((await get(leader, `/summary${Q}`)).body.confirmedTrips).toBe(0);
  });

  it("refuses when someone else's company or login holds the name", async () => {
    await col("customers").insertOne({ name: seed.COMPANY });
    await expect(seed.seedStatusNeoDemo(opts())).rejects.toThrow(/REFUSING/);
    await col("customers").deleteOne({ _id: { $ne: seed.CUSTOMER_ID } as any, name: seed.COMPANY });
  });

  it("--remove leaves nothing behind", async () => {
    await seed.removeStatusNeoDemo(true, () => {});
    expect(Object.values(await counts()).every((n) => n === 0)).toBe(true);
  });
});
