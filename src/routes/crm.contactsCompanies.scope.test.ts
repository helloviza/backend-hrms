// Contacts & Companies scope — audit findings P1-3 / P1-4 / P1-5
// (docs/audits/crm-disposition-audit.md). Real collections
// (mongodb-memory-server), the real requireCRMAccess gate and real
// UserPermission rows, so a grant's raw scope string goes through the same
// path it does in prod. Callers:
//   admin    role ADMIN                     → FULL / ALL by construction
//   none     READ  / scope NONE              → must behave as OWN
//   team     READ  / scope TEAM              → must behave as OWN (reserved)
//   allread  READ  / scope ALL               → the shared view
//   allfull  FULL  / scope ALL (not admin)   → every contact
//   owner    WRITE / scope OWN               → the owner-only writer
//   other    WRITE / scope OWN               → whose rows the others must not see
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import ExcelJS from "exceljs";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/crm-cc-scope-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

type Who = "admin" | "none" | "team" | "allread" | "allfull" | "owner" | "other";
const WHO: Who[] = ["admin", "none", "team", "allread", "allfull", "owner", "other"];
const ids = Object.fromEntries(WHO.map((w) => [w, new mongoose.Types.ObjectId().toHexString()])) as Record<Who, string>;
const oid = (w: Who) => new mongoose.Types.ObjectId(ids[w]);
const USERS: Record<Who, any> = Object.fromEntries(
  WHO.map((w) => [w, { id: ids[w], sub: ids[w], roles: w === "admin" ? ["ADMIN"] : ["EMPLOYEE"], email: `${w}@plumtrips.com`, name: w }]),
) as any;

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = USERS[String(req.headers["x-test-user"] || "admin") as Who];
    next();
  },
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireHouse.js", () => ({
  requireHouse: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

const { default: CRMContact } = await import("../models/CRMContact.js");
const { default: CRMCompany } = await import("../models/CRMCompany.js");
const { default: User } = await import("../models/User.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { default: companiesRouter } = await import("./crm.companies.js");
const { default: contactsRouter } = await import("./crm.contacts.js");
const { CRM_V2_FOUNDATION_ENV } = await import("../config/crmV2.js");

let mongod: MongoMemoryServer;
function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/crm/companies", companiesRouter);
  a.use("/api/crm/contacts", contactsRouter);
  return a;
}
const get = (who: Who, path: string) => request(app()).get(`/api${path}`).set("x-test-user", who);
const post = (who: Who, path: string, body: any = {}) => request(app()).post(`/api${path}`).set("x-test-user", who).send(body);
const put = (who: Who, path: string, body: any = {}) => request(app()).put(`/api${path}`).set("x-test-user", who).send(body);

/** GET an XLSX export and return column 2 (contact First Name / company Name) of every data row. */
async function exportNames(who: Who, path: string): Promise<string[]> {
  const r = await request(app())
    .get(`/api${path}`)
    .set("x-test-user", who)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  expect(r.status).toBe(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.body as any);
  const names: string[] = [];
  wb.worksheets[0].eachRow((row, n) => {
    if (n > 1) names.push(String(row.getCell(2).value ?? ""));
  });
  return names.sort();
}
const sorted = (xs: string[]) => [...xs].sort();

let seq = 0;
async function contact(name: string, o: Record<string, any>) {
  seq += 1;
  return CRMContact.create({ firstName: name, jobTitle: "x", phone: `9${String(seq).padStart(9, "0")}`, ...o } as any);
}
async function company(name: string, o: Record<string, any>) {
  return CRMCompany.create({ name, ...o } as any);
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const perm = (w: Who, access: string, scope: string) => ({
    userId: ids[w], email: `${w}@plumtrips.com`, workspaceId: "69679a7628330a58d29f2254", universe: "STAFF", level: { code: "L2", name: "Executive" },
    modules: { leads: { access, scope }, crmContacts: { access, scope }, crmCompanies: { access, scope } }, grantedBy: ids.admin,
  });
  await UserPermission.create([
    perm("none", "READ", "NONE"),
    perm("team", "READ", "TEAM"),
    perm("allread", "READ", "ALL"),
    perm("allfull", "FULL", "ALL"),
    perm("owner", "WRITE", "OWN"),
    perm("other", "WRITE", "OWN"),
  ] as any);
  await User.collection.insertMany(WHO.map((w) => ({ _id: oid(w), name: w, email: `${w}@plumtrips.com`, roles: USERS[w].roles, passwordHash: "x" })) as any[]);
}, 120_000);
afterAll(async () => {
  delete process.env[CRM_V2_FOUNDATION_ENV];
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  delete process.env[CRM_V2_FOUNDATION_ENV];
  await Promise.all([CRMContact.deleteMany({}), CRMCompany.deleteMany({})]);
});

/* ───────────────────────── FIX 1 — list + export scope (P1-3) ───────────────────────── */

describe("contacts list + export: scope through normalizeScope", () => {
  it.each(["none", "team"] as const)("%s scope behaves as OWN — own + assigned-to-me only, never another user's rows", async (who) => {
    await contact("MinePrivate", { createdBy: oid(who), isPrivate: true });
    await contact("AssignedToMe", { createdBy: oid("other"), assignedTo: oid(who), isPrivate: true });
    await contact("OtherPublic", { createdBy: oid("other"), isPrivate: false });
    await contact("OtherPrivate", { createdBy: oid("other"), isPrivate: true });

    const list = await get(who, "/crm/contacts?limit=100");
    expect(list.status).toBe(200);
    expect(sorted(list.body.contacts.map((c: any) => c.firstName))).toEqual(["AssignedToMe", "MinePrivate"]);
    expect(list.body.total).toBe(2);
    expect(await exportNames(who, "/crm/contacts/export")).toEqual(["AssignedToMe", "MinePrivate"]);
  });

  it("ALL (not FULL) keeps the shared view: public rows + my own, not another user's private ones", async () => {
    await contact("MinePrivate", { createdBy: oid("allread"), isPrivate: true });
    await contact("OtherPublic", { createdBy: oid("other"), isPrivate: false });
    await contact("OtherPrivate", { createdBy: oid("other"), isPrivate: true });
    const list = await get("allread", "/crm/contacts?limit=100");
    expect(sorted(list.body.contacts.map((c: any) => c.firstName))).toEqual(["MinePrivate", "OtherPublic"]);
    expect(await exportNames("allread", "/crm/contacts/export")).toEqual(["MinePrivate", "OtherPublic"]);
  });

  it.each(["admin", "allfull"] as const)("%s (FULL + ALL) still sees every contact, private included", async (who) => {
    await contact("OtherPublic", { createdBy: oid("other"), isPrivate: false });
    await contact("OtherPrivate", { createdBy: oid("other"), isPrivate: true });
    const list = await get(who, "/crm/contacts?limit=100");
    expect(sorted(list.body.contacts.map((c: any) => c.firstName))).toEqual(["OtherPrivate", "OtherPublic"]);
    expect(await exportNames(who, "/crm/contacts/export")).toEqual(["OtherPrivate", "OtherPublic"]);
  });

  it("GET /:id uses the same rule: ALL-not-FULL gets 404 on another user's private contact", async () => {
    const priv = await contact("OtherPrivate", { createdBy: oid("other"), isPrivate: true });
    const pub = await contact("OtherPublic", { createdBy: oid("other"), isPrivate: false });
    expect((await get("allread", `/crm/contacts/${priv._id}`)).status).toBe(404);
    expect((await get("allread", `/crm/contacts/${pub._id}`)).status).toBe(200);
    expect((await get("none", `/crm/contacts/${pub._id}`)).status).toBe(404);
    expect((await get("admin", `/crm/contacts/${priv._id}`)).status).toBe(200);
    expect((await get("allfull", `/crm/contacts/${priv._id}`)).status).toBe(200);
  });
});

describe("companies list + export: scope through normalizeScope, export applies isPrivate", () => {
  beforeEach(async () => {
    await company("NoneMine", { createdBy: oid("none"), isPrivate: true });
    await company("TeamMine", { createdBy: oid("team"), isPrivate: true });
    await company("AllMine", { createdBy: oid("allread"), isPrivate: true });
    await company("OtherPublic", { createdBy: oid("other"), isPrivate: false });
    await company("OtherPrivate", { createdBy: oid("other"), isPrivate: true });
  });

  it.each([
    ["none", ["NoneMine"]],
    ["team", ["TeamMine"]],
  ] as const)("%s scope behaves as OWN — only companies I created", async (who, expected) => {
    const list = await get(who, "/crm/companies?limit=100");
    expect(list.status).toBe(200);
    expect(sorted(list.body.companies.map((c: any) => c.name))).toEqual(expected);
    expect(await exportNames(who, "/crm/companies/export")).toEqual(expected);
  });

  it("ALL (not admin): list and export match — public + mine, never another user's private company", async () => {
    const list = await get("allread", "/crm/companies?limit=100");
    expect(sorted(list.body.companies.map((c: any) => c.name))).toEqual(["AllMine", "OtherPublic"]);
    const exp = await exportNames("allread", "/crm/companies/export");
    expect(exp).toEqual(["AllMine", "OtherPublic"]);
    expect(exp).not.toContain("OtherPrivate");
  });

  it("admin list is unchanged (it never showed others' private companies) and export now matches it", async () => {
    const list = await get("admin", "/crm/companies?limit=100");
    expect(sorted(list.body.companies.map((c: any) => c.name))).toEqual(["OtherPublic"]);
    expect(await exportNames("admin", "/crm/companies/export")).toEqual(["OtherPublic"]);
  });
});

/* ───────────────────────── FIX 2 — GET /crm/companies/:id (P1-4) ───────────────────────── */

describe("GET /crm/companies/:id follows the list rule; outside it is 404", () => {
  it("non-ALL callers (NONE / TEAM / OWN): only companies they created; another user's private or public company is 404", async () => {
    const otherPrivate = await company("OtherPrivate", { createdBy: oid("other"), isPrivate: true });
    const otherPublic = await company("OtherPublic", { createdBy: oid("other"), isPrivate: false });
    for (const who of ["none", "team", "owner"] as const) {
      const mine = await company(`${who} Mine`, { createdBy: oid(who), isPrivate: true });
      expect((await get(who, `/crm/companies/${otherPrivate._id}`)).status).toBe(404);
      expect((await get(who, `/crm/companies/${otherPublic._id}`)).status).toBe(404);
      const r = await get(who, `/crm/companies/${mine._id}`);
      expect(r.status).toBe(200);
      expect(r.body.company.name).toBe(`${who} Mine`);
    }
  });

  it("ALL (not admin): another user's private company is 404, public ones and my own private one open", async () => {
    const otherPrivate = await company("OtherPrivate", { createdBy: oid("other"), isPrivate: true });
    const otherPublic = await company("OtherPublic", { createdBy: oid("other"), isPrivate: false });
    const mine = await company("AllMine", { createdBy: oid("allread"), isPrivate: true });
    expect((await get("allread", `/crm/companies/${otherPrivate._id}`)).status).toBe(404);
    expect((await get("allread", `/crm/companies/${otherPublic._id}`)).status).toBe(200);
    expect((await get("allread", `/crm/companies/${mine._id}`)).status).toBe(200);
  });

  it("admin: same rule as the admin list — public opens, another user's private company is 404", async () => {
    const otherPrivate = await company("OtherPrivate", { createdBy: oid("other"), isPrivate: true });
    const otherPublic = await company("OtherPublic", { createdBy: oid("other"), isPrivate: false });
    expect((await get("admin", `/crm/companies/${otherPublic._id}`)).status).toBe(200);
    expect((await get("admin", `/crm/companies/${otherPrivate._id}`)).status).toBe(404);
  });

  it("an invalid id is still 400; a missing id is 404 (indistinguishable from out-of-scope)", async () => {
    expect((await get("allread", "/crm/companies/not-an-id")).status).toBe(400);
    expect((await get("allread", `/crm/companies/${new mongoose.Types.ObjectId()}`)).status).toBe(404);
  });
});

/* ───────────────────────── FIX 3 — mass-assignment (P1-5) ───────────────────────── */

describe("contact POST / PUT: allow-list; owner and links are not client-writable", () => {
  const base = { firstName: "Asha", jobTitle: "CFO", phone: "9000000001" };

  it("owner-only POST: forged assignedTo / leadId / createdBy / contactCode are ignored", async () => {
    const r = await post("owner", "/crm/contacts", {
      ...base,
      assignedTo: ids.other,
      leadId: new mongoose.Types.ObjectId().toHexString(),
      createdBy: ids.other,
      contactCode: "CONT-HACK-0001",
      visibleTo: [ids.other],
      assignedToName: "Other",
    });
    expect(r.status).toBe(201);
    const doc = (await CRMContact.findById(r.body.contact._id).lean()) as any;
    expect(doc.assignedTo).toBeNull();
    expect(doc.leadId).toBeNull();
    expect(String(doc.createdBy)).toBe(ids.owner);
    expect(doc.contactCode).not.toBe("CONT-HACK-0001");
    expect(doc.visibleTo).toEqual([]);
    expect(sorted(r.body.ignored)).toEqual(sorted(["assignedTo", "leadId", "createdBy", "contactCode", "visibleTo", "assignedToName"]));
  });

  it("owner-only POST may leave the owner empty or name themselves", async () => {
    const empty = await post("owner", "/crm/contacts", { ...base, assignedTo: "" });
    expect(empty.status).toBe(201);
    expect(empty.body.ignored).toBeUndefined();
    expect(empty.body.contact.assignedTo).toBeNull();
    const self = await post("owner", "/crm/contacts", { ...base, phone: "9000000002", assignedTo: ids.owner });
    expect(self.body.contact.assignedTo).toBe(ids.owner);
    expect(self.body.ignored).toBeUndefined();
  });

  it.each(["admin", "allfull"] as const)("%s (FULL + ALL) may set any owner on create and change it on edit", async (who) => {
    const r = await post(who, "/crm/contacts", { ...base, assignedTo: ids.other });
    expect(r.status).toBe(201);
    expect(r.body.contact.assignedTo).toBe(ids.other);
    const u = await put(who, `/crm/contacts/${r.body.contact._id}`, { assignedTo: ids.owner });
    expect(u.status).toBe(200);
    expect(u.body.contact.assignedTo).toBe(ids.owner);
    expect(u.body.ignored).toBeUndefined();
  });

  it("owner-only PUT: assignedTo / leadId / createdBy changes are ignored; the edit form's full echo still saves", async () => {
    const c = await contact("Mine", { createdBy: oid("owner"), assignedTo: oid("owner") });
    const forged = await put("owner", `/crm/contacts/${c._id}`, {
      assignedTo: ids.other,
      leadId: new mongoose.Types.ObjectId().toHexString(),
      createdBy: ids.other,
      city: "Pune",
    });
    expect(forged.status).toBe(200);
    expect(sorted(forged.body.ignored)).toEqual(["assignedTo", "createdBy", "leadId"]);
    const doc = (await CRMContact.findById(c._id).lean()) as any;
    expect(String(doc.assignedTo)).toBe(ids.owner);
    expect(doc.leadId).toBeNull();
    expect(String(doc.createdBy)).toBe(ids.owner);
    expect(doc.city).toBe("Pune");

    // ContactDetail.tsx: setForm({ ...contact }) then PUT the whole object.
    const loaded = (await get("owner", `/crm/contacts/${c._id}`)).body.contact;
    const echo = await put("owner", `/crm/contacts/${c._id}`, { ...loaded, jobTitle: "VP Finance" });
    expect(echo.status).toBe(200);
    expect(echo.body.contact.jobTitle).toBe("VP Finance");
    expect(String(echo.body.contact.assignedTo)).toBe(ids.owner);
    expect(echo.body.ignored).not.toContain("assignedTo"); // unchanged owner is a no-op
    expect(echo.body.ignored).toEqual(expect.arrayContaining(["_id", "contactCode", "createdBy", "assignedToName"]));
  });

  it("isPrivate: the creator sets it on create and edit; non-booleans are ignored", async () => {
    const r = await post("owner", "/crm/contacts", { ...base, isPrivate: true });
    expect(r.body.contact.isPrivate).toBe(true);
    const u = await put("owner", `/crm/contacts/${r.body.contact._id}`, { isPrivate: false });
    expect(u.body.contact.isPrivate).toBe(false);
    const bad = await put("owner", `/crm/contacts/${r.body.contact._id}`, { isPrivate: "yes" });
    expect(bad.body.contact.isPrivate).toBe(false);
    expect(bad.body.ignored).toEqual(["isPrivate"]);
  });

  it("a non-creator still cannot PUT another user's contact (unchanged gate)", async () => {
    const c = await contact("Theirs", { createdBy: oid("other") });
    expect((await put("owner", `/crm/contacts/${c._id}`, { city: "X" })).status).toBe(403);
  });
});

describe.each([false, true])("company POST / PUT allow-list (CRM_V2_FOUNDATION=%s)", (flagOn) => {
  beforeEach(() => {
    if (flagOn) process.env[CRM_V2_FOUNDATION_ENV] = "true";
    else delete process.env[CRM_V2_FOUNDATION_ENV];
  });

  it("POST: forged nameNormalized / customerId / customerWorkspaceId / createdBy are ignored", async () => {
    const r = await post("owner", "/crm/companies", {
      name: "Forge Co",
      nameNormalized: "someone else",
      customerId: new mongoose.Types.ObjectId().toHexString(),
      customerWorkspaceId: "69679a7628330a58d29f2254",
      createdBy: ids.other,
      companyCode: "COMP-HACK-0001",
      contactCount: 42,
      isPrivate: true,
    });
    expect(r.status).toBe(201);
    const doc = (await CRMCompany.findById(r.body.company._id).lean()) as any;
    expect(doc.nameNormalized).toBe("forge co");
    expect(doc.customerId).toBeNull();
    expect(doc.customerWorkspaceId).toBeNull();
    expect(String(doc.createdBy)).toBe(ids.owner);
    expect(doc.companyCode).not.toBe("COMP-HACK-0001");
    expect(doc.contactCount).toBe(0);
    expect(doc.isPrivate).toBe(true);
    expect(sorted(r.body.ignored)).toEqual(sorted(["nameNormalized", "customerId", "customerWorkspaceId", "createdBy", "companyCode", "contactCount"]));
  });

  it("PUT: forged fields are ignored; the detail page's full echo still saves", async () => {
    const co = await company("Mine Co", { createdBy: oid("owner"), isPrivate: false });
    const cust = new mongoose.Types.ObjectId().toHexString();
    const forged = await put("owner", `/crm/companies/${co._id}`, {
      nameNormalized: "hijack",
      customerId: cust,
      customerWorkspaceId: "ws",
      createdBy: ids.other,
      city: "Delhi",
    });
    expect(forged.status).toBe(200);
    expect(sorted(forged.body.ignored)).toEqual(["createdBy", "customerId", "customerWorkspaceId", "nameNormalized"]);
    const doc = (await CRMCompany.findById(co._id).lean()) as any;
    expect(doc.nameNormalized).toBe("mine co");
    expect(doc.customerId).toBeNull();
    expect(doc.customerWorkspaceId).toBeNull();
    expect(String(doc.createdBy)).toBe(ids.owner);
    expect(doc.city).toBe("Delhi");

    // CompanyDetail.tsx: setForm({ ...company }) then PUT the whole object.
    const loaded = (await get("owner", `/crm/companies/${co._id}`)).body.company;
    const echo = await put("owner", `/crm/companies/${co._id}`, { ...loaded, industry: "Travel" });
    expect(echo.status).toBe(200);
    expect(echo.body.company.industry).toBe("Travel");
  });

  it("PUT: a server-set customer link survives a client edit", async () => {
    const cust = new mongoose.Types.ObjectId();
    const co = await company("Customer Co", { createdBy: oid("owner"), customerId: cust, customerWorkspaceId: "ws-1" });
    const r = await put("owner", `/crm/companies/${co._id}`, { customerId: null, customerWorkspaceId: null, notes: "n" });
    expect(r.status).toBe(200);
    const doc = (await CRMCompany.findById(co._id).lean()) as any;
    expect(String(doc.customerId)).toBe(String(cust));
    expect(doc.customerWorkspaceId).toBe("ws-1");
  });
});

/* ──────────── FOLLOW-UP A — companies linked to the rep's own work ──────────── */

const { default: Lead } = await import("../models/Lead.js");
const { default: Opportunity } = await import("../models/Opportunity.js");
const { CRM_V2_OPPORTUNITY_ENV } = await import("../config/crmV2.js");

describe.each(["owner", "none", "team"] as const)("non-ALL caller %s: companies linked to work they can see", (who) => {
  let n = 0;
  async function leadAt(owner: Who, o: Record<string, any>) {
    n += 1;
    const _id = new mongoose.Types.ObjectId();
    const now = new Date();
    await Lead.collection.insertOne({
      _id, leadCode: `LEAD-L-${String(n).padStart(4, "0")}`, type: "company", companyName: `Co ${n}`, contactName: `P ${n}`,
      contactPhone: `8${String(n).padStart(9, "0")}`, stage: "new", source: "manual", assignedTo: oid(owner), createdAt: now, updatedAt: now, ...o,
    } as any);
    return _id;
  }
  async function oppAt(owner: Who, companyId: mongoose.Types.ObjectId) {
    const now = new Date();
    await Opportunity.collection.insertOne({
      _id: new mongoose.Types.ObjectId(), opportunityCode: `OPP-L-${++n}`, name: "d", pipeline: "corporate", stage: "proposal", probability: 65,
      dealValue: 1, currency: "INR", closedAt: null, leadId: new mongoose.Types.ObjectId(), ownerUserId: oid(owner), companyId,
      serviceMix: [], serviceLines: [], createdAt: now, updatedAt: now,
    } as any);
  }

  beforeEach(async () => {
    await Promise.all([Lead.deleteMany({}), Opportunity.deleteMany({})]);
    process.env[CRM_V2_OPPORTUNITY_ENV] = "true";
  });
  afterAll(() => {
    delete process.env[CRM_V2_OPPORTUNITY_ENV];
  });

  it("GET /:id, list and export agree: own lead / converted lead / deal / contact / created → visible; another rep's lead or a private linked company → hidden", async () => {
    const myLead = await company("MyLeadCo", { createdBy: oid("other"), isPrivate: false });
    await leadAt(who, { companyId: myLead._id });
    const converted = await company("ConvertedCo", { createdBy: oid("other"), isPrivate: false });
    await leadAt(who, { convertedToCompanyId: converted._id });
    const myDeal = await company("MyDealCo", { createdBy: oid("other"), isPrivate: false });
    await oppAt(who, myDeal._id);
    const myContact = await company("MyContactCo", { createdBy: oid("other"), isPrivate: false });
    await contact("C", { createdBy: oid("other"), assignedTo: oid(who), companyId: myContact._id });
    const created = await company("CreatedCo", { createdBy: oid(who), isPrivate: true });

    const theirLead = await company("TheirLeadCo", { createdBy: oid("other"), isPrivate: false });
    await leadAt("other", { companyId: theirLead._id });
    await oppAt("other", theirLead._id);
    const privLinked = await company("PrivateLinkedCo", { createdBy: oid("other"), isPrivate: true });
    await leadAt(who, { companyId: privLinked._id });
    await company("UnlinkedCo", { createdBy: oid("other"), isPrivate: false });

    const visible = ["ConvertedCo", "CreatedCo", "MyContactCo", "MyDealCo", "MyLeadCo"];
    for (const c of [myLead, converted, myDeal, myContact, created]) {
      expect((await get(who, `/crm/companies/${c._id}`)).status).toBe(200);
    }
    expect((await get(who, `/crm/companies/${theirLead._id}`)).status).toBe(404);
    expect((await get(who, `/crm/companies/${privLinked._id}`)).status).toBe(404);

    const list = await get(who, "/crm/companies?limit=100");
    expect(sorted(list.body.companies.map((c: any) => c.name))).toEqual(visible);
    expect(list.body.total).toBe(visible.length);
    expect(await exportNames(who, "/crm/companies/export")).toEqual(visible);
  });

  it("deals only link while CRM_V2_OPPORTUNITY is on (the flag that shows them at all)", async () => {
    delete process.env[CRM_V2_OPPORTUNITY_ENV];
    const myDeal = await company("MyDealCo", { createdBy: oid("other"), isPrivate: false });
    await oppAt(who, myDeal._id);
    expect((await get(who, `/crm/companies/${myDeal._id}`)).status).toBe(404);
  });
});

describe("linked visibility leaves ALL callers and admins unchanged", () => {
  beforeEach(async () => {
    await Promise.all([Lead.deleteMany({}), Opportunity.deleteMany({})]);
  });

  it("ALL / admin: a private company linked to their own lead is still hidden; public ones show as before", async () => {
    const priv = await company("PrivateCo", { createdBy: oid("other"), isPrivate: true });
    const pub = await company("PublicCo", { createdBy: oid("other"), isPrivate: false });
    const now = new Date();
    for (const who of ["allread", "admin"] as const) {
      await Lead.collection.insertOne({ _id: new mongoose.Types.ObjectId(), leadCode: `LEAD-A-${who}`, type: "company", companyName: "x", contactName: "x", contactPhone: "1", stage: "new", source: "manual", assignedTo: oid(who), companyId: priv._id, createdAt: now, updatedAt: now } as any);
      expect((await get(who, `/crm/companies/${priv._id}`)).status).toBe(404);
      expect((await get(who, `/crm/companies/${pub._id}`)).status).toBe(200);
      const list = await get(who, "/crm/companies?limit=100");
      expect(list.body.companies.map((c: any) => c.name)).toEqual(["PublicCo"]);
    }
  });
});
