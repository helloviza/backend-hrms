// CRM export/report timezone — the attendance-P0 class of bug in routes/leads.
// The server runs UTC; every user is IST. Real Mongo (memory server) and the
// real router; auth is stubbed to an ADMIN (whole-collection scope). Run it
// under TZ=UTC (prod's zone) — that is where the old code breaks:
//
//   • the activity export's "Date & Time" is IST (12:31 pm, not 07:01 am) and
//     agrees with the on-screen ActivityTimeline for an IST viewer
//   • the activity export's date filter keeps the whole IST day — including
//     00:00–05:30 IST — and nothing of the days either side, for both the
//     "YYYY-MM-DD" (/crm/reports) and ISO-instant (/crm dashboard) param shapes
//   • /reports/owner-status bounds its range on the same IST day
//   • the leads export writes IST dates (a 00:30 IST lead is not a day early)
//     and filters its createdAt range on the IST day
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import ExcelJS from "exceljs";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/leads-tz-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const ADMIN_ID = new mongoose.Types.ObjectId().toHexString();
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: ADMIN_ID, sub: ADMIN_ID, roles: ["ADMIN"], email: "ops@plumtrips.com", name: "Ops Admin" };
    next();
  },
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireHouse.js", () => ({
  requireHouse: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

const { default: Lead } = await import("../models/Lead.js");
const { default: LeadActivity } = await import("../models/LeadActivity.js");
const { default: leadsRouter } = await import("./leads.js");

let mongod: MongoMemoryServer;
const app = express();
app.use(express.json());
app.use("/api/leads", leadsRouter);

// Instants around the IST day 2026-09-23 (= 2026-09-22T18:30Z .. 2026-09-23T18:29:59.999Z).
const AT = {
  prev2350: new Date("2026-09-22T18:20:00Z"), // 22 Sep 23:50 IST — the day before
  d0030: new Date("2026-09-22T19:00:00Z"), //    23 Sep 00:30 IST — UTC still says the 22nd
  d0500: new Date("2026-09-22T23:30:00Z"), //    23 Sep 05:00 IST — UTC still says the 22nd
  d1231: new Date("2026-09-23T07:01:00Z"), //    23 Sep 12:31 IST — the reported sample
  d2350: new Date("2026-09-23T18:20:00Z"), //    23 Sep 23:50 IST — UTC agrees
  next0030: new Date("2026-09-23T19:00:00Z"), // 24 Sep 00:30 IST — the day after, UTC says the 23rd
};
const IN_DAY = ["d0030", "d0500", "d1231", "d2350"];
// The two shapes the frontends send for "23 Sept".
const DAY_YMD = "dateFrom=2026-09-23&dateTo=2026-09-23";
const DAY_ISO = `dateFrom=${encodeURIComponent("2026-09-22T18:30:00.000Z")}&dateTo=${encodeURIComponent("2026-09-23T18:29:59.999Z")}`;

let seq = 0;
async function lead(o: Record<string, any> = {}) {
  seq += 1;
  const _id = new mongoose.Types.ObjectId();
  const at = o.createdAt ?? new Date("2026-01-01T06:30:00Z");
  await Lead.collection.insertOne({
    _id, leadCode: `LEAD-TZ-${String(seq).padStart(4, "0")}`, type: "company", companyName: `Co ${seq}`, contactName: `Person ${seq}`,
    contactPhone: `9${String(seq).padStart(9, "0")}`, stage: "new", source: "manual", dealValue: 0, currency: "INR",
    nextFollowUpDate: null, createdAt: at, updatedAt: at, ...o,
  } as any);
  return _id;
}
async function activity(leadId: mongoose.Types.ObjectId, note: string, createdAt: Date) {
  await LeadActivity.collection.insertOne({ _id: new mongoose.Types.ObjectId(), leadId, type: "note", note, createdByName: "Rep", createdAt, updatedAt: createdAt } as any);
}

async function xlsx(path: string): Promise<Record<string, string>[]> {
  const res = await request(app)
    .get(path)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  expect(res.status).toBe(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body as any);
  const sheet = wb.worksheets[0];
  const header = (sheet.getRow(1).values as any[]).slice(1).map(String);
  const rows: Record<string, string>[] = [];
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const v = (row.values as any[]).slice(1);
    rows.push(Object.fromEntries(header.map((h, i) => [h, v[i] == null ? "" : String(v[i])])));
  });
  return rows;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all([Lead.deleteMany({}), LeadActivity.deleteMany({})]);
});

describe("activity export — Date & Time column", () => {
  it("renders IST: an activity at 12:31 pm IST (07:01Z) shows 12:31 pm, not 07:01 am", async () => {
    const id = await lead();
    await activity(id, "sample", AT.d1231);
    const [row] = await xlsx("/api/leads/export/activities");
    expect(row["Date & Time"]).toMatch(/^23 Sept? 2026, 12:31\s?pm$/i);
    expect(row["Date & Time"]).not.toMatch(/07:01/);
  });
  it("agrees with the on-screen ActivityTimeline for an IST viewer, across the 00:00–05:30 window", async () => {
    const id = await lead();
    await activity(id, "early", AT.d0030);
    const [row] = await xlsx("/api/leads/export/activities");
    // ActivityTimeline.tsx formats in the browser zone; an IST browser is timeZone Asia/Kolkata.
    const screen = AT.d0030.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
    const clock = (s: string) => {
      const m = s.match(/(\d{1,2}):(\d{2})\s?([ap]m)/i)!;
      return `${Number(m[1])}:${m[2]} ${m[3].toLowerCase()}`;
    };
    const day = (s: string) => Number(s.match(/^(\d{1,2})/)![1]);
    expect(clock(row["Date & Time"])).toBe("12:30 am");
    expect(clock(row["Date & Time"])).toBe(clock(screen));
    expect(day(row["Date & Time"])).toBe(23);
    expect(day(row["Date & Time"])).toBe(day(screen));
  });
});

describe("activity export — date-range filter is the IST day", () => {
  for (const [shape, qs] of [["YYYY-MM-DD", DAY_YMD], ["ISO instant", DAY_ISO]] as const) {
    it(`"23 Sept" (${shape}) keeps 00:00–05:30 IST and drops the days either side`, async () => {
      const id = await lead();
      for (const [k, at] of Object.entries(AT)) await activity(id, k, at);
      const notes = (await xlsx(`/api/leads/export/activities?${qs}`)).map((r) => r["Note / Description"]).sort();
      expect(notes).toEqual([...IN_DAY].sort());
    });
  }
});

describe("/reports/owner-status — range is the IST day", () => {
  for (const [shape, qs] of [["YYYY-MM-DD", DAY_YMD], ["ISO instant", DAY_ISO]] as const) {
    it(`"23 Sept" (${shape}) counts the 00:00–05:30 IST leads and not the neighbours`, async () => {
      for (const at of Object.values(AT)) await lead({ createdAt: at }); // no activities ⇒ last_activity_date = createdAt
      const res = await request(app).get(`/api/leads/reports/owner-status?${qs}`);
      expect(res.status).toBe(200);
      expect(res.body.filters.dateFrom).toBe("2026-09-22T18:30:00.000Z");
      expect(res.body.filters.dateTo).toBe("2026-09-23T18:29:59.999Z");
      expect(res.body.totals.totalLeads).toBe(IN_DAY.length);
    });
  }
});

describe("leads export — dates are IST", () => {
  it("Created At / Next Follow Up / Won Date of a 00:30 IST record read the IST date, not the day before", async () => {
    await lead({ createdAt: AT.d0030, nextFollowUpDate: AT.d0500, wonDate: AT.d0030, stage: "won" });
    const [row] = await xlsx("/api/leads/export");
    expect(row["Created At"]).toBe("23/09/2026");
    expect(row["Next Follow Up"]).toBe("23/09/2026");
    expect(row["Won Date"]).toBe("23/09/2026");
  });
  it("normal hours are unchanged, and late evening IST does not roll forward", async () => {
    await lead({ createdAt: AT.d2350 });
    const [row] = await xlsx("/api/leads/export");
    expect(row["Created At"]).toBe("23/09/2026");
  });
  it(`createdAt range "23 Sept" keeps the whole IST day (shared resolver)`, async () => {
    for (const [k, at] of Object.entries(AT)) await lead({ createdAt: at, companyName: k });
    for (const qs of [DAY_YMD, DAY_ISO]) {
      const names = (await xlsx(`/api/leads/export?${qs}`)).map((r) => r["Company Name"]).sort();
      expect(names).toEqual([...IN_DAY].sort());
    }
  });
});
