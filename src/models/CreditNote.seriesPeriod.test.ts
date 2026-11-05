// The series a credit note number belongs to is the IST month / financial year,
// whatever zone the server runs in (App Runner is UTC). Between 00:00 and 05:30
// IST on the 1st the two disagree, and a number from the previous period is a
// wrong GST series. Run under TZ=UTC to see the failure this guards against: an
// IST machine passes by accident.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import CreditNote from "./CreditNote.js";

const KA = "29ABCDE1234F1Z5"; // default profile, bare annual series
const MH = "27ABCDE1234F1Z5"; // prefixed profile
const col = (n: string) => mongoose.connection.db!.collection(n);

async function settings(cadence: "annual" | "monthly") {
  await col("companysettings").deleteMany({});
  await col("companysettings").insertOne({
    companyName: "Plumtrips", invoiceSeriesCadence: cadence,
    gstProfiles: [
      { gstin: KA, isDefault: true, active: true, invoiceSeriesPrefix: "" },
      { gstin: MH, isDefault: false, active: true, invoiceSeriesPrefix: "MH" },
    ],
  } as any);
}

/** The pre-save hook only, at a given instant: the number it assigns. */
async function numberAt(iso: string, gstin: string): Promise<string> {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });
  try {
    const cn: any = new CreditNote({ issuerDetails: { gstin } });
    await cn.save({ validateBeforeSave: false });
    return cn.creditNoteNo;
  } finally {
    vi.useRealTimers();
  }
}

const counterIds = async () =>
  (await col("counters").find({}).toArray()).map((c) => String(c._id)).sort();

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("credit-note-series-period-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => { for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({}); });
afterEach(() => { vi.useRealTimers(); });

describe("credit note number period follows the IST calendar", () => {
  it("2 AM IST on the 1st is the new month (monthly series)", async () => {
    await settings("monthly");
    expect(await numberAt("2026-11-30T20:30:00Z", MH)).toBe("CN-MH2026120001");
    expect(await counterIds()).toEqual([`creditnote:202612:${MH}`]);
  });

  it("one minute before IST midnight is still the old month", async () => {
    await settings("monthly");
    expect(await numberAt("2026-11-30T18:29:00Z", MH)).toBe("CN-MH2026110001");
  });

  it("IST midnight exactly is the new month", async () => {
    await settings("monthly");
    expect(await numberAt("2026-11-30T18:30:00Z", MH)).toBe("CN-MH2026120001");
  });

  it("2 AM IST on 1 January is the new calendar year in the monthly series, same financial year", async () => {
    await settings("monthly");
    expect(await numberAt("2026-12-31T20:30:00Z", MH)).toBe("CN-MH2027010001");
  });

  it("2 AM IST on 1 April is the new financial year (default and prefixed annual series)", async () => {
    await settings("annual");
    expect(await numberAt("2027-03-31T20:30:00Z", KA)).toBe("CN-20270001");
    expect(await numberAt("2027-03-31T20:30:00Z", MH)).toBe("CN-MH20270001");
    expect(await counterIds()).toEqual(["creditnote:FY2027", `creditnote:FY2027:${MH}`]);
  });

  it("one minute before IST midnight on 31 March is still the old financial year", async () => {
    await settings("annual");
    expect(await numberAt("2027-03-31T18:29:00Z", KA)).toBe("CN-20260001");
    expect(await numberAt("2027-03-31T18:29:00Z", MH)).toBe("CN-MH20260001");
  });

  it("the default series is annual even when the cadence is monthly, and turns over with the IST financial year", async () => {
    await settings("monthly");
    expect(await numberAt("2027-03-31T18:29:00Z", KA)).toBe("CN-20260001");
    expect(await numberAt("2027-03-31T20:30:00Z", KA)).toBe("CN-20270001");
  });
});
