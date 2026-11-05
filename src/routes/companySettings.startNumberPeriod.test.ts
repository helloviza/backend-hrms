// An invoice start number applies to the series the next invoice will draw from,
// and that series is the IST month / financial year whatever zone the server
// runs in (App Runner is UTC). Saved between 00:00 and 05:30 IST on the 1st, it
// used to land on the previous period's counter, so the new series ignored it.
// Each case proves the whole path: save, then the number the Invoice hook hands
// out. Run under TZ=UTC to see the failure: an IST machine passes by accident.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requirePlatformAdmin.js", () => ({
  requirePlatformAdmin: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import router from "./companySettings.js";
import Invoice from "../models/Invoice.js";

const KA = "29ABCDE1234F1Z5"; // default profile, bare annual series
const MH = "27ABCDE1234F1Z5"; // prefixed profile
const col = (n: string) => mongoose.connection.db!.collection(n);

const profile = (gstin: string, stateCode: string, state: string, isDefault: boolean, extra: object = {}) => ({
  gstin, state, stateCode, isDefault, active: true, label: state, ...extra,
});

/** A monthly/annual company with both profiles; start numbers are what each case saves. */
async function seed(cadence: "annual" | "monthly") {
  await col("companysettings").insertOne({
    companyName: "Plumtrips", invoiceSeriesCadence: cadence,
    gstProfiles: [
      { gstin: KA, isDefault: true, active: true, invoiceSeriesPrefix: "" },
      { gstin: MH, isDefault: false, active: true, invoiceSeriesPrefix: "MH" },
    ],
  } as any);
}

function app() {
  const a = express();
  a.use(express.json());
  a.use("/", router);
  return a;
}

async function at<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });
  try { return await fn(); } finally { vi.useRealTimers(); }
}

async function saveStartNumber(iso: string, body: object) {
  const res = await at(iso, () => request(app()).put("/").send(body));
  expect(res.status).toBe(200);
}

async function nextInvoiceNo(iso: string, gstin: string): Promise<string> {
  return at(iso, async () => {
    const inv: any = new Invoice({ issuerDetails: { gstin } });
    await inv.save({ validateBeforeSave: false });
    return inv.invoiceNo;
  });
}

const prefixedStart = (n: number) => ({
  gstProfiles: [
    profile(KA, "29", "Karnataka", true),
    profile(MH, "27", "Maharashtra", false, { invoiceSeriesPrefix: "MH", invoiceStartNumber: n }),
  ],
});

const counters = async () =>
  Object.fromEntries((await col("counters").find({}).toArray()).map((c: any) => [String(c._id), c.seq]));

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("company-settings-start-number-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => { for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({}); });
afterEach(() => { vi.useRealTimers(); });

describe("per-GSTIN start number, monthly series", () => {
  it("saved 2 AM IST on the 1st, it starts the new month's series", async () => {
    await seed("monthly");
    await saveStartNumber("2026-11-30T20:30:00Z", prefixedStart(500));
    expect(await counters()).toEqual({ [`invoice:202612:${MH}`]: 499 });
    expect(await nextInvoiceNo("2026-11-30T20:31:00Z", MH)).toBe("INV-MH2026120500");
  });

  it("saved one minute before IST midnight, it starts the old month's series", async () => {
    await seed("monthly");
    await saveStartNumber("2026-11-30T18:29:00Z", prefixedStart(500));
    expect(await counters()).toEqual({ [`invoice:202611:${MH}`]: 499 });
    expect(await nextInvoiceNo("2026-11-30T18:29:30Z", MH)).toBe("INV-MH2026110500");
  });
});

describe("per-GSTIN start number, annual series", () => {
  it("saved 2 AM IST on 1 April, it starts the new financial year's series", async () => {
    await seed("annual");
    await saveStartNumber("2027-03-31T20:30:00Z", prefixedStart(500));
    expect(await counters()).toEqual({ [`invoice:FY2027:${MH}`]: 499 });
    expect(await nextInvoiceNo("2027-03-31T20:31:00Z", MH)).toBe("INV-MH20270500");
  });

  it("saved one minute before IST midnight on 31 March, it starts the old financial year's series", async () => {
    await seed("annual");
    await saveStartNumber("2027-03-31T18:29:00Z", prefixedStart(500));
    expect(await counters()).toEqual({ [`invoice:FY2026:${MH}`]: 499 });
    expect(await nextInvoiceNo("2027-03-31T18:29:30Z", MH)).toBe("INV-MH20260500");
  });
});

describe("flat start number, default annual series", () => {
  it("saved 2 AM IST on 1 April, it starts the new financial year's series", async () => {
    await seed("annual");
    await saveStartNumber("2027-03-31T20:30:00Z", { invoiceStartNumber: 300 });
    expect(await counters()).toEqual({ "invoice:FY2027": 299 });
    expect(await nextInvoiceNo("2027-03-31T20:31:00Z", KA)).toBe("INV-20270300");
  });

  it("saved one minute before IST midnight on 31 March, it starts the old financial year's series", async () => {
    await seed("annual");
    await saveStartNumber("2027-03-31T18:29:00Z", { invoiceStartNumber: 300 });
    expect(await counters()).toEqual({ "invoice:FY2026": 299 });
    expect(await nextInvoiceNo("2027-03-31T18:29:30Z", KA)).toBe("INV-20260300");
  });
});
