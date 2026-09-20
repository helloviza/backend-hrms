// PlumConnect Slice 3a — createLead() reproduces the tail of POST /api/leads
// exactly. The golden is not hand-typed: legacyTail() below is the code that
// was removed from routes/leads.ts (:672-724 on origin/main fd2aebdd) copied
// verbatim and run against the same collections; the raw documents are
// compared field for field. Then the automation handle: started
// synchronously, exactly one Task, never rejects.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/leads-service-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const H = vi.hoisted(() => ({ trigger: vi.fn() }));
// Spy that WRAPS the real automation so the Task actually lands and the call
// count is still observable.
vi.mock("./taskAutomation.js", async (importOriginal) => {
  const real: any = await importOriginal();
  H.trigger.mockImplementation(real.triggerTaskAutomation);
  return { ...real, triggerTaskAutomation: H.trigger };
});

const { createLead } = await import("./leads.service.js");
const { default: Lead } = await import("../models/Lead.js");
const { default: LeadActivity } = await import("../models/LeadActivity.js");
const { default: CRMCompany } = await import("../models/CRMCompany.js");
const { default: Task } = await import("../models/Task.js");
const { default: TaskAutomation } = await import("../models/TaskAutomation.js");
const { default: User } = await import("../models/User.js");
const { default: Counter } = await import("../models/Counter.js");
const { resolveOrCreateCompany } = await import("../utils/crmCompany.js");
const { triggerTaskAutomation } = await import("./taskAutomation.js");
const { SYSTEM_WORKSPACE_ID } = await import("../config/defaultTaskAutomations.js");

let mongod: MongoMemoryServer;
const ADMIN_ID = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Lead.syncIndexes();
  await User.collection.insertOne({ _id: ADMIN_ID, name: "Ops Admin", email: "ops@plumtrips.com", roles: ["ADMIN"], passwordHash: "x", workspaceId: new mongoose.Types.ObjectId() } as any);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  H.trigger.mockClear();
  await Promise.all([Lead.deleteMany({}), LeadActivity.deleteMany({}), CRMCompany.deleteMany({}), Task.deleteMany({}), TaskAutomation.deleteMany({}), Counter.deleteMany({})]);
});

/* ── the pre-refactor tail of POST /api/leads, verbatim ──────────────── */

async function legacyTail(body: Record<string, any>, ctx: { assignedToId: string; assignedToName: string; createdById: mongoose.Types.ObjectId | undefined; user: any }) {
  const { assignedToId, assignedToName, createdById, user } = ctx;

  // Anchor on a shared company (resolve-or-create) for company-type leads with
  // a non-blank name. companyId is set server-side, never trusted from the body.
  const leadType = body.type === "individual" ? "individual" : "company";
  let companyId: mongoose.Types.ObjectId | null = null;
  if (leadType === "company" && body.companyName && String(body.companyName).trim()) {
    const co = await resolveOrCreateCompany(
      {
        name: body.companyName,
        industry: body.industry,
        companySize: body.companySize,
        location: body.location,
        website: body.website,
        gstin: body.gstin,
      },
      createdById
    );
    companyId = co?._id ?? null;
  }

  const lead = await Lead.create({
    ...body,
    assignedTo: mongoose.isValidObjectId(assignedToId)
      ? new mongoose.Types.ObjectId(String(assignedToId))
      : undefined,
    assignedToName,
    companyId,
    createdBy: createdById,
  });

  if (body.notes) {
    await LeadActivity.create({
      leadId: lead._id,
      type: "note" as any,
      note: String(body.notes),
      createdBy: lead.createdBy,
      createdByName: user.name || `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "System",
    });
  }

  // Task automation hook — fire-and-forget, never breaks lead creation
  triggerTaskAutomation("lead.created", {
    workspaceId: SYSTEM_WORKSPACE_ID,
    entityType: "LEAD",
    entityId: lead._id as mongoose.Types.ObjectId,
    entityRef: lead.leadCode,
    ownerId: lead.assignedTo,
    variables: {
      leadName: lead.contactName || lead.companyName || "Lead",
      ownerName: lead.assignedToName || "",
    },
  }).catch(() => {});

  return lead;
}

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
  nextFollowUpDate: "2026-10-01T00:00:00.000Z",
  followUpNotes: "call after expo",
  // permissive spread: a field the UI does not send but the spread allows
  importBatchId: "batch-xyz",
};
const USER = { name: "Ops Admin", firstName: "", lastName: "", email: "ops@plumtrips.com" };

async function rawLead(id: any) {
  const d: any = await Lead.collection.findOne({ _id: id });
  const { _id, __v, leadCode, createdAt, updatedAt, ...rest } = d;
  return rest;
}

describe("createLead ≡ the old POST / tail", () => {
  it("company lead with notes: identical Lead document, same CRMCompany anchor, identical note activity", async () => {
    const legacy = await legacyTail(BODY, { assignedToId: String(ADMIN_ID), assignedToName: "Ops Admin", createdById: ADMIN_ID, user: USER });
    const { lead } = await createLead({ body: BODY, assignedTo: ADMIN_ID, assignedToName: "Ops Admin", createdBy: ADMIN_ID, noteAuthorName: USER.name });

    expect(await rawLead(lead._id)).toEqual(await rawLead(legacy._id));
    // one shared company, both leads anchored on it
    expect(await CRMCompany.countDocuments({})).toBe(1);
    expect(String((await rawLead(lead._id)).companyId)).toBe(String((await rawLead(legacy._id)).companyId));
    // the permissive spread carried the non-UI field through, exactly as before
    expect((await rawLead(lead._id)).importBatchId).toBe("batch-xyz");

    const notes = await LeadActivity.find({ type: "note" }).sort({ createdAt: 1 }).lean();
    expect(notes).toHaveLength(2);
    const strip = (n: any) => ({ note: n.note, createdBy: String(n.createdBy), createdByName: n.createdByName, type: n.type });
    expect(strip(notes[1])).toEqual(strip(notes[0]));
  });

  it("individual lead, no notes, no creator: no company, no activity, assignedTo undefined stays absent", async () => {
    const body = { ...BODY, type: "individual", companyName: "", notes: "" };
    const legacy = await legacyTail(body, { assignedToId: "not-an-id", assignedToName: "", createdById: undefined, user: USER });
    const { lead } = await createLead({ body, assignedTo: undefined, assignedToName: "", createdBy: undefined, noteAuthorName: "System" });
    expect(await rawLead(lead._id)).toEqual(await rawLead(legacy._id));
    expect(await CRMCompany.countDocuments({})).toBe(0);
    expect(await LeadActivity.countDocuments({})).toBe(0);
    expect(await rawLead(lead._id)).not.toHaveProperty("assignedTo");
    expect(await rawLead(lead._id)).not.toHaveProperty("createdBy");
  });

  it("company-type body with a blank companyName anchors nothing (same as before)", async () => {
    const body = { ...BODY, companyName: "   " };
    const { lead } = await createLead({ body, assignedTo: ADMIN_ID, assignedToName: "Ops Admin", createdBy: ADMIN_ID, noteAuthorName: "Ops Admin" });
    expect((await rawLead(lead._id)).companyId).toBeNull();
    expect(await CRMCompany.countDocuments({})).toBe(0);
  });
});

describe("the automation handle (decision iii)", () => {
  it("is started synchronously, exactly once, with the same context the route built", async () => {
    const { lead, automation } = await createLead({ body: BODY, assignedTo: ADMIN_ID, assignedToName: "Ops Admin", createdBy: ADMIN_ID, noteAuthorName: "Ops Admin" });
    expect(H.trigger).toHaveBeenCalledTimes(1);
    expect(H.trigger).toHaveBeenCalledWith("lead.created", {
      workspaceId: SYSTEM_WORKSPACE_ID,
      entityType: "LEAD",
      entityId: lead._id,
      entityRef: lead.leadCode,
      ownerId: lead.assignedTo,
      variables: { leadName: "Rohan Mehta", ownerName: "Ops Admin" },
    });
    expect(automation).toBeInstanceOf(Promise);
    expect(await automation).toBeNull(); // no automation row configured → null, not a throw
  });

  it("resolves to the Task when a lead.created automation exists — exactly one row, no sleep", async () => {
    await TaskAutomation.create({ workspaceId: SYSTEM_WORKSPACE_ID, triggerKey: "lead.created", label: "welcome", entityType: "LEAD", titleTemplate: "Welcome {{leadName}}", dueOffsetMinutes: 60, priority: "MEDIUM", assigneeRule: { type: "OWNER" }, tags: [] });
    const { lead, automation } = await createLead({ body: BODY, assignedTo: ADMIN_ID, assignedToName: "Ops Admin", createdBy: ADMIN_ID, noteAuthorName: "Ops Admin" });
    const task = await automation;
    expect(task).not.toBeNull();
    expect(task!.title).toBe("Welcome Rohan Mehta");
    expect(String(task!.linkedId)).toBe(String(lead._id));
    expect(await Task.countDocuments({})).toBe(1);
    expect(H.trigger).toHaveBeenCalledTimes(1);
  });

  it("never rejects — a throwing automation becomes null on the handle and createLead still returns the lead", async () => {
    H.trigger.mockImplementationOnce(async () => {
      throw new Error("automation exploded");
    });
    const { lead, automation } = await createLead({ body: BODY, assignedTo: ADMIN_ID, assignedToName: "Ops Admin", createdBy: ADMIN_ID, noteAuthorName: "Ops Admin" });
    expect(lead._id).toBeTruthy();
    await expect(automation).resolves.toBeNull();
  });

  it("is not awaited inside createLead: the lead is returned while a slow automation is still pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let settled = false;
    H.trigger.mockImplementationOnce(async () => {
      await gate;
      settled = true;
      return null;
    });
    const { lead, automation } = await createLead({ body: BODY, assignedTo: ADMIN_ID, assignedToName: "Ops Admin", createdBy: ADMIN_ID, noteAuthorName: "Ops Admin" });
    expect(lead._id).toBeTruthy();
    expect(settled).toBe(false); // createLead did not wait for it
    release();
    await automation;
    expect(settled).toBe(true);
  });
});
