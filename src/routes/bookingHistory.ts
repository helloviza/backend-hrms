// apps/backend/src/routes/bookingHistory.ts
import { Router } from "express";
import type { Request, Response } from "express";
import path from "path";
import fs from "fs";
import ApprovalRequest from "../models/ApprovalRequest.js";
import CustomerMember from "../models/CustomerMember.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

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

function isStaffViewer(user: any): boolean {
  return (
    isAdmin(user) ||
    hasRole(user, "hr") ||
    hasRole(user, "l0") ||
    hasRole(user, "l1") ||
    hasRole(user, "l2")
  );
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

function canViewBookingHistory(user: any): boolean {
  return isStaffViewer(user) || isCustomerViewer(user) || isRequesterViewer(user);
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

/* ────────────────────────────────────────────────────────────────
 * Routes
 * ──────────────────────────────────────────────────────────────── */

/**
 * GET /api/booking-history/admin/history?states=done,cancelled   (Admin only)
 */
router.get("/admin/history", requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!isAdmin(user)) return res.status(403).json({ ok: false, error: "Forbidden" });

  const states = String(req.query.states || "done,cancelled")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);

  const rows = await ApprovalRequest.find({ adminState: { $in: states } } as any)
    .sort({ updatedAt: -1 })
    .lean();

  const travelerMap = await buildTravelerIdMap(rows);

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
 * - Staff (L0/L1/L2/HR/Admin) => can see all
 * - Workspace Leader (Customer/Business) => org-wide view (resolved via email)
 * - Requester => email-scoped view
 */
router.get("/history", requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;

  if (!canViewBookingHistory(user)) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }

  const states = String(req.query.states || "done,cancelled")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);

  const base: any = { adminState: { $in: states } };

  // Staff sees all
  if (isStaffViewer(user)) {
    const rows = await ApprovalRequest.find(base as any).sort({ updatedAt: -1 }).lean();
    const travelerMap = await buildTravelerIdMap(rows);
    return res.json({
      ok: true,
      rows: rows.map((r: any) => {
        const hist = Array.isArray(r?.history) ? r.history : [];
        const latest = hist.length ? hist[hist.length - 1] : null;
        const parsed = parseAdminComment(latest?.comment || "");

        const pdfCandidate = pickPdfCandidate(r);
        const attachmentDownloadUrl = pdfCandidate ? makeAttachmentDownloadUrl(pdfCandidate) : "";
        const requesterEmail = String(r.requesterEmail || r.frontlinerEmail || "").toLowerCase();

        return {
          ...r,
          requesterTravelerId: travelerMap.get(requesterEmail) || "",
          _latestParsed: {
            mode: parsed.mode,
            service: parsed.service,
            reason: parsed.reason,
            note: parsed.note,
            bookingAmount: parsed.bookingAmount,
            attachmentDownloadUrl,
            raw: parsed.raw,
          },
        };
      }),
    });
  }

  // Customer/Workspace Leader => resolve org ids and show org-wide history
  if (isCustomerViewer(user)) {
    const email = userEmail(user);
    const tokenCid = getCustomerIdFromToken(user);

    // ✅ key fix: resolve real workspace ids using their email
    const resolvedOrgIds = await resolveWorkspaceIdsForUser(user);

    // also include token customerId if present
    if (tokenCid) resolvedOrgIds.push(tokenCid);

    const ors: any[] = [];

    for (const id of resolvedOrgIds) ors.push(...buildOrgScopeOrs(id));
    // also allow their own email scope (optional)
    ors.push(...buildEmailScopeOrs(email));

    const query = ors.length ? ({ ...base, $or: ors } as any) : (base as any);

    const rows = await ApprovalRequest.find(query).sort({ updatedAt: -1 }).lean();
    const travelerMap = await buildTravelerIdMap(rows);

    const out = rows.map((r: any) => {
      const hist = Array.isArray(r?.history) ? r.history : [];

      // sanitize for non-admin
      const safeHist = isAdmin(user)
        ? hist
        : hist.map((h: any) => ({
            ...h,
            comment: stripActualPriceToken(h?.comment || ""),
          }));

      const latest = safeHist.length ? safeHist[safeHist.length - 1] : null;
      const parsed = parseAdminComment(latest?.comment || "");

      const pdfCandidate = pickPdfCandidate({ ...r, history: safeHist });
      const attachmentDownloadUrl = pdfCandidate ? makeAttachmentDownloadUrl(pdfCandidate) : "";
      const requesterEmail = String(r.requesterEmail || r.frontlinerEmail || "").toLowerCase();

      return {
        ...r,
        history: safeHist,
        requesterTravelerId: travelerMap.get(requesterEmail) || "",
        _latestParsed: {
          mode: parsed.mode,
          service: parsed.service,
          reason: parsed.reason,
          note: parsed.note,
          bookingAmount: parsed.bookingAmount,
          attachmentDownloadUrl,
          raw: parsed.raw,
        },
      };
    });

    // Optional debug (helps you verify what ids were used)
    const debug = req.query.debug ? { email, tokenCid, resolvedOrgIds: [...new Set(resolvedOrgIds)] } : undefined;

    return res.json({ ok: true, rows: out, ...(debug ? { debug } : {}) });
  }

  // Requester-only => email scoped
  const email = userEmail(user);
  const emailOrs = buildEmailScopeOrs(email);
  const query = emailOrs.length ? ({ ...base, $or: emailOrs } as any) : (base as any);

  const rows = await ApprovalRequest.find(query).sort({ updatedAt: -1 }).lean();
  const travelerMap = await buildTravelerIdMap(rows);

  const out = rows.map((r: any) => {
    const hist = Array.isArray(r?.history) ? r.history : [];

    const safeHist = isAdmin(user)
      ? hist
      : hist.map((h: any) => ({
          ...h,
          comment: stripActualPriceToken(h?.comment || ""),
        }));

    const latest = safeHist.length ? safeHist[safeHist.length - 1] : null;
    const parsed = parseAdminComment(latest?.comment || "");

    const pdfCandidate = pickPdfCandidate({ ...r, history: safeHist });
    const attachmentDownloadUrl = pdfCandidate ? makeAttachmentDownloadUrl(pdfCandidate) : "";
    const requesterEmail = String(r.requesterEmail || r.frontlinerEmail || "").toLowerCase();

    return {
      ...r,
      history: safeHist,
      requesterTravelerId: travelerMap.get(requesterEmail) || "",
      _latestParsed: {
        mode: parsed.mode,
        service: parsed.service,
        reason: parsed.reason,
        note: parsed.note,
        bookingAmount: parsed.bookingAmount,
        attachmentDownloadUrl,
        raw: parsed.raw,
      },
    };
  });

  return res.json({ ok: true, rows: out });
});

/**
 * Protected download:
 * GET /api/booking-history/attachments/:file/download
 *
 * ✅ Also searches multiple safe dirs so “PDF must be available at all stages”.
 */
router.get("/attachments/:file/download", requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!canViewBookingHistory(user)) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }

  const file = String(req.params.file || "");
  const safeFile = path.basename(file);
  if (!safeFile) return res.status(400).send("Bad file");

  const candidates = [
    path.join(process.cwd(), "uploads", "approvals", safeFile),
    path.join(process.cwd(), "uploads", "booking-history", safeFile),
    path.join(process.cwd(), "uploads", safeFile),
  ];

  const fullPath = candidates.find((p) => fs.existsSync(p));
  if (!fullPath) return res.status(404).send("Not found");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${safeFile}"`);
  fs.createReadStream(fullPath).pipe(res);
});

export default router;
