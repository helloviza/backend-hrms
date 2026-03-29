// apps/backend/src/routes/proposals.ts
import { Router } from "express";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import mongoose from "mongoose";
import multer from "multer";
import fs from "fs";
import path from "path";

import { requireAuth } from "../middleware/auth.js";
import { requireTravelMode } from "../middleware/travelModeGuard.js";
import { scopedFindById } from "../middleware/scopedFindById.js";
import Proposal from "../models/Proposal.js";
import ApprovalRequest, { type ApprovalStage } from "../models/ApprovalRequest.js";

// ✅ reuse existing utilities (same as approvals flow)
// NOTE: signatures may vary in your codebase; we call as `any` safely.
import { sendMail as sendMailAny } from "../utils/mailer.js";
import {
  signEmailActionToken as signEmailActionTokenAny,
  verifyEmailActionToken as verifyEmailActionTokenAny,
} from "../utils/emailActionToken.js";

type AnyObj = Record<string, any>;
type ProposalStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "DECLINED" | "EXPIRED";
type ApprovalDecision = "PENDING" | "APPROVED" | "DECLINED";
type BookingStatus = "NOT_STARTED" | "IN_PROGRESS" | "DONE" | "CANCELLED";

type RoleForProposal = "L2" | "L0";
type CustomerProposalAction = "accept" | "reject" | "needs_changes";

type AuthedReq = Request & {
  user?: AnyObj;
  _proposal?: AnyObj;
  _proposalMyRoles?: RoleForProposal[];
  _proposalIsOwner?: boolean;
  _proposalIsWorkspaceL0?: boolean;
  _proposalWorkspaceId?: string;
};

const router = Router();

/* ───────────────────────── storage (PDF attachments) ───────────────────────── */

const proposalUploadRoot = path.join(process.cwd(), "uploads", "proposals");
if (!fs.existsSync(proposalUploadRoot)) {
  fs.mkdirSync(proposalUploadRoot, { recursive: true });
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeBasename(name: string) {
  return String(name || "file.pdf")
    .replace(/[^a-zA-Z0-9.\-_]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 180);
}

function setNoStore(res: Response) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

function publicBaseUrl() {
  return (
    process.env.PUBLIC_BASE_URL ||
    process.env.BACKEND_PUBLIC_URL ||
    `http://localhost:${process.env.PORT || 8080}`
  );
}

/**
 * Canonical download endpoint:
 * GET /api/proposals/attachments/download?path=proposals/<proposalId>/<filename>
 */
function buildAttachmentPublicUrl(relativePathFromUploads: string) {
  const base = publicBaseUrl().replace(/\/$/, "");
  const safe = encodeURIComponent(relativePathFromUploads);
  return `${base}/api/proposals/attachments/download?path=${safe}`;
}

/* ────────────────────────────────────────────────────────────────
 * Multer storage
 * ──────────────────────────────────────────────────────────────── */

const proposalStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const proposalId = String((req as AnyObj).params?.id || "").trim();
    const dir = proposalId
      ? path.join(proposalUploadRoot, proposalId)
      : proposalUploadRoot;
    ensureDir(dir);
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safeOriginal = safeBasename(file.originalname || "file.pdf");
    cb(null, `${ts}_${safeOriginal}`);
  },
});

const proposalUpload = multer({
  storage: proposalStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB each
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") return cb(null, true);
    const err: any = new Error("Only PDF files are allowed");
    err.statusCode = 400;
    return cb(err, false);
  },
});

/* ────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────── */

function normEmail(v: any) {
  return String(v || "").trim().toLowerCase();
}
function normStr(v: any) {
  return String(v || "").trim();
}
function parseBool(v: any): boolean {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y" || s === "on";
}
function ensureArray<T = any>(v: any): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function pushHistory(by: AnyObj, action: string, note?: string) {
  const email = String(by?.email || by?.userEmail || "").trim();
  const name = String(by?.name || by?.userName || by?.fullName || "").trim();
  return {
    action,
    at: new Date(),
    byEmail: email,
    byName: name,
    note: String(note || "").trim(),
  };
}

function collectRoles(u: any): string[] {
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

function isStaffAdmin(u: any): boolean {
  const r = collectRoles(u);
  return (
    r.includes("ADMIN") ||
    r.includes("SUPERADMIN") ||
    r.includes("SUPER_ADMIN") ||
    r.includes("HR_ADMIN") ||
    r.includes("OPS") ||
    r.includes("OPS_ADMIN")
  );
}

/**
 * request code should always exist even if ticketId missing.
 */
function getPublicRequestCode(ar: AnyObj | null | undefined): string {
  if (!ar) return "";

  const candidates = [
    ar.ticketId,
    ar.ticketID,
    ar.ticketNo,
    ar.ticketNumber,

    ar.requestCode,
    ar.requestIdCode,
    ar.requestNo,
    ar.requestNumber,

    ar.code,
    ar.displayCode,
    ar.displayId,
    ar.publicId,
  ];

  for (const c of candidates) {
    const s = String(c || "").trim();
    if (s) return s;
  }

  const id = String(ar._id || "").trim();
  if (id && id.length >= 6) return id.slice(-6).toUpperCase();

  return "";
}

function cloneToDraftFromLatest(
  latest: AnyObj,
  requestId: mongoose.Types.ObjectId,
  version: number
) {
  const base = defaultProposalDoc({ requestId, version });

  return {
    ...base,
    currency: normStr(latest?.currency || "INR").toUpperCase() || "INR",
    totalAmount: Number(latest?.totalAmount || 0) || 0,
    options: ensureArray(latest?.options).map((o: any) => ({
      ...o,
      attachments: ensureArray(o?.attachments),
    })),
    history: [...(ensureArray(latest?.history) as any[]).slice(-10)],
  };
}

/* ────────────────────────────────────────────────────────────────
 * Enrichment from ApprovalRequest
 * ──────────────────────────────────────────────────────────────── */

function safeDateStr(v: any): string {
  const s = String(v || "").trim();
  if (!s) return "";
  return s;
}

function buildRouteLabelFromCartItems(cartItems: any[]): string {
  const first = cartItems?.[0];
  const type = String(first?.type || "").toLowerCase();

  if (type === "flight") {
    const meta = first?.meta || {};
    const tripType = String(meta?.tripType || "").toLowerCase();
    const origin = String(meta?.origin || meta?.originMeta?.iata || "").trim();
    const destination = String(
      meta?.destination || meta?.destinationMeta?.iata || ""
    ).trim();

    const t =
      tripType === "roundtrip"
        ? "Round Trip"
        : tripType === "multicity"
        ? "Multi City"
        : "One Way";

    if (origin && destination) return `${origin} → ${destination} (${t})`;
    return `Flight (${t})`;
  }

  if (type) return type.toUpperCase();
  return "";
}

function buildTravellerSummary(
  cartItems: any[]
): { count: number; names: string[] } {
  const first = cartItems?.[0];
  const travs = ensureArray(first?.meta?.travellers);
  const names = travs
    .map(
      (t: any) =>
        `${String(t?.firstName || "").trim()} ${String(t?.lastName || "").trim()}`.trim()
    )
    .filter(Boolean);
  return { count: travs.length || 0, names };
}

function buildRequestSummary(ar: AnyObj) {
  const cartItems = ensureArray(ar?.cartItems);
  const first = cartItems?.[0] || {};
  const meta = first?.meta || {};

  const routeLabel = buildRouteLabelFromCartItems(cartItems);
  const departDate = safeDateStr(meta?.departDate);
  const returnDate = safeDateStr(meta?.returnDate);
  const traveller = buildTravellerSummary(cartItems);

  return {
    requestId: String(ar?._id || ""),
    requestCode: getPublicRequestCode(ar),
    type: String(first?.type || "").toLowerCase(),
    title: String(first?.title || routeLabel || "").trim(),
    routeLabel: routeLabel || undefined,

    requesterEmail: normEmail(ar?.frontlinerEmail),
    requesterName: normStr(ar?.frontlinerName || ar?.frontlinerFullName || ""),
    managerEmail: normEmail(ar?.managerEmail),
    managerName: normStr(ar?.managerName || ""),

    departDate: departDate || undefined,
    returnDate: returnDate || undefined,

    travellerCount: traveller.count || undefined,
    travellerNames: traveller.names.length ? traveller.names : undefined,

    priority: normStr(meta?.priority || "") || undefined,
    needBy: safeDateStr(meta?.needBy) || undefined,

    travelScope: normStr(meta?.travelScope || "") || undefined,
  };
}

async function enrichProposalsWithRequestData(proposals: AnyObj[]) {
  const requestIds: mongoose.Types.ObjectId[] = [];
  for (const p of proposals) {
    const rid = String(p?.requestId || "").trim();
    if (mongoose.Types.ObjectId.isValid(rid))
      requestIds.push(new mongoose.Types.ObjectId(rid));
  }

  if (!requestIds.length) return proposals;

  const reqDocs = await ApprovalRequest.find({ _id: { $in: requestIds } }).lean();
  const reqMap = new Map<string, AnyObj>();
  for (const r of reqDocs as any[]) reqMap.set(String(r._id), r);

  return proposals.map((p: AnyObj) => {
    const ar = reqMap.get(String(p?.requestId || ""));
    if (!ar) return p;

    const requestCode = getPublicRequestCode(ar);
    const summary = buildRequestSummary(ar);

    return {
      ...p,
      _requestCode: requestCode || undefined,
      _requestSummary: summary,
    };
  });
}

/* ────────────────────────────────────────────────────────────────
 * Approver resolution (L2/L0) from ApprovalRequest (schema-tolerant)
 * ──────────────────────────────────────────────────────────────── */

function emailFromAny(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return normEmail(v);

  if (typeof v === "object") {
    const candidates = [
      v.email,
      v.userEmail,
      v.workEmail,
      v.corporateEmail,
      v.employeeEmail,
      v.requesterEmail,
      v.approverEmail,
      v.managerEmail,
      v.reportingManagerEmail,
    ];
    for (const c of candidates) {
      const e = normEmail(c);
      if (e) return e;
    }
  }
  return "";
}

function emailsFromAny(v: any): string[] {
  const out: string[] = [];
  const walk = (x: any) => {
    if (x == null) return;
    if (Array.isArray(x)) {
      for (const y of x) walk(y);
      return;
    }
    const e = emailFromAny(x);
    if (e) out.push(e);
  };
  walk(v);
  return out;
}

function uniqEmails(...vals: any[]): string[] {
  const out: string[] = [];
  for (const v of vals) out.push(...emailsFromAny(v));
  return Array.from(new Set(out.filter(Boolean)));
}

function pickFirstEmail(...vals: any[]): string {
  for (const v of vals) {
    const list = emailsFromAny(v);
    if (list.length) return list[0];
  }
  return "";
}

function extractApproversFromApprovalRequest(ar: AnyObj): {
  l2Email: string;
  l0Emails: string[];
} {
  const l2Email = pickFirstEmail(
    ar?.approverEmail,
    ar?.l2Email,
    ar?.l2ApproverEmail,
    ar?.level2ApproverEmail,
    ar?.approval?.l2?.email,
    ar?.approvers?.l2,
    ar?.approvals?.l2?.email,
    ar?.approver,
    ar?.l2Approver,
    ar?.approval?.l2,
    ar?.approvals?.l2,
    ar?.managerEmail
  );

  const l0Emails = uniqEmails(
    ar?.l0Emails,
    ar?.l0ApproverEmails,
    ar?.level0ApproverEmails,
    ar?.approval?.l0?.emails,
    ar?.approval?.l0?.email,
    ar?.approvers?.l0,
    ar?.approvals?.l0?.emails,
    ar?.superApproverEmails,
    ar?.workspaceLeaderEmails,
    ar?.l0Approver,
    ar?.approval?.l0,
    ar?.approvals?.l0,
    ar?.meta?.ccLeaders
  );

  if (!l0Emails.length) {
    const maybeOne = pickFirstEmail(
      ar?.l0Email,
      ar?.l0ApproverEmail,
      ar?.level0ApproverEmail,
      ar?.approvals?.l0?.email,
      ar?.approval?.l0?.email,
      ar?.l0Approver
    );
    if (maybeOne) return { l2Email, l0Emails: [maybeOne] };
  }

  return { l2Email, l0Emails };
}

function computeMyRolesFromAR(ar: AnyObj, userEmail: string): RoleForProposal[] {
  const roles: RoleForProposal[] = [];
  if (!userEmail) return roles;

  const { l2Email, l0Emails } = extractApproversFromApprovalRequest(ar || {});

  if (l2Email && userEmail === l2Email) roles.push("L2");
  if (Array.isArray(l0Emails) && l0Emails.includes(userEmail)) roles.push("L0");

  const fallbackL2 = emailFromAny(
    ar?.approver || ar?.approval?.l2 || ar?.approvals?.l2 || ar?.l2Approver
  );
  if (!roles.includes("L2") && fallbackL2 && fallbackL2 === userEmail)
    roles.push("L2");

  return Array.from(new Set(roles));
}

function extractOwnerEmailsFromApprovalRequest(ar: AnyObj): string[] {
  return uniqEmails(
    ar?.requesterEmail,
    ar?.requestedByEmail,
    ar?.createdByEmail,
    ar?.employeeEmail,
    ar?.userEmail,
    ar?.email,
    ar?.requestedBy?.email,
    ar?.createdBy?.email,
    ar?.requester?.email,
    ar?.employee?.email,
    ar?.customerEmail,
    ar?.businessEmail,
    ar?.frontlinerEmail,
    ar?.approvedByEmail
  );
}

function isOwnerOfRequest(ar: AnyObj, userEmail: string): boolean {
  const owners = extractOwnerEmailsFromApprovalRequest(ar || {});
  return Boolean(userEmail && owners.includes(userEmail));
}

/**
 * HARD workflow gate:
 * Admin proposal draft can start only after request is fully approved.
 */
function isRequestFullyApproved(ar: AnyObj): boolean {
  const stage = String(ar?.stage || "").trim();
  if (stage === "REQUEST_APPROVED") return true;

  const s1 = String(ar?.status || "").toLowerCase();
  const s2 = String(ar?.approvalStatus || "").toLowerCase();
  if (s1 === "approved" || s2 === "approved") return true;

  const l2 = String(
    ar?.approvals?.l2?.decision ||
      ar?.approval?.l2?.decision ||
      ar?.l2Decision ||
      ""
  )
    .trim()
    .toUpperCase();
  const l0 = String(
    ar?.approvals?.l0?.decision ||
      ar?.approval?.l0?.decision ||
      ar?.l0Decision ||
      ""
  )
    .trim()
    .toUpperCase();

  if (l2 === "APPROVED" && l0 === "APPROVED") return true;
  if (ar?.l2Approved === true && ar?.l0Approved === true) return true;

  return false;
}

/* ────────────────────────────────────────────────────────────────
 * Defaults / fetch helpers
 * ──────────────────────────────────────────────────────────────── */

function defaultProposalDoc(input: { requestId: mongoose.Types.ObjectId; version: number }) {
  return {
    requestId: input.requestId,
    version: input.version,
    status: "DRAFT" as ProposalStatus,
    currency: "INR",
    totalAmount: 0,
    options: [],
    approvals: {
      l2: { decision: "PENDING" as ApprovalDecision },
      l0: { decision: "PENDING" as ApprovalDecision },
    },
    booking: {
      status: "NOT_STARTED" as BookingStatus,
      attachments: [] as string[],
    },
    history: [],
    customer: {
      action: null as CustomerProposalAction | null,
      note: "",
      at: null as any,
      byEmail: "",
      byName: "",
    },
  };
}

async function latestProposalForRequest(requestId: mongoose.Types.ObjectId) {
  return Proposal.findOne({ requestId }).sort({ version: -1, createdAt: -1 });
}

async function nextVersionForRequest(requestId: mongoose.Types.ObjectId) {
  const last = await Proposal.findOne({ requestId }).sort({ version: -1 }).lean();
  const v = Number((last as any)?.version || 0);
  return Math.max(1, v + 1);
}

/* ───────────────────────── Stage sync (ApprovalRequest.stage) ───────────────────────── */

const STAGE_RANK: Partial<Record<ApprovalStage, number>> = {
  REQUEST_RAISED: 10,
  REQUEST_APPROVED: 20,
  REQUEST_ON_HOLD: 30,
  REQUEST_DECLINED: 40,

  PROPOSAL_PENDING: 50,
  PROPOSAL_SUBMITTED: 60,
  PROPOSAL_APPROVED: 70,
  PROPOSAL_DECLINED: 80,

  BOOKING_IN_PROGRESS: 90,
  BOOKING_ON_HOLD: 95,
  BOOKING_DONE: 100,
  BOOKING_CANCELLED: 110,

  COMPLETED: 120,
  CANCELLED: 130,
};

function isApprovalStage(v: any): v is ApprovalStage {
  return typeof v === "string" && (v as ApprovalStage) in (STAGE_RANK as AnyObj);
}

async function safeAdvanceStage(
  requestId: mongoose.Types.ObjectId,
  nextStage: ApprovalStage,
  opts?: { force?: boolean; workspaceId?: string }
) {
  const force = Boolean(opts?.force);

  const reqDoc: any = await scopedFindById(ApprovalRequest, requestId, opts?.workspaceId ?? "");
  if (!reqDoc) return;

  const current = String(reqDoc.stage || "").trim();
  const currentStage = isApprovalStage(current) ? (current as ApprovalStage) : undefined;

  if (!currentStage || force) {
    reqDoc.stage = nextStage;
    await reqDoc.save();
    return;
  }

  const curRank = Number(STAGE_RANK[currentStage] ?? 0);
  const nextRank = Number(STAGE_RANK[nextStage] ?? 0);

  if (nextRank >= curRank) {
    reqDoc.stage = nextStage;
    await reqDoc.save();
  }
}

/* ────────────────────────────────────────────────────────────────
 * Auth guards
 * ──────────────────────────────────────────────────────────────── */

const DISABLE_AUTH = parseBool(process.env.DISABLE_AUTH);

const requireAnyAuth: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (DISABLE_AUTH) {
    (req as AuthedReq).user = {
      id: "dev-user", // ✅ required by apps/backend/src/types/express.d.ts (User.id)
      sub: "dev-user",
      email: "dev@local",
      roles: ["ADMIN"],
      name: "Dev Admin",
    };
    return next();
  }

  return requireAuth(req as any, res as any, next as any);
};

const requireStaff: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const u = (req as AuthedReq).user;

  if (!u) return res.status(401).json({ error: "Unauthenticated" });
  if (isStaffAdmin(u)) return next();

  return res.status(403).json({ error: "Admin access required" });
};

const requireProposalViewer: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const aReq = req as AuthedReq;

    if (!aReq.user) return res.status(401).json({ error: "Unauthenticated" });
    if (isStaffAdmin(aReq.user)) return next();

    const userEmail = normEmail(aReq.user?.email);
    if (!userEmail) return res.status(401).json({ error: "Unauthenticated" });

    const proposalId = normStr(aReq.params?.id || "");
    if (!mongoose.Types.ObjectId.isValid(proposalId)) {
      return res.status(400).json({ error: "Invalid proposal id" });
    }

    const p: any = await Proposal.findOne({ _id: proposalId, workspaceId: (req as any).workspaceId }).lean();
    if (!p) return res.status(404).json({ error: "Proposal not found" });
    if (!p.requestId) return res.status(400).json({ error: "Proposal missing requestId" });

    const ar: any = await ApprovalRequest.findOne({ _id: p.requestId, workspaceId: (req as any).workspaceId }).lean();
    if (!ar) return res.status(404).json({ error: "ApprovalRequest not found for proposal" });

    const myRoles = computeMyRolesFromAR(ar, userEmail);
    const owner = isOwnerOfRequest(ar, userEmail);

    if (!myRoles.length && !owner) {
      return res.status(403).json({ error: "Not allowed" });
    }

    aReq._proposal = p;
    aReq._proposalMyRoles = myRoles;
    aReq._proposalIsOwner = owner;

    return next();
  } catch (e) {
    return next(e);
  }
};

const requireProposalViewerFromDownloadPath: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const aReq = req as AuthedReq;

    if (!aReq.user) return res.status(401).json({ error: "Unauthenticated" });
    if (isStaffAdmin(aReq.user)) return next();

    const userEmail = normEmail(aReq.user?.email);
    if (!userEmail) return res.status(401).json({ error: "Unauthenticated" });

    const rel = String(req.query?.path || "").trim().replace(/\\/g, "/");
    if (!rel.startsWith("proposals/")) return res.status(400).json({ error: "Invalid path" });

    const parts = rel.split("/");
    const proposalId = String(parts[1] || "").trim();
    if (!mongoose.Types.ObjectId.isValid(proposalId)) {
      return res.status(400).json({ error: "Invalid proposal id in path" });
    }

    const p: any = await Proposal.findOne({ _id: proposalId, workspaceId: (req as any).workspaceId }).lean();
    if (!p) return res.status(404).json({ error: "Proposal not found" });
    if (!p.requestId) return res.status(400).json({ error: "Proposal missing requestId" });

    const ar: any = await ApprovalRequest.findOne({ _id: p.requestId, workspaceId: (req as any).workspaceId }).lean();
    if (!ar) return res.status(404).json({ error: "ApprovalRequest not found for proposal" });

    const myRoles = computeMyRolesFromAR(ar, userEmail);
    const owner = isOwnerOfRequest(ar, userEmail);

    if (!myRoles.length && !owner) return res.status(403).json({ error: "Not allowed" });

    return next();
  } catch (e) {
    return next(e);
  }
};

/* ────────────────────────────────────────────────────────────────
 * L0 requirement policy
 * ──────────────────────────────────────────────────────────────── */

function requiresL0Approval(ar: AnyObj | null | undefined, proposal: AnyObj | null | undefined): boolean {
  const explicit =
    ar?.meta?.requireL0Approval ??
    ar?.requireL0Approval ??
    ar?.approvalPolicy?.requireL0Approval;

  if (explicit === true) return true;
  if (explicit === false) return false;

  const threshold = Number(process.env.PROPOSAL_L0_THRESHOLD || 0);
  if (Number.isFinite(threshold) && threshold > 0) {
    const amt = Number(proposal?.totalAmount ?? 0);
    if (Number.isFinite(amt) && amt >= threshold) return true;
  }

  return false;
}

/* ────────────────────────────────────────────────────────────────
 * Email helpers
 * ──────────────────────────────────────────────────────────────── */

function frontendBaseUrl() {
  return (
    process.env.FRONTEND_PUBLIC_URL ||
    process.env.PUBLIC_FRONTEND_URL ||
    process.env.PUBLIC_WEB_URL ||
    "http://localhost:5173"
  ).replace(/\/$/, "");
}

function buildEmailActionUrl(token: string) {
  const base = publicBaseUrl().replace(/\/$/, "");
  return `${base}/api/proposals/email-action?token=${encodeURIComponent(token)}`;
}

function moneyINR(n: any) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "₹0";
  return `₹${v.toLocaleString("en-IN")}`;
}

function buildProposalSummaryHtml(p: any) {
  const options = ensureArray(p?.options).slice().sort((a: any, b: any) => Number(a?.optionNo || 0) - Number(b?.optionNo || 0));

  const optBlocks = options
    .map((opt: any) => {
      const lines = ensureArray(opt?.lineItems);

      const rows = lines
        .map((li: any) => {
          const title = String(li?.title || li?.category || "Item");
          const qty = Number(li?.qty || 1);
          const unit = Number(li?.unitPrice || 0);
          const total = Number(li?.totalPrice || qty * unit || 0);
          return `<tr>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;">${title}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${qty}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${moneyINR(unit)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${moneyINR(total)}</td>
          </tr>`;
        })
        .join("");

      const attachments = ensureArray(opt?.attachments);
      const attHtml =
        attachments.length
          ? `<div style="color:#666;margin-top:6px;">${attachments.length} PDF attachment(s) included.</div>`
          : `<div style="color:#666;margin-top:6px;">No attachments</div>`;

      return `
        <div style="border:1px solid #eee;border-radius:10px;padding:14px;margin-top:12px;">
          <div style="font-weight:800;margin-bottom:6px;">
            Option ${String(opt?.optionNo || "")} — ${String(opt?.title || "Option")}
          </div>

          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr>
                <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #eee;">Item</th>
                <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #eee;">Qty</th>
                <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #eee;">Unit</th>
                <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #eee;">Total</th>
              </tr>
            </thead>
            <tbody>${rows || ""}</tbody>
          </table>

          <div style="display:flex;justify-content:space-between;margin-top:10px;">
            <div style="color:#666;">Option Total</div>
            <div style="font-weight:900;">${moneyINR(opt?.totalAmount)}</div>
          </div>

          <div style="margin-top:10px;">
            <div style="font-weight:700;">Attachments</div>
            ${attHtml}
          </div>
        </div>
      `;
    })
    .join("");

  return `
    <div style="font-family:Arial,sans-serif;max-width:720px;">
      <h2 style="margin:0 0 8px;">Proposal submitted for approval</h2>
      <div style="color:#666;margin-bottom:10px;">Proposal ID: <b>${String(p?._id || "")}</b></div>

      <div style="display:flex;justify-content:space-between;margin:8px 0 6px;">
        <div style="color:#666;">Grand Total</div>
        <div style="font-weight:900;">${moneyINR(p?.totalAmount)}</div>
      </div>

      ${optBlocks || `<div style="color:#666;">No options</div>`}
    </div>
  `;
}


function buttonHtml(label: string, url: string, kind: "green" | "red" | "gray") {
  const bg = kind === "green" ? "#16a34a" : kind === "red" ? "#dc2626" : "#6b7280";
  return `
    <a href="${url}" style="
      display:inline-block;
      padding:10px 14px;
      margin-right:10px;
      border-radius:10px;
      background:${bg};
      color:#fff;
      text-decoration:none;
      font-weight:700;
      font-family:Arial,sans-serif;
    ">${label}</a>
  `;
}

function extractRelativeUploadPathFromAttachmentUrl(u: string): string {
  const s = String(u || "").trim();
  if (!s) return "";

  // expects .../api/proposals/attachments/download?path=proposals%2F<proposalId>%2Ffile.pdf
  const m = s.match(/[?&]path=([^&]+)/);
  if (!m?.[1]) return "";
  try {
    return decodeURIComponent(m[1]).replace(/\\/g, "/"); // "proposals/<id>/<file>"
  } catch {
    return "";
  }
}

function buildPdfAttachmentsForEmail(p: any, maxFiles = 10) {
  const uploadsRoot = path.resolve(process.cwd(), "uploads");

  const urls: string[] = [];
  for (const opt of ensureArray(p?.options)) {
    for (const u of ensureArray(opt?.attachments)) urls.push(String(u || ""));
  }

  const uniq = Array.from(new Set(urls.filter(Boolean))).slice(0, maxFiles);

  const attachments: any[] = [];
  for (const u of uniq) {
    const rel = extractRelativeUploadPathFromAttachmentUrl(u);
    if (!rel.startsWith("proposals/")) continue;

    const abs = path.resolve(uploadsRoot, rel);
    if (!abs.startsWith(uploadsRoot + path.sep)) continue;
    if (!fs.existsSync(abs)) continue;

    attachments.push({
      filename: path.basename(abs),
      content: fs.readFileSync(abs),
      contentType: "application/pdf",
    });
  }

  return attachments;
}


/* ────────────────────────────────────────────────────────────────
 * Routes (specific FIRST, :id LAST)
 * ──────────────────────────────────────────────────────────────── */

/**
 * GET /api/proposals/attachments/download?path=proposals/<proposalId>/<filename>
 */
router.get(
  "/attachments/download",
  requireAnyAuth,
  requireProposalViewerFromDownloadPath,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      setNoStore(res);

      const rel = String(req.query?.path || "").trim();
      if (!rel) return res.status(400).json({ error: "Missing path" });

      const safeRel = rel.replace(/\\/g, "/");
      if (!safeRel.startsWith("proposals/")) return res.status(400).json({ error: "Invalid path" });

      const uploadsRoot = path.resolve(process.cwd(), "uploads");
      const abs = path.resolve(uploadsRoot, safeRel);

      if (!abs.startsWith(uploadsRoot + path.sep)) return res.status(400).json({ error: "Invalid path" });
      if (!fs.existsSync(abs)) return res.status(404).json({ error: "File not found" });

      res.setHeader("Content-Type", "application/pdf");
      return res.download(abs, path.basename(abs));
    } catch (err) {
      next(err);
    }
  }
);

/**
 * ✅ Public email action endpoint (token-based)
 * GET /api/proposals/email-action?token=...
 * Verifies token, updates proposal, redirects to frontend confirmation page.
 */
router.get("/email-action", async (req: Request, res: Response) => {
  try {
    setNoStore(res);

    const token = String(req.query?.token || "").trim();
    if (!token) return res.status(400).send("Missing token");

    const verify = verifyEmailActionTokenAny as any;
    const payload = await verify(token); // expected { proposalId, action, role, ... }

    const proposalId = String(payload?.proposalId || payload?.id || "").trim();
    const action = String(payload?.action || "").trim().toLowerCase(); // approve|decline|hold
    const role = String(payload?.role || "L2").trim().toUpperCase(); // L2/L0
    const byEmail = normEmail(payload?.email || payload?.byEmail || "");
    const byName = normStr(payload?.name || payload?.byName || "");

    if (!mongoose.Types.ObjectId.isValid(proposalId)) {
      return res.redirect(`${frontendBaseUrl()}/proposal-action?ok=0&msg=Invalid%20proposal`);
    }

    const doc: any = await scopedFindById(Proposal, proposalId, (req as any).workspaceId);
    if (!doc) {
      return res.redirect(`${frontendBaseUrl()}/proposal-action?ok=0&msg=Proposal%20not%20found`);
    }

    if (String(doc.status || "") !== "SUBMITTED") {
      return res.redirect(`${frontendBaseUrl()}/proposal-action?ok=0&msg=Proposal%20not%20in%20SUBMITTED`);
    }

    // Map action
    const decision: ApprovalDecision =
      action === "approve" || action === "approved" ? "APPROVED" :
      action === "decline" || action === "reject" || action === "declined" ? "DECLINED" :
      action === "hold" || action === "on_hold" ? "PENDING" :
      "PENDING";

    // Apply decision
    doc.approvals = doc.approvals || {};
    doc.approvals.l2 = doc.approvals.l2 || { decision: "PENDING" };
    doc.approvals.l0 = doc.approvals.l0 || { decision: "PENDING" };

    const key = role === "L0" ? "l0" : "l2";
    doc.approvals[key] = {
      decision,
      at: new Date(),
      byEmail,
      byName,
      comment: action === "hold" ? "On hold (email action)" : "",
    };

    doc.history = ensureArray(doc.history);
    doc.history.push(
      pushHistory(
        { email: byEmail, name: byName },
        `EMAIL_${role}_${decision}`,
        action
      )
    );

    // Determine final proposal status
    let ar: any = null;
    if (doc.requestId) ar = await ApprovalRequest.findOne({ _id: doc.requestId, workspaceId: (req as any).workspaceId }).lean();
    const needL0 = requiresL0Approval(ar, doc);

    const l2 = String(doc.approvals?.l2?.decision || "PENDING").toUpperCase();
    const l0 = String(doc.approvals?.l0?.decision || "PENDING").toUpperCase();

    const shouldDecline = l2 === "DECLINED" || (needL0 && l0 === "DECLINED");
    if (shouldDecline) {
      doc.status = "DECLINED";
      await doc.save();
      if (doc.requestId) await safeAdvanceStage(doc.requestId, "PROPOSAL_DECLINED", { workspaceId: doc.workspaceId });
      return res.redirect(`${frontendBaseUrl()}/proposal-action?ok=1&status=DECLINED`);
    }

    const fullyApproved = l2 === "APPROVED" && (!needL0 || l0 === "APPROVED");
    if (fullyApproved) {
      doc.status = "APPROVED";
      await doc.save();
      if (doc.requestId) await safeAdvanceStage(doc.requestId, "PROPOSAL_APPROVED", { workspaceId: doc.workspaceId });
      return res.redirect(`${frontendBaseUrl()}/proposal-action?ok=1&status=APPROVED`);
    }

    await doc.save();
    return res.redirect(`${frontendBaseUrl()}/proposal-action?ok=1&status=UPDATED`);
  } catch (e: any) {
    const msg = encodeURIComponent(String(e?.message || "Invalid/expired token"));
    return res.redirect(`${frontendBaseUrl()}/proposal-action?ok=0&msg=${msg}`);
  }
});

/**
 * ✅ GET /api/proposals/inbox
 */
router.get("/inbox", requireAnyAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    setNoStore(res);

    const aReq = req as AuthedReq;
    const userEmail = normEmail(aReq.user?.email);
    if (!userEmail) return res.status(401).json({ error: "Unauthenticated" });

    const proposals = await Proposal.find({
      status: "SUBMITTED",
      $or: [{ "approvals.l2.decision": "PENDING" }, { "approvals.l0.decision": "PENDING" }],
    })
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean();

    if (!proposals.length) return res.json({ ok: true, items: [] });

    const reqObjIds: mongoose.Types.ObjectId[] = [];
    for (const p of proposals as any[]) {
      const rid = String(p?.requestId || "").trim();
      if (mongoose.Types.ObjectId.isValid(rid)) reqObjIds.push(new mongoose.Types.ObjectId(rid));
    }
    if (!reqObjIds.length) return res.json({ ok: true, items: [] });

    const reqDocs = await ApprovalRequest.find({ _id: { $in: reqObjIds } }).lean();
    const reqMap = new Map<string, AnyObj>();
    for (const r of reqDocs as any[]) reqMap.set(String(r._id), r);

    const out: AnyObj[] = [];

    for (const p of proposals as any[]) {
      const rid = String(p?.requestId || "").trim();
      const ar = reqMap.get(rid);
      if (!ar) continue;

      const myRoles = computeMyRolesFromAR(ar, userEmail);
      if (!myRoles.length) continue;

      const l2Decision = String(p?.approvals?.l2?.decision || "PENDING").toUpperCase();
      const l0Decision = String(p?.approvals?.l0?.decision || "PENDING").toUpperCase();

      const needL0 = requiresL0Approval(ar, p);

      const needsL2 = l2Decision === "PENDING";
      const needsL0 = needL0 && l0Decision === "PENDING";

      let actionable = false;
      if (myRoles.includes("L2") && needsL2) actionable = true;
      if (myRoles.includes("L0") && needsL0) actionable = true;

      if (!actionable) continue;

      out.push({
        ...(p as any),
        _myRoles: myRoles,
        _isSelfApproval: myRoles.includes("L2") && isOwnerOfRequest(ar, userEmail),
      });
    }

    const enriched = await enrichProposalsWithRequestData(out);
    return res.json({ ok: true, items: enriched });
  } catch (err) {
    next(err);
  }
});

/**
 * ✅ GET /api/proposals/mine
 */
router.get("/mine", requireAnyAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    setNoStore(res);

    const aReq = req as AuthedReq;
    const userEmail = normEmail(aReq.user?.email);
    if (!userEmail) return res.status(401).json({ error: "Unauthenticated" });

    const candidateRequests = await ApprovalRequest.find({
      $or: [{ frontlinerEmail: userEmail }, { managerEmail: userEmail }, { "meta.ccLeaders": userEmail }],
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(1000)
      .lean();

    if (!candidateRequests.length) return res.json({ ok: true, items: [] });

    const l0WorkspaceIds = new Set<string>();
    for (const ar of candidateRequests as any[]) {
      const l0List = ensureArray(ar?.meta?.ccLeaders).map(normEmail);
      if (l0List.includes(userEmail)) {
        const ws = String(ar?.meta?.customerWorkspaceId || "").trim();
        if (ws) l0WorkspaceIds.add(ws);
      }
    }

    let requestIds: mongoose.Types.ObjectId[] = [];

    if (l0WorkspaceIds.size) {
      const wsRequests = await ApprovalRequest.find({
        "meta.customerWorkspaceId": { $in: Array.from(l0WorkspaceIds) },
      })
        .select({ _id: 1 })
        .lean();

      requestIds = wsRequests.map((x: any) => x._id);
    } else {
      const allowed = new Set<string>();

      for (const ar of candidateRequests as any[]) {
        const rid = String(ar?._id || "");
        if (!mongoose.Types.ObjectId.isValid(rid)) continue;

        const isOwner = normEmail(ar?.frontlinerEmail) === userEmail;
        const isL2 = normEmail(ar?.managerEmail) === userEmail;

        if (isOwner || isL2) allowed.add(rid);
      }

      requestIds = Array.from(allowed).map((id) => new mongoose.Types.ObjectId(id));
    }

    if (!requestIds.length) return res.json({ ok: true, items: [] });

    const items = await Proposal.aggregate([
      { $match: { requestId: { $in: requestIds } } },
      { $sort: { requestId: 1, version: -1, updatedAt: -1, createdAt: -1 } },
      { $group: { _id: "$requestId", doc: { $first: "$$ROOT" } } },
      { $replaceRoot: { newRoot: "$doc" } },
      { $sort: { updatedAt: -1, createdAt: -1 } },
      { $limit: 200 },
    ]);

    const enriched = await enrichProposalsWithRequestData(items || []);

    return res.json({
      ok: true,
      scope: l0WorkspaceIds.size ? "WORKSPACE_L0" : "USER",
      items: enriched,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/proposals/queue (staff only)
 */
router.get("/queue", requireAnyAuth, requireStaff, async (req: Request, res: Response, next: NextFunction) => {
  try {
    setNoStore(res);

    const status = normStr(req.query?.status || "").toUpperCase();
    const l2 = normStr(req.query?.l2 || "").toUpperCase();
    const l0 = normStr(req.query?.l0 || "").toUpperCase();
    const bookingStatus = normStr(req.query?.bookingStatus || "").toUpperCase();

    const q: AnyObj = {};
    if (["DRAFT", "SUBMITTED", "APPROVED", "DECLINED", "EXPIRED"].includes(status)) q.status = status;
    if (["PENDING", "APPROVED", "DECLINED"].includes(l2)) q["approvals.l2.decision"] = l2;
    if (["PENDING", "APPROVED", "DECLINED"].includes(l0)) q["approvals.l0.decision"] = l0;
    if (["NOT_STARTED", "IN_PROGRESS", "DONE", "CANCELLED"].includes(bookingStatus)) q["booking.status"] = bookingStatus;

    const items = await Proposal.find(q).sort({ updatedAt: -1 }).limit(200).lean();
    const enriched = await enrichProposalsWithRequestData(items || []);
    return res.json({ ok: true, items: enriched });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/proposals/by-request/:requestId (staff-only)
 */
router.get("/by-request/:requestId", requireAnyAuth, requireStaff, async (req: Request, res: Response, next: NextFunction) => {
  try {
    setNoStore(res);

    const requestId = String(req.params.requestId || "");
    if (!mongoose.Types.ObjectId.isValid(requestId)) return res.status(400).json({ error: "Invalid requestId" });

    const rid = new mongoose.Types.ObjectId(requestId);
    const p = await latestProposalForRequest(rid);
    if (!p) return res.json({ ok: true, proposal: null });

    const enriched = await enrichProposalsWithRequestData([(p as any).toObject()]);
    return res.json({ ok: true, proposal: enriched[0] || null });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/proposals/by-request/:requestId/draft (staff-only)
 */
router.post("/by-request/:requestId/draft", requireAnyAuth, requireStaff, requireTravelMode("APPROVAL_FLOW"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    setNoStore(res);

    const requestId = String(req.params.requestId || "");
    if (!mongoose.Types.ObjectId.isValid(requestId)) return res.status(400).json({ error: "Invalid requestId" });
    const rid = new mongoose.Types.ObjectId(requestId);

    const ar: any = await ApprovalRequest.findOne({ _id: rid, workspaceId: (req as any).workspaceId }).lean();
    if (!ar) return res.status(404).json({ error: "ApprovalRequest not found" });

    if (!isRequestFullyApproved(ar)) {
      return res.status(403).json({
        error: "Request must be approved by L2 and L0 before proposal can be created.",
      });
    }

    const latest = await latestProposalForRequest(rid);

    if (latest) {
      const st = String((latest as any).status || "").toUpperCase();

      if (st === "DRAFT") {
        const enriched = await enrichProposalsWithRequestData([(latest as any).toObject()]);
        return res.json({ ok: true, proposal: enriched[0], created: false });
      }

      const version = await nextVersionForRequest(rid);
      const cloned = cloneToDraftFromLatest((latest as any).toObject?.() ?? latest, rid, version);

      const doc: any = await Proposal.create(cloned);
      doc.history = ensureArray(doc.history);
      doc.history.push(
        pushHistory(
          (req as AuthedReq).user || {},
          "DRAFT_CREATED",
          `Draft created v${doc.version} (cloned from v${latest.version || "?"} ${st})`
        )
      );

      const currency = normStr((req as any).body?.currency || "");
      if (currency) doc.currency = currency.toUpperCase();

      await doc.save();
      await safeAdvanceStage(rid, "PROPOSAL_PENDING", { workspaceId: (req as any).workspaceId });

      const enriched = await enrichProposalsWithRequestData([doc.toObject()]);
      return res.json({ ok: true, proposal: enriched[0], created: true });
    }

    const version = await nextVersionForRequest(rid);
    const doc: any = await Proposal.create(defaultProposalDoc({ requestId: rid, version }));

    const currency = normStr((req as any).body?.currency || "");
    if (currency) doc.currency = currency.toUpperCase();

    doc.history = ensureArray(doc.history);
    doc.history.push(pushHistory((req as AuthedReq).user || {}, "DRAFT_CREATED", `Draft created v${doc.version}`));

    await doc.save();
    await safeAdvanceStage(rid, "PROPOSAL_PENDING", { workspaceId: (req as any).workspaceId });

    const enriched = await enrichProposalsWithRequestData([doc.toObject()]);
    return res.json({ ok: true, proposal: enriched[0], created: true });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/proposals/:id (staff-only) - Update DRAFT only.
 */
router.put("/:id", requireAnyAuth, requireStaff, async (req: Request, res: Response, next: NextFunction) => {
  try {
    setNoStore(res);

    const id = String(req.params.id || "");
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid proposal id" });

    const doc: any = await scopedFindById(Proposal, id, (req as any).workspaceId);
    if (!doc) return res.status(404).json({ error: "Proposal not found" });

    if (String(doc.status || "") !== "DRAFT") {
      return res.status(400).json({ error: "Only DRAFT proposals can be edited" });
    }

    const body = (req as any).body || {};
    if (body?.currency != null) doc.currency = normStr(body.currency || "INR").toUpperCase();
    if (body?.options != null) doc.options = ensureArray(body.options);
    if (body?.totalAmount != null) doc.totalAmount = Number(body.totalAmount) || 0;

    doc.history = ensureArray(doc.history);
    doc.history.push(pushHistory((req as AuthedReq).user || {}, "DRAFT_UPDATED", normStr(body?.note || "")));

    await doc.save();

    const enriched = await enrichProposalsWithRequestData([doc.toObject()]);
    return res.json({ ok: true, proposal: enriched[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/proposals/:id/submit (staff-only)
 * - Sets status SUBMITTED
 * - Sends email to L2 with token actions
 */
router.post("/:id/submit", requireAnyAuth, requireStaff, requireTravelMode("APPROVAL_FLOW"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    setNoStore(res);

    const id = String(req.params.id || "");
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid proposal id" });

    const doc: any = await scopedFindById(Proposal, id, (req as any).workspaceId);
    if (!doc) return res.status(404).json({ error: "Proposal not found" });

    if (String(doc.status || "") !== "DRAFT") return res.status(400).json({ error: "Only DRAFT proposals can be submitted" });

    const opts = ensureArray(doc.options);
    if (!opts.length) return res.status(400).json({ error: "Add at least one option before submitting" });

    // Resolve L2 from ApprovalRequest
    let ar: any = null;
    if (doc.requestId) ar = await ApprovalRequest.findOne({ _id: doc.requestId, workspaceId: (req as any).workspaceId }).lean();
    if (!ar) return res.status(400).json({ error: "ApprovalRequest not found for proposal" });

    const { l2Email, l0Emails } = extractApproversFromApprovalRequest(ar);
    if (!l2Email) return res.status(400).json({ error: "Could not resolve L2 approver email" });

    doc.status = "SUBMITTED" as ProposalStatus;
    doc.approvals = doc.approvals || {};
    doc.approvals.l2 = { decision: "PENDING" as ApprovalDecision };
    doc.approvals.l0 = { decision: "PENDING" as ApprovalDecision };

    const body = (req as any).body || {};
    doc.history = ensureArray(doc.history);
    doc.history.push(pushHistory((req as AuthedReq).user || {}, "SUBMITTED", normStr(body?.note || "")));

    await doc.save();
    if (doc.requestId) await safeAdvanceStage(doc.requestId, "PROPOSAL_SUBMITTED", { workspaceId: (req as any).workspaceId });

    // Build email action tokens
    const sign = signEmailActionTokenAny as any;

    const approveToken = await sign({
      proposalId: String(doc._id),
      action: "approve",
      role: "L2",
      email: l2Email,
    });

    const declineToken = await sign({
      proposalId: String(doc._id),
      action: "decline",
      role: "L2",
      email: l2Email,
    });

    const holdToken = await sign({
      proposalId: String(doc._id),
      action: "hold",
      role: "L2",
      email: l2Email,
    });

    const approveUrl = buildEmailActionUrl(approveToken);
    const declineUrl = buildEmailActionUrl(declineToken);
    const holdUrl = buildEmailActionUrl(holdToken);

    const reqCode = getPublicRequestCode(ar);
    const summaryHtml = buildProposalSummaryHtml(doc);

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:720px;">
        <div style="font-size:18px;font-weight:800;margin-bottom:6px;">PlumTrips HRMS — Proposal Approval</div>
        <div style="color:#666;margin-bottom:14px;">Request: <b>${reqCode || String(doc.requestId || "")}</b></div>

        ${summaryHtml}

        <div style="margin-top:16px;">
          ${buttonHtml("Approve", approveUrl, "green")}
          ${buttonHtml("Reject", declineUrl, "red")}
          ${buttonHtml("Hold", holdUrl, "gray")}
        </div>

        <div style="color:#666;font-size:12px;margin-top:14px;">
          If you didn’t request this email, you can ignore it.
        </div>
      </div>
    `;

    // Send email (signature may vary; we call as any)
    try {
      const sendMail = sendMailAny as any;
      const toList = Array.from(new Set([l2Email, ...ensureArray(l0Emails)].filter(Boolean)));

const attachments = buildPdfAttachmentsForEmail(doc, 10);

await sendMail({
  to: toList,
  subject: `Proposal Approval Needed — ${reqCode || "Request"}`,
  html,
  attachments,
});


    } catch (e) {
      // Do not fail submit if SMTP misconfigured; you can enforce later if needed.
      doc.history = ensureArray(doc.history);
      doc.history.push(pushHistory((req as AuthedReq).user || {}, "EMAIL_SEND_FAILED", String((e as any)?.message || e)));
      await doc.save();
    }

    const enriched = await enrichProposalsWithRequestData([doc.toObject()]);
    return res.json({ ok: true, proposal: enriched[0], emailedTo: l2Email });
  } catch (err) {
    next(err);
  }
});

/* ───────────────────────── Attachments (PDF) ─────────────────────────
 * FIX:
 * - support multiple uploads
 * - accept both field names: `file` (single) and `files` (multi)
 * - endpoint: POST /:id/options/:optionNo/attachments
 * - keep old endpoint /attachment for backward compatibility
 */

const uploadOptionAttachmentsMiddleware: RequestHandler = (req, res, next) => {
  // Accept either:
  // - single("file")
  // - array("files")
  // - or any() for flexible compatibility
  proposalUpload.any()(req as any, res as any, (err: any) => {
    if (err) {
      return res.status(Number(err?.statusCode) || 400).json({ error: String(err?.message || "Upload failed") });
    }
    next();
  });
};

function extractUploadedFiles(req: Request): Array<{ filename: string; originalname: string }> {
  const anyReq = req as any;
  const out: Array<{ filename: string; originalname: string }> = [];

  // multer.any() => req.files[]
  const filesArr = ensureArray<any>(anyReq.files);
  for (const f of filesArr) {
    if (f?.filename) out.push({ filename: f.filename, originalname: f.originalname || f.filename });
  }

  // legacy single => req.file
  if (anyReq.file?.filename) {
    out.push({ filename: anyReq.file.filename, originalname: anyReq.file.originalname || anyReq.file.filename });
  }

  return out;
}

// New multi-upload endpoint
router.post(
  "/:id/options/:optionNo/attachments",
  requireAnyAuth,
  requireStaff,
  uploadOptionAttachmentsMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      setNoStore(res);

      const id = String(req.params.id || "");
      const optionNo = Number(req.params.optionNo);
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid proposal id" });
      if (!Number.isFinite(optionNo) || optionNo <= 0) return res.status(400).json({ error: "Invalid optionNo" });

      const files = extractUploadedFiles(req);
      if (!files.length) return res.status(400).json({ error: "At least one PDF file is required" });

      const doc: any = await scopedFindById(Proposal, id, (req as any).workspaceId);
      if (!doc) return res.status(404).json({ error: "Proposal not found" });

      const st = String(doc.status || "").toUpperCase();
      if (!["DRAFT", "SUBMITTED", "APPROVED"].includes(st)) {
        return res.status(400).json({ error: "Cannot upload attachments in current proposal status" });
      }

      doc.options = ensureArray(doc.options);
      const opt = doc.options.find((o: any) => Number(o.optionNo || 0) === optionNo);
      if (!opt) return res.status(404).json({ error: `Option ${optionNo} not found` });

      opt.attachments = ensureArray(opt.attachments);

      const addedUrls: string[] = [];

      for (const f of files) {
        const relFromUploads = path.posix.join("proposals", id, f.filename);
        const url = buildAttachmentPublicUrl(relFromUploads);
        opt.attachments.push(url);
        addedUrls.push(url);

        doc.history = ensureArray(doc.history);
        doc.history.push(
          pushHistory(
            (req as AuthedReq).user || {},
            "OPTION_ATTACHMENT_UPLOADED",
            `Option ${optionNo}: ${f.originalname}`
          )
        );
      }

      doc.markModified("options");
      await doc.save();

      return res.json({ ok: true, added: addedUrls, attachments: opt.attachments });
    } catch (err) {
      next(err);
    }
  }
);

// Backward compatible single endpoint (kept)
router.post(
  "/:id/options/:optionNo/attachment",
  requireAnyAuth,
  requireStaff,
  uploadOptionAttachmentsMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // delegate to new handler semantics but return single url for old clients
      setNoStore(res);

      const id = String(req.params.id || "");
      const optionNo = Number(req.params.optionNo);
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid proposal id" });
      if (!Number.isFinite(optionNo) || optionNo <= 0) return res.status(400).json({ error: "Invalid optionNo" });

      const files = extractUploadedFiles(req);
      if (!files.length) return res.status(400).json({ error: "File is required" });

      const doc: any = await scopedFindById(Proposal, id, (req as any).workspaceId);
      if (!doc) return res.status(404).json({ error: "Proposal not found" });

      const st = String(doc.status || "").toUpperCase();
      if (!["DRAFT", "SUBMITTED", "APPROVED"].includes(st)) {
        return res.status(400).json({ error: "Cannot upload attachments in current proposal status" });
      }

      doc.options = ensureArray(doc.options);
      const opt = doc.options.find((o: any) => Number(o.optionNo || 0) === optionNo);
      if (!opt) return res.status(404).json({ error: `Option ${optionNo} not found` });

      opt.attachments = ensureArray(opt.attachments);

      const first = files[0];
      const relFromUploads = path.posix.join("proposals", id, first.filename);
      const url = buildAttachmentPublicUrl(relFromUploads);

      opt.attachments.push(url);

      doc.history = ensureArray(doc.history);
      doc.history.push(
        pushHistory((req as AuthedReq).user || {}, "OPTION_ATTACHMENT_UPLOADED", `Option ${optionNo}: ${first.originalname}`)
      );

      doc.markModified("options");
      await doc.save();

      return res.json({ ok: true, url });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Booking attachment (kept single; can be extended same way if needed)
 */
router.post(
  "/:id/booking/attachment",
  requireAnyAuth,
  requireStaff,
  (req: Request, res: Response, next: NextFunction) => {
    proposalUpload.single("file")(req as any, res as any, (err: any) => {
      if (err) {
        return res.status(Number(err?.statusCode) || 400).json({ error: String(err?.message || "Upload failed") });
      }
      next();
    });
  },
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      setNoStore(res);

      const id = String(req.params.id || "");
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid proposal id" });

      const file = (req as any).file as { filename: string; originalname: string } | undefined;
      if (!file) return res.status(400).json({ error: "File is required" });

      const doc: any = await scopedFindById(Proposal, id, (req as any).workspaceId);
      if (!doc) return res.status(404).json({ error: "Proposal not found" });

      if (String(doc.status || "") !== "APPROVED") {
        return res.status(400).json({ error: "Booking attachments allowed only when proposal is APPROVED" });
      }

      doc.booking = doc.booking || { status: "NOT_STARTED", attachments: [] };
      const b = String(doc.booking.status || "NOT_STARTED").toUpperCase();
      if (!["IN_PROGRESS", "DONE"].includes(b)) {
        return res.status(400).json({ error: "Upload allowed only when booking is IN_PROGRESS or DONE" });
      }

      const relFromUploads = path.posix.join("proposals", id, file.filename);
      const url = buildAttachmentPublicUrl(relFromUploads);

      doc.booking.attachments = ensureArray(doc.booking.attachments);
      doc.booking.attachments.push(url);

      doc.history = ensureArray(doc.history);
      doc.history.push(pushHistory((req as AuthedReq).user || {}, "BOOKING_ATTACHMENT_UPLOADED", file.originalname));

      doc.markModified("booking");
      await doc.save();

      return res.json({ ok: true, url });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/proposals/:id/decide (existing UI decisions)
 */
router.post("/:id/decide", requireAnyAuth, requireProposalViewer, requireTravelMode("APPROVAL_FLOW"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    setNoStore(res);

    const aReq = req as AuthedReq;
    if (!isStaffAdmin(aReq.user) && !ensureArray(aReq._proposalMyRoles).length) {
      return res.status(403).json({ error: "Only assigned approvers can decide proposals" });
    }

    const id = String(req.params.id || "");
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid proposal id" });

    const body = (req as any).body || {};
    const decisionRaw = String(body?.decision || "").trim().toUpperCase();
    const roleRaw = String(body?.role || "").trim().toUpperCase();
    const comment = normStr(body?.comment || body?.note || "");

    if (!["APPROVED", "DECLINED"].includes(decisionRaw)) return res.status(400).json({ error: "Invalid decision" });
    if (!["L2", "L0"].includes(roleRaw)) return res.status(400).json({ error: "Invalid role" });

    if (!isStaffAdmin(aReq.user)) {
      const myRoles = ensureArray(aReq._proposalMyRoles);
      if (!myRoles.includes(roleRaw as RoleForProposal)) {
        return res.status(403).json({ error: "You are not assigned to this approval role" });
      }
    }

    const doc: any = await scopedFindById(Proposal, id, (req as any).workspaceId);
    if (!doc) return res.status(404).json({ error: "Proposal not found" });
    if (String(doc.status || "") !== "SUBMITTED") return res.status(400).json({ error: "Only SUBMITTED proposals can be decided" });

    let ar: any = null;
    if (doc.requestId) ar = await ApprovalRequest.findOne({ _id: doc.requestId, workspaceId: (req as any).workspaceId }).lean();

    const needL0 = requiresL0Approval(ar, doc);

    doc.approvals = doc.approvals || {};
    doc.approvals.l2 = doc.approvals.l2 || { decision: "PENDING" as ApprovalDecision };
    doc.approvals.l0 = doc.approvals.l0 || { decision: "PENDING" as ApprovalDecision };

    const byEmail = normEmail(aReq.user?.email);
    const byName = normStr(aReq.user?.name || aReq.user?.firstName || "");

    const key = roleRaw === "L2" ? "l2" : "l0";
    doc.approvals[key] = {
      decision: decisionRaw as ApprovalDecision,
      at: new Date(),
      byEmail,
      byName,
      comment,
    };

    doc.history = ensureArray(doc.history);
    doc.history.push(pushHistory(aReq.user || {}, `${roleRaw}_${decisionRaw}`, comment));

    const l2 = String(doc.approvals?.l2?.decision || "PENDING").toUpperCase();
    const l0 = String(doc.approvals?.l0?.decision || "PENDING").toUpperCase();

    const shouldDecline = l2 === "DECLINED" || (needL0 && l0 === "DECLINED");

    if (shouldDecline) {
      doc.status = "DECLINED" as ProposalStatus;
      await doc.save();
      if (doc.requestId) await safeAdvanceStage(doc.requestId, "PROPOSAL_DECLINED", { workspaceId: (req as any).workspaceId });

      const enriched = await enrichProposalsWithRequestData([doc.toObject()]);
      return res.json({ ok: true, proposal: enriched[0], needL0 });
    }

    const fullyApproved = l2 === "APPROVED" && (!needL0 || l0 === "APPROVED");
    if (fullyApproved) {
      doc.status = "APPROVED" as ProposalStatus;
      await doc.save();
      if (doc.requestId) await safeAdvanceStage(doc.requestId, "PROPOSAL_APPROVED", { workspaceId: (req as any).workspaceId });

      const enriched = await enrichProposalsWithRequestData([doc.toObject()]);
      return res.json({ ok: true, proposal: enriched[0], needL0 });
    }

    await doc.save();
    const enriched = await enrichProposalsWithRequestData([doc.toObject()]);
    return res.json({ ok: true, proposal: enriched[0], needL0 });
  } catch (err) {
    next(err);
  }
});

/**
 * ✅ POST /api/proposals/:id/action (customer action)
 */
router.post("/:id/action", requireAnyAuth, requireProposalViewer, requireTravelMode("APPROVAL_FLOW"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    setNoStore(res);

    const aReq = req as AuthedReq;
    if (!aReq._proposalIsOwner && !isStaffAdmin(aReq.user)) {
      return res.status(403).json({ error: "Only request owner can take customer action" });
    }

    const id = String(req.params.id || "");
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid proposal id" });

    const body = (req as any).body || {};
    const action = String(body?.action || "").trim().toLowerCase() as CustomerProposalAction;
    const note = normStr(body?.note || "");

    if (!["accept", "reject", "needs_changes"].includes(action)) return res.status(400).json({ error: "Invalid action" });

    const doc: any = await scopedFindById(Proposal, id, (req as any).workspaceId);
    if (!doc) return res.status(404).json({ error: "Proposal not found" });

    const st = String(doc.status || "").toUpperCase();
    if (!["SUBMITTED", "APPROVED", "DECLINED"].includes(st)) {
      return res.status(400).json({ error: "Customer action not allowed in current proposal status" });
    }

    doc.customer = doc.customer || {};
    doc.customer.action = action;
    doc.customer.note = note;
    doc.customer.at = new Date();
    doc.customer.byEmail = normEmail(aReq.user?.email);
    doc.customer.byName = normStr(aReq.user?.name || aReq.user?.firstName || "");

    doc.history = ensureArray(doc.history);
    doc.history.push(pushHistory(aReq.user || {}, `CUSTOMER_${action.toUpperCase()}`, note));

    doc.markModified("customer");
    await doc.save();

    const enriched = await enrichProposalsWithRequestData([doc.toObject()]);
    return res.json({ ok: true, proposal: enriched[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/proposals/:id
 * Keep LAST.
 */
router.get("/:id", requireAnyAuth, requireProposalViewer, async (req: Request, res: Response, next: NextFunction) => {
  try {
    setNoStore(res);

    const id = String(req.params.id || "");
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid proposal id" });

    const p = await Proposal.findOne({ _id: id, workspaceId: (req as any).workspaceId }).lean();
    if (!p) return res.status(404).json({ error: "Proposal not found" });

    const aReq = req as AuthedReq;
    const myRoles = isStaffAdmin(aReq.user) ? (["L2", "L0"] as RoleForProposal[]) : ensureArray(aReq._proposalMyRoles);
    const isOwner = Boolean(aReq._proposalIsOwner);

    const enrichedList = await enrichProposalsWithRequestData([{ ...(p as any) }]);
    const enriched = enrichedList[0] || (p as any);

    return res.json({
      ok: true,
      proposal: {
        ...(enriched as any),
        _myRoles: myRoles,
        _isOwner: isOwner,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
