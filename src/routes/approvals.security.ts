// apps/backend/src/routes/approvals.security.ts
import { requireAuth } from "../middleware/auth.js";
import User from "../models/User.js";
import { scopedFindById } from "../middleware/scopedFindById.js";
import CustomerMember from "../models/CustomerMember.js";
import { maskTailId } from "../utils/piiMask.js";
import { readCapability } from "../services/capabilityProbe.js";
import { hasAccess } from "../models/UserPermission.js";
import ApprovalRequest from "../models/ApprovalRequest.js";
import { isSuperAdmin as isSuperAdminReq } from "../middleware/isSuperAdmin.js";

export type AnyObj = Record<string, any>;
export type EmailAction = "approved" | "declined" | "on_hold" | "resend_email";

export function normEmail(v: any) {
  return String(v || "").trim().toLowerCase();
}
export function normStr(v: any) {
  return String(v || "").trim();
}

export function getEmailDomain(email: string) {
  const e = normEmail(email);
  const at = e.lastIndexOf("@");
  return at >= 0 ? e.slice(at + 1) : "";
}


export function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function exactIRegex(value: string) {
  return new RegExp(`^${escapeRegExp(value)}$`, "i");
}
export function isValidObjectId(id: any) {
  return /^[a-fA-F0-9]{24}$/.test(String(id || "").trim());
}
export function parseBool(v: any): boolean {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y" || s === "on";
}

export function collectRoles(u: any): string[] {
  const roles: string[] = [];
  if (Array.isArray(u?.roles)) roles.push(...u.roles);
  if (u?.role) roles.push(u.role);
  if (u?.accountType) roles.push(u.accountType);
  if (u?.userType) roles.push(u.userType);
  if (u?.hrmsAccessRole) roles.push(u.hrmsAccessRole);
  if (u?.hrmsAccessLevel) roles.push(u.hrmsAccessLevel);
  if (u?.memberRole) roles.push(u.memberRole);
  if (u?.approvalRole) roles.push(u.approvalRole);
  return roles.map((r) => String(r).trim().toUpperCase()).filter(Boolean);
}

export function isStaffAdmin(u: any): boolean {
  const r = collectRoles(u);
  // ✅ STRICT: Only internal ops roles
  return (
    r.includes("ADMIN") ||
    r.includes("SUPERADMIN") ||
    r.includes("SUPER_ADMIN") ||
    r.includes("HR_ADMIN") ||
    r.includes("OPS") ||
    r.includes("OPS_ADMIN")
  );
}

export function normalizeList(v: any): string[] {
  if (!v) return [];
  if (Array.isArray(v))
    return v
      .map((x) => String(x))
      .map((s) => s.trim())
      .filter(Boolean);
  if (typeof v === "string")
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

export function normalizeAction(v: any): EmailAction | "" {
  const s = String(v || "").trim().toLowerCase();
  if (s === "approved") return "approved";
  if (s === "declined") return "declined";
  if (s === "resend_email" || s === "resend" || s === "resend-email")
    return "resend_email";
  if (s === "on_hold" || s === "hold" || s === "on-hold") return "on_hold";
  return "";
}

export function assertEmailAction(v: any): Exclude<EmailAction, "resend_email"> {
  // email/consume must ONLY accept decision actions (not resend_email)
  const a = normalizeAction(v);
  if (a === "approved" || a === "declined" || a === "on_hold") return a;
  const err: any = new Error("Invalid action");
  err.statusCode = 400;
  err.publicMessage = "Invalid action";
  throw err;
}

export function publicBaseUrl() {
  return (
    process.env.PUBLIC_BASE_URL ||
    process.env.BACKEND_PUBLIC_URL ||
    `http://localhost:${process.env.PORT || 8080}`
  );
}

/**
 * ✅ Email action links should open FRONTEND page (not backend).
 */
export function frontendBaseUrl() {
  const isProd = process.env.NODE_ENV === "production";

  const fromPublic = normStr(process.env.FRONTEND_PUBLIC_URL || "");
  if (fromPublic) return fromPublic.replace(/\/$/, "");

  const csv = normStr(process.env.FRONTEND_ORIGIN || "");
  const list = csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!list.length) {
    return (isProd ? "https://plumbox.plumtrips.com" : "http://localhost:5173").replace(/\/$/, "");
  }

  if (!isProd) {
    const local = list.find((x) => /localhost|127\.0\.0\.1/i.test(x));
    if (local) return local.replace(/\/$/, "");
  }

  const https = list.find((x) => /^https:\/\//i.test(x));
  return (https || list[0]).replace(/\/$/, "");
}

export function emailUiPath() {
  const raw = normStr(process.env.EMAIL_APPROVAL_PATH || "/approval/email");
  const p = raw.startsWith("/") ? raw : `/${raw}`;
  if (/^\/api\//i.test(p) || /\/api\/approvals/i.test(p)) return "/approval/email";
  return p;
}

export function buildEmailUiActionUrl(token: string, action: EmailAction) {
  const base = frontendBaseUrl() || publicBaseUrl();
  return `${base}${emailUiPath()}?t=${encodeURIComponent(token)}&a=${encodeURIComponent(
    action,
  )}`;
}

export function setNoStore(res: any) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

export function uniqEmails(list: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e0 of list) {
    const e = normEmail(e0);
    if (!e) continue;
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────
 * Security: hide ACTUAL_PRICE from non-admin API responses
 * ──────────────────────────────────────────────────────────────── */

export function stripActualPriceTokens(input: any) {
  let s = String(input ?? "");
  if (!s) return s;

  // Remove bracket tags like [ACTUAL_PRICE:32000]
  s = s.replace(/\[\s*ACTUAL[_ ]?(PRICE|AMOUNT)\s*:\s*[^\]]*\]/gi, " ").trim();

  // Also remove bare tokens like "ACTUAL_PRICE:32000"
  s = s.replace(/\bACTUAL[_ ]?(PRICE|AMOUNT)\s*:\s*\d{1,12}\b/gi, " ").trim();

  // Cleanup
  s = s.replace(/[ \t]{2,}/g, " ").trim();
  return s;
}

export function removeActualPriceFieldsDeep(obj: any) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const it of obj) removeActualPriceFieldsDeep(it);
    return;
  }

  for (const k of Object.keys(obj)) {
    const lk = String(k).toLowerCase();

    if (
      lk === "actualprice" ||
      lk === "actual_price" ||
      lk === "actualamount" ||
      lk === "actual_amount" ||
      lk === "actualbookingprice" ||
      lk.includes("actualprice") ||
      lk.includes("actual_price") ||
      lk.includes("actualamount") ||
      lk.includes("actual_amount") ||
      lk.includes("actualbookingprice")
    ) {
      delete (obj as any)[k];
      continue;
    }

    const v = (obj as any)[k];
    if (v && typeof v === "object") removeActualPriceFieldsDeep(v);
  }
}

/* ────────────────────────────────────────────────────────────────
 * Security: no price of any kind to customer-side viewers
 *
 * Flows 2/3 are manual booking. Requester, approver, Workspace Leader and
 * every other customer role see no amount anywhere in the request path;
 * only Plumtrips staff (isStaffAdmin) do.
 *
 * A key is money when any camelCase / snake_case segment of it is in
 * PRICE_KEY_TOKENS ("_netPublishedFare" → net|published|fare), or when its
 * lowercased form contains one of PRICE_KEY_SUBSTRINGS (catches compounds
 * written in one word: "bookingamount", "totalfare", "actualbookingprice").
 * Ambiguous words (rate, tax, total, net, cost, fee, ...) are segment-only
 * so "corporate", "taxi", "network" survive.
 *
 * NON_PRICE_KEYS is checked FIRST: every non-money key the request form
 * (ApprovalNew.tsx, all services) writes, plus the count/quantity names a
 * total-ish rule would otherwise catch ("totalTravellers", "totalNights").
 * ──────────────────────────────────────────────────────────────── */

export const PRICE_KEY_TOKENS = new Set([
  "price", "prices", "fare", "fares", "amount", "amounts",
  "cost", "costs", "rate", "rates", "tax", "taxes", "total", "totals",
  "margin", "margins", "markup", "markups", "commission", "commissions", "net",
  "budget", "fee", "fees", "charge", "charges", "discount", "gst", "tds", "inr",
]);

export const PRICE_KEY_SUBSTRINGS = [
  "price", "fare", "amount", "margin", "markup", "commission",
];

/** Never stripped, whatever the rules below say. Lowercased. */
export const NON_PRICE_KEYS = new Set([
  // counts and quantities
  "qty", "quantity", "pax", "paxcount", "totalpax", "adults", "children", "infants",
  "rooms", "roomcount", "totalrooms", "nights", "totalnights", "days", "totaldays",
  "travellers", "travelers", "totaltravellers", "totaltravelers", "numberoftravellers",
  "travellercount", "passengers", "people", "attendees", "guests", "guestcount", "luggage",
  // ApprovalNew.tsx — flight
  "triptype", "origin", "destination", "originmeta", "destinationmeta", "departdate", "returndate",
  "cabinclass", "preferredtime", "preferredairline", "directonly", "flexibledates", "preferredflighttime",
  // hotel
  "city", "checkin", "checkout", "hoteltype", "starrating", "roomtype", "mealplan", "locationpreference",
  // visa
  "destinationcountry", "visatype", "purpose", "traveldate", "processingspeed", "passportvaliditymonths",
  // cab
  "pickup", "drop", "pickupdate", "pickuptime", "vehicletype",
  // forex (the requested quantity itself is exempted per item, see FOREX_META_KEEP)
  "currency", "deliverymode", "requiredby",
  // esim / holiday / mice
  "country", "startdate", "datapack", "budgetband", "hotelclass", "inclusions", "interests",
  "mode", "location", "enddate", "travelmode", "addons", "foodpref", "servicesneeded",
  // every service
  "notes", "priority", "needby", "travelscope",
  // service forms (2026-10-04): multi-city legs, cab hours, forex PAN + holder,
  // holiday/MICE lead contact, picked country / place codes
  "legs", "date", "hours", "pan", "holder", "leadname", "leadphone", "leademail",
  "destinationcountrycode", "countrycode", "citycode", "hotelcode", "hotelname", "cityname", "placetype", "flightnumber",
]);

/** A forex item's requested currency quantity ("USD 2,000") is the request itself, not a price. */
const FOREX_META_KEEP = new Set(["amount", "currency"]);

function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map((s) => s.toLowerCase())
    .filter(Boolean);
}

export function isPriceKey(key: string): boolean {
  const lk = String(key || "").toLowerCase();
  if (!lk || NON_PRICE_KEYS.has(lk)) return false;
  if (keySegments(String(key)).some((s) => PRICE_KEY_TOKENS.has(s))) return true;
  return PRICE_KEY_SUBSTRINGS.some((s) => lk.includes(s));
}

/**
 * Currency figures in free text: "₹5,432", "(₹ 5,432)", "INR 5432.00",
 * "Rs. 500", "5,432 INR", "₹4,200/nt", plus admin tags like
 * "[BOOKING_AMOUNT:26000]" / "[ACTUAL_PRICE:32000]".
 */
const PRICE_TEXT_PATTERNS: RegExp[] = [
  /\[\s*(?:ACTUAL[_ ]?)?(?:BOOKING[_ ]?)?(?:PRICE|AMOUNT|FARE|COST)\s*:[^\]]*\]/gi,
  /\b(?:ACTUAL|BOOKING)[_ ]?(?:PRICE|AMOUNT)\s*:\s*[\d,]+(?:\.\d+)?/gi,
  /\(\s*(?:₹|&#8377;|INR|Rs\.?)\s*[\d,]+(?:\.\d+)?\s*(?:\/\s*(?:nt|night))?\s*\)/gi,
  /(?:₹|&#8377;|\bINR|\bRs\.?)\s*[\d,]+(?:\.\d+)?(?:\s*\/\s*(?:nt|night))?/gi,
  /\b[\d,]+(?:\.\d+)?\s*(?:₹|INR\b)/gi,
];

export function stripPriceText(input: any): string {
  let s = String(input ?? "");
  if (!s) return s;
  for (const rx of PRICE_TEXT_PATTERNS) s = s.replace(rx, " ");
  // Separators the removed figure leaves dangling: "AI 101 — " / "IndiGo ()".
  s = s.replace(/\(\s*\)/g, " ");
  s = s.replace(/[ \t]*[—–\-|:,·][ \t]*$/gm, "");
  s = s.replace(/[ \t]{2,}/g, " ").trim();
  return s;
}

function stripPricesDeep(v: any, keep?: Set<string>): any {
  if (typeof v === "string") return stripPriceText(v);
  if (!v || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => stripPricesDeep(x));
  const isForexItem = String(v.type || "").toLowerCase() === "forex";
  const out: AnyObj = {};
  for (const k of Object.keys(v)) {
    if (!keep?.has(k) && isPriceKey(k)) continue;
    out[k] = stripPricesDeep(v[k], isForexItem && k === "meta" ? FOREX_META_KEEP : undefined);
  }
  return out;
}

/** Traveller passport numbers (meta.travellers[]) → last 4, at any depth. */
function maskPassportsDeep(v: any): any {
  if (!v || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(maskPassportsDeep);
  const out: AnyObj = {};
  for (const k of Object.keys(v)) {
    const val = v[k];
    out[k] =
      (k === "passportNumber" || k === "passportNo") && typeof val === "string" && val
        ? maskTailId(val)
        : maskPassportsDeep(val);
  }
  return out;
}

/** Travel Desk history rows customers never see (they keep "admin_assigned"). */
export const STAFF_ONLY_HISTORY_ACTIONS = new Set(["admin_auto_assigned", "admin_reassigned", "admin_unassigned"]);

/**
 * Staff payloads from the approvals router: everything kept (prices too),
 * passport numbers last 4. Staff get a full number only through the audited
 * POST /admin/requests/:id/passport-reveal.
 */
export function maskPassportsForStaff(doc: any) {
  if (!doc) return doc;
  return maskPassportsDeep(JSON.parse(JSON.stringify(doc)));
}

/**
 * The one sanitiser for customer-side viewers: no prices, passport numbers
 * last 4 only. Used for approval requests (approvals.ts, bookingHistory.ts)
 * and proposals (proposals.ts). Staff see everything.
 */
export function sanitizeApprovalForViewer(doc: any, user: any) {
  // Admins can see everything
  if (isStaffAdmin(user)) return doc;
  if (!doc) return doc;

  // Clone (works for lean objects + mongoose docs), then drop every money key
  // at any depth and every currency figure in any string.
  const safe = maskPassportsDeep(stripPricesDeep(JSON.parse(JSON.stringify(doc))));
  // Staff-only audit of passport reveals (select:false, so normally absent).
  if (safe && typeof safe === "object") delete safe.passportReveals;
  // A forex item's PAN: last 4 for customer-side viewers (like passports).
  if (Array.isArray(safe?.cartItems)) {
    for (const it of safe.cartItems) {
      if (it?.meta && typeof it.meta.pan === "string" && it.meta.pan) it.meta.pan = maskTailId(it.meta.pan);
    }
  }

  // Travel Desk assignment is staff-only: who holds the case, why, and the
  // "no agent available" flag. Customers keep today's one "Assigned" history
  // row (actor + note) and nothing more.
  if (safe?.meta && typeof safe.meta === "object") {
    delete safe.meta.adminAssigned;
    delete safe.meta.assignmentFlag;
  }
  if (Array.isArray(safe?.history)) {
    safe.history = safe.history
      .filter((h: any) => !STAFF_ONLY_HISTORY_ACTIONS.has(String(h?.action || "")))
      .map((h: any) => {
        if (!h || typeof h !== "object") return h;
        // "Assigned" is all a customer learns: no agent, no assigner, no note
        // (older rows may carry a note or a staff name in these fields).
        if (String(h.action || "") === "admin_assigned") return { action: "admin_assigned", at: h.at };
        delete h.staffNote;
        return h;
      });
  }

  // Proposal option PDFs are supplier quotes (they carry prices) — staff only.
  // Booking documents (safe.booking.attachments) stay.
  if (Array.isArray(safe?.options)) {
    safe.options = safe.options.map((o: any) =>
      o && typeof o === "object" ? { ...o, attachments: [] } : o,
    );
  }

  // ✅ Hide protected attachment URLs from non-admin viewers
  if (safe?.meta?.attachments && Array.isArray(safe.meta.attachments)) {
    safe.meta.attachments = safe.meta.attachments.map((a: any) => ({
      filename: a?.filename,
      size: a?.size,
      mime: a?.mime,
      uploadedAt: a?.uploadedAt,
      kind: a?.kind,
      url: undefined,
      path: undefined,
      uploadedBy: undefined,
    }));
  }

  return safe;
}

/* ────────────────────────────────────────────────────────────────
 * Owner / Manager / Leader helpers
 * ──────────────────────────────────────────────────────────────── */

export function isOwnerOfRequest(doc: any, user: any) {
  const sub = String(user?.sub || user?._id || "");
  const email = normEmail(user?.email);
  return (
    String(doc.frontlinerId || "") === sub ||
    exactIRegex(email).test(String(doc.frontlinerEmail || ""))
  );
}

export function isManagerOrLeaderOfRequest(doc: any, user: any) {
  const email = normEmail(user?.email);
  if (exactIRegex(email).test(String(doc.managerEmail || ""))) return true;

  const ccLeaders: string[] = normalizeList(doc?.meta?.ccLeaders || []).map(normEmail);
  return ccLeaders.some((e) => exactIRegex(email).test(e));
}

/* ────────────────────────────────────────────────────────────────
 * Admin auth helper for approvals
 * ──────────────────────────────────────────────────────────────── */

export const DISABLE_EMAILS = parseBool(process.env.DISABLE_EMAILS);

export async function hydrateUserFromDb(user: AnyObj | null | undefined): Promise<AnyObj> {
  const u: AnyObj = user ? { ...user } : {};
  const sub = String(u.sub || u._id || u.id || "").trim();
  if (u.email) u.email = normEmail(u.email);

  const rolesNow = collectRoles(u);
  if (u.email && rolesNow.length) return u;

  try {
    let doc: any = null;

    if (sub && isValidObjectId(sub)) {
      // NOTE: pre-auth hydration utility — no req.workspaceId available in this standalone function
      doc = await User.findById(sub).lean().exec();
    }
    if (!doc && sub) {
      doc = await User.findOne({ sub: sub }).lean().exec();
    }
    if (!doc && u.email) {
      doc = await User.findOne({ email: exactIRegex(String(u.email)) }).lean().exec();
    }

    if (doc) {
      if (!u.email && doc.email) u.email = normEmail(doc.email);
      if (!u.sub && (doc.sub || doc._id)) u.sub = String(doc.sub || doc._id);

      if (!u.roles && Array.isArray(doc.roles)) u.roles = doc.roles;
      if (!u.role && doc.role) u.role = doc.role;
      if (!u.hrmsAccessRole && doc.hrmsAccessRole) u.hrmsAccessRole = doc.hrmsAccessRole;
      if (!u.hrmsAccessLevel && doc.hrmsAccessLevel) u.hrmsAccessLevel = doc.hrmsAccessLevel;
      if (!u.userType && doc.userType) u.userType = doc.userType;
      if (!u.accountType && doc.accountType) u.accountType = doc.accountType;
      if (!u.name && (doc.name || doc.firstName)) u.name = doc.name || doc.firstName;
    }
  } catch {
    // ignore hydration failures
  }

  return u;
}

export async function resolveLeaderCustomerIds(email: string): Promise<string[]> {
  const e = normEmail(email);
  if (!e) return [];
  const rows = await CustomerMember.find({
    email: exactIRegex(e),
    role: "WORKSPACE_LEADER",
    isActive: { $ne: false },
  })
    .lean()
    .exec();

  const ids = rows
    .map((r: any) => String(r.customerId || "").trim())
    .filter(Boolean);

  return Array.from(new Set(ids));
}

/* ────────────────────────────────────────────────────────────────
 * Ops queue access — the /admin/access "Admin Queue" grant (adminQueue)
 *
 * The booking team is whoever holds adminQueue on their UserPermission
 * (Access Console), not whoever carries an ops role. Resolved per request
 * (the token carries roles[] only) through readCapability, which reads the
 * live grant with status "active" — a revoked (deleted) or suspended grant
 * stops working on the next request.
 *
 *   view   adminQueue READ+   — open the queue, see requests and proposals
 *   work   adminQueue WRITE+  — assign, book, proposals, passport reveal,
 *                               and be a Travel Desk agent
 *
 * Only callers signed in to HOUSE are considered: a customer user with any
 * role (including a tenant admin carrying ADMIN) gets neither. SUPERADMIN,
 * and ADMIN signed in to HOUSE, keep both for oversight — they are never
 * Travel Desk agents unless they also hold the grant.
 *
 * Scope (the grant's scope in Access Console):
 *   OWN                     — only cases assigned to the caller
 *                             (meta.adminAssigned.userId)
 *   TEAM / WORKSPACE / ALL  — every case
 * Oversight (SUPERADMIN / HOUSE ADMIN) is always "all". queueCaseScope(req)
 * is the one filter every queue list and every per-case route applies.
 * ──────────────────────────────────────────────────────────────── */

export const PLUMTRIPS_HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";

export type QueueScope = "all" | "own";
export type AdminQueueAccess = {
  view: boolean;
  work: boolean;
  via: "superadmin" | "admin-role" | "permission" | "none";
  scope: QueueScope;
};
const NO_QUEUE_ACCESS: AdminQueueAccess = { view: false, work: false, via: "none", scope: "own" };

/**
 * Resolve once per request and stamp it on `req` (not req.user: a route-level
 * requireAuth replaces req.user with a fresh object, which would drop it).
 */
export async function adminQueueAccess(req: AnyObj): Promise<AdminQueueAccess> {
  const user = req?.user;
  if (!user) return NO_QUEUE_ACCESS;
  if (req.__adminQueue) return req.__adminQueue as AdminQueueAccess;

  let out: AdminQueueAccess = NO_QUEUE_ACCESS;
  if (isSuperAdminReq(req as any)) {
    out = { view: true, work: true, via: "superadmin", scope: "all" };
  } else if (String(req.workspaceId || req.workspaceObjectId || "") === PLUMTRIPS_HOUSE_WORKSPACE_ID) {
    const roles = (Array.isArray(user.roles) ? user.roles : []).map((r: any) => String(r).trim().toUpperCase());
    if (roles.includes("ADMIN")) {
      out = { view: true, work: true, via: "admin-role", scope: "all" };
    } else {
      const grant = await readCapability(req, "adminQueue");
      if (hasAccess(grant.access, "READ")) {
        out = {
          view: true,
          work: hasAccess(grant.access, "WRITE"),
          via: "permission",
          scope: grant.scope === "OWN" ? "own" : "all",
        };
      }
    }
  }
  Object.defineProperty(req, "__adminQueue", { value: out, enumerable: false, configurable: true });
  return out;
}

/** Router-level: resolve queue access for every request on the router. */
export async function stampAdminQueueAccess(req: AnyObj, _res: any, next: any) {
  try {
    await adminQueueAccess(req);
    next();
  } catch (err) {
    next(err);
  }
}

/** Sync readers of the stamp on req (false when nothing resolved — the safe side). */
export function hasQueueView(req: any): boolean {
  return req?.__adminQueue?.view === true;
}
export function hasQueueWork(req: any): boolean {
  return req?.__adminQueue?.work === true;
}

/** The caller's user id as Travel Desk stores it (meta.adminAssigned.userId). */
function queueCallerId(req: any): string {
  return String(req?.user?.sub || req?.user?._id || req?.user?.id || "");
}

/**
 * THE queue scope filter — every queue list and every per-case staff route
 * (approvals + proposals) goes through this. `{}` = every case; an OWN grant =
 * only cases assigned to the caller. Callers without queue view get a filter
 * that matches nothing (they are never meant to reach a queue path).
 */
export function queueCaseScope(req: any): AnyObj {
  const a: AdminQueueAccess | undefined = req?.__adminQueue;
  if (!a?.view) return { _id: null };
  if (a.scope === "all") return {};
  const me = queueCallerId(req);
  return me ? { "meta.adminAssigned.userId": me } : { _id: null };
}

/** Same rule as queueCaseScope, for a request document already in hand. */
export function caseInQueueScope(req: any, doc: any): boolean {
  const a: AdminQueueAccess | undefined = req?.__adminQueue;
  if (!a?.view) return false;
  if (a.scope === "all") return true;
  const me = queueCallerId(req);
  return !!me && String(doc?.meta?.adminAssigned?.userId || "") === me;
}

/** Is request `requestId` inside the caller's queue scope? (one indexed read when OWN) */
export async function requestInQueueScope(req: any, requestId: any): Promise<boolean> {
  const a: AdminQueueAccess | undefined = req?.__adminQueue;
  if (!a?.view) return false;
  if (a.scope === "all") return true;
  if (!isValidObjectId(requestId)) return false;
  return !!(await ApprovalRequest.exists({ _id: String(requestId), ...queueCaseScope(req) }));
}

export async function requireApprovalsAdminRead(req: AnyObj, res: any, next: any) {
  try {
    return requireAuth(req as any, res as any, async () => {
      let user = (req as AnyObj).user;
      user = await hydrateUserFromDb(user);
      (req as AnyObj).user = user;

      if ((await adminQueueAccess(req)).view) return next();

      const leaderCustomerIds = await resolveLeaderCustomerIds(user?.email);
      if (!leaderCustomerIds.length) {
        return res.status(403).json({
          error: "Your account doesn’t have permission to view this page.",
          reason: "NOT_ADMIN_OR_WORKSPACE_LEADER",
          debug:
            process.env.NODE_ENV !== "production"
              ? { email: user?.email, roles: collectRoles(user), sub: user?.sub }
              : undefined,
        });
      }

      (req as AnyObj).__leaderCustomerIds = leaderCustomerIds;
      return next();
    });
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.error("[approvals] requireApprovalsAdminRead error", err);
    }
    return res.status(401).json({ error: "Unauthorized" });
  }
}

export async function requireApprovalsAdminWrite(req: AnyObj, res: any, next: any) {
  try {
    return requireAuth(req as any, res as any, async () => {
      let user = (req as AnyObj).user;
      user = await hydrateUserFromDb(user);
      (req as AnyObj).user = user;

      if (!(await adminQueueAccess(req)).work) {
        return res.status(403).json({
          error: "Admin Queue access required",
          reason: "NO_ADMIN_QUEUE_ACCESS",
          debug:
            process.env.NODE_ENV !== "production"
              ? { email: user?.email, roles: collectRoles(user), sub: user?.sub }
              : undefined,
        });
      }
      return next();
    });
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.error("[approvals] requireApprovalsAdminWrite error", err);
    }
    return res.status(401).json({ error: "Unauthorized" });
  }
}

/* ────────────────────────────────────────────────────────────────
 * Who may raise a travel request (POST /requests and /search/*)
 *
 * WORKSPACE_LEADER always passes. Anyone else is refused when their
 * User row in this workspace has sbtEnabled (they book directly) or
 * canRaiseRequest === false. No row found → allowed, as before.
 * ──────────────────────────────────────────────────────────────── */

export type RaiseRequestRefusal = { status: 403; body: { error: string; code: string } };

export async function checkCanRaiseRequest(req: AnyObj): Promise<RaiseRequestRefusal | null> {
  const sub = String(req.user?.sub || req.user?._id || "");
  const isWL = (req.user?.roles || [])
    .map((r: string) => String(r).toUpperCase().replace(/[\s_-]/g, ""))
    .includes("WORKSPACELEADER");

  if (!sub || isWL) return null;

  const sbtCheck: any = await User.findOne({ _id: sub, workspaceId: req.workspaceObjectId })
    .select("sbtEnabled canRaiseRequest")
    .lean();
  if (sbtCheck?.sbtEnabled === true) {
    return {
      status: 403,
      body: {
        error: "Direct booking is enabled for your account. Please use the Self Booking Tool.",
        code: "SBT_USER_CANNOT_RAISE_REQUEST",
      },
    };
  }
  if (sbtCheck?.canRaiseRequest === false) {
    return {
      status: 403,
      body: {
        error: "You don't have permission to raise travel requests.",
        code: "RAISE_REQUEST_DISABLED",
      },
    };
  }
  return null;
}

export async function requireCanRaiseRequest(req: AnyObj, res: any, next: any) {
  try {
    const refusal = await checkCanRaiseRequest(req);
    if (refusal) return res.status(refusal.status).json(refusal.body);
    next();
  } catch (err) {
    next(err);
  }
}

/* ────────────────────────────────────────────────────────────────
 * Leader scope helper for admin read endpoints
 * ──────────────────────────────────────────────────────────────── */

export function applyLeaderScopeIfNeeded(req: AnyObj, baseFilter: AnyObj) {
  // Ops queue access (Admin Queue grant / oversight) sees every customer —
  // narrowed to the caller's own cases on an OWN grant; anyone else here is
  // a Workspace Leader, scoped to their customers.
  if (hasQueueView(req)) {
    const scope = queueCaseScope(req);
    return Object.keys(scope).length ? { $and: [baseFilter, scope] } : baseFilter;
  }

  const ids: string[] = Array.isArray(req.__leaderCustomerIds) ? req.__leaderCustomerIds : [];
  if (!ids.length) return { $and: [baseFilter, { _id: null }] };

  return { $and: [baseFilter, { customerId: { $in: ids } }] };
}
