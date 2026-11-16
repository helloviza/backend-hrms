// Leads list / export line up with the disposition set (audit P2-4, P2-6).
// Real Mongo (memory server), the real router, two callers:
//   admin  role ADMIN               → ALL scope
//   rep    leads WRITE / OWN        → only their own leads
//
//   • GET /leads ?disposition= / ?subDisposition= — case-insensitive EXACT
//     match, AND-ed with the caller's scope and every other filter; a retired
//     sub still finds its old leads; legacy rows never match
//   • /counts-by-stage and /pipeline-summary follow the same filter (the tabs
//     and kanban headers count what the columns show)
//   • POST /bulk target.filter honours it (same leadListFilter)
//   • GET /dispositions?includeInactive=1 lists the retired subs (filter only)
//   • /export adds Disposition / Sub-disposition / Disposition Status /
//     Disposition Date and keeps every existing column; the file re-imports
//   • /export/activities adds Disposition From / To on disposition rows
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import ExcelJS from "exceljs";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/leads-dispo-filter-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const ids = {
  ADMIN: new mongoose.Types.ObjectId().toHexString(),
  REP: new mongoose.Types.ObjectId().toHexString(),
  OTHER: new mongoose.Types.ObjectId().toHexString(),
};
const USERS: Record<string, any> = {
  admin: { id: ids.ADMIN, sub: ids.ADMIN, roles: ["ADMIN"], email: "ops@plumtrips.com", name: "Ops Admin" },
  rep: { id: ids.REP, sub: ids.REP, roles: ["EMPLOYEE"], email: "rep@plumtrips.com", name: "Rep" },
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
const { default: User } = await import("../models/User.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { default: leadsRouter } = await import("./leads.js");
const { ensureDefaultPipeline } = await import("../services/crmPipelines.js");
const { CRM_V2_DISPOSITION_ENV, CRM_V2_OPPORTUNITY_ENV } = await import("../config/crmV2.js");

let mongod: MongoMemoryServer;
const app = express();
app.use(express.json());
app.use("/api/leads", leadsRouter);
type Who = "admin" | "rep";
const get = (who: Who, path: string) => request(app).get(`/api/leads${path}`).set("x-test-user", who);

const REP = new mongoose.Types.ObjectId(ids.REP);
const OTHER = new mongoose.Types.ObjectId(ids.OTHER);
const now = new Date();
let seq = 0;
async function lead(o: Record<string, any> = {}) {
  seq += 1;
  const _id = new mongoose.Types.ObjectId();
  await Lead.collection.insertOne({
    _id, leadCode: `LEAD-DF-${String(seq).padStart(4, "0")}`, type: "company", companyName: `Co ${seq}`, contactName: `Person ${seq}`,
    contactPhone: `98${String(seq).padStart(8, "0")}`, stage: "new", source: "manual", dealValue: 1000, currency: "INR",
    nextFollowUpDate: null, createdAt: now, updatedAt: now, ...o,
  } as any);
  return _id;
}
/** A lead stamped the way a disposition leaves it. */
const on = (disposition: string, subDisposition: string, stage: string, status: string, o: Record<string, any> = {}) =>
  lead({ disposition, subDisposition, dispositionStage: status === "Lost" ? "Lost" : status === "Won" ? "Onboarded" : "In-progress", dispositionStatus: status, dispositionAt: new Date("2026-11-03T06:30:00Z"), stage, ...o });

async function xlsx(who: Who, path: string): Promise<{ header: string[]; rows: Record<string, string>[]; buf: Buffer }> {
  const res = await get(who, path).buffer(true).parse((r, cb) => {
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
  return { header, rows, buf: res.body as Buffer };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await UserPermission.create([{
    userId: ids.REP, email: "rep@plumtrips.com", workspaceId: "69679a7628330a58d29f2254", universe: "STAFF", level: { code: "L2", name: "Executive" },
    modules: { leads: { access: "WRITE", scope: "OWN" } }, grantedBy: ids.ADMIN,
  }] as any);
  await User.collection.insertMany(Object.values(USERS).map((u) => ({ _id: new mongoose.Types.ObjectId(u.id), name: u.name, email: u.email, roles: u.roles, passwordHash: "x" })) as any[]);
  process.env[CRM_V2_DISPOSITION_ENV] = "true";
  process.env[CRM_V2_OPPORTUNITY_ENV] = "true";
}, 120_000);
afterAll(async () => {
  delete process.env[CRM_V2_DISPOSITION_ENV];
  delete process.env[CRM_V2_OPPORTUNITY_ENV];
  await mongoose.disconnect();
  await mongod.stop();
});

let L: Record<string, mongoose.Types.ObjectId>;
beforeEach(async () => {
  await Promise.all([Lead.deleteMany({}), LeadActivity.deleteMany({}), Opportunity.deleteMany({})]);
  await ensureDefaultPipeline();
  L = {
    demoRep: await on("Interested", "Demo Scheduled", "contacted", "Open", { assignedTo: REP, assignedToName: "Rep" }),
    demoOther: await on("Interested", "Demo Scheduled", "contacted", "Open", { assignedTo: OTHER, assignedToName: "Other" }),
    proposalRep: await on("Interested", "Proposal Mail Sent", "proposal_sent", "Open", { assignedTo: REP, assignedToName: "Rep", dealValue: 5000 }),
    rnrRep: await on("Not Interested", "Repeated RNR", "lost", "Lost", { assignedTo: REP, assignedToName: "Rep", lostReason: "Repeated RNR" }),
    trustOther: await on("Not Interested", "Trust Issue", "lost", "Lost", { assignedTo: OTHER, assignedToName: "Other", lostReason: "Trust Issue" }), // retired sub
    // "Demo Scheduledx" must NOT match "Demo Scheduled" (exact, not prefix)
    lookalike: await on("Interested", "Demo Scheduledx", "contacted", "Open", { assignedTo: REP, assignedToName: "Rep" }),
    legacyRep: await lead({ stage: "contacted", assignedTo: REP, assignedToName: "Rep" }),
  };
});

const codes = (b: any) => (b.leads as any[]).map((l) => String(l._id)).sort();
const idsOf = (...k: string[]) => k.map((x) => String(L[x])).sort();

describe("GET /leads — disposition / sub-disposition filters", () => {
  it("sub-disposition: case-insensitive exact match, not a prefix; legacy rows never match", async () => {
    const r = await get("admin", "/?subDisposition=" + encodeURIComponent("  demo SCHEDULED "));
    expect(r.status).toBe(200);
    expect(codes(r.body)).toEqual(idsOf("demoRep", "demoOther"));
    expect(r.body.total).toBe(2);
    // regex metacharacters are literal
    expect((await get("admin", "/?subDisposition=" + encodeURIComponent("Demo.*"))).body.total).toBe(0);
  });

  it("disposition group alone, and group + sub together", async () => {
    expect(codes((await get("admin", "/?disposition=interested&limit=100")).body)).toEqual(idsOf("demoRep", "demoOther", "proposalRep", "lookalike"));
    expect(codes((await get("admin", "/?disposition=Interested&subDisposition=Proposal%20Mail%20Sent")).body)).toEqual(idsOf("proposalRep"));
    // wrong parent → nothing (both conditions must hold)
    expect((await get("admin", "/?disposition=Not%20Interested&subDisposition=Demo%20Scheduled")).body.total).toBe(0);
  });

  it("a retired (hidden) sub still finds its old leads", async () => {
    expect(codes((await get("admin", "/?subDisposition=Trust%20Issue")).body)).toEqual(idsOf("trustOther"));
  });

  it("is scoped like every other filter: an OWN rep only sees their own matches", async () => {
    expect(codes((await get("rep", "/?subDisposition=Demo%20Scheduled")).body)).toEqual(idsOf("demoRep"));
    expect((await get("rep", "/?subDisposition=Trust%20Issue")).body.total).toBe(0);
    // AND-ed with the stage filter and search
    expect(codes((await get("admin", "/?disposition=Not%20Interested&stage=lost")).body)).toEqual(idsOf("rnrRep", "trustOther"));
    expect((await get("admin", "/?disposition=Not%20Interested&stage=contacted")).body.total).toBe(0);
  });

  it("counts-by-stage and pipeline-summary follow the same filter", async () => {
    expect((await get("admin", "/counts-by-stage")).body).toEqual({ contacted: 4, proposal_sent: 1, lost: 2 });
    expect((await get("admin", "/counts-by-stage?disposition=Not%20Interested")).body).toEqual({ lost: 2 });
    expect((await get("rep", "/counts-by-stage?disposition=Not%20Interested")).body).toEqual({ lost: 1 });
    const s = (await get("admin", "/pipeline-summary?disposition=Interested")).body;
    expect(s.perStage.contacted.count).toBe(3);
    expect(s.perStage.proposal_sent).toMatchObject({ count: 1, sumValue: 5000 });
    expect(s.perStage.lost.count).toBe(0);
    expect(s.kpis.activeCount).toBe(4);
    // the kanban column total for a stage = the list total under the same filter
    expect((await get("admin", "/?stage=contacted&disposition=Interested")).body.total).toBe(s.perStage.contacted.count);
  });

  it("POST /bulk target.filter resolves the same rows", async () => {
    const r = await request(app).post("/api/leads/bulk").set("x-test-user", "admin")
      .send({ action: "reassign", target: { filter: { subDisposition: "demo scheduled" } }, params: { assignedTo: ids.ADMIN } });
    expect(r.status).toBe(200);
    expect(r.body.target).toEqual({ mode: "filter", matched: 2 });
  });
});

describe("GET /leads/dispositions?includeInactive=1", () => {
  it("adds the 11 retired subs (filter options only); without the flag nothing changes", async () => {
    const plain = (await get("admin", "/dispositions")).body;
    expect(plain.inactive).toBeUndefined();
    expect(plain.groups.flatMap((g: any) => g.subs)).toHaveLength(21);
    const all = (await get("admin", "/dispositions?includeInactive=1")).body;
    expect(all.groups).toEqual(plain.groups);
    expect(all.inactive).toHaveLength(11);
    expect(all.inactive).toContainEqual({ disposition: "Not Interested", subDisposition: "Trust Issue" });
    expect(all.inactive).toContainEqual({ disposition: "Interested", subDisposition: "Follow up Required" });
    expect(all.inactive).toContainEqual({ disposition: "Not Interested", subDisposition: "Working with other vendors" });
  });
});

describe("GET /leads/export — disposition columns", () => {
  const OLD = [
    "Lead Code", "Type", "Company Name", "Industry", "Company Size", "Location", "Contact Name", "Contact Phone", "Contact Email",
    "Designation", "Source", "Stage", "Budget", "Deal Value", "Currency", "Assigned To", "Next Follow Up", "Lost Reason", "Won Date", "Created At", "Notes",
  ];
  it("keeps every existing column and appends the four disposition columns", async () => {
    const { header, rows } = await xlsx("admin", "/export");
    expect(header).toEqual([...OLD, "Disposition", "Sub-disposition", "Disposition Status", "Disposition Date"]);
    expect(rows).toHaveLength(7);
    const p = rows.find((r) => r["Sub-disposition"] === "Proposal Mail Sent")!;
    // 03 Nov 12:00 IST
    expect(p).toMatchObject({ Disposition: "Interested", "Disposition Status": "Open", "Disposition Date": "03/11/2026", Stage: "proposal_sent" });
    const legacyCode = (await Lead.findById(L.legacyRep).lean())!.leadCode;
    const legacy = rows.find((r) => r["Lead Code"] === legacyCode)!;
    expect(legacy).toMatchObject({ Disposition: "", "Sub-disposition": "", "Disposition Status": "", "Disposition Date": "" });
    // OWN rep: own leads only
    expect((await xlsx("rep", "/export")).rows).toHaveLength(5);
  });

  // The preview, run on the export file with its suggested mapping minus the owner
  // column (the test's reps are not CRM reps — see GET /leads/reps).
  async function previewOf(buf: Buffer) {
    const first = await request(app).post("/api/leads/import/preview").set("x-test-user", "admin").attach("file", buf, "leads-export.xlsx");
    expect(first.status).toBe(200);
    const mapping = { ...first.body.suggestedMapping, "Assigned To": "" };
    const p = await request(app).post("/api/leads/import/preview").set("x-test-user", "admin").field("mapping", JSON.stringify(mapping)).attach("file", buf, "leads-export.xlsx");
    expect(p.status).toBe(200);
    return { suggested: first.body.suggestedMapping, rows: p.body.rows as any[] };
  }

  it("round trip: the import preview maps the export's disposition columns and resolves them", async () => {
    await Lead.deleteMany({ _id: { $in: [L.lookalike, L.trustOther] } }); // a non-set sub / a retired sub — below
    const created = new Date("2026-11-01T06:30:00Z");
    await Lead.collection.updateMany({}, { $set: { createdAt: created } });
    await Lead.updateOne({ _id: L.proposalRep }, { $set: { nextFollowUpDate: new Date("2026-11-20T04:30:00Z") } });
    const { buf } = await xlsx("admin", "/export");
    await Lead.deleteMany({}); // into a CRM that does not have these leads (else they are skipped — below)
    const { suggested, rows } = await previewOf(buf);
    expect(suggested).toMatchObject({ "Lead Code": "leadCode", Disposition: "disposition", "Sub-disposition": "subDisposition", "Disposition Date": "dispositionDate", "Next Follow Up": "nextFollowUpDate" });
    expect(suggested["Disposition Status"]).toBe(""); // derived from the sub, never imported
    const bySub = (sub: string) => rows.filter((r) => r.values["Sub-disposition"] === sub);
    const [rnr] = bySub("Repeated RNR");
    expect(rnr.errors).toEqual([]);
    expect(rnr.resolved.disposition).toMatchObject({ disposition: "Not Interested", subDisposition: "Repeated RNR", status: "Lost" });
    const [prop] = bySub("Proposal Mail Sent");
    expect(prop.errors).toEqual([]);
    expect(prop.resolved.disposition).toMatchObject({ disposition: "Interested", subDisposition: "Proposal Mail Sent", opportunityEffect: "open" });
    // an open sub exported with no follow-up date (a v1-era lead) needs one before it re-imports
    for (const demo of bySub("Demo Scheduled")) expect(demo.errors).toEqual(['"Demo Scheduled" needs a next follow-up date']);
    expect(bySub("")[0].errors).toEqual([]); // legacy row, no disposition
  });

  it("round trip: a lead on a retired sub exports, but re-importing it is refused as no longer in use", async () => {
    await Lead.collection.updateMany({}, { $set: { createdAt: new Date("2026-11-01T06:30:00Z") } });
    const { buf } = await xlsx("admin", "/export");
    await Lead.deleteMany({}); // a CRM without the lead — into the same one it is skipped (below)
    const { rows } = await previewOf(buf);
    const trust = rows.find((r) => r.values["Sub-disposition"] === "Trust Issue");
    expect(trust.valid).toBe(false);
    expect(trust.errors.join(" ")).toMatch(/no longer in use/);
  });

  it("re-import into the same CRM: every row is 'already in CRM' — no errors, nothing written, leads unchanged", async () => {
    await Lead.collection.updateMany({}, { $set: { createdAt: new Date("2026-11-01T06:30:00Z") } });
    const before = await Lead.find({}).sort({ _id: 1 }).lean();
    const acts = await LeadActivity.countDocuments();
    const { buf } = await xlsx("admin", "/export");
    const { rows } = await previewOf(buf);
    expect(rows).toHaveLength(7);
    // the retired sub (Trust Issue) and an open sub with no follow-up (Demo Scheduled) are unchanged rows, not errors
    for (const r of rows) {
      expect(r.existing).toEqual({ leadCode: r.values["Lead Code"] });
      expect(r.valid).toBe(false);
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual([]);
    }
    const p = await request(app).post("/api/leads/import/preview").set("x-test-user", "admin").attach("file", buf, "leads-export.xlsx");
    expect(p.body.summary).toMatchObject({ total: 7, valid: 0, invalid: 0, existing: 7 });
    // commit with one new row alongside: only the new row is written
    const fresh = { "Lead Code": "", "Contact Name": "New Person", "Contact Phone": "9822000001", "Company Name": "New Co" };
    const mapping = { "Lead Code": "leadCode", "Contact Name": "contactName", "Contact Phone": "contactPhone", "Company Name": "companyName", Disposition: "disposition", "Sub-disposition": "subDisposition" };
    const exported = rows.map((r) => r.values);
    const c = await request(app).post("/api/leads/import/commit").set("x-test-user", "admin").send({ rows: [...exported, fresh], mapping, defaults: {} });
    expect(c.status).toBe(201);
    expect(c.body.summary).toMatchObject({ total: 8, created: 1, invalid: 0, existing: 7 });
    expect(c.body.existing.map((e: any) => e.leadCode).sort()).toEqual(before.map((l: any) => l.leadCode).sort());
    expect(await Lead.countDocuments()).toBe(8);
    const after = await Lead.find({ _id: { $in: before.map((l: any) => l._id) } }).sort({ _id: 1 }).lean();
    expect(after).toEqual(before);
    expect(await LeadActivity.countDocuments()).toBe(acts + 1); // the new lead's import note only
  });

  it("re-import: a changed disposition on an existing lead is still skipped, with a warning; an unknown code creates a new lead", async () => {
    const code = (await Lead.findById(L.proposalRep).lean())!.leadCode;
    const mapping = { code: "leadCode", name: "contactName", phone: "contactPhone", d: "disposition", s: "subDisposition", fu: "nextFollowUpDate" };
    const rows = [
      { code: code.toLowerCase(), name: "Person", phone: "9800000003", d: "Interested", s: "Negotiation in Progress", fu: "20-11-2026" },
      { code: "LEAD-NOPE-0001", name: "Ghost", phone: "9800009999", d: "", s: "", fu: "" },
    ];
    const p = await request(app).post("/api/leads/import/preview").set("x-test-user", "admin").send({ rows, mapping, defaults: {} });
    expect(p.status).toBe(200);
    const [changed, unknown] = p.body.rows;
    expect(changed.existing).toEqual({ leadCode: code });
    expect(changed.errors).toEqual([]);
    expect(changed.warnings).toEqual([`Disposition differs from ${code} (Interested / Proposal Mail Sent) — import never changes an existing lead; set it on the lead`]);
    expect(unknown.existing).toBeNull();
    expect(unknown.valid).toBe(true);
    expect(unknown.warnings).toEqual(['Lead code "LEAD-NOPE-0001" is not in the CRM — the row is created as a new lead with a new code']);
    const c = await request(app).post("/api/leads/import/commit").set("x-test-user", "admin").send({ rows, mapping, defaults: {} });
    expect(c.body.summary).toMatchObject({ created: 1, existing: 1 });
    expect((await Lead.findById(L.proposalRep).lean())!.subDisposition).toBe("Proposal Mail Sent");
    expect(c.body.created[0].leadCode).not.toBe("LEAD-NOPE-0001");
  });
});

describe("GET /leads/export — follows the Leads page's filters", () => {
  it("disposition / sub-disposition, dueBefore and search narrow the rows exactly like GET /leads", async () => {
    await Lead.updateOne({ _id: L.demoRep }, { $set: { nextFollowUpDate: new Date("2026-11-10T05:00:00Z") } });
    await Lead.updateOne({ _id: L.proposalRep }, { $set: { nextFollowUpDate: new Date("2026-11-30T05:00:00Z") } });
    const cases = [
      "?subDisposition=" + encodeURIComponent("demo scheduled"),
      "?disposition=Not%20Interested",
      "?disposition=Interested&dueBefore=" + encodeURIComponent("2026-11-14T00:00:00Z"),
      "?search=" + encodeURIComponent("Person 3"),
      "?subDisposition=Trust%20Issue",
    ];
    for (const qs of cases) {
      for (const who of ["admin", "rep"] as const) {
        const list = (await get(who, `/${qs}${qs ? "&" : "?"}limit=100`)).body;
        const ex = await xlsx(who, `/export${qs}`);
        expect(ex.rows.map((r) => r["Lead Code"]).sort(), `${who} ${qs}`).toEqual((list.leads as any[]).map((l) => l.leadCode).sort());
      }
    }
    expect((await xlsx("admin", "/export?subDisposition=demo%20scheduled")).rows).toHaveLength(2);
    expect((await xlsx("rep", "/export?subDisposition=demo%20scheduled")).rows).toHaveLength(1);
    expect((await xlsx("admin", "/export?disposition=Interested&dueBefore=" + encodeURIComponent("2026-11-14T00:00:00Z"))).rows).toHaveLength(1);
  });
});

describe("GET /leads/export/activities — Disposition From / To", () => {
  it("filled on disposition rows only", async () => {
    const at = new Date("2026-11-03T06:30:00Z");
    await LeadActivity.collection.insertMany([
      { leadId: L.proposalRep, type: "disposition", note: "sent", createdByName: "Rep", createdAt: at, updatedAt: at,
        disposition: { from: { disposition: "", subDisposition: "", stage: "Prospect", status: "Open" }, to: { disposition: "Interested", subDisposition: "Demo Scheduled", stage: "In-progress", status: "Open" } } },
      { leadId: L.proposalRep, type: "disposition", note: "sent", createdByName: "Rep", createdAt: new Date(at.getTime() + 60_000), updatedAt: at,
        disposition: { from: { disposition: "Interested", subDisposition: "Demo Scheduled", stage: "In-progress", status: "Open" }, to: { disposition: "Interested", subDisposition: "Proposal Mail Sent", stage: "In-progress", status: "Open" } } },
      { leadId: L.proposalRep, type: "note", note: "hello", createdByName: "Rep", createdAt: at, updatedAt: at },
    ] as any[]);
    const { header, rows } = await xlsx("admin", "/export/activities");
    expect(header).toEqual(["Lead Code", "Company", "Contact Name", "Lead Stage", "Activity Type", "Note / Description", "From Stage", "To Stage", "Disposition From", "Disposition To", "Done By", "Date & Time"]);
    expect(rows).toHaveLength(3);
    const d = rows.filter((r) => r["Activity Type"] === "disposition");
    expect(d.map((r) => [r["Disposition From"], r["Disposition To"]])).toEqual([
      ["Interested / Demo Scheduled", "Interested / Proposal Mail Sent"],
      ["—", "Interested / Demo Scheduled"],
    ]);
    const n = rows.find((r) => r["Activity Type"] === "note")!;
    expect([n["Disposition From"], n["Disposition To"]]).toEqual(["", ""]);
  });
});
