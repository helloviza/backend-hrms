// POST /leads/import/preview + /import/commit — bulk import (ask #6), against
// a REAL leads / crmcompanies / counters collection (mongodb-memory-server)
// through the actual multer + xlsx pipeline (real CSV and XLSX buffers). No
// model mocks: what matters is what lands in Mongo — the row count, the
// atomic LEAD codes, the dedupe flag and that a bad row never half-writes.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import XLSX from "xlsx";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/leads-import-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const ADMIN_ID = new mongoose.Types.ObjectId().toHexString();
const REP_ID = new mongoose.Types.ObjectId().toHexString();

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
const { default: CRMCompany } = await import("../models/CRMCompany.js");
const { default: Counter } = await import("../models/Counter.js");
const { default: User } = await import("../models/User.js");
const { default: router } = await import("./leads.js");
const { CRM_V2_DISPOSITION_ENV, CRM_V2_OPPORTUNITY_ENV } = await import("../config/crmV2.js");

let mongod: MongoMemoryServer;

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/leads", router);
  return a;
}

const CSV = [
  "Name,Phone,Email,Company,Designation,Source,Deal Value,Next Follow-up",
  "Arjun Sethi,9811000456,arjun@onboarded.test,Onboarded Demo Co,Procurement Manager,LinkedIn,180000,20-09-2026",
  "Priya Nair,9811000111,priya@fresh.test,Fresh Ventures,Founder,,50000,",
  "No Phone,,nophone@x.test,Fresh Ventures,CFO,,, ",
  "Rahul Verma,9811000222,rahul@solo.test,,,Referral,not-a-number,",
  "Meera Iyer,9811000333,,onboarded demo co,Travel Desk,,, ",
].join("\n");

const preview = (buf: Buffer, filename: string, fields: Record<string, string> = {}) => {
  let r = request(app()).post("/api/leads/import/preview").attach("file", buf, filename);
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r;
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await User.collection.insertMany([
    { _id: new mongoose.Types.ObjectId(ADMIN_ID), name: "Ops Admin", email: "ops@plumtrips.com", roles: ["ADMIN"], passwordHash: "x" },
    { _id: new mongoose.Types.ObjectId(REP_ID), name: "Imran", email: "imran@plumtrips.com", roles: ["ADMIN"], passwordHash: "x" },
  ] as any[]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([Lead.deleteMany({}), LeadActivity.deleteMany({}), CRMCompany.deleteMany({}), Counter.deleteMany({})]);
});
afterEach(() => {
  delete process.env[CRM_V2_DISPOSITION_ENV];
  delete process.env[CRM_V2_OPPORTUNITY_ENV];
});

async function seedOpenLead() {
  const r = await request(app()).post("/api/leads").send({ contactName: "Existing Person", contactPhone: "9000000000", companyName: "Onboarded Demo Co", stage: "contacted", assignedTo: REP_ID });
  expect(r.status).toBe(201);
  return r.body.lead as any;
}

describe("POST /leads/import/preview", () => {
  it("parses a CSV, suggests the mapping, and flags rows missing required fields — without writing", async () => {
    const r = await preview(Buffer.from(CSV), "leads.csv");
    expect(r.status).toBe(200);
    expect(r.body.columns).toEqual(["Name", "Phone", "Email", "Company", "Designation", "Source", "Deal Value", "Next Follow-up"]);
    expect(r.body.suggestedMapping).toEqual({
      Name: "contactName", Phone: "contactPhone", Email: "contactEmail", Company: "companyName", Designation: "contactDesignation",
      Source: "source", "Deal Value": "dealValue", "Next Follow-up": "nextFollowUpDate",
    });
    expect(r.body.rowCount).toBe(5);
    expect(r.body.summary).toEqual({ total: 5, valid: 3, invalid: 2, flagged: 0 });

    const byRow = Object.fromEntries(r.body.rows.map((x: any) => [x.row, x]));
    expect(byRow[3].valid).toBe(false);
    expect(byRow[3].errors).toEqual(["Contact phone is required"]);
    expect(byRow[4].valid).toBe(false);
    expect(byRow[4].errors).toEqual(["Deal value must be a number"]);
    expect(byRow[1].valid).toBe(true);
    // Rows 2 and 5 share a company with another row in the file (row 3 is invalid, so not counted).
    expect(byRow[5].sameCompanyRowsInFile).toBe(1); // row 1 (Onboarded Demo Co, same key)
    expect(byRow[2].sameCompanyRowsInFile).toBe(0);

    expect(await Lead.countDocuments({})).toBe(0);
    expect(await CRMCompany.countDocuments({})).toBe(0);
  });

  it("reads XLSX too, and surfaces the dedupe warning for a company that already has an open lead", async () => {
    await seedOpenLead();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Full Name", "Mobile", "Organisation"], ["New Person", "9811000999", "ONBOARDED DEMO CO"], ["Other Person", "9811000888", "Nobody Ltd"]]), "Leads");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const r = await preview(buf, "leads.xlsx");
    expect(r.status).toBe(200);
    expect(r.body.suggestedMapping).toEqual({ "Full Name": "contactName", Mobile: "contactPhone", Organisation: "companyName" });
    expect(r.body.summary).toEqual({ total: 2, valid: 2, invalid: 0, flagged: 1 });
    expect(r.body.rows[0].duplicate).toMatchObject({ contactName: "Existing Person", ownerName: "Imran" });
    expect(r.body.rows[0].duplicate.leadCode).toMatch(/^LEAD-/);
    expect(r.body.rows[1].duplicate).toBeNull();
    expect(await Lead.countDocuments({})).toBe(1);
  });

  it("re-validates already-parsed rows under a confirmed mapping (step 3) and honours the batch default source", async () => {
    const r = await request(app()).post("/api/leads/import/preview").send({
      columns: ["Who", "Tel"], rows: [{ Who: "A", Tel: "9811000001" }, { Who: "", Tel: "9811000002" }],
      mapping: { Who: "contactName", Tel: "contactPhone" }, defaults: { source: "LinkedIn" },
    });
    expect(r.status).toBe(200);
    expect(r.body.defaults).toEqual({ source: "linkedin" });
    expect(r.body.summary).toEqual({ total: 2, valid: 1, invalid: 1, flagged: 0 });
    expect(r.body.rows[1].errors).toEqual(["Contact name is required"]);
  });

  it("rejects an unknown batch source", async () => {
    const r = await preview(Buffer.from(CSV), "leads.csv", { defaults: JSON.stringify({ source: "carrier pigeon" }) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Unknown source/);
  });
});

describe("POST /leads/import/commit", () => {
  const rows = () => {
    const parsed = XLSX.utils.sheet_to_json<Record<string, string>>(XLSX.read(Buffer.from(CSV), { type: "buffer", raw: false }).Sheets.Sheet1, { raw: false, defval: "" });
    return parsed.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v ?? "").trim()])));
  };
  const mapping = { Name: "contactName", Phone: "contactPhone", Email: "contactEmail", Company: "companyName", Designation: "contactDesignation", Source: "source", "Deal Value": "dealValue", "Next Follow-up": "nextFollowUpDate" };

  it("creates the valid rows with consecutive atomic codes, skips the invalid ones without half-writing, and flags the dedupe", async () => {
    // Both flags, as the local stack runs: status derives from stage under OPPORTUNITY (the model's pre-validate), same as a single create.
    process.env[CRM_V2_DISPOSITION_ENV] = "true";
    process.env[CRM_V2_OPPORTUNITY_ENV] = "true";
    const existing = await seedOpenLead(); // LEAD-YYYY-0001, owned by Imran, at Onboarded Demo Co

    const r = await request(app()).post("/api/leads/import/commit").send({ rows: rows(), mapping, defaults: { source: "referral" } });
    expect(r.status).toBe(201);
    expect(r.body.summary).toEqual({ total: 5, created: 3, flagged: 2, invalid: 2, failed: 0 });
    expect(r.body.invalid.map((x: any) => x.row)).toEqual([3, 4]);
    expect(r.body.batchId).toMatch(/^IMP-\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/);

    // Codes: the seed took 0001; the three imports draw 0002..0004 from the Counter, in row order.
    const year = new Date().getFullYear();
    expect(r.body.created.map((c: any) => [c.row, c.leadCode])).toEqual([[1, `LEAD-${year}-0002`], [2, `LEAD-${year}-0003`], [5, `LEAD-${year}-0004`]]);
    expect((await Counter.findById(`LEAD-${year}`).lean())?.seq).toBe(4);

    // Dedupe: rows 1 and 5 name the company that already had an open lead — flagged, still created.
    const flagged = r.body.created.filter((c: any) => c.duplicateOf);
    expect(flagged.map((c: any) => c.row)).toEqual([1, 5]);
    expect(flagged[0].duplicateOf).toMatchObject({ leadCode: existing.leadCode, contactName: "Existing Person", ownerName: "Imran" });
    expect(flagged[1].sameCompanyRowsInFile).toBe(1);
    const fresh = r.body.created.find((c: any) => c.row === 2);
    expect(fresh.duplicateOf).toBeNull();

    // What landed: 1 seed + 3 imports; both companies anchored on ONE canonical row each.
    expect(await Lead.countDocuments({})).toBe(4);
    expect(await CRMCompany.countDocuments({})).toBe(2);
    const co = await CRMCompany.findOne({ nameNormalized: "onboarded demo co" }).lean();
    const imported = (await Lead.find({ importBatchId: r.body.batchId }).sort({ leadCode: 1 }).lean()) as any[];
    expect(imported).toHaveLength(3);
    expect(imported.map((l) => String(l.companyId))).toEqual([String(co!._id), expect.any(String), String(co!._id)]);
    expect(imported.map((l) => l.possibleDuplicateOf?.toString() ?? null)).toEqual([existing._id, null, existing._id]);

    // Field mapping + defaults + fresh-lead state.
    const arjun = imported[0];
    expect(arjun).toMatchObject({ contactName: "Arjun Sethi", contactEmail: "arjun@onboarded.test", contactDesignation: "Procurement Manager", source: "linkedin", dealValue: 180000, currency: "INR", stage: "new", status: "NEW", disposition: "", dispositionStatus: "", assignedToName: "Ops Admin" });
    expect(String(arjun.assignedTo)).toBe(ADMIN_ID);
    expect(new Date(arjun.nextFollowUpDate).toISOString()).toBe("2026-09-20T00:00:00.000Z");
    expect(imported[1]).toMatchObject({ contactName: "Priya Nair", source: "referral", type: "company" }); // blank source → batch default
    expect(imported[2]).toMatchObject({ contactName: "Meera Iyer", type: "company", companyName: "onboarded demo co" });
    expect(imported[2].opportunityId ?? null).toBeNull();

    // Timeline record: one import note per created lead, the flagged ones say why.
    const notes = (await LeadActivity.find({ leadId: { $in: imported.map((l) => l._id) }, type: "note" }).lean()) as any[];
    expect(notes).toHaveLength(3);
    expect(notes.find((n) => String(n.leadId) === String(arjun._id)).note).toMatch(new RegExp(`Imported in batch ${r.body.batchId}.*Possible duplicate.*${existing.leadCode}.*owned by Imran`));
  });

  it("assigns to a chosen owner, and refuses an unknown one", async () => {
    const r = await request(app()).post("/api/leads/import/commit").send({ rows: rows().slice(0, 2), mapping, defaults: { source: "other" }, assignedTo: REP_ID });
    expect(r.status).toBe(201);
    expect(r.body.summary.created).toBe(2);
    const leads = (await Lead.find({}).lean()) as any[];
    expect(leads.every((l) => String(l.assignedTo) === REP_ID && l.assignedToName === "Imran")).toBe(true);

    const bad = await request(app()).post("/api/leads/import/commit").send({ rows: rows().slice(0, 1), mapping, defaults: {}, assignedTo: new mongoose.Types.ObjectId().toHexString() });
    expect(bad.status).toBe(400);
    expect(await Lead.countDocuments({})).toBe(2);
  });

  it("refuses a batch with no valid rows and writes nothing", async () => {
    const r = await request(app()).post("/api/leads/import/commit").send({ rows: [{ Name: "Nobody", Phone: "" }], mapping: { Name: "contactName", Phone: "contactPhone" }, defaults: {} });
    expect(r.status).toBe(400);
    expect(r.body.invalid).toEqual([{ row: 1, errors: ["Contact phone is required"] }]);
    expect(await Lead.countDocuments({})).toBe(0);
    expect(await CRMCompany.countDocuments({})).toBe(0);
  });

  it("caps a batch at 1000 rows", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({ Name: `P${i}`, Phone: `98110${String(i).padStart(5, "0")}` }));
    const r = await request(app()).post("/api/leads/import/commit").send({ rows: many, mapping: { Name: "contactName", Phone: "contactPhone" }, defaults: {} });
    expect(r.status).toBe(400);
    expect(await Lead.countDocuments({})).toBe(0);
  });
});
