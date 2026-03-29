// apps/backend/src/routes/approvals.security.ts
import { requireAuth } from "../middleware/auth.js";
import User from "../models/User.js";
import { scopedFindById } from "../middleware/scopedFindById.js";
import CustomerMember from "../models/CustomerMember.js";

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
    return (isProd ? "" : "http://localhost:5173").replace(/\/$/, "");
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

export function sanitizeApprovalForViewer(doc: any, user: any) {
  // Admins can see everything
  if (isStaffAdmin(user)) return doc;

  // Make a safe mutable clone (works for lean objects + mongoose docs)
  const safe = JSON.parse(JSON.stringify(doc));

  // Strip ACTUAL_PRICE tokens from any user-visible text fields
  if (safe.comments) safe.comments = stripActualPriceTokens(safe.comments);

  if (Array.isArray(safe.history)) {
    safe.history = safe.history.map((h: any) => {
      if (h?.comment) h.comment = stripActualPriceTokens(h.comment);
      return h;
    });
  }

  // Remove actual price fields wherever they exist
  removeActualPriceFieldsDeep(safe.meta);
  removeActualPriceFieldsDeep(safe.cartItems);

  // ✅ ALSO remove root-level internal pricing
  if ("actualBookingPrice" in safe) delete safe.actualBookingPrice;
  if ("actualPrice" in safe) delete safe.actualPrice;
  if ("actual_amount" in safe) delete safe.actual_amount;
  if ("actualAmount" in safe) delete safe.actualAmount;

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

export async function requireApprovalsAdminRead(req: AnyObj, res: any, next: any) {
  try {
    return requireAuth(req as any, res as any, async () => {
      let user = (req as AnyObj).user;
      user = await hydrateUserFromDb(user);
      (req as AnyObj).user = user;

      if (isStaffAdmin(user)) return next();

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

      if (!isStaffAdmin(user)) {
        return res.status(403).json({
          error: "Admin access required",
          reason: "NOT_STAFF_ADMIN",
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
 * Leader scope helper for admin read endpoints
 * ──────────────────────────────────────────────────────────────── */

export function applyLeaderScopeIfNeeded(req: AnyObj, baseFilter: AnyObj) {
  const user = req.user;
  if (isStaffAdmin(user)) return baseFilter;

  const ids: string[] = Array.isArray(req.__leaderCustomerIds) ? req.__leaderCustomerIds : [];
  if (!ids.length) return { $and: [baseFilter, { _id: null }] };

  return { $and: [baseFilter, { customerId: { $in: ids } }] };
}
