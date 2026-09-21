// apps/backend/src/scripts/plumconnect-seed-dev.ts
//
// DEV-ONLY seed for the PlumConnect inbox. `pnpm -C apps/backend seed:plumconnect`
// (add `-- --clean` to remove everything it made). docs/plumconnect/LOCAL_RUN.md.
//
// Populates a LOCAL database with five WhatsApp threads that between them
// exercise everything Slices 0–5 built, so /crm/plumconnect renders every
// list state and every bubble type without a Meta app, a tunnel or a phone:
//
//   1. concierge lead, bot mid-flow      (name answered, awaiting destination)
//   2. helloviza lead, department queue  (keyword-routed, assigned, no bot)
//   3. plumtrips lead, department queue  (menu-routed, 24h window closed)
//   4. general support                   (unknown contact, menu sent, typed
//                                         "something else")
//   5. bound-employee expense thread     (legacy expense bot, hidden by
//                                         default behind "System conversations")
//
// plus two logins (a SUPERADMIN to open the inbox with, an ungranted rep to
// demonstrate the permission gate) and one bound employee.
//
// ── HARD SAFETY ──────────────────────────────────────────────────────────
// This script writes FAKE conversations. It refuses to run — before it
// opens a connection — unless ALL of these hold:
//   • NODE_ENV is not "production"
//   • MONGO_URI passes assertLocalDatabase() (loopback host, never +srv)
//   • MONGO_URI does not even LOOK like the production cluster
// There is no override flag. To point it at anything remote you have to
// edit this file, and that is the intended amount of friction.
//
// ── IDEMPOTENT / REVERSIBLE ──────────────────────────────────────────────
// Everything it creates is keyed on a fixed dev set: five phones in the
// 91990000010x block, three *@plumtrips.test logins, lead codes DEV-PC-*,
// one campaign-map ad id starting DEVPC. Re-running tears those down and
// rebuilds them (the same shape seed-dev.ts uses — upserting a cross-linked
// graph across six collections drifts with every schema change; a scoped
// teardown stays correct for free). `--clean` runs only the teardown.
// Nothing outside that set is ever read or written.

import "../bootstrap/loadSecrets.js";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { plumconnectDevTargetProblem } from "../seed/plumconnectDevGuard.js";

/* ───────────────────────────── the guard ───────────────────────────── */
// One definition, shared with scripts/plumconnect-local.mjs: seed/plumconnectDevGuard.ts.

function refuse(reason: string): never {
  console.error(`\n[plumconnect-seed-dev] REFUSING TO RUN: ${reason}\n`);
  process.exit(2);
}

function guard(): string {
  const uri = String(process.env.MONGO_URI || "");
  const problem = plumconnectDevTargetProblem(uri, process.env.NODE_ENV);
  if (problem) refuse(problem);
  return uri;
}

const MONGO_URI = guard();

/* ───────────────────────────── models (after the guard) ───────────────────────────── */

const { default: User } = await import("../models/User.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { default: Lead } = await import("../models/Lead.js");
const { default: Contact } = await import("../models/plumconnect/Contact.js");
const { default: Conversation } = await import("../models/plumconnect/Conversation.js");
const { default: Message } = await import("../models/plumconnect/Message.js");
const { default: CampaignMap } = await import("../models/plumconnect/CampaignMap.js");
const { MENU_TEXT, MENU_BUTTONS, MENU_BUTTON_IDS } = await import("../services/plumconnect/intent.js");
const { LEVEL_TEMPLATES } = await import("../config/levelTemplates.js");

/* ───────────────────────────── the fixed dev set ───────────────────────────── */

export const DEV_TAG = "plumconnect-dev-seed";
// Mirrors middleware/requireHouse.ts — the inbox is HOUSE-only. Never written to.
const HOUSE_WORKSPACE_ID = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const PASSWORD = "Passw0rd!";
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID || "1265026903369191";

export const DEV_LOGINS = {
  admin: { email: "plumconnect-dev@plumtrips.test", name: "Dev Superadmin", roles: ["SUPERADMIN"] },
  rep: { email: "plumconnect-rep@plumtrips.test", name: "Riya Rep", roles: ["EMPLOYEE"] },
  employee: { email: "plumconnect-employee@plumtrips.test", name: "Vikram Bound", roles: ["EMPLOYEE"] },
} as const;

export const DEV_PHONES = {
  concierge: "919900000101",
  helloviza: "919900000102",
  plumtrips: "919900000103",
  support: "919900000104",
  expense: "919900000105",
} as const;

export const DEV_LEAD_CODES = ["DEV-PC-CONCIERGE", "DEV-PC-HELLOVIZA", "DEV-PC-PLUMTRIPS"] as const;
export const DEV_AD_ID = "DEVPC120200000000001";

const REFERRAL = {
  source_url: "https://www.instagram.com/p/plumtrips-bali-dev/",
  source_type: "ad",
  source_id: DEV_AD_ID,
  headline: "Bali from ₹49,999",
  body: "7 nights, flights included",
  media_type: "image",
  ctwa_clid: "DEVPC-clid-1",
};

/* ───────────────────────────── teardown ───────────────────────────── */

async function teardown(): Promise<Record<string, number>> {
  const phones = Object.values(DEV_PHONES);
  const contacts = await Contact.find({ phone: { $in: phones } }).select("_id").lean();
  const contactIds = contacts.map((c) => c._id);
  const convs = await Conversation.find({ contactId: { $in: contactIds } }).select("_id").lean();
  const convIds = convs.map((c) => c._id);

  const emails = Object.values(DEV_LOGINS).map((l) => l.email);
  const users = await User.find({ email: { $in: emails } }).select("_id").lean();
  const userIds = users.map((u) => String(u._id));

  const out: Record<string, number> = {};
  out.messages = (await Message.deleteMany({ conversationId: { $in: convIds } })).deletedCount;
  out.conversations = (await Conversation.deleteMany({ _id: { $in: convIds } })).deletedCount;
  out.contacts = (await Contact.deleteMany({ _id: { $in: contactIds } })).deletedCount;
  out.leads = (await Lead.deleteMany({ leadCode: { $in: [...DEV_LEAD_CODES] } })).deletedCount;
  out.campaignMap = (await CampaignMap.deleteMany({ adId: DEV_AD_ID })).deletedCount;
  out.permissions = (await UserPermission.deleteMany({ userId: { $in: userIds } })).deletedCount;
  out.users = (await User.deleteMany({ _id: { $in: users.map((u) => u._id) } })).deletedCount;
  return out;
}

/* ───────────────────────────── build ───────────────────────────── */

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const hoursAgo = (h: number) => minutesAgo(h * 60);

let seq = 0;
const wamid = (dir: "IN" | "OUT") => `wamid.DEVPC.${dir}.${Date.now()}.${++seq}`;

type Msg = {
  direction: "INBOUND" | "OUTBOUND";
  type: string;
  text?: string;
  payload?: Record<string, unknown>;
  authorUserId?: mongoose.Types.ObjectId | null;
  visibleToContact?: boolean;
  deliveryStatus?: "sent" | "delivered" | "read" | null;
  at: Date;
};

async function thread(input: {
  phone: string;
  displayName: string;
  identityState: "unknown" | "soft_employee" | "soft_crm" | "verified_employee";
  userId?: mongoose.Types.ObjectId | null;
  kind: "lead" | "support" | "expense";
  businessLine?: "plumtrips" | "helloviza" | "concierge" | null;
  intentSource?: "keyword" | "menu" | "campaign_map" | null;
  intent?: string;
  intentConfidence?: number | null;
  intentMenuSentAt?: Date | null;
  referralRaw?: unknown;
  leadId?: mongoose.Types.ObjectId | null;
  assignedTo?: mongoose.Types.ObjectId | null;
  bot?: { active: boolean; step: string; retries: number; stoppedBy: string | null; stoppedAt: Date | null };
  messages: Msg[];
}) {
  const first = input.messages[0].at;
  const inbound = input.messages.filter((m) => m.direction === "INBOUND" && m.type !== "system");
  const outbound = input.messages.filter((m) => m.direction === "OUTBOUND" && m.visibleToContact !== false);
  const lastIn = inbound.length ? inbound[inbound.length - 1].at : null;
  const lastOut = outbound.length ? outbound[outbound.length - 1].at : null;
  const lastAt = input.messages[input.messages.length - 1].at;

  const contact = await Contact.create({
    phone: input.phone,
    displayName: input.displayName,
    identityState: input.identityState,
    refs: { userId: input.userId ?? null, leadIds: input.leadId ? [input.leadId] : [] },
    firstSeenAt: first,
    lastSeenAt: lastIn ?? first,
  });

  const conversation = await Conversation.create({
    contactId: contact._id,
    channel: "whatsapp",
    channelAccountId: PHONE_NUMBER_ID,
    kind: input.kind,
    status: "OPEN",
    businessLine: input.businessLine ?? null,
    intentSource: input.intentSource ?? null,
    intent: input.intent ?? "",
    intentConfidence: input.intentConfidence ?? null,
    intentMenuSentAt: input.intentMenuSentAt ?? null,
    referralRaw: input.referralRaw ?? null,
    leadId: input.leadId ?? null,
    assignedTo: input.assignedTo ?? null,
    bot: input.bot ?? { active: false, step: null, retries: 0, stoppedBy: null, stoppedAt: null },
    lastInboundAt: lastIn,
    lastOutboundAt: lastOut,
    lastMessageAt: lastAt,
    createdAt: first,
    updatedAt: lastAt,
  });

  for (const m of input.messages) {
    const isRecord = m.type === "note" || m.type === "system";
    await Message.create({
      conversationId: conversation._id,
      direction: m.direction,
      channel: "whatsapp",
      externalId: isRecord ? undefined : wamid(m.direction === "INBOUND" ? "IN" : "OUT"),
      type: m.type,
      text: m.text ?? "",
      payload: { ...(m.payload ?? {}), devSeed: DEV_TAG },
      authorUserId: m.authorUserId ?? null,
      visibleToContact: m.visibleToContact ?? true,
      deliveryStatus: m.direction === "OUTBOUND" && !isRecord ? (m.deliveryStatus ?? "delivered") : null,
      sentAt: m.at,
      createdAt: m.at,
      updatedAt: m.at,
    });
  }
  if (input.leadId) await Lead.updateOne({ _id: input.leadId }, { $set: { "attribution.conversationId": conversation._id } });
  return { contact, conversation };
}

// A staff login needs TWO rows: the User, and a UserPermission keyed on the
// email — POST /auth/login answers "Your account has not been activated yet"
// to any staff user without one (routes/auth.ts, the isSA / permission gate).
// The superadmin row carries hrmsAccessRole "SuperAdmin" (the spelling that
// gate checks) and an L8 / roleType SUPERADMIN grant; the other two get a
// plain L1 grant whose plumconnect module is NONE — which is exactly what
// makes the rep's inbox call 403 (requirePlumConnectAccess) until an admin
// grants it in /admin/access.
async function makeUser(login: { email: string; name: string; roles: readonly string[] }, level: "L1" | "L8", extra: Record<string, unknown> = {}) {
  const [firstName, ...rest] = login.name.split(" ");
  const isSuper = level === "L8";
  const user: any = await User.create({
    email: login.email,
    passwordHash: await bcrypt.hash(PASSWORD, 10),
    firstName,
    lastName: rest.join(" "),
    name: login.name,
    roles: [...login.roles],
    hrmsAccessRole: isSuper ? "SuperAdmin" : "EMPLOYEE",
    workspaceId: HOUSE_WORKSPACE_ID,
    isActive: true,
    status: "ACTIVE",
    ...extra,
  } as any);
  await UserPermission.create({
    userId: String(user._id),
    email: login.email,
    workspaceId: String(HOUSE_WORKSPACE_ID),
    universe: "STAFF",
    level: { code: level, name: isSuper ? "Super Admin" : "Employee", designation: `${DEV_TAG}` },
    modules: LEVEL_TEMPLATES[level],
    status: "active",
    tier: isSuper ? 3 : 0,
    roleType: isSuper ? "SUPERADMIN" : "EMPLOYEE",
    source: "manual",
    grantedBy: String(user._id), // self — a dev fixture, not an audit trail
    grantedAt: new Date(),
  } as any);
  return user;
}

async function makeLead(code: string, input: { businessLine: "concierge" | "helloviza" | "plumtrips"; contactName: string; phone: string; assignedTo?: mongoose.Types.ObjectId | null; assignedToName?: string; referral?: boolean }) {
  const shape = {
    concierge: { enquiryType: "holiday_package", type: "individual" },
    helloviza: { enquiryType: "visa", type: "individual" },
    plumtrips: { enquiryType: "corporate_account", type: "company" },
  }[input.businessLine];
  return Lead.create({
    leadCode: code,
    type: shape.type,
    contactName: input.contactName,
    contactPhone: input.phone,
    contactEmail: "",
    companyName: input.businessLine === "plumtrips" ? "Dev Corp (seed)" : "",
    source: input.referral ? "instagram" : "other",
    stage: "new",
    notes: `[${DEV_TAG}] fake lead for the local PlumConnect inbox — safe to delete`,
    enquiryType: shape.enquiryType,
    sourceChannel: "whatsapp",
    assignedTo: input.assignedTo ?? null,
    assignedToName: input.assignedToName ?? "",
    ...(input.referral
      ? {
          attribution: {
            channel: "whatsapp",
            sourceType: REFERRAL.source_type,
            sourceId: REFERRAL.source_id,
            sourceUrl: REFERRAL.source_url,
            ctwaClid: REFERRAL.ctwa_clid,
            headline: REFERRAL.headline,
            body: REFERRAL.body,
            mediaType: REFERRAL.media_type,
            capturedAt: hoursAgo(2),
          },
        }
      : {}),
  } as any);
}

async function build() {
  const admin: any = await makeUser(DEV_LOGINS.admin, "L8");
  const rep: any = await makeUser(DEV_LOGINS.rep, "L1");
  const employee: any = await makeUser(DEV_LOGINS.employee, "L1", { waId: DEV_PHONES.expense, phone: `+91 ${DEV_PHONES.expense.slice(2, 7)} ${DEV_PHONES.expense.slice(7)}` });

  await CampaignMap.create({ adId: DEV_AD_ID, businessLine: "concierge", label: `Bali promo (${DEV_TAG})`, enabled: true, createdBy: admin._id });

  const botMsg = (text: string, step: string, at: Date): Msg => ({ direction: "OUTBOUND", type: "text", text, payload: { origin: "bot", bot: step }, deliveryStatus: "read", at });
  const menuMsg = (at: Date): Msg => ({
    direction: "OUTBOUND",
    type: "interactive",
    text: MENU_TEXT,
    payload: { origin: "support", intentMenu: true, buttons: MENU_BUTTONS.map((b) => b.id) },
    deliveryStatus: "read",
    at,
  });
  const note = (text: string, by: mongoose.Types.ObjectId, at: Date): Msg => ({ direction: "OUTBOUND", type: "note", text, authorUserId: by, visibleToContact: false, at });
  const system = (text: string, payload: Record<string, unknown>, by: mongoose.Types.ObjectId | null, at: Date): Msg => ({ direction: "OUTBOUND", type: "system", text, payload, authorUserId: by, visibleToContact: false, at });

  // 1. concierge — CTWA ad, campaign-mapped, bot mid-flow (name answered, awaiting destination)
  const conciergeLead: any = await makeLead("DEV-PC-CONCIERGE", { businessLine: "concierge", contactName: "Priya Sharma", phone: DEV_PHONES.concierge, referral: true });
  await thread({
    phone: DEV_PHONES.concierge,
    displayName: "Priya Sharma",
    identityState: "unknown",
    kind: "lead",
    businessLine: "concierge",
    intentSource: "campaign_map",
    intent: `ad:${DEV_AD_ID}`,
    intentConfidence: 1,
    referralRaw: REFERRAL,
    leadId: conciergeLead._id,
    bot: { active: true, step: "ask_destination", retries: 0, stoppedBy: null, stoppedAt: null },
    messages: [
      { direction: "INBOUND", type: "text", text: "Hi, saw your Bali ad", payload: { referral: REFERRAL, rawType: "text" }, at: minutesAgo(9) },
      botMsg('Hi! Thanks for reaching out to Plumtrips about "Bali from ₹49,999". To get started, what\'s your name?', "ask_name", minutesAgo(9)),
      { direction: "INBOUND", type: "text", text: "Priya Sharma", payload: { rawType: "text" }, at: minutesAgo(6) },
      botMsg("Nice to meet you, Priya Sharma! Where would you like to go?", "ask_destination", minutesAgo(6)),
    ],
  });

  // 2. helloviza — keyword-routed, assigned to the rep, replied, contact spoke last (needs reply)
  const vizaLead: any = await makeLead("DEV-PC-HELLOVIZA", { businessLine: "helloviza", contactName: "Rahul Verma", phone: DEV_PHONES.helloviza, assignedTo: rep._id, assignedToName: rep.name });
  await thread({
    phone: DEV_PHONES.helloviza,
    displayName: "Rahul Verma",
    identityState: "unknown",
    kind: "lead",
    businessLine: "helloviza",
    intentSource: "keyword",
    intent: "visa,schengen",
    intentConfidence: 1,
    leadId: vizaLead._id,
    assignedTo: rep._id,
    messages: [
      { direction: "INBOUND", type: "text", text: "Hello, I need a Schengen visa for Germany in November. What documents do you need?", payload: { rawType: "text" }, at: hoursAgo(3) },
      { direction: "INBOUND", type: "image", text: "", payload: { media: { id: "DEVPC-MEDIA-1", mime: "image/jpeg", mediaType: "image", caption: "passport" }, rawType: "image" }, at: hoursAgo(3) },
      system(`Assigned to ${rep.name}`, { kind: "assignment", from: null, to: String(rep._id) }, admin._id, hoursAgo(2.5)),
      note("Checked with ops: Germany short-stay needs a VFS Delhi slot — earliest is 3 weeks out. Send the checklist first.", rep._id, hoursAgo(2.4)),
      { direction: "OUTBOUND", type: "text", text: "Hi Rahul, thanks for reaching out — I'm Riya from Helloviza. For a Germany short-stay visa you'll need a valid passport, 3 months' bank statements, flight and hotel bookings, travel insurance and a cover letter. I'll send the full checklist now.", payload: { origin: "agent", agentReply: true }, authorUserId: rep._id, deliveryStatus: "read", at: hoursAgo(2.3) },
      { direction: "INBOUND", type: "text", text: "Great, thank you! When can we start the application?", payload: { rawType: "text" }, at: minutesAgo(25) },
    ],
  });

  // 3. plumtrips — menu-routed, unassigned, last inbound 30h ago (24h reply window closed)
  const corpLead: any = await makeLead("DEV-PC-PLUMTRIPS", { businessLine: "plumtrips", contactName: "Ananya Rao", phone: DEV_PHONES.plumtrips });
  await thread({
    phone: DEV_PHONES.plumtrips,
    displayName: "Ananya Rao",
    identityState: "unknown",
    kind: "lead",
    businessLine: "plumtrips",
    intentSource: "menu",
    intent: "menu:plumtrips",
    intentConfidence: 1,
    intentMenuSentAt: hoursAgo(30.2),
    leadId: corpLead._id,
    messages: [
      { direction: "INBOUND", type: "text", text: "hi", payload: { rawType: "text" }, at: hoursAgo(30.2) },
      menuMsg(hoursAgo(30.2)),
      { direction: "INBOUND", type: "interactive", text: "", payload: { buttonId: MENU_BUTTON_IDS.plumtrips, rawType: "interactive" }, at: hoursAgo(30.1) },
      { direction: "INBOUND", type: "text", text: "We're a 40-person startup and want a corporate travel platform with GST invoices.", payload: { rawType: "text" }, at: hoursAgo(30) },
      note("Good fit for the SMB plan — needs a call. No reply went out in time; the 24h window has closed (template send is Phase 2).", admin._id, hoursAgo(4)),
    ],
  });

  // 4. general support — unknown contact, menu sent, typed "something else"
  await thread({
    phone: DEV_PHONES.support,
    displayName: "Meera K",
    identityState: "unknown",
    kind: "support",
    intentMenuSentAt: minutesAgo(40),
    messages: [
      { direction: "INBOUND", type: "text", text: "Hello? I need help with my booking PT-2291, the hotel says they have no record", payload: { rawType: "text" }, at: minutesAgo(40) },
      menuMsg(minutesAgo(40)),
      { direction: "INBOUND", type: "text", text: "Something else — it's an existing booking, not a new enquiry", payload: { rawType: "text" }, at: minutesAgo(38) },
      { direction: "INBOUND", type: "document", text: "", payload: { media: { id: "DEVPC-MEDIA-2", mime: "application/pdf", mediaType: "document", filename: "hotel-voucher-PT-2291.pdf" }, rawType: "document" }, at: minutesAgo(37) },
    ],
  });

  // 5. bound employee — legacy expense bot thread (hidden by default in the inbox)
  await thread({
    phone: DEV_PHONES.expense,
    displayName: employee.name,
    identityState: "verified_employee",
    userId: employee._id,
    kind: "expense",
    messages: [
      { direction: "INBOUND", type: "image", text: "", payload: { media: { id: "DEVPC-MEDIA-3", mime: "image/jpeg", mediaType: "image", caption: "team lunch" }, rawType: "image" }, at: hoursAgo(1) },
      { direction: "OUTBOUND", type: "text", text: "Got it! I read ₹1,240 at Cafe Delhi Heights on 20 Sep. Log it as Meals?", payload: { origin: "expense" }, deliveryStatus: "read", at: hoursAgo(1) },
      { direction: "INBOUND", type: "interactive", text: "", payload: { buttonId: "confirm", rawType: "interactive" }, at: minutesAgo(58) },
      { direction: "OUTBOUND", type: "text", text: "Logged ✅ Expense EXP-2041 is in your drafts.", payload: { origin: "expense" }, deliveryStatus: "delivered", at: minutesAgo(58) },
    ],
  });

  return { admin, rep, employee };
}

/* ───────────────────────────── main ───────────────────────────── */

const clean = process.argv.includes("--clean");

console.log(`[plumconnect-seed-dev] target ${MONGO_URI.replace(/\/\/[^@]*@/, "//<creds>@")} (NODE_ENV=${process.env.NODE_ENV || "unset"})`);
await mongoose.connect(MONGO_URI);
try {
  const removed = await teardown();
  console.log(`[plumconnect-seed-dev] removed previous dev rows:`, removed);
  if (clean) {
    console.log("[plumconnect-seed-dev] --clean: done, nothing created.");
  } else {
    const { admin, rep, employee } = await build();
    const counts = {
      contacts: await Contact.countDocuments({ phone: { $in: Object.values(DEV_PHONES) } }),
      conversations: await Conversation.countDocuments({ contactId: { $in: (await Contact.find({ phone: { $in: Object.values(DEV_PHONES) } }).select("_id").lean()).map((c) => c._id) } }),
      messages: await Message.countDocuments({ "payload.devSeed": DEV_TAG }),
      leads: await Lead.countDocuments({ leadCode: { $in: [...DEV_LEAD_CODES] } }),
    };
    console.log(`[plumconnect-seed-dev] created:`, counts);
    console.log(`
  Log in at http://localhost:5173/login
    inbox (SUPERADMIN, sees everything):  ${admin.email}     / ${PASSWORD}
    rep   (EMPLOYEE, NO grant → 403):     ${rep.email}     / ${PASSWORD}
    bound employee (waId ${employee.waId}): ${employee.email} / ${PASSWORD}
  Then open http://localhost:5173/crm/plumconnect  (needs VITE_PLUMCONNECT_UI=true + PLUMCONNECT_ENABLED=true).
  Re-run to reset the threads; \`--clean\` removes everything above.
`);
  }
} finally {
  await mongoose.disconnect();
}
