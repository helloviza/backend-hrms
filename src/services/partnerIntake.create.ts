// apps/backend/src/services/partnerIntake.create.ts
//
// A student's request through a partner link becomes an approval request that
// is born approved and goes straight into the ops queue (/admin/approvals):
//
//   status "approved", adminState "pending", stage "REQUEST_APPROVED",
//   meta.travelFlow "APPROVAL_DIRECT" (whatever the partner workspace's own
//   flow), meta.source "PARTNER_LINK", meta.partnerLead (immutable),
//   workspaceId = the partner's CustomerWorkspace._id,
//   customerId  = that workspace's customerId (Customer._id),
//
// then enterOpsQueue() — the same Travel Desk auto-allocation (RM first) and
// desk email an approved request gets. This is the shape approvals.ts writes
// when a Workspace Leader raises (and so self-approves) a request; nothing in
// approvals.ts or approvalDecisions.ts changes for it.
//
// The partner comes from the LINK only: any workspaceId / customerId / code in
// the body is ignored. The link, its workspace and the workspace's customerId
// are re-checked on every submit; any failure is the same "not found".
//
// Requester and approver are the one Partner Intake system user
// (services/partnerLeadCase.ts). The student's contact details are stored on
// the case only (meta.partnerLead.contact) and on its travellers. Travellers
// are "manual" only — "self" is refused (there is no owner profile) — and
// nothing is written to TravellerProfile, CustomerMember or User.
import crypto from "crypto";
import ApprovalRequest from "../models/ApprovalRequest.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import PartnerLink, { PARTNER_LINK_CODE_RE } from "../models/PartnerLink.js";
import User from "../models/User.js";
import { normaliseUtm, isUtmEmpty } from "../models/visaUtm.js";
import { SYSTEM_ACTOR } from "./actorNames.js";
import { enterOpsQueue } from "./approvalDecisions.js";
import { checkCartItems } from "./approvalCartItems.js";
import { isEmail, isPhone, todayIST } from "./approvalItemRules.js";
import { prepareCartTravellers } from "./approvalTravellers.js";
import { PARTNER_INTAKE_EMAIL, PARTNER_INTAKE_NAME, PARTNER_LINK_SOURCE } from "./partnerLeadCase.js";
import { sendPartnerLeadReceived } from "./partnerIntake.email.js";
import { contactEmailHashOf } from "./partnerTrackHash.js";

type AnyObj = Record<string, any>;
const str = (v: any, max = 200) => String(v ?? "").trim().slice(0, max);

/** A refusal the public route turns into a status + body. `status` 404 is always the same body. */
export class PartnerIntakeError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: AnyObj = {},
  ) {
    super(message);
  }
}

export const NOT_FOUND = () => new PartnerIntakeError(404, "NOT_FOUND", "This link is not available.");

/* ───────────────────────── the link ───────────────────────── */

export type ResolvedLink = { link: AnyObj; workspace: AnyObj; partnerName: string };

/**
 * The active link for a code, with its active workspace, or null. Null for
 * every failure (unknown code, inactive link, missing / inactive workspace,
 * a workspace whose customerId no longer matches the link's copy), so a
 * caller can't tell which.
 */
export async function resolveActivePartnerLink(code: any): Promise<ResolvedLink | null> {
  const c = String(code ?? "").trim();
  if (!PARTNER_LINK_CODE_RE.test(c)) return null;
  const link: any = await PartnerLink.findOne({ code: c, active: true }).lean();
  if (!link) return null;
  const workspace: any = await CustomerWorkspace.findById(link.workspaceId)
    .select("_id customerId companyName status config.travelFlow")
    .lean();
  if (!workspace || String(workspace.status || "ACTIVE") !== "ACTIVE") return null;
  if (String(workspace.customerId || "") !== String(link.customerId || "")) return null;
  return { link, workspace, partnerName: str(workspace.companyName) || "Partner" };
}

/* ───────────────────────── input ───────────────────────── */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMBED_MODES = new Set(["iframe", "tab", "direct"]);
const MAX_ITEMS = 6;

export type PartnerIntakeInput = {
  code: string;
  submissionId: string;
  cartItems: any[];
  contact: { name?: string; phone?: string; email?: string };
  consent: { accepted?: boolean; version?: string; text?: string };
  comments?: string;
  embedMode?: string;
  parentOrigin?: string;
  utm?: AnyObj;
  /** Request context, from the route (never the body). */
  ip?: string;
  referrer?: string;
};

function badRequest(code: string, message: string, extra: AnyObj = {}) {
  return new PartnerIntakeError(400, code, message, extra);
}

/** Only what a student may say about an item: its service and its fields. Never a price or a selection. */
function cleanItem(raw: any): AnyObj {
  const meta: AnyObj = raw?.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta) ? { ...raw.meta } : {};
  delete meta.selection;
  delete meta.optionRef;
  const travellers = Array.isArray(meta.travellers) ? meta.travellers.filter((t: any) => t && typeof t === "object") : [];
  if (travellers.some((t: any) => String(t.kind || "").toLowerCase() === "self")) {
    throw badRequest("SELF_NOT_ALLOWED", "Add each traveller's details on the form.");
  }
  meta.travellers = travellers.map((t: any) => ({ ...t, kind: "manual" }));
  return { type: str(raw?.type, 20).toLowerCase(), description: str(raw?.description, 500) || undefined, meta };
}

function checkContact(c: PartnerIntakeInput["contact"]) {
  const name = str(c?.name, 120);
  const email = str(c?.email, 120).toLowerCase();
  const phone = str(c?.phone, 30);
  const missing: string[] = [];
  if (!name) missing.push("name");
  if (!isEmail(email)) missing.push("email");
  if (!isPhone(phone)) missing.push("phone");
  if (missing.length) throw badRequest("CONTACT_REQUIRED", "Your name, a valid email and a valid phone number are required.", { missing });
  return { name, email, phone };
}

function checkConsent(c: PartnerIntakeInput["consent"]) {
  const version = str(c?.version, 40);
  if (c?.accepted !== true || !version) throw badRequest("CONSENT_REQUIRED", "Please accept the privacy notice to continue.");
  return { version, at: new Date(), textHash: crypto.createHash("sha256").update(String(c?.text ?? "")).digest("hex") };
}

function ipHash(ip: string): string {
  if (!ip) return "";
  const salt = process.env.PARTNER_LEAD_IP_SALT || process.env.JWT_SECRET || "";
  return crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

/* ───────────────────────── case number ───────────────────────── */

const BASE32 = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I, L, O, 0, 1: read aloud on a call
export function newCaseNumber(): string {
  let out = "";
  for (const byte of crypto.randomBytes(12)) {
    if (byte < 248 && out.length < 6) out += BASE32[byte % 31]; // 248 = 8 × 31
  }
  while (out.length < 6) out += BASE32[crypto.randomInt(31)];
  return `PL-${out}`;
}

/* ───────────────────────── system requester ───────────────────────── */

let intakeUserId: string | null = null;
async function partnerIntakeUserId(): Promise<string> {
  if (intakeUserId) return intakeUserId;
  const u: any = await User.findOne({ email: PARTNER_INTAKE_EMAIL }).select("_id").lean();
  if (!u) throw new PartnerIntakeError(503, "INTAKE_NOT_CONFIGURED", "We couldn't submit your request. Please try again shortly.");
  intakeUserId = String(u._id);
  return intakeUserId;
}
/** Tests reseed the database between files. */
export function resetPartnerIntakeCache() {
  intakeUserId = null;
}

/* ───────────────────────── per-code daily cap ───────────────────────── */

/** Takes one of today's submissions for the link; false when the cap is reached. */
async function takeDailySlot(linkId: any): Promise<boolean> {
  const day = todayIST();
  const res = await PartnerLink.updateOne(
    {
      _id: linkId,
      active: true,
      $expr: { $or: [{ $ne: ["$dailyCountDay", day] }, { $lt: ["$dailyCount", "$dailyCap"] }] },
    },
    [
      {
        $set: {
          dailyCount: { $cond: [{ $eq: ["$dailyCountDay", day] }, { $add: ["$dailyCount", 1] }, 1] },
          dailyCountDay: day,
        },
      },
    ],
  );
  return res.modifiedCount === 1;
}

/* ───────────────────────── create ───────────────────────── */

export type PartnerIntakeResult = { caseNumber: string; deduped: boolean; requestId: string };

async function existingCase(intakeRef: string): Promise<PartnerIntakeResult | null> {
  const doc: any = await ApprovalRequest.findOne({ "meta.partnerLead.intakeRef": intakeRef }).select("_id meta.partnerLead.caseNumber").lean();
  return doc ? { caseNumber: String(doc.meta?.partnerLead?.caseNumber || ""), deduped: true, requestId: String(doc._id) } : null;
}

const isDup = (err: any, field: string) => err?.code === 11000 && JSON.stringify(err?.keyPattern || err?.keyValue || err?.message || "").includes(field);

export async function createPartnerIntakeCase(input: PartnerIntakeInput): Promise<PartnerIntakeResult> {
  const resolved = await resolveActivePartnerLink(input.code);
  if (!resolved) throw NOT_FOUND();
  const { link, workspace, partnerName } = resolved;

  if (!UUID_V4.test(String(input.submissionId || ""))) throw badRequest("INVALID_SUBMISSION", "Invalid submission.");
  const intakeRef = `partner:${String(input.submissionId).toLowerCase()}`;
  const replay = await existingCase(intakeRef);
  if (replay) return replay;

  const contact = checkContact(input.contact);
  const consent = checkConsent(input.consent);

  const rawItems = Array.isArray(input.cartItems) ? input.cartItems : [];
  if (!rawItems.length) throw badRequest("CART_REQUIRED", "Tell us what you need: a flight, a hotel or a visa.");
  if (rawItems.length > MAX_ITEMS) throw badRequest("CART_TOO_LARGE", `At most ${MAX_ITEMS} items per request.`);
  const items = rawItems.map(cleanItem);
  const offered = new Set((Array.isArray(link.services) && link.services.length ? link.services : ["flight", "hotel", "visa"]).map(String));
  const off = items.findIndex((it) => !offered.has(it.type));
  if (off >= 0) throw badRequest("SERVICE_NOT_OFFERED", "This service isn't available through this link.", { itemIndex: off });
  // The partner page offers one way and round trip only; a multi-city flight
  // sent by hand is refused here (the signed-in request form still allows it).
  const multi = items.findIndex((it) => it.type === "flight" && String(it.meta?.tripType ?? "").toLowerCase().replace(/[^a-z]/g, "") === "multicity");
  if (multi >= 0) throw badRequest("TRIP_TYPE_NOT_OFFERED", "Multi-city trips aren't available here. Choose one way or round trip.", { itemIndex: multi });

  const ownerUserId = await partnerIntakeUserId();
  // Manual travellers only (checked above), so prepareCartTravellers never
  // reads a profile; then the request form's own item rules — passport fields
  // are required for an international trip, exactly as on /customer/approvals/new.
  const cartItems = checkCartItems(await prepareCartTravellers({ cartItems: items, workspaceId: workspace._id, ownerUserId }));

  if (!(await takeDailySlot(link._id))) {
    throw new PartnerIntakeError(429, "DAILY_CAP", "We're receiving a lot of requests right now. Please try again tomorrow.");
  }

  const utmIn = normaliseUtm(input.utm || {});
  const utmDefaults = normaliseUtm(link.utmDefaults || {});
  const utm = Object.fromEntries(Object.entries(utmIn).map(([k, v]) => [k, v || (utmDefaults as AnyObj)[k] || ""]));
  const embedMode = EMBED_MODES.has(String(input.embedMode)) ? String(input.embedMode) : "direct";
  const parentOrigin = str(input.parentOrigin, 200);
  const allowed: string[] = Array.isArray(link.allowedOrigins) ? link.allowedOrigins : [];
  const now = new Date();

  const partnerLead = (caseNumber: string) => ({
    intakeRef,
    caseNumber,
    linkId: String(link._id),
    code: String(link.code),
    placement: str(link.placement, 80),
    partnerWorkspaceId: String(workspace._id),
    partnerName,
    embedMode,
    parentOrigin,
    // Advisory: the client reports its parent page; a mismatch flags the case, never refuses it.
    ...(embedMode === "iframe" && allowed.length && !allowed.includes(parentOrigin) ? { originMismatch: true } : {}),
    referrer: str(input.referrer, 300),
    ...(isUtmEmpty(utm as any) ? {} : { utm }),
    contact,
    // The salted lookup hash "Track my case" finds the student's cases by (services/partnerTrack.ts).
    ...(contactEmailHashOf(contact.email) ? { contactEmailHash: contactEmailHashOf(contact.email) } : {}),
    consent,
    submittedAt: now,
    ipHash: ipHash(str(input.ip, 64)),
  });

  const historyBase = { at: now, by: "system:partner-intake", userEmail: PARTNER_INTAKE_EMAIL, userName: PARTNER_INTAKE_NAME, ...SYSTEM_ACTOR };
  const where = [partnerName, str(link.placement, 80)].filter(Boolean).join(" · ");

  let doc: any = null;
  for (let attempt = 0; attempt < 5 && !doc; attempt++) {
    const caseNumber = newCaseNumber();
    try {
      doc = await ApprovalRequest.create({
        workspaceId: workspace._id,
        ticketId: caseNumber,
        customerId: String(workspace.customerId),
        customerName: partnerName,
        frontlinerId: ownerUserId,
        frontlinerEmail: PARTNER_INTAKE_EMAIL,
        frontlinerName: PARTNER_INTAKE_NAME,
        managerId: ownerUserId,
        managerEmail: PARTNER_INTAKE_EMAIL,
        managerName: PARTNER_INTAKE_NAME,
        status: "approved",
        adminState: "pending",
        stage: "REQUEST_APPROVED",
        approvedByEmail: PARTNER_INTAKE_EMAIL,
        approvedByName: PARTNER_INTAKE_NAME,
        cartItems,
        comments: str(input.comments, 1000) || undefined,
        meta: {
          customerWorkspaceId: String(workspace._id),
          ccLeaders: [],
          travelFlow: "APPROVAL_DIRECT",
          source: PARTNER_LINK_SOURCE,
          partnerLead: partnerLead(caseNumber),
        },
        history: [
          { ...historyBase, action: "submitted", comment: `Case created — partner lead${where ? ` from ${where}` : ""}` },
          { ...historyBase, action: "approved", comment: "In Admin Queue — partner lead, customer approval not required" },
        ],
      });
    } catch (err: any) {
      if (isDup(err, "intakeRef")) {
        // The same submission landed twice at once: the other one won.
        const won = await existingCase(intakeRef);
        if (won) return won;
      }
      if (!isDup(err, "caseNumber")) throw err;
    }
  }
  if (!doc) throw new Error("Could not allocate a case number");

  await PartnerLink.updateOne({ _id: link._id }, { $inc: { submissions: 1 } });
  await enterOpsQueue(doc, PARTNER_INTAKE_NAME);
  await sendPartnerLeadReceived({
    to: contact.email,
    requestId: doc._id,
    caseNumber: doc.ticketId,
    studentName: contact.name,
    partnerName,
    cartItems: doc.cartItems || [],
  });
  return { caseNumber: String(doc.ticketId), deduped: false, requestId: String(doc._id) };
}
