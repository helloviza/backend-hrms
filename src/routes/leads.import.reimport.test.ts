// GET /leads/import/template + the re-import columns (owner, disposition /
// subDisposition, status / stage, createdDate, dispositionDate) through the
// real preview → commit pipeline against mongodb-memory-server, both CRM_V2
// flags on. What matters is what lands: the owner resolved per row, the
// original created date preserved, the disposition derived exactly as the
// live flow (opportunity + contact for Onboarded), and every bad row rejected
// with a readable reason — never silently dropped or self-assigned.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import XLSX from "xlsx";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/leads-reimport-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const HOUSE = "69679a7628330a58d29f2254";
const ids = {
  ADMIN: new mongoose.Types.ObjectId().toHexString(),
  IMRAN: new mongoose.Types.ObjectId().toHexString(),
  REP: new mongoose.Types.ObjectId().toHexString(),
  NOCRM: new mongoose.Types.ObjectId().toHexString(),
};
const USERS: Record<string, any> = {
  admin: { id: ids.ADMIN, sub: ids.ADMIN, roles: ["ADMIN"], email: "ops@plumtrips.com", name: "Ops Admin" },
  imran: { id: ids.IMRAN, sub: ids.IMRAN, roles: ["ADMIN"], email: "imran@plumtrips.com", name: "Imran Ali Khan" },
  rep: { id: ids.REP, sub: ids.REP, roles: ["EMPLOYEE"], email: "rep@plumtrips.com", name: "Own Rep" },
  nocrm: { id: ids.NOCRM, sub: ids.NOCRM, roles: ["EMPLOYEE"], email: "nocrm@plumtrips.com", name: "No Crm" },
};

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = USERS[String(req.headers["x-test-user"] || "admin")];
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
const { default: Opportunity } = await import("../models/Opportunity.js");
const { default: CRMContact } = await import("../models/CRMContact.js");
const { default: CRMCompany } = await import("../models/CRMCompany.js");
const { default: Counter } = await import("../models/Counter.js");
const { default: User } = await import("../models/User.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { default: router } = await import("./leads.js");
const { IMPORT_FIELDS } = await import("../services/leadImport.js");
const { CRM_V2_DISPOSITION_ENV, CRM_V2_OPPORTUNITY_ENV } = await import("../config/crmV2.js");

let mongod: MongoMemoryServer;
function app() {
  const a = express();
  a.use(express.json({ limit: "5mb" }));
  a.use("/api/leads", router);
  return a;
}
const as = (who: string) => ({ "x-test-user": who });
const KEYS = IMPORT_FIELDS.map((f) => f.key);
const identity = Object.fromEntries(KEYS.map((k) => [k, k]));
/** A template-shaped row: every column present, blanks for what's not given. */
const row = (o: Partial<Record<(typeof KEYS)[number], string>>) => Object.fromEntries(KEYS.map((k) => [k, o[k] ?? ""]));

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Opportunity.syncIndexes();
  const house = new mongoose.Types.ObjectId(HOUSE);
  await User.collection.insertMany(Object.values(USERS).map((u) => ({ _id: new mongoose.Types.ObjectId(u.id), name: u.name, email: u.email, roles: u.roles, passwordHash: "x", workspaceId: house })) as any[]);
  await UserPermission.create([{
    userId: ids.REP, email: "rep@plumtrips.com", workspaceId: HOUSE, universe: "STAFF", level: { code: "L2", name: "Executive" },
    modules: { leads: { access: "WRITE", scope: "OWN" } }, grantedBy: ids.ADMIN,
  }] as any);
  process.env[CRM_V2_DISPOSITION_ENV] = "true";
  process.env[CRM_V2_OPPORTUNITY_ENV] = "true";
}, 120_000);
afterAll(async () => {
  delete process.env[CRM_V2_DISPOSITION_ENV];
  delete process.env[CRM_V2_OPPORTUNITY_ENV];
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all([Lead.deleteMany({}), LeadActivity.deleteMany({}), Opportunity.deleteMany({}), CRMContact.deleteMany({}), CRMCompany.deleteMany({}), Counter.deleteMany({})]);
});

describe("GET /leads/import/template", () => {
  it("is an XLSX whose first sheet's header is exactly the importer's field keys, with a valid example row and the vocabulary sheet", async () => {
    const r = await request(app()).get("/api/leads/import/template").set(as("imran")).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/spreadsheetml/);
    const wb = XLSX.read(r.body as Buffer, { type: "buffer" });
    expect(wb.SheetNames).toEqual(["Leads", "Lists", "Allowed values"]);

    const grid: any[][] = XLSX.utils.sheet_to_json(wb.Sheets.Leads, { header: 1, raw: false, defval: "" });
    expect(grid[0]).toEqual(KEYS);
    expect(grid).toHaveLength(2); // header + one example row
    const example = Object.fromEntries(KEYS.map((k, i) => [k, String(grid[1][i] ?? "")]));
    expect(example).toMatchObject({ contactName: "Kavya Rao", owner: "imran@plumtrips.com", disposition: "Interested", subDisposition: "Follow up Required", currency: "INR" });
    expect(example.createdDate).toMatch(/^\d{2}-\d{2}-\d{4}$/);

    // The vocabulary: the full disposition set, grouped, and the reps with their emails.
    const av: any[][] = XLSX.utils.sheet_to_json(wb.Sheets["Allowed values"], { header: 1, raw: false, defval: "" });
    const flat = av.map((r) => r.join("|")).join("\n");
    for (const sub of ["Call Back Time Given", "Follow up Required", "Trust Issue", "Number Does not Exist", "Onboarded"]) expect(flat).toContain(sub);
    expect(flat).toContain("Interested|Follow up Required|In-progress|Open|CONVERTED|follow_up|YES|opened / synced at qualified");
    expect(flat).toContain("Onboarded|Onboarded|Onboarded|Won|CONVERTED|won||closed-won + CRM contact");
    expect(flat).toContain("Imran Ali Khan|imran@plumtrips.com");
    expect(flat).toContain("Own Rep|rep@plumtrips.com");
    expect(flat).not.toContain("nocrm@plumtrips.com"); // no leads access → not a rep
    for (const s of ["NEW", "CONTACTED", "CONVERTED", "LOST", "proposal_sent", "Cold Call", "AED"]) expect(flat).toContain(s);

    // The example row, fed straight back through the real parser, is a valid row that resolves as documented.
    const p = await request(app()).post("/api/leads/import/preview").set(as("imran")).attach("file", r.body as Buffer, "leads-import-template.xlsx");
    expect(p.status).toBe(200);
    expect(p.body.suggestedMapping).toEqual(identity);
    expect(p.body.summary).toEqual({ total: 1, valid: 1, invalid: 0, flagged: 0 });
    expect(p.body.rows[0].resolved).toMatchObject({ ownerName: "Imran Ali Khan", stage: "follow_up", status: "CONVERTED", disposition: { disposition: "Interested", subDisposition: "Follow up Required", stage: "In-progress", status: "Open", opportunityEffect: "open" } });
    expect(p.body.rows[0].resolved.createdAt).toMatch(/T00:00:00\.000Z$/);
    expect(await Lead.countDocuments({})).toBe(0);
  });
});

describe("POST /leads/import/commit — re-import columns", () => {
  const FIVE = [
    // 1 · Interested, owner by email, original dates → open opportunity at qualified
    row({ contactName: "Arjun Sethi", contactPhone: "9811000456", contactEmail: "arjun@northwind.test", companyName: "Northwind Logistics", source: "LinkedIn", owner: "imran@plumtrips.com", disposition: "Interested", subDisposition: "Follow up Required", dealValue: "1,80,000", nextFollowUpDate: "20-09-2026", followUpNotes: "Send proposal", createdDate: "14-03-2026", dispositionDate: "2026-04-01T09:30:00.000Z" }),
    // 2 · Onboarded (sub omitted — unique), owner by exact name → closed-won opportunity + contact, wonDate = dispositionDate
    row({ contactName: "Priya Nair", contactPhone: "9811000111", contactEmail: "priya@fresh.test", contactDesignation: "Founder", companyName: "Fresh Ventures", owner: "Ops Admin", disposition: "Onboarded", dealValue: "500000", currency: "usd", createdDate: "05-12-2025", dispositionDate: "10-02-2026" }),
    // 3 · Not Interested, owner blank → batch default; lost at the lead grain, no opportunity
    row({ contactName: "Meera Iyer", contactPhone: "9811000333", companyName: "Bluefin Media", subDisposition: "trust issue", createdDate: "2026-01-20", notes: "Burnt by a previous vendor" }),
    // 4 · legacy-only row: no disposition, explicit stage; status derived
    row({ contactName: "Rahul Verma", contactPhone: "9811000222", stage: "Proposal Sent", createdDate: "01-06-2026", dispositionDate: "02-06-2026" }),
    // 5 · unknown owner → rejected
    row({ contactName: "Sana Qureshi", contactPhone: "9811000904", companyName: "Nobody Ltd", owner: "nobody@plumtrips.com", disposition: "Interested", subDisposition: "Demo Scheduled" }),
  ];

  it("resolves owners, preserves original dates, derives stage/status/opportunity/contact from the disposition, and rejects the bad row with a reason", async () => {
    const before = Date.now();
    const r = await request(app()).post("/api/leads/import/commit").set(as("admin")).send({ rows: FIVE, mapping: identity, defaults: { source: "referral" } });
    expect(r.status).toBe(201);
    expect(r.body.summary).toEqual({ total: 5, created: 4, flagged: 0, invalid: 1, failed: 0, dispositioned: 3 });
    expect(r.body.invalid).toEqual([{ row: 5, errors: ['Owner "nobody@plumtrips.com" is not a CRM rep — use a rep email from the Allowed values sheet'] }]);

    const byRow = Object.fromEntries(r.body.created.map((c: any) => [c.row, c]));
    // Owners: email, exact name, blank → batch default (the importer).
    expect(byRow[1]).toMatchObject({ ownerId: ids.IMRAN, ownerName: "Imran Ali Khan" });
    expect(byRow[2]).toMatchObject({ ownerId: ids.ADMIN, ownerName: "Ops Admin" });
    expect(byRow[3]).toMatchObject({ ownerId: ids.ADMIN, ownerName: "Ops Admin" });
    expect(byRow[4]).toMatchObject({ ownerId: ids.ADMIN, ownerName: "Ops Admin" });

    const leads = Object.fromEntries(((await Lead.find({ importBatchId: r.body.batchId }).lean()) as any[]).map((l) => [l.contactName, l]));
    expect(Object.keys(leads).sort()).toEqual(["Arjun Sethi", "Meera Iyer", "Priya Nair", "Rahul Verma"]);

    // ── row 1: created date preserved (dd-mm-yyyy → UTC midnight), disposition date preserved (ISO), Interested → open opp ──
    const arjun = leads["Arjun Sethi"];
    expect(new Date(arjun.createdAt).toISOString()).toBe("2026-03-14T00:00:00.000Z");
    expect(new Date(arjun.dispositionAt).toISOString()).toBe("2026-04-01T09:30:00.000Z");
    expect(new Date(arjun.nextFollowUpDate).toISOString()).toBe("2026-09-20T00:00:00.000Z");
    expect(arjun).toMatchObject({ source: "linkedin", dealValue: 180000, currency: "INR", disposition: "Interested", subDisposition: "Follow up Required", dispositionStage: "In-progress", dispositionStatus: "Open", stage: "follow_up", status: "CONVERTED", followUpNotes: "Send proposal" });
    expect(String(arjun.assignedTo)).toBe(ids.IMRAN);
    expect(arjun.pipelineId).toBeTruthy();
    const arjunOpp = (await Opportunity.findById(arjun.opportunityId).lean()) as any;
    expect(arjunOpp).toMatchObject({ stage: "qualified", pipeline: "corporate", dealValue: 180000, name: "Northwind Logistics" });
    expect(String(arjunOpp.ownerUserId)).toBe(ids.IMRAN);
    expect(String(arjunOpp.leadId)).toBe(String(arjun._id));
    expect(new Date(arjunOpp.createdAt).toISOString()).toBe("2026-04-01T09:30:00.000Z");
    expect(arjunOpp.closedAt).toBeNull();
    expect(byRow[1].disposition).toMatchObject({ disposition: "Interested", subDisposition: "Follow up Required", stage: "In-progress", status: "Open", leadStatus: "CONVERTED", legacyStage: "follow_up", at: "2026-04-01T09:30:00.000Z", opportunity: { id: String(arjunOpp._id), created: true, stage: "qualified", effect: "open" }, contact: null });

    // ── row 2: Onboarded → Won/Onboarded, closed-won opp, CRM contact + company, wonDate = dispositionDate ──
    const priya = leads["Priya Nair"];
    expect(new Date(priya.createdAt).toISOString()).toBe("2025-12-05T00:00:00.000Z");
    expect(new Date(priya.dispositionAt).toISOString()).toBe("2026-02-10T00:00:00.000Z");
    expect(new Date(priya.wonDate).toISOString()).toBe("2026-02-10T00:00:00.000Z");
    expect(priya).toMatchObject({ disposition: "Onboarded", subDisposition: "Onboarded", dispositionStage: "Onboarded", dispositionStatus: "Won", stage: "won", status: "CONVERTED", currency: "USD", dealValue: 500000 });
    expect(String(priya.assignedTo)).toBe(ids.ADMIN);
    const priyaOpp = (await Opportunity.findById(priya.opportunityId).lean()) as any;
    expect(priyaOpp).toMatchObject({ stage: "closed_won", dealValue: 500000, currency: "USD" });
    expect(new Date(priyaOpp.closedAt).toISOString()).toBe("2026-02-10T00:00:00.000Z");
    const contact = (await CRMContact.findById(priya.convertedToContactId).lean()) as any;
    expect(contact).toMatchObject({ firstName: "Priya", lastName: "Nair", email: "priya@fresh.test", jobTitle: "Founder", companyName: "Fresh Ventures" });
    expect(String(contact.leadId)).toBe(String(priya._id));
    expect(String(priyaOpp.primaryContactId)).toBe(String(contact._id));
    const co = (await CRMCompany.findOne({ nameNormalized: "fresh ventures" }).lean()) as any;
    expect(String(priya.companyId)).toBe(String(co._id));
    expect(String(priya.convertedToCompanyId)).toBe(String(co._id));
    expect(byRow[2].disposition).toMatchObject({ status: "Won", opportunity: { created: true, stage: "closed_won", effect: "won" }, contact: { id: String(contact._id), how: "created" } });

    // ── row 3: Not Interested (sub matched case-insensitively) → Lost/Lost, lostReason, NO opportunity (never Interested) ──
    const meera = leads["Meera Iyer"];
    expect(new Date(meera.createdAt).toISOString()).toBe("2026-01-20T00:00:00.000Z");
    expect(meera).toMatchObject({ source: "referral", disposition: "Not Interested", subDisposition: "Trust Issue", dispositionStage: "Lost", dispositionStatus: "Lost", stage: "lost", status: "LOST", lostReason: "Trust Issue" });
    expect(meera.opportunityId ?? null).toBeNull();
    expect(new Date(meera.dispositionAt).getTime()).toBeGreaterThanOrEqual(before); // blank dispositionDate = import time
    expect(byRow[3].disposition).toMatchObject({ status: "Lost", opportunity: null, contact: null });

    // ── row 4: legacy-only → explicit stage, status derived by the model hook, no disposition, dispositionDate ignored ──
    const rahul = leads["Rahul Verma"];
    expect(new Date(rahul.createdAt).toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(rahul).toMatchObject({ type: "individual", stage: "proposal_sent", status: "CONVERTED", disposition: "", dispositionStatus: "" });
    expect(rahul.dispositionAt ?? null).toBeNull();
    expect(rahul.opportunityId ?? null).toBeNull();
    expect(byRow[4].disposition).toBeNull();

    // Only three opportunities/contacts in total: rows 1 + 2 opps, row 2 contact. The rejected row wrote nothing.
    expect(await Opportunity.countDocuments({})).toBe(2);
    expect(await CRMContact.countDocuments({})).toBe(1);
    expect(await Lead.countDocuments({ contactName: "Sana Qureshi" })).toBe(0);
    expect(await CRMCompany.countDocuments({ nameNormalized: "nobody ltd" })).toBe(0);

    // Timeline: the import note, the disposition activity (stamped at the original disposition date) and the opportunity stage_change.
    const acts = (await LeadActivity.find({ leadId: arjun._id }).sort({ createdAt: 1 }).lean()) as any[];
    expect(acts.map((a) => a.type)).toEqual(["disposition", "note", "stage_change"]);
    expect(new Date(acts[0].createdAt).toISOString()).toBe("2026-04-01T09:30:00.000Z");
    expect(acts[0].disposition.to).toEqual({ disposition: "Interested", subDisposition: "Follow up Required", stage: "In-progress", status: "Open" });
    expect(acts[0].note).toBe("Send proposal");
    expect(acts[1].note).toMatch(/^Imported in batch IMP-/);
  });

  it("rejects every malformed re-import cell with the reason, in preview, without writing", async () => {
    const bad = [
      row({ contactName: "A", contactPhone: "9811000001", disposition: "Interested", subDisposition: "Trust Issue" }),
      row({ contactName: "B", contactPhone: "9811000002", disposition: "Interested" }),
      row({ contactName: "C", contactPhone: "9811000003", subDisposition: "Call Back Time Given" }),
      row({ contactName: "D", contactPhone: "9811000004", subDisposition: "Ringing Only", createdDate: "01-01-2999" }),
      row({ contactName: "E", contactPhone: "9811000005", createdDate: "10-05-2026", dispositionDate: "01-05-2026", subDisposition: "Switched off" }),
      row({ contactName: "F", contactPhone: "9811000006", stage: "won", status: "banana" }),
      row({ contactName: "G", contactPhone: "9811000007", subDisposition: "Follow up Required", nextFollowUpDate: "25-09-2026", stage: "won", status: "LOST" }),
      row({ contactName: "H", contactPhone: "9811000008", owner: "Own Rep", subDisposition: "Not a thing" }),
      row({ contactName: "I", contactPhone: "9811000009", createdDate: "yesterday" }),
    ];
    const r = await request(app()).post("/api/leads/import/preview").set(as("admin")).send({ columns: KEYS, rows: bad, mapping: identity, defaults: {} });
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.rows.map((x: any) => [x.row, x]));
    expect(by[1].errors).toEqual(['Sub-disposition "Trust Issue" belongs to "Not Interested", not "Interested"']);
    expect(by[2].errors).toEqual(['Disposition "Interested" needs a subDisposition (one of: Follow up Required, Introduction Email Sent, Proposal Mail Required, Proposal Mail Sent, Demo Scheduled, Negotiation in Progress, Agreement in Progress, NDA in Progress)']);
    expect(by[3].errors).toEqual(['"Call Back Time Given" needs a next follow-up date']);
    expect(by[4].errors).toEqual(["Created date is in the future"]);
    expect(by[5].errors).toEqual(["Disposition date is before the created date"]);
    expect(by[6].errors).toEqual(['Status "banana" isn\'t one of: NEW, ASSIGNED, CONTACTED, ENGAGED, QUALIFIED, CONVERTED, NURTURE, LOST']);
    // 7 is VALID: with a disposition the stage/status cells are ignored, with a warning each.
    expect(by[7].valid).toBe(true);
    expect(by[7].warnings).toEqual(['Stage "won" ignored — "Follow up Required" derives stage follow_up', 'Status "LOST" ignored — "Follow up Required" derives status CONVERTED']);
    expect(by[7].resolved).toMatchObject({ stage: "follow_up", status: "CONVERTED" });
    expect(by[8].errors).toEqual(['"Not a thing" is not a sub-disposition — see the Allowed values sheet']);
    expect(by[8].resolved).toBeNull();
    expect(by[9].errors).toEqual(["Created date isn't a date (use dd-mm-yyyy or ISO)"]);
    expect(r.body.summary).toEqual({ total: 9, valid: 1, invalid: 8, flagged: 0 });
    expect(await Lead.countDocuments({})).toBe(0);
  });

  it("OWN scope: an owner cell naming another rep is rejected; naming yourself (or blank) lands on you", async () => {
    const rows = [
      row({ contactName: "Mine", contactPhone: "9811000010", owner: "rep@plumtrips.com" }),
      row({ contactName: "Blank", contactPhone: "9811000011" }),
      row({ contactName: "Theirs", contactPhone: "9811000012", owner: "imran@plumtrips.com" }),
    ];
    const r = await request(app()).post("/api/leads/import/commit").set(as("rep")).send({ rows, mapping: identity, defaults: {}, assignedTo: ids.IMRAN });
    expect(r.status).toBe(201);
    expect(r.body.summary).toMatchObject({ created: 2, invalid: 1 });
    expect(r.body.invalid).toEqual([{ row: 3, errors: ['Owner "imran@plumtrips.com" is another rep — you can only import leads owned by you'] }]);
    const leads = (await Lead.find({}).lean()) as any[];
    expect(leads).toHaveLength(2);
    expect(leads.every((l) => String(l.assignedTo) === ids.REP && l.assignedToName === "Own Rep")).toBe(true); // body.assignedTo ignored under OWN
  });

  it("with CRM_V2_DISPOSITION off, a disposition cell is rejected and the template carries no disposition set", async () => {
    delete process.env[CRM_V2_DISPOSITION_ENV];
    try {
      const r = await request(app()).post("/api/leads/import/preview").set(as("admin")).send({ columns: KEYS, rows: [row({ contactName: "A", contactPhone: "9811000001", subDisposition: "Onboarded" }), row({ contactName: "B", contactPhone: "9811000002", stage: "contacted", createdDate: "01-02-2026" })], mapping: identity, defaults: {} });
      expect(r.status).toBe(200);
      expect(r.body.defaults.dispositionsEnabled).toBe(false);
      expect(r.body.rows[0].errors).toEqual(["Dispositions are not enabled on this server (CRM_V2_DISPOSITION) — leave disposition / subDisposition blank"]);
      expect(r.body.rows[1].valid).toBe(true);
      expect(r.body.rows[1].resolved).toMatchObject({ stage: "contacted", createdAt: "2026-02-01T00:00:00.000Z" });

      const t = await request(app()).get("/api/leads/import/template").set(as("admin")).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); });
      const wb = XLSX.read(t.body as Buffer, { type: "buffer" });
      const grid: any[][] = XLSX.utils.sheet_to_json(wb.Sheets.Leads, { header: 1, raw: false, defval: "" });
      const example = Object.fromEntries(KEYS.map((k, i) => [k, String(grid[1][i] ?? "")]));
      expect(example).toMatchObject({ disposition: "", subDisposition: "", stage: "contacted", status: "CONTACTED" });
    } finally {
      process.env[CRM_V2_DISPOSITION_ENV] = "true";
    }
  });
});
