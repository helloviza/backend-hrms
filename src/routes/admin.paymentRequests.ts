// apps/backend/src/routes/admin.paymentRequests.ts
//
// /api/admin/payment-requests — staff create and manage Razorpay Payment Link
// requests on a ManualBooking (before booking) or a SENT Invoice. Service:
// services/paymentRequests.ts. Audit: docs/audits/payment-links-audit.md.
//
// ── WHO ──────────────────────────────────────────────────────────────────
// The money lands in the Plumtrips (B2B) Razorpay account, so only Plumtrips
// staff (HOUSE workspace, not a customer / vendor account) or a Super Admin
// may raise or manage links — for BOTH subjects. requireBillingStaff alone
// would also admit a tenant's own ADMIN on its own invoices, and a tenant
// collecting its customer's invoice into Plumtrips' account is wrong money.
//
//   BOOKING  manualBookings READ (reads) / WRITE (changes) + canAccessBooking
//   INVOICE  invoices READ / WRITE + requireBillingStaff + invoiceInCallerScope
//
// A subject out of the caller's scope answers 404, exactly like a missing one.
// Every by-id read also carries the tenant clause on {customerId,
// invoiceWorkspaceId}.
//
// ── WHAT IT NEVER DOES ──────────────────────────────────────────────────
// Change a booking's status, an invoice's status, or loyalty. Status only.
import { Router, type Request, type Response } from "express";
import mongoose from "mongoose";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireBillingStaff, isExternalAccount } from "../middleware/requireBillingStaff.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import { userOrIpKey } from "../middleware/rateLimit.js";
import { canAccessBooking, isHouseCallerContext, type BookingAccessContext } from "../utils/bookingAccess.js";
import { invoiceInCallerScope } from "./invoices.js";
import ManualBooking from "../models/ManualBooking.js";
import Invoice from "../models/Invoice.js";
import PaymentRequest from "../models/PaymentRequest.js";
import {
  resolveSubject,
  createPaymentRequest,
  retryFailedLinks,
  cancelLink,
  replaceLink,
  refreshFromRazorpay,
  paymentSummaryForBookings,
  paymentSummaryByBooking,
  serializeRequest,
  PaymentRequestError,
  type Actor,
} from "../services/paymentRequests.js";
import { sendPaymentLinkEmail } from "../services/paymentLinkEmails/send.js";
import { paymentLogger } from "../utils/logger.js";

const router = Router();
router.use(requireAuth);

const limiterMessage = { success: false, message: "Too many payment-link requests, please try again shortly." };
/** Creating, retrying and replacing links all call Razorpay's create API. */
const writeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, keyGenerator: userOrIpKey, standardHeaders: true, legacyHeaders: false, message: limiterMessage });
const refreshLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, keyGenerator: userOrIpKey, standardHeaders: true, legacyHeaders: false, message: limiterMessage });

type Level = "READ" | "WRITE";
type Subject = "BOOKING" | "INVOICE";

const actorOf = (req: any): Actor => ({
  id: String(req.user?._id ?? req.user?.id ?? req.user?.sub ?? ""),
  email: req.user?.email,
});

function accessCtx(req: any): BookingAccessContext {
  return {
    callerId: String(req.user?._id ?? req.user?.id ?? req.user?.sub ?? ""),
    customerId: req.workspace?.customerId ? String(req.workspace.customerId) : null,
    workspaceObjectId: req.workspaceObjectId,
    permissionScope: req.permissionScope,
    isSuperAdmin: isSuperAdmin(req),
  };
}

/** Run an Express middleware inline: true when it called next(), false when it answered. */
function runMw(mw: (req: any, res: any, next: any) => any, req: Request, res: Response): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let passed = false;
    const next = (err?: unknown) => {
      passed = true;
      if (err) reject(err);
      else resolve(true);
    };
    Promise.resolve(mw(req, res, next)).then(() => {
      if (!passed) resolve(false);
    }, reject);
  });
}

/** Plumtrips staff or Super Admin — the only callers who may touch links. */
function isPlumtripsStaff(req: any): boolean {
  if (isSuperAdmin(req)) return true;
  return isHouseCallerContext(accessCtx(req)) && !isExternalAccount(req.user);
}

/** Permission + staff gates for a subject, before anything is loaded. */
async function gate(req: Request, res: Response, subject: Subject, level: Level): Promise<boolean> {
  const module = subject === "BOOKING" ? "manualBookings" : "invoices";
  if (!(await runMw(requirePermission(module, level), req, res))) return false;
  if (subject === "INVOICE" && !(await runMw(requireBillingStaff, req, res))) return false;
  if (!isPlumtripsStaff(req)) {
    res.status(403).json({ error: "Payment links are for Plumtrips staff only.", code: "STAFF_ONLY" });
    return false;
  }
  return true;
}

/** The loaded subject is within the caller's scope (else: answer as missing). */
async function subjectInScope(req: Request, subject: Subject, subjectId: unknown): Promise<boolean> {
  if (!mongoose.Types.ObjectId.isValid(String(subjectId))) return false;
  if (subject === "BOOKING") {
    const b: any = await ManualBooking.findById(subjectId).select("workspaceId createdBy assignPerson assignmentStatus").lean();
    return !!b && canAccessBooking(accessCtx(req), b, "WRITE");
  }
  const inv: any = await Invoice.findById(subjectId).lean();
  return !!inv && (await invoiceInCallerScope(req, inv));
}

/** Tenant clause for PaymentRequest reads: both id spaces, as invoices do. */
function requestTenantClause(req: any): Record<string, any> | null {
  if (isSuperAdmin(req) || isHouseCallerContext(accessCtx(req))) return null;
  const or: any[] = [];
  const cust = req.workspace?.customerId;
  const ws = req.workspaceObjectId;
  if (cust && mongoose.Types.ObjectId.isValid(String(cust))) or.push({ customerId: new mongoose.Types.ObjectId(String(cust)) });
  if (ws && mongoose.Types.ObjectId.isValid(String(ws))) {
    or.push({ invoiceWorkspaceId: new mongoose.Types.ObjectId(String(ws)) });
    or.push({ customerId: new mongoose.Types.ObjectId(String(ws)) });
  }
  return or.length ? { $or: or } : { _id: { $in: [] } };
}

const notFound = (res: Response) => res.status(404).json({ error: "Not found.", code: "NOT_FOUND" });

/** Load a request by :id with every gate applied; answers and returns null on failure. */
async function loadRequest(req: Request, res: Response, level: Level): Promise<any | null> {
  const id = String(req.params.id || "");
  if (!mongoose.Types.ObjectId.isValid(id)) { notFound(res); return null; }
  const clause = requestTenantClause(req);
  const doc: any = await PaymentRequest.findOne({ _id: id, ...(clause ? { $and: [clause] } : {}) });
  if (!doc) { notFound(res); return null; }
  if (!(await gate(req, res, doc.subject, level))) return null;
  if (!(await subjectInScope(req, doc.subject, doc.subjectId))) { notFound(res); return null; }
  return doc;
}

function sendError(res: Response, err: any, where: string) {
  if (err instanceof PaymentRequestError) {
    return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra || {}) });
  }
  if (err?.status && err?.code) return res.status(err.status).json({ error: err.message, code: err.code });
  paymentLogger.error(`[payment-links] ${where} failed`, { error: err?.message, stack: err?.stack });
  return res.status(500).json({ error: "Something went wrong with the payment request.", code: "INTERNAL" });
}

const subjectOf = (v: unknown): Subject | null => (v === "BOOKING" || v === "INVOICE" ? v : null);

/* ── GET /preview?subject=&id= — target, default recipient, warnings ───── */
router.get("/preview", async (req: Request, res: Response) => {
  try {
    const subject = subjectOf(req.query.subject);
    if (!subject) return res.status(400).json({ error: "subject must be BOOKING or INVOICE", code: "BAD_SUBJECT" });
    if (!(await gate(req, res, subject, "READ"))) return;
    if (!(await subjectInScope(req, subject, req.query.id))) return notFound(res);
    const s = await resolveSubject(subject, req.query.id);
    const open: any = await PaymentRequest.findOne({ subject, subjectId: s.subjectId, isOpen: true }).select("_id").lean();
    res.json({
      subject,
      subjectId: String(s.subjectId),
      subjectRef: s.subjectRef,
      targetBasePaise: s.targetPaise,
      defaultRecipient: s.defaultRecipient,
      blockedReason: s.blockedReason,
      openRequestId: open ? String(open._id) : null,
      bookingLinks: subject === "INVOICE" ? await paymentSummaryForBookings(s.bookingIds) : null,
    });
  } catch (err) {
    sendError(res, err, "preview");
  }
});

/* ── GET /?bookingId= | ?invoiceId= ─────────────────────────────────── */
/* ── GET /summary?bookingIds=a,b,c — the list page's Payment chips ──────
 * One query for a whole page (≤ 100 ids). Bookings the caller can't reach are
 * left out of the answer, exactly as if they had no request. */
const SUMMARY_MAX = 100;
router.get("/summary", async (req: Request, res: Response) => {
  try {
    const raw = String(req.query.bookingIds || "");
    const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => mongoose.Types.ObjectId.isValid(s)))];
    if (ids.length > SUMMARY_MAX) return res.status(400).json({ error: `At most ${SUMMARY_MAX} bookings at a time.`, code: "TOO_MANY" });
    if (!(await gate(req, res, "BOOKING", "READ"))) return;
    if (!ids.length) return res.json({ summaries: {} });
    const bookings: any[] = await ManualBooking.find({ _id: { $in: ids } }).select("workspaceId createdBy assignPerson assignmentStatus").lean();
    const ctx = accessCtx(req);
    const allowed = bookings.filter((b) => canAccessBooking(ctx, b, "READ")).map((b) => new mongoose.Types.ObjectId(String(b._id)));
    res.json({ summaries: await paymentSummaryByBooking(allowed) });
  } catch (err) {
    sendError(res, err, "summary");
  }
});

router.get("/", async (req: Request, res: Response) => {
  try {
    const subject: Subject | null = req.query.bookingId ? "BOOKING" : req.query.invoiceId ? "INVOICE" : null;
    if (!subject) return res.status(400).json({ error: "Pass bookingId or invoiceId.", code: "BAD_QUERY" });
    const id = String(subject === "BOOKING" ? req.query.bookingId : req.query.invoiceId);
    if (!(await gate(req, res, subject, "READ"))) return;
    if (!(await subjectInScope(req, subject, id))) return notFound(res);
    const clause = requestTenantClause(req);
    const docs = await PaymentRequest.find({ subject, subjectId: new mongoose.Types.ObjectId(id), ...(clause ? { $and: [clause] } : {}) })
      .sort({ createdAt: -1 })
      .lean();
    let bookingLinks = null;
    if (subject === "INVOICE") {
      const inv: any = await Invoice.findById(id).select("bookingIds").lean();
      bookingLinks = await paymentSummaryForBookings((inv?.bookingIds || []).map((b: any) => new mongoose.Types.ObjectId(String(b))));
    }
    res.json({ requests: docs.map(serializeRequest), bookingLinks });
  } catch (err) {
    sendError(res, err, "list");
  }
});

/* ── GET /:id ───────────────────────────────────────────────────────── */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const doc = await loadRequest(req, res, "READ");
    if (!doc) return;
    res.json({ request: serializeRequest(doc) });
  } catch (err) {
    sendError(res, err, "get");
  }
});

/* ── POST / — create ─────────────────────────────────────────────────
 * body: { subject, subjectId, split: {mode:"EQUAL",parts} | {mode:"PERCENT",
 *   percents} | {mode:"AMOUNTS",amountsPaise}, pgChargePct?, expireBy?,
 *   recipient: {name,email,phone}, confirm?, sendEmail? } */
router.post("/", writeLimiter, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const subject = subjectOf(body.subject);
    if (!subject) return res.status(400).json({ error: "subject must be BOOKING or INVOICE", code: "BAD_SUBJECT" });
    if (!(await gate(req, res, subject, "WRITE"))) return;
    if (!(await subjectInScope(req, subject, body.subjectId))) return notFound(res);
    const resolved = await resolveSubject(subject, body.subjectId);
    const actor = actorOf(req);
    const result = await createPaymentRequest(
      { subject, subjectId: body.subjectId, split: body.split, pgChargePct: body.pgChargePct, expireBy: body.expireBy, recipient: body.recipient || {}, confirm: body.confirm === true, dryRun: body.dryRun === true },
      resolved,
      actor,
    );
    if (result.kind === "WARNING") return res.status(409).json({ error: result.warning.message, code: result.warning.code, needsConfirm: true, summary: result.warning.summary });
    if (result.kind === "DRY_RUN") return res.json({ dryRun: true, plan: result.plan });

    const doc = result.request;
    let email: any = null;
    if (body.sendEmail === true && doc.links.some((l: any) => l.status === "CREATED")) {
      email = await sendPaymentLinkEmail(doc, actor.id);
      await doc.save();
    }
    res.status(201).json({ request: serializeRequest(doc), email: email ? { status: email.outbox.status, to: email.to } : null });
  } catch (err) {
    sendError(res, err, "create");
  }
});

/* ── POST /:id/retry — retry every FAILED_CREATE link (same references) ── */
router.post("/:id/retry", writeLimiter, async (req: Request, res: Response) => {
  try {
    const doc = await loadRequest(req, res, "WRITE");
    if (!doc) return;
    await retryFailedLinks(doc, actorOf(req));
    res.json({ request: serializeRequest(doc) });
  } catch (err) {
    sendError(res, err, "retry");
  }
});

/* ── POST /:id/links/:linkId/cancel ───────────────────────────────────── */
router.post("/:id/links/:linkId/cancel", async (req: Request, res: Response) => {
  try {
    const doc = await loadRequest(req, res, "WRITE");
    if (!doc) return;
    const { outcome } = await cancelLink(doc, req.params.linkId, actorOf(req));
    res.json({ outcome, request: serializeRequest(doc) });
  } catch (err) {
    sendError(res, err, "cancel");
  }
});

/* ── POST /:id/links/:linkId/replace — body { expireBy?, sendEmail? } ── */
router.post("/:id/links/:linkId/replace", writeLimiter, async (req: Request, res: Response) => {
  try {
    const doc = await loadRequest(req, res, "WRITE");
    if (!doc) return;
    const actor = actorOf(req);
    await replaceLink(doc, req.params.linkId, { expireBy: req.body?.expireBy }, actor);
    let email: any = null;
    if (req.body?.sendEmail === true && doc.links.some((l: any) => l.status === "CREATED")) {
      email = await sendPaymentLinkEmail(doc, actor.id);
      await doc.save();
    }
    res.json({ request: serializeRequest(doc), email: email ? { status: email.outbox.status, to: email.to } : null });
  } catch (err) {
    sendError(res, err, "replace");
  }
});

/* ── POST /:id/send-email — body { recipient? } (RM may correct it) ───── */
router.post("/:id/send-email", writeLimiter, async (req: Request, res: Response) => {
  try {
    const doc = await loadRequest(req, res, "WRITE");
    if (!doc) return;
    const r = req.body?.recipient;
    if (r && typeof r === "object") {
      const email = String(r.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Confirm the recipient's email address.", code: "BAD_RECIPIENT" });
      doc.recipient = { name: String(r.name || "").trim().slice(0, 120) || undefined, email, phone: String(r.phone || "").trim().slice(0, 20) || undefined };
    }
    const email = await sendPaymentLinkEmail(doc, actorOf(req).id);
    await doc.save();
    res.json({ email: { status: email.outbox.status, to: email.to }, request: serializeRequest(doc) });
  } catch (err) {
    sendError(res, err, "send-email");
  }
});

/* ── POST /:id/refresh — pull link states from Razorpay ───────────────── */
router.post("/:id/refresh", refreshLimiter, async (req: Request, res: Response) => {
  try {
    const doc = await loadRequest(req, res, "WRITE");
    if (!doc) return;
    const { changes } = await refreshFromRazorpay(doc, actorOf(req));
    res.json({ changes, request: serializeRequest(doc) });
  } catch (err) {
    sendError(res, err, "refresh");
  }
});

export default router;
