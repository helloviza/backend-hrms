// PlumConnect Slice 3a — POST /api/leads after the createLead() extraction:
// byte-identical route behaviour (golden document + response shape), exactly
// one lead.created automation call per create, the Task awaited through the
// spy's returned promise (no sleep, no poll), and proof the 201 does not
// wait on the automation.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/leads-create-test";
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

const H = vi.hoisted(() => ({ trigger: vi.fn() }));
vi.mock("../services/taskAutomation.js", async (importOriginal) => {
  const real: any = await importOriginal();
  H.trigger.mockImplementation(real.triggerTaskAutomation);
  return { ...real, triggerTaskAutomation: H.trigger };
});

const { default: Lead } = await import("../models/Lead.js");
const { default: LeadActivity } = await import("../models/LeadActivity.js");
const { default: CRMCompany } = await import("../models/CRMCompany.js");
const { default: Task } = await import("../models/Task.js");
const { default: TaskAutomation } = await import("../models/TaskAutomation.js");
const { default: User } = await import("../models/User.js");
const { default: Counter } = await import("../models/Counter.js");
const { default: router } = await import("./leads.js");
const { SYSTEM_WORKSPACE_ID } = await import("../config/defaultTaskAutomations.js");

let mongod: MongoMemoryServer;
function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/leads", router);
  return a;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Lead.syncIndexes();
  await User.collection.insertOne({ _id: new mongoose.Types.ObjectId(ADMIN_ID), name: "Ops Admin", email: "ops@plumtrips.com", roles: ["ADMIN"], passwordHash: "x" } as any);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  H.trigger.mockClear();
  delete process.env.CRM_V2_OPPORTUNITY;
  await Promise.all([Lead.deleteMany({}), LeadActivity.deleteMany({}), CRMCompany.deleteMany({}), Task.deleteMany({}), TaskAutomation.deleteMany({}), Counter.deleteMany({})]);
});

/** What the Leads form posts. */
const BODY = {
  type: "company",
  companyName: "Acme Travels Pvt Ltd",
  industry: "IT/Technology",
  companySize: "51-200",
  location: "Bengaluru",
  website: "https://acme.example",
  gstin: "29ABCDE1234F1Z5",
  contactName: "Rohan Mehta",
  contactPhone: "+91 98765 43210",
  contactEmail: "rohan@acme.example",
  contactDesignation: "Travel Manager",
  source: "linkedin",
  stage: "new",
  budget: "5L/yr",
  dealValue: 500000,
  currency: "INR",
  notes: "Met at the expo.",
};

/** The exact stored document POST / produced before the extraction, for BODY
 *  posted by the ADMIN above with CRM_V2_OPPORTUNITY unset. */
function goldenDoc(companyId: mongoose.Types.ObjectId) {
  return {
    type: "company",
    companyName: "Acme Travels Pvt Ltd",
    industry: "IT/Technology",
    companySize: "51-200",
    location: "Bengaluru",
    address: "",
    website: "https://acme.example",
    gstin: "29ABCDE1234F1Z5",
    contactName: "Rohan Mehta",
    contactPhone: "+91 98765 43210",
    contactEmail: "rohan@acme.example",
    contactDesignation: "Travel Manager",
    source: "linkedin",
    stage: "new",
    budget: "5L/yr",
    dealValue: 500000,
    currency: "INR",
    notes: "Met at the expo.",
    assignedTo: new mongoose.Types.ObjectId(ADMIN_ID),
    assignedToName: "Ops Admin", // resolved from the DB, not the token
    createdBy: new mongoose.Types.ObjectId(ADMIN_ID),
    followUpNotes: "",
    lostReason: "",
    onboardingInviteSent: false,
    onboardingToken: "",
    convertedToContactId: null,
    convertedToCompanyId: null,
    companyId,
    status: null,
    sourceChannel: "",
    enquiryType: "",
    travelRequirement: { serviceMix: [], travelDate: null, travelDateEnd: null, origin: "", destination: "", destinationCountry: "", travellerCount: null, urgency: null, notes: "" },
    opportunityId: null,
    workspaceId: null,
    attribution: { channel: "", sourceType: "", sourceId: "", sourceUrl: "", ctwaClid: "", headline: "", body: "", mediaType: "", capturedAt: null, conversationId: null },
    pipelineId: null,
    disposition: "",
    subDisposition: "",
    dispositionStage: "",
    dispositionStatus: "",
    dispositionAt: null,
    importBatchId: "",
    possibleDuplicateOf: null,
  };
}

async function rawLead(id: any) {
  const d: any = await Lead.collection.findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
  const { _id, __v, leadCode, createdAt, updatedAt, ...rest } = d;
  return { rest, leadCode };
}

describe("POST /api/leads — byte-identical after the createLead() extraction", () => {
  it("201 with { lead }, the golden stored document, one company anchor, one note activity", async () => {
    const r = await request(app()).post("/api/leads").send(BODY);
    expect(r.status).toBe(201);
    expect(Object.keys(r.body)).toEqual(["lead"]);
    expect(r.body.lead.contactName).toBe("Rohan Mehta");
    expect(r.body.lead.leadCode).toMatch(/^LEAD-\d{4}-\d{4}$/);

    const company = await CRMCompany.findOne({}).lean();
    expect(company).toBeTruthy();
    const { rest } = await rawLead(r.body.lead._id);
    expect(rest).toEqual(goldenDoc(company!._id as mongoose.Types.ObjectId));

    const notes = await LeadActivity.find({ leadId: r.body.lead._id }).lean();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ type: "note", note: "Met at the expo.", createdByName: "Ops Admin" });
    expect(String(notes[0].createdBy)).toBe(ADMIN_ID);
  });

  it("400 without contactName/contactPhone, and nothing is created or triggered", async () => {
    const r = await request(app()).post("/api/leads").send({ companyName: "X" });
    expect(r.status).toBe(400);
    expect(await Lead.countDocuments({})).toBe(0);
    expect(H.trigger).not.toHaveBeenCalled();
  });

  it("individual lead: no company anchor, assignedToName honoured from the body", async () => {
    const r = await request(app()).post("/api/leads").send({ ...BODY, type: "individual", companyName: "", notes: "", assignedToName: "Custom Label" });
    expect(r.status).toBe(201);
    const { rest } = await rawLead(r.body.lead._id);
    expect(rest.companyId).toBeNull();
    expect(rest.assignedToName).toBe("Custom Label");
    expect(await CRMCompany.countDocuments({})).toBe(0);
    expect(await LeadActivity.countDocuments({})).toBe(0);
  });
});

describe("lead.created automation from the route path", () => {
  it("exactly ONE call per create, with the route's context; the Task is awaited through the spy, not slept for", async () => {
    await TaskAutomation.create({ workspaceId: SYSTEM_WORKSPACE_ID, triggerKey: "lead.created", label: "welcome", entityType: "LEAD", titleTemplate: "Welcome {{leadName}}", dueOffsetMinutes: 60, priority: "MEDIUM", assigneeRule: { type: "OWNER" }, tags: [] });

    const r = await request(app()).post("/api/leads").send(BODY);
    expect(r.status).toBe(201);

    // Deterministic: the call happens synchronously inside the awaited createLead().
    expect(H.trigger).toHaveBeenCalledTimes(1);
    const [key, ctx] = H.trigger.mock.calls[0];
    expect(key).toBe("lead.created");
    expect(ctx).toMatchObject({
      workspaceId: SYSTEM_WORKSPACE_ID,
      entityType: "LEAD",
      entityRef: r.body.lead.leadCode,
      variables: { leadName: "Rohan Mehta", ownerName: "Ops Admin" },
    });
    expect(String(ctx.entityId)).toBe(r.body.lead._id);
    expect(String(ctx.ownerId)).toBe(ADMIN_ID);

    // The handle the route ignored is the promise the spy returned.
    const task = await H.trigger.mock.results[0].value;
    expect(task).not.toBeNull();
    expect(task.title).toBe("Welcome Rohan Mehta");
    expect(await Task.countDocuments({})).toBe(1);
  });

  it("three creates → three calls, three tasks, one each", async () => {
    await TaskAutomation.create({ workspaceId: SYSTEM_WORKSPACE_ID, triggerKey: "lead.created", label: "welcome", entityType: "LEAD", titleTemplate: "Welcome {{leadName}}", dueOffsetMinutes: 60, priority: "MEDIUM", assigneeRule: { type: "OWNER" }, tags: [] });
    const ids: string[] = [];
    for (const n of ["A", "B", "C"]) {
      const r = await request(app()).post("/api/leads").send({ ...BODY, contactName: n, companyName: `Co ${n}` });
      ids.push(r.body.lead._id);
    }
    expect(H.trigger).toHaveBeenCalledTimes(3);
    await Promise.all(H.trigger.mock.results.map((x) => x.value));
    const tasks = await Task.find({}).lean();
    expect(tasks).toHaveLength(3);
    expect(tasks.map((t) => String(t.linkedId)).sort()).toEqual([...ids].sort());
  });

  it("the 201 does not wait on the automation (no new latency), and an automation failure does not fail the create", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let finished = false;
    H.trigger.mockImplementationOnce(async () => {
      await gate;
      finished = true;
      return null;
    });
    const r = await request(app()).post("/api/leads").send(BODY);
    expect(r.status).toBe(201);
    expect(finished).toBe(false); // responded while the automation was still pending
    release();
    await H.trigger.mock.results[0].value;
    expect(finished).toBe(true);

    H.trigger.mockImplementationOnce(async () => {
      throw new Error("automation exploded");
    });
    const r2 = await request(app()).post("/api/leads").send({ ...BODY, contactName: "Still created" });
    expect(r2.status).toBe(201);
    expect(await Lead.countDocuments({ contactName: "Still created" })).toBe(1);
  });
});
