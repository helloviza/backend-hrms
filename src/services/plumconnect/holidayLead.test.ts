// PlumConnect Slice 3b — the holiday-lead adapter against real collections:
// referral parsing, the explicit field set through the 3a createLead() seam,
// attribution at first touch only, Contact-layer phone dedup (repeat touch =
// record, never a second Lead), and Track B routing (matrix → SALES; no
// matrix → held, unassigned — the first-admin
// fallback. Nothing here sends anything.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-holidaylead-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const H = vi.hoisted(() => ({ trigger: vi.fn() }));
vi.mock("../taskAutomation.js", async (importOriginal) => {
  const real: any = await importOriginal();
  H.trigger.mockImplementation(real.triggerTaskAutomation);
  return { ...real, triggerTaskAutomation: H.trigger };
});

const { captureHolidayLead, parseReferral, leadSourceForReferral } = await import("./holidayLead.js");
const { default: AssignmentRule } = await import("../../models/plumconnect/AssignmentRule.js");
const { default: AgentPresence } = await import("../../models/plumconnect/AgentPresence.js");
const { UserPermission } = await import("../../models/UserPermission.js");
const { default: Lead } = await import("../../models/Lead.js");
const { default: LeadActivity } = await import("../../models/LeadActivity.js");
const { default: CRMCompany } = await import("../../models/CRMCompany.js");
const { default: Task } = await import("../../models/Task.js");
const { default: TaskAutomation } = await import("../../models/TaskAutomation.js");
const { default: User } = await import("../../models/User.js");
const { default: Counter } = await import("../../models/Counter.js");
const { default: Contact } = await import("../../models/plumconnect/Contact.js");
const { default: Conversation } = await import("../../models/plumconnect/Conversation.js");
const { default: Message } = await import("../../models/plumconnect/Message.js");
const { SYSTEM_WORKSPACE_ID } = await import("../../config/defaultTaskAutomations.js");
const { CRM_V2_OPPORTUNITY_ENV } = await import("../../config/crmV2.js");

let mongod: MongoMemoryServer;
const WS = new mongoose.Types.ObjectId();
const ADMIN = new mongoose.Types.ObjectId();
const SALES = new mongoose.Types.ObjectId();
const CANON = "919876543210";
const NOW = new Date("2026-09-20T12:00:00Z");

const REFERRAL = {
  source_url: "https://www.instagram.com/p/abc123/",
  source_type: "ad",
  source_id: "120212345678901234",
  headline: "Bali from ₹49,999",
  body: "7 nights, flights included. " + "x".repeat(600),
  media_type: "image",
  ctwa_clid: "AfeXYZ123",
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Lead.syncIndexes(), Contact.syncIndexes(), Conversation.syncIndexes(), Message.syncIndexes()]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  H.trigger.mockClear();
  delete process.env[CRM_V2_OPPORTUNITY_ENV];
  await Promise.all([Lead.deleteMany({}), LeadActivity.deleteMany({}), CRMCompany.deleteMany({}), Task.deleteMany({}), TaskAutomation.deleteMany({}), User.deleteMany({}), UserPermission.deleteMany({}), AssignmentRule.deleteMany({}), AgentPresence.deleteMany({}), Counter.deleteMany({}), Contact.deleteMany({}), Conversation.deleteMany({}), Message.deleteMany({})]);
  await User.collection.insertOne({ _id: ADMIN, name: "Ops Admin", email: "ops@plumtrips.com", roles: ["ADMIN"], passwordHash: "x", workspaceId: WS, status: "ACTIVE" } as any);
  await User.collection.insertOne({ _id: SALES, firstName: "Sana", lastName: "Holiday", email: "sana@plumtrips.com", roles: ["EMPLOYEE"], passwordHash: "x", workspaceId: WS, status: "ACTIVE" } as any);
});

/** Track B: map SALES onto concierge (WRITE grant + present), so the matrix routes to them. */
async function mapSalesToConcierge(now: Date) {
  await UserPermission.deleteMany({ userId: String(SALES) });
  await UserPermission.create({ userId: String(SALES), email: "sana@plumtrips.com", workspaceId: String(WS), universe: "STAFF", source: "manual", level: { code: "L3", name: "Exec", designation: "x" }, status: "active", tier: 1, grantedModules: [], roleType: "EMPLOYEE", grantedBy: "test", grantedAt: new Date(), modules: { plumconnectConcierge: { access: "WRITE", scope: "OWN" } } } as any);
  await AssignmentRule.create({ target: { type: "department", line: "concierge" }, userId: SALES, priority: 1, enabled: true });
  await AgentPresence.findOneAndUpdate({ userId: SALES, line: "concierge" }, { $set: { active: true, activeSince: now, updatedAt: now } }, { upsert: true, timestamps: false });
}

async function thread() {
  const contact = await Contact.create({ phone: CANON, displayName: "Curious" });
  const conversation = await Conversation.create({ contactId: contact._id, kind: "lead", channelAccountId: "1265026903369191", referralRaw: REFERRAL });
  return { contact, conversation };
}

/* ───────────────────────────── parsing ───────────────────────────── */

describe("parseReferral / leadSourceForReferral", () => {
  it("maps Meta's fields, trims, caps body at 500", () => {
    const p = parseReferral(REFERRAL);
    expect(p).toMatchObject({ sourceType: "ad", sourceId: "120212345678901234", sourceUrl: REFERRAL.source_url, ctwaClid: "AfeXYZ123", headline: "Bali from ₹49,999", mediaType: "image" });
    expect(p.body).toHaveLength(500);
    expect(p.body.startsWith("7 nights, flights included.")).toBe(true);
  });

  it("tolerates missing / non-object input", () => {
    expect(parseReferral(null)).toEqual({ sourceType: "", sourceId: "", sourceUrl: "", ctwaClid: "", headline: "", body: "", mediaType: "" });
    expect(parseReferral("garbage")).toEqual(parseReferral(undefined));
  });

  it("derives the legacy Lead.source from the ad platform, never 'campaign'", () => {
    expect(leadSourceForReferral(parseReferral(REFERRAL))).toBe("instagram");
    expect(leadSourceForReferral(parseReferral({ source_url: "https://fb.me/xyz" }))).toBe("facebook");
    expect(leadSourceForReferral(parseReferral({ source_url: "https://www.facebook.com/ads/…" }))).toBe("facebook");
    expect(leadSourceForReferral(parseReferral({ source_url: "" }))).toBe("other");
  });
});

/* ───────────────────────────── assignee (Track B) ───────────────────────────── */

describe("assignee — the matrix, never the first admin", () => {
  it("no matrix rule → HELD: lead created unassigned, thread unassigned + routing 'held'; the ADMIN is NOT picked", async () => {
    const { contact, conversation } = await thread();
    const r = await captureHolidayLead({ canonical: CANON, profileName: "Curious", referralRaw: REFERRAL, contactId: contact._id as any, conversation, messageId: "w", now: NOW });
    expect(r).toMatchObject({ touch: "first", assignedTo: null, routing: "held" });
    const lead: any = await Lead.collection.findOne({ _id: (r as any).leadId });
    expect(lead).not.toHaveProperty("assignedTo");
    expect(lead.assignedToName).toBe("");
    const c: any = await Conversation.findById(conversation._id).lean();
    expect(c.assignedTo).toBeNull();
    expect(c.routing).toMatchObject({ state: "held", targetType: "department", targetKey: "department:concierge", candidates: [], autoAssigned: false, reason: "nobody mapped" });
    expect(c.routing.resolvedAt).toEqual(NOW);
  });

  it("SALES mapped on concierge, present, WRITE → assigned to SALES with the DB-resolved label; the thread carries the decision", async () => {
    await mapSalesToConcierge(NOW);
    const { contact, conversation } = await thread();
    const r = await captureHolidayLead({ canonical: CANON, profileName: "Curious", referralRaw: REFERRAL, contactId: contact._id as any, conversation, messageId: "w", now: NOW });
    expect(r).toMatchObject({ touch: "first", routing: "assigned" });
    expect(String((r as any).assignedTo)).toBe(String(SALES));
    const lead: any = await Lead.collection.findOne({ _id: (r as any).leadId });
    expect(lead).toMatchObject({ assignedTo: SALES, assignedToName: "Sana Holiday", createdBy: SALES });
    const c: any = await Conversation.findById(conversation._id).lean();
    expect(String(c.assignedTo)).toBe(String(SALES));
    expect(c.routing).toMatchObject({ state: "assigned", targetKey: "department:concierge", autoAssigned: true, reason: "priority 1" });
    expect(c.routing.candidates.map(String)).toEqual([String(SALES)]);
    // the thread's message ledger is untouched by routing
    expect(await Message.countDocuments({ conversationId: conversation._id })).toBe(0);
  });

  it("SALES mapped but AWAY → held (no first-admin fallback)", async () => {
    await mapSalesToConcierge(NOW);
    await AgentPresence.updateOne({ userId: SALES, line: "concierge" }, { $set: { active: false } });
    const { contact, conversation } = await thread();
    const r = await captureHolidayLead({ canonical: CANON, profileName: "Curious", referralRaw: REFERRAL, contactId: contact._id as any, conversation, messageId: "w", now: NOW });
    expect(r).toMatchObject({ assignedTo: null, routing: "held" });
    expect((await Conversation.findById(conversation._id).lean())!.routing).toMatchObject({ state: "held", reason: "nobody eligible (away or cannot act)" });
  });
});

/* ───────────────────────────── first touch ───────────────────────────── */

describe("captureHolidayLead — first touch", () => {
  it("creates the Lead with the explicit field set, attribution, links, and exactly one lead.created call", async () => {
    await TaskAutomation.create({ workspaceId: SYSTEM_WORKSPACE_ID, triggerKey: "lead.created", label: "welcome", entityType: "LEAD", titleTemplate: "Welcome {{leadName}}", dueOffsetMinutes: 60, priority: "MEDIUM", assigneeRule: { type: "OWNER" }, tags: [] });
    await mapSalesToConcierge(NOW);
    const { contact, conversation } = await thread();

    const r = await captureHolidayLead({ canonical: CANON, profileName: "Curious", referralRaw: REFERRAL, contactId: contact._id as any, conversation, messageId: "wamid.first", now: NOW });
    expect(r).toMatchObject({ touch: "first", created: true });

    const lead: any = await Lead.collection.findOne({ _id: (r as any).leadId });
    expect(lead).toMatchObject({
      type: "individual",
      contactName: "Curious",
      contactPhone: CANON,
      contactEmail: "",
      companyName: "",
      companyId: null,
      source: "instagram",
      stage: "new",
      enquiryType: "holiday_package",
      sourceChannel: "whatsapp",
      assignedTo: SALES,
      assignedToName: "Sana Holiday",
      createdBy: SALES,
    });
    expect(lead.attribution).toEqual({
      channel: "whatsapp",
      sourceType: "ad",
      sourceId: "120212345678901234",
      sourceUrl: REFERRAL.source_url,
      ctwaClid: "AfeXYZ123",
      headline: "Bali from ₹49,999",
      body: parseReferral(REFERRAL).body,
      mediaType: "image",
      capturedAt: NOW,
      conversationId: conversation._id,
    });
    expect(lead.notes).toContain("Bali from ₹49,999");
    expect(lead.leadCode).toMatch(/^LEAD-\d{4}-\d{4}$/);
    // the adapter never touches a company
    expect(await CRMCompany.countDocuments({})).toBe(0);

    // links
    expect(String((await Conversation.findById(conversation._id).lean())!.leadId)).toBe(String(lead._id));
    expect((await Contact.findById(contact._id).lean())!.refs.leadIds.map(String)).toEqual([String(lead._id)]);

    // the note activity from createLead (body.notes set), credited to PlumConnect
    const notes = await LeadActivity.find({ leadId: lead._id }).lean();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ type: "note", createdByName: "PlumConnect" });

    // exactly one lead.created, and the Task lands via the real automation
    expect(H.trigger).toHaveBeenCalledTimes(1);
    expect(H.trigger.mock.calls[0][0]).toBe("lead.created");
    const task = await H.trigger.mock.results[0].value;
    expect(task!.title).toBe("Welcome Curious");
    expect(await Task.countDocuments({})).toBe(1);
  });

  it("flag-ON hook keeps status/sourceChannel coherent; flag-OFF persists the explicit values untouched", async () => {
    process.env[CRM_V2_OPPORTUNITY_ENV] = "true";
    let t = await thread();
    let r = await captureHolidayLead({ canonical: CANON, profileName: "A", referralRaw: REFERRAL, contactId: t.contact._id as any, conversation: t.conversation, messageId: "w1", now: NOW });
    let lead: any = await Lead.collection.findOne({ _id: (r as any).leadId });
    expect(lead.status).toBe("NEW"); // derived by the hook from stage "new"
    expect(lead.sourceChannel).toBe("whatsapp"); // explicit value wins over the source copy

    delete process.env[CRM_V2_OPPORTUNITY_ENV];
    await Promise.all([Contact.deleteMany({}), Conversation.deleteMany({})]);
    t = await thread();
    r = await captureHolidayLead({ canonical: CANON, profileName: "B", referralRaw: REFERRAL, contactId: t.contact._id as any, conversation: t.conversation, messageId: "w2", now: NOW });
    lead = await Lead.collection.findOne({ _id: (r as any).leadId });
    expect(lead.status).toBeNull(); // hook is a no-op; readers use effectiveLeadStatus()
    expect(lead.sourceChannel).toBe("whatsapp");
    expect(lead.enquiryType).toBe("holiday_package");
  });

  it("blank profile name → the 'WhatsApp contact' placeholder (contactName is required); nobody mapped → unassigned", async () => {
    await User.deleteMany({});
    const { contact, conversation } = await thread();
    const r = await captureHolidayLead({ canonical: CANON, profileName: "", referralRaw: { source_type: "ad" }, contactId: contact._id as any, conversation, messageId: "w", now: NOW });
    const lead: any = await Lead.collection.findOne({ _id: (r as any).leadId });
    expect(lead.contactName).toBe("WhatsApp contact");
    expect(lead).not.toHaveProperty("assignedTo");
    expect(lead.assignedToName).toBe("");
    expect(lead.notes).toBe("");
    expect(await LeadActivity.countDocuments({})).toBe(0);
    expect((r as any).assignedTo).toBeNull();
  });
});

/* ───────────────────────────── repeat touch (dedup) ───────────────────────────── */

describe("captureHolidayLead — repeat touch on an open lead thread", () => {
  it("no second Lead; a referral-touch Message + note activity; first attribution and leadIds untouched", async () => {
    const { contact, conversation } = await thread();
    const first = await captureHolidayLead({ canonical: CANON, profileName: "Curious", referralRaw: REFERRAL, contactId: contact._id as any, conversation, messageId: "wamid.first", now: NOW });
    const firstLead: any = await Lead.collection.findOne({ _id: (first as any).leadId });

    const LATER = new Date(NOW.getTime() + 3 * 24 * 3600_000);
    const SECOND_REFERRAL = { ...REFERRAL, headline: "Bali — last seats!", ctwa_clid: "AfeSECOND", source_id: "999" };
    const conv2 = (await Conversation.findById(conversation._id))!; // as the dispatcher would re-read it
    const second = await captureHolidayLead({ canonical: CANON, profileName: "Curious", referralRaw: SECOND_REFERRAL, contactId: contact._id as any, conversation: conv2, messageId: "wamid.second", now: LATER });

    expect(second).toEqual({ touch: "repeat", created: false, leadId: (first as any).leadId });
    expect(await Lead.countDocuments({})).toBe(1);

    // first-touch attribution is exactly what it was
    const leadNow: any = await Lead.collection.findOne({ _id: (first as any).leadId });
    expect(leadNow.attribution).toEqual(firstLead.attribution);
    expect(leadNow.attribution.ctwaClid).toBe("AfeXYZ123");
    expect(leadNow.attribution.capturedAt).toEqual(NOW);

    // the touch is recorded twice over: thread + lead timeline
    const touch = await Message.findOne({ conversationId: conversation._id, type: "system", "payload.kind": "referral_touch" }).lean();
    expect(touch).toMatchObject({ direction: "INBOUND", visibleToContact: false });
    expect(touch!.text).toContain("Bali — last seats!");
    expect((touch!.payload as any)).toMatchObject({ kind: "referral_touch", inboundExternalId: "wamid.second", referral: SECOND_REFERRAL });
    const acts = await LeadActivity.find({ leadId: (first as any).leadId }).sort({ createdAt: 1 }).lean();
    expect(acts.map((a) => a.type)).toEqual(["note", "note"]);
    expect(acts[1].note).toContain("repeat touch");
    expect(acts[1].note).toContain("Bali — last seats!");

    // contact still references one lead; automation fired once in total
    expect((await Contact.findById(contact._id).lean())!.refs.leadIds).toHaveLength(1);
    expect(H.trigger).toHaveBeenCalledTimes(1);
  });

  it("a RESOLVED earlier thread does not block a new enquiry: a new open thread gets its own Lead", async () => {
    const { contact, conversation } = await thread();
    const first = await captureHolidayLead({ canonical: CANON, profileName: "Curious", referralRaw: REFERRAL, contactId: contact._id as any, conversation, messageId: "w1", now: NOW });
    await Conversation.updateOne({ _id: conversation._id }, { $set: { status: "RESOLVED" } });

    const fresh = await Conversation.create({ contactId: contact._id, kind: "lead", referralRaw: REFERRAL });
    const second = await captureHolidayLead({ canonical: CANON, profileName: "Curious", referralRaw: REFERRAL, contactId: contact._id as any, conversation: fresh, messageId: "w2", now: NOW });
    expect(second.touch).toBe("first");
    expect(String(second.leadId)).not.toBe(String(first.leadId));
    expect(await Lead.countDocuments({})).toBe(2);
    expect((await Contact.findById(contact._id).lean())!.refs.leadIds).toHaveLength(2);
  });
});
