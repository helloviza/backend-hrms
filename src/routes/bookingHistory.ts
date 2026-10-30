// apps/backend/src/routes/bookingHistory.ts
import { Router } from "express";
import type { Request, Response } from "express";
import path from "path";
import fs from "fs";
import ApprovalRequest from "../models/ApprovalRequest.js";
import CustomerMember from "../models/CustomerMember.js";
import { requireAuth } from "../middleware/auth.js";
import { resolveWorkspaceForUser } from "../middleware/requireWorkspace.js";
import { sanitizeApprovalForViewer, adminQueueAccess, queueCaseScope, hasQueueView, resolveLeaderCustomerIds } from "./approvals.security.js";
import { actorNamesOnResponse, userNames, nameOrUnknown, collectActorRows, resolveActors, maskStaffActors } from "../services/actorNames.js";
import { publicDocuments, requestDocumentsVisibleTo } from "../services/bookingDocuments.js";
import { dateRangeOr400, withDateRange } from "../utils/dateRange.js";

const router = Router();
// Activity rows name people, never ids; customers see staff as "Plumtrips
// Travel Desk". The staff answer is the one isQueueViewer stamped on req.
router.use(actorNamesOnResponse((req) => hasQueueView(req)));

/* ────────────────────────────────────────────────────────────────
 * helpers
 * ──────────────────────────────────────────────────────────────── */

function norm(v: unknown): string {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-_]/g, "");
}

function userEmail(user: any): string {
  return String(user?.email || "").trim().toLowerCase();
}

function collectRoles(user: any): string[] {
  const out: string[] = [];
  if (Array.isArray(user?.roles)) out.push(...user.roles);
  if (user?.role) out.push(user.role);
  if (user?.hrmsAccessRole) out.push(user.hrmsAccessRole);
  if (user?.hrmsAccessLevel) out.push(user.hrmsAccessLevel);
  if (user?.userType) out.push(user.userType);
  if (user?.accountType) out.push(user.accountType);
  if (user?.approvalRole) out.push(user.approvalRole);
  return out.map(norm).filter(Boolean);
}

function hasRole(user: any, role: string): boolean {
  return collectRoles(user).includes(norm(role));
}

function isAdmin(user: any): boolean {
  return (
    hasRole(user, "admin") ||
    hasRole(user, "superadmin") ||
    hasRole(user, "super_admin") ||
    hasRole(user, "hr_admin")
  );
}

/**
 * The staff (all-tenant) view: the Admin Queue rule, not roles —
 * adminQueueAccess (grant READ+, or SUPERADMIN / HOUSE ADMIN), held to the
 * grant's scope by queueCaseScope (OWN = only requests assigned to them).
 * This router only runs requireAuth, so the caller's workspace (which
 * adminQueueAccess needs to recognise HOUSE) is resolved here, softly: no
 * workspace simply means no staff view, never a 403.
 */
async function isQueueViewer(req: any): Promise<boolean> {
  // Fails closed: any error here means no staff view (and never an unhandled
  // rejection — these handlers have no try/catch, so a throw would hang).
  try {
    if (!req.workspaceId) {
      const ws: any = await resolveWorkspaceForUser(req.user, "_id status");
      if (ws?._id && ws.status === "ACTIVE") {
        req.workspaceId = String(ws._id);
        req.workspaceObjectId = ws._id;
      }
    }
    return (await adminQueueAccess(req)).view;
  } catch {
    return false;
  }
}

function isCustomerViewer(user: any): boolean {
  // Workspace Leader / Customer / Business / Requester under business account
  return (
    hasRole(user, "customer") ||
    hasRole(user, "business") ||
    Boolean(user?.customerId || user?.businessId)
  );
}

function isRequesterViewer(user: any): boolean {
  return hasRole(user, "requester") || hasRole(user, "employee") || hasRole(user, "staff");
}

function canViewBookingHistory(user: any, queueViewer: boolean): boolean {
  return queueViewer || isCustomerViewer(user) || isRequesterViewer(user);
}

function getCustomerIdFromToken(user: any): string {
  const cid = user?.customerId || user?.businessId || user?.customer_id || user?.business_id;
  return cid ? String(cid).trim() : "";
}

/* ────────────────────────────────────────────────────────────────
 * PDF parsing / picking
 * ──────────────────────────────────────────────────────────────── */

function stripActualPriceToken(comment: string): string {
  return String(comment || "")
    .replace(/\s*\[ACTUAL_PRICE:[^\]]+\]\s*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractPdfFromText(text: unknown): string {
  const t = String(text ?? "");

  const m0 = t.match(/Attachment:\s*([^\s]+\.pdf)/i);
  if (m0?.[1]) return String(m0[1]).trim();

  const m1 = t.match(/(https?:\/\/[^\s]+?\.pdf)\b/i);
  if (m1?.[1]) return String(m1[1]).trim();

  const m2 = t.match(/(\/?uploads\/approvals\/[^\s]+?\.pdf)\b/i);
  if (m2?.[1]) return String(m2[1]).trim();

  const m3 = t.match(/(\/?uploads\/[^\s]+?\.pdf)\b/i);
  if (m3?.[1]) return String(m3[1]).trim();

  return "";
}

function extractFilenameFromAny(input: unknown): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  const s = raw.split("#")[0].split("?")[0];
  try {
    const u = new URL(s, "http://local");
    return path.basename(u.pathname || "");
  } catch {
    return path.basename(s);
  }
}

function parseAdminComment(raw: unknown) {
  const text = String(raw || "");

  const mode = (text.match(/\[MODE:([^\]]+)\]/i)?.[1] || "").trim();
  const service = (text.match(/\[SERVICE:([^\]]+)\]/i)?.[1] || "").trim();
  const reason = (text.match(/\[REASON:([^\]]+)\]/i)?.[1] || "").trim();

  const bookingAmount = Number(text.match(/\[BOOKING_AMOUNT:([^\]]+)\]/i)?.[1] || NaN);
  const actualPrice = Number(text.match(/\[ACTUAL_PRICE:([^\]]+)\]/i)?.[1] || NaN);

  let rest = text.replace(/^\s*(?:\[[^\]]+\]\s*)+/g, "").trim();

  const attachmentUrl = extractPdfFromText(text) || extractPdfFromText(rest);
  if (attachmentUrl) rest = rest.replace(/Attachment:\s*[^\s]+\.pdf/gi, "").trim();

  return {
    mode: mode || undefined,
    service: service || undefined,
    reason: reason || undefined,
    bookingAmount: Number.isFinite(bookingAmount) ? bookingAmount : undefined,
    actualPrice: Number.isFinite(actualPrice) ? actualPrice : undefined,
    note: rest || undefined,
    attachmentUrl: attachmentUrl || undefined,
    raw: text,
  };
}

function pickPdfCandidate(r: any): string {
  if (!r) return "";

  // meta.attachments array
  const atts = r?.meta?.attachments;
  if (Array.isArray(atts) && atts.length) {
    for (const a of [...atts].reverse()) {
      const url = typeof a === "string" ? a : a?.url || a?.path || a?.filename || "";
      const f = extractFilenameFromAny(url);
      if (f && /\.pdf$/i.test(f)) return String(url || "");
    }
  }

  // common fields
  const common = [
    r?.adminPdfUrl,
    r?.adminPdfPath,
    r?.pdfUrl,
    r?.pdfPath,
    r?.attachmentUrl,
    r?.attachmentPath,
    r?.meta?.adminPdfUrl,
    r?.meta?.adminPdfPath,
  ];

  for (const c of common) {
    const f = extractFilenameFromAny(c);
    if (f && /\.pdf$/i.test(f)) return String(c || "");
  }

  // scan history comments
  const hist = Array.isArray(r?.history) ? r.history : [];
  for (const h of [...hist].reverse()) {
    const parsed = parseAdminComment(h?.comment || "");
    if (parsed.attachmentUrl) return parsed.attachmentUrl;
    const maybe = extractPdfFromText(h?.comment || "");
    if (maybe) return maybe;
  }

  return "";
}

function makeAttachmentDownloadUrl(candidate: string): string {
  const file = extractFilenameFromAny(candidate);
  if (!file) return "";
  return `/api/booking-history/attachments/${encodeURIComponent(file)}/download`;
}

/* ────────────────────────────────────────────────────────────────
 * Org resolution (KEY FIX for Workspace Leader)
 * ──────────────────────────────────────────────────────────────── */

function addId(set: Set<string>, v: unknown) {
  const s = String(v ?? "").trim();
  if (!s) return;
  set.add(s);
}

async function resolveWorkspaceIdsForUser(user: any): Promise<string[]> {
  const ids = new Set<string>();

  // 1) token ids
  addId(ids, user?.customerId);
  addId(ids, user?.businessId);
  addId(ids, user?.customer_id);
  addId(ids, user?.business_id);

  const email = userEmail(user);
  if (!email) return [...ids];

  // 2) Try resolving via CustomerWorkspace (if model exists)
  try {
    const mod = await import("../models/CustomerWorkspace.js");
    const CustomerWorkspace: any = (mod as any).default || mod;

    if (CustomerWorkspace?.findOne) {
      const ws = await CustomerWorkspace.findOne({
        $or: [
          { ownerEmail: email },
          { email: email },
          { contactEmail: email },
          { adminEmail: email },
          { "members.email": email },
          { "users.email": email },
          { "admins.email": email },
          { "defaultApproverEmails": email },
        ],
      }).lean();

      if (ws) {
        addId(ids, ws?._id);
        addId(ids, ws?.id);
        addId(ids, ws?.customerId);
        addId(ids, ws?.businessId);
        addId(ids, ws?.masterDataId);
        addId(ids, ws?.businessMasterDataId);
      }
    }
  } catch {
    // ignore if model not present
  }

  // 3) Try resolving via MasterData (if model exists)
  try {
    const mod = await import("../models/MasterData.js");
    const MasterData: any = (mod as any).default || mod;

    if (MasterData?.findOne) {
      const md = await MasterData.findOne({
        $or: [
          { email: email },
          { ownerEmail: email },
          { contactEmail: email },
          { adminEmail: email },
          { "admins.email": email },
          { "users.email": email },
          { "members.email": email },
        ],
      }).lean();

      if (md) {
        addId(ids, md?._id);
        addId(ids, md?.id);
        addId(ids, md?.businessId);
        addId(ids, md?.customerId);
      }
    }
  } catch {
    // ignore if model not present
  }

  return [...ids];
}

function buildOrgScopeOrs(orgId: string) {
  const cid = String(orgId || "").trim();
  if (!cid) return [];

  return [
    { customerId: cid },
    { businessId: cid },
    { workspaceCustomerId: cid },
    { customerWorkspaceId: cid },
    { workspaceId: cid },
    { workspace_id: cid },
    { customer_workspace_id: cid },

    { "customerWorkspace._id": cid },
    { "workspace._id": cid },
    { "meta.customerId": cid },
    { "meta.businessId": cid },
    { "meta.workspaceCustomerId": cid },
    { "meta.customerWorkspaceId": cid },
    { "meta.workspaceId": cid },
    { "meta.workspace._id": cid },
    { "meta.customerWorkspace._id": cid },
  ];
}

function buildEmailScopeOrs(email: string) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return [];
  return [
    { requesterEmail: e },
    { frontlinerRaiserEmail: e },
    { frontlinerEmail: e },
    { createdByEmail: e },
    { customerEmail: e },
    { "requester.email": e },
    { "customer.email": e },
  ];
}

async function buildTravelerIdMap(rows: any[]): Promise<Map<string, string>> {
  const emails = [...new Set(
    rows
      .map((r) => String(r.requesterEmail || r.frontlinerEmail || "").toLowerCase())
      .filter(Boolean),
  )];
  if (!emails.length) return new Map();
  const members = await CustomerMember.find({ email: { $in: emails } })
    .select("email travelerId")
    .lean()
    .exec();
  return new Map<string, string>(
    (members as any[]).map((m) => [String(m.email).toLowerCase(), m.travelerId || ""]),
  );
}

/**
 * Requester and approver as profile names (services/actorNames.ts) — the list
 * and drawer show names, never an id or a bare email. One lookup per page.
 */
async function peopleNames(rows: any[]): Promise<Map<string, string>> {
  return userNames(
    rows.flatMap((r: any) => [r.frontlinerId, r.frontlinerEmail, r.requesterEmail, r.approvedByEmail, r.managerEmail]),
  );
}
function peopleOf(r: any, names: Map<string, string>) {
  const get = (k: any) => names.get(String(k || "").trim().toLowerCase()) || names.get(String(k || "").trim());
  const approverEmail = r.approvedByEmail || r.managerEmail;
  return {
    requesterName: nameOrUnknown(get(r.frontlinerId), get(r.frontlinerEmail || r.requesterEmail), r.frontlinerName),
    approverName: approverEmail || r.approvedByName || r.managerName
      ? nameOrUnknown(get(approverEmail), r.approvedByName, r.managerName)
      : "",
  };
}

/* ────────────────────────────────────────────────────────────────
 * Routes
 * ──────────────────────────────────────────────────────────────── */

/**
 * GET /api/booking-history/admin/history?states=done,cancelled   (Admin Queue only, scoped)
 */
router.get("/admin/history", requireAuth, async (req: Request, res: Response) => {
  if (!(await isQueueViewer(req))) return res.status(403).json({ ok: false, error: "Forbidden" });

  const states = String(req.query.states || "done,cancelled")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);

  // ?from&to&by — narrows only (utils/dateRange.ts).
  const range = dateRangeOr400(req, res);
  if (range === false) return;

  const rows = await ApprovalRequest.find(withDateRange({ adminState: { $in: states }, ...queueCaseScope(req) }, range) as any)
    .sort({ updatedAt: -1 })
    .lean();

  const travelerMap = await buildTravelerIdMap(rows);
    const people = await peopleNames(rows);

  const out = rows.map((r: any) => {
    const hist = Array.isArray(r?.history) ? r.history : [];
    const latest = hist.length ? hist[hist.length - 1] : null;
    const parsed = parseAdminComment(latest?.comment || "");

    const pdfCandidate = pickPdfCandidate(r);
    const attachmentDownloadUrl = pdfCandidate ? makeAttachmentDownloadUrl(pdfCandidate) : "";
    const requesterEmail = String(r.requesterEmail || r.frontlinerEmail || "").toLowerCase();

    return {
      ...r,
      requesterTravelerId: travelerMap.get(requesterEmail) || "",
          ...peopleOf(r, people),
      _latestParsed: {
        mode: parsed.mode,
        service: parsed.service,
        reason: parsed.reason,
        note: parsed.note,
        bookingAmount: parsed.bookingAmount,
        actualBookingPrice: parsed.actualPrice, // admin only
        attachmentDownloadUrl,
        raw: parsed.raw,
      },
    };
  });

  return res.json({ ok: true, rows: out });
});

/**
 * GET /api/booking-history/history?states=done,cancelled
 * - Staff (Admin Queue grant / oversight) => every tenant, within their queue scope
 * - Workspace Leader (Customer/Business) => org-wide view (resolved via email)
 * - Requester => email-scoped view
 */
router.get("/history", requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  const queueViewer = await isQueueViewer(req);

  if (!canViewBookingHistory(user, queueViewer)) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }

  const states = String(req.query.states || "done,cancelled")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);

  // ?from&to&by — narrows every branch below (utils/dateRange.ts).
  const range = dateRangeOr400(req, res);
  if (range === false) return;
  const base: any = withDateRange({ adminState: { $in: states } }, range);

  // Staff (Admin Queue): every tenant, held to their queue scope
  if (queueViewer) {
    const rows = await ApprovalRequest.find({ ...base, ...queueCaseScope(req) } as any).sort({ updatedAt: -1 }).lean();
    const travelerMap = await buildTravelerIdMap(rows);
    const people = await peopleNames(rows);
    return res.json({
      ok: true,
      rows: rows.map((r: any) => {
        const hist = Array.isArray(r?.history) ? r.history : [];
        const latest = hist.length ? hist[hist.length - 1] : null;
        const parsed = parseAdminComment(latest?.comment || "");

        const pdfCandidate = pickPdfCandidate(r);
        const attachmentDownloadUrl = pdfCandidate ? makeAttachmentDownloadUrl(pdfCandidate) : "";
        const requesterEmail = String(r.requesterEmail || r.frontlinerEmail || "").toLowerCase();

        return sanitizeApprovalForViewer({
          ...r,
          requesterTravelerId: travelerMap.get(requesterEmail) || "",
          ...peopleOf(r, people),
          _latestParsed: {
            mode: parsed.mode,
            service: parsed.service,
            reason: parsed.reason,
            note: parsed.note,
            bookingAmount: parsed.bookingAmount,
            attachmentDownloadUrl,
            raw: parsed.raw,
          },
        }, user);
      }),
    });
  }

  // Customer side: a Workspace Leader sees their company's bookings, everyone
  // else their own. Rows are the customer-safe shape (customerHistoryRow).
  const email = userEmail(user);
  const sub = String(user?.sub || user?._id || user?.id || "");
  const leaderOf = await resolveLeaderCustomerIds(email);
  const leader = leaderOf.length > 0 || isWorkspaceLeaderRole(user);
  let scope: any;
  if (leader) {
    const ors: any[] = [];
    if (leaderOf.length) ors.push({ customerId: { $in: leaderOf } });
    if ((req as any).workspaceObjectId) ors.push({ workspaceId: (req as any).workspaceObjectId });
    scope = ors.length ? { $or: ors } : ownScope(sub, email);
  } else {
    scope = ownScope(sub, email);
  }

  const rows = await ApprovalRequest.find({ ...base, ...scope } as any).sort({ updatedAt: -1 }).lean();
  const people = await peopleNames(rows);
  const out = rows.map((r: any) => customerHistoryRow(r, user, people));
  // Names resolved and staff masked here, then every email that is not the
  // viewer's own removed — the response hook then has nothing left to change.
  const actorRows = collectActorRows(out);
  try {
    await resolveActors(actorRows.map((x) => x.row));
  } catch (err: any) {
    console.error("[booking-history] could not resolve actors", err?.message || err);
  }
  maskStaffActors(actorRows);
  for (const r of out) stripOtherEmails(r, email);

  return res.json({ ok: true, rows: out });
});

function isWorkspaceLeaderRole(user: any): boolean {
  return (Array.isArray(user?.roles) ? user.roles : [])
    .map((r: any) => String(r).toUpperCase().replace(/[\s_-]/g, ""))
    .includes("WORKSPACELEADER");
}

/** The caller's own requests (by user id, or the email they raised it with). */
function ownScope(sub: string, email: string) {
  const ors: any[] = [];
  if (sub) ors.push({ frontlinerId: sub });
  if (email) ors.push({ frontlinerEmail: email });
  return ors.length ? { $or: ors } : { _id: null };
}

/** When the request was booked / closed: the first done or cancel row, else the last update. */
function closedAt(r: any): any {
  const hist: any[] = Array.isArray(r?.history) ? r.history : [];
  const row = hist.find((h) => ["admin_done", "admin_closed", "admin_cancelled"].includes(String(h?.action || "")));
  return row?.at || r?.updatedAt || r?.createdAt;
}

/**
 * One booking for a customer-side viewer: what the card and the drawer need —
 * no prices, no internal notes, no ids of people, no URLs (documents as
 * { id, name, type, size }; download through the guarded approvals route).
 */
function customerHistoryRow(r: any, user: any, people: Map<string, string>) {
  const safe: any = sanitizeApprovalForViewer({ ...r, ...peopleOf(r, people) }, user);
  return {
    _id: safe._id,
    ticketId: safe.ticketId,
    status: safe.status,
    stage: safe.stage,
    adminState: safe.adminState,
    customerName: safe.customerName,
    requesterName: safe.requesterName,
    approverName: safe.approverName,
    frontlinerName: safe.requesterName,
    frontlinerEmail: safe.frontlinerEmail,
    cartItems: safe.cartItems,
    comments: safe.comments,
    createdAt: safe.createdAt,
    updatedAt: safe.updatedAt,
    bookedAt: closedAt(r),
    history: safe.history,
    meta: { travelFlow: safe.meta?.travelFlow, revoked: safe.meta?.revoked || undefined },
    _documents: safe._documents || publicDocuments(r),
  };
}

const EMAIL_KEYS = ["userEmail", "byEmail", "actorEmail", "doneByEmail", "requesterEmail", "frontlinerEmail", "assigneeEmail"];
/** Remove every email that is not the viewer's own (the row, its history). */
function stripOtherEmails(row: any, own: string) {
  const strip = (o: any) => {
    if (!o || typeof o !== "object") return;
    for (const k of EMAIL_KEYS) if (k in o && String(o[k] || "").toLowerCase() !== own) delete o[k];
    if (typeof o.by === "string" && o.by.includes("@") && o.by.toLowerCase() !== own) delete o.by;
  };
  strip(row);
  for (const h of Array.isArray(row.history) ? row.history : []) strip(h);
}

/**
 * Legacy download links (/api/booking-history/attachments/<file>/download):
 * served only to someone who may see that request's booking documents — the
 * same rule as GET /api/approvals/requests/:id/documents/:docId/download.
 * Anything else (another company's file, a file on no request): 404.
 */
router.get("/attachments/:file/download", requireAuth, async (req: Request, res: Response) => {
  try {
    await isQueueViewer(req); // resolves the caller's workspace + queue scope
    const safeFile = path.basename(String(req.params.file || ""));
    if (!safeFile || safeFile !== String(req.params.file || "")) return res.status(404).json({ error: "Not found" });
    const doc: any = await ApprovalRequest.findOne({ "meta.attachments.path": `/uploads/approvals/${safeFile}` }).lean();
    if (!doc || !(await requestDocumentsVisibleTo(req, doc))) return res.status(404).json({ error: "Not found" });
    const fullPath = path.join(process.cwd(), "uploads", "approvals", safeFile);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: "Not found" });
    const att = (doc.meta?.attachments || []).find((a: any) => String(a?.path || "") === `/uploads/approvals/${safeFile}`);
    res.setHeader("Content-Type", "application/pdf");
    return res.download(fullPath, String(att?.filename || safeFile));
  } catch {
    return res.status(404).json({ error: "Not found" });
  }
});

export default router;
