// apps/backend/src/routes/approvals.ts
import { Router } from "express";
import mongoose from "mongoose";
import ApprovalRequest from "../models/ApprovalRequest.js";
import MasterData from "../models/MasterData.js";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import CustomerMember from "../models/CustomerMember.js";
import { requireAuth } from "../middleware/auth.js";
import { sendMail } from "../utils/mailer.js";
import {
  signEmailActionToken,
  verifyEmailActionToken,
} from "../utils/emailActionToken.js";

import fs from "fs";
import path from "path";
import multer from "multer";

type AnyObj = Record<string, any>;
type EmailAction = "approved" | "declined" | "on_hold";

const router = Router();

/* ───────────────────────── uploads (PDF attachments) ───────────────────────── */

const approvalsUploadRoot = path.join(process.cwd(), "uploads", "approvals");
if (!fs.existsSync(approvalsUploadRoot)) {
  fs.mkdirSync(approvalsUploadRoot, { recursive: true });
}

const approvalsStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, approvalsUploadRoot),
  filename: (req, file, cb) => {
    const id = String((req as AnyObj).params?.id || "approval");
    const ts = Date.now();
    const safeOriginal = String(file.originalname || "file.pdf").replace(
      /[^a-zA-Z0-9.\-_]+/g,
      "_",
    );
    cb(null, `${id}_${ts}_${safeOriginal}`);
  },
});

const approvalsUpload = multer({
  storage: approvalsStorage,
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are allowed"));
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
function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function exactIRegex(value: string) {
  return new RegExp(`^${escapeRegExp(value)}$`, "i");
}
function isValidObjectId(id: any) {
  return /^[a-fA-F0-9]{24}$/.test(String(id || "").trim());
}
function getEmailDomain(email: string) {
  const e = normEmail(email);
  const at = e.lastIndexOf("@");
  return at >= 0 ? e.slice(at + 1) : "";
}
function parseBool(v: any): boolean {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y" || s === "on";
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
  return roles
    .map((r) => String(r).trim().toUpperCase())
    .filter(Boolean);
}

function isStaffAdmin(u: any): boolean {
  const r = collectRoles(u);
  return (
    r.includes("ADMIN") ||
    r.includes("SUPERADMIN") ||
    r.includes("SUPER_ADMIN") ||
    r.includes("HR_ADMIN") ||
    r.includes("HR")
  );
}

function normalizeList(v: any): string[] {
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

function normalizeAction(v: any): EmailAction | "" {
  const s = String(v || "").trim().toLowerCase();
  if (s === "approved") return "approved";
  if (s === "declined") return "declined";
  if (s === "on_hold" || s === "hold" || s === "on-hold") return "on_hold";
  return "";
}

function assertEmailAction(v: any): EmailAction {
  const a = normalizeAction(v);
  if (a === "approved" || a === "declined" || a === "on_hold") return a;
  const err: any = new Error("Invalid action");
  err.statusCode = 400;
  err.publicMessage = "Invalid action";
  throw err;
}

function publicBaseUrl() {
  return (
    process.env.PUBLIC_BASE_URL ||
    process.env.BACKEND_PUBLIC_URL ||
    `http://localhost:${process.env.PORT || 8080}`
  );
}

/**
 * ✅ Email action links should open FRONTEND page (not backend).
 * Uses:
 *   FRONTEND_PUBLIC_URL + EMAIL_APPROVAL_PATH
 * fallback:
 *   FRONTEND_ORIGIN (first suitable) + EMAIL_APPROVAL_PATH
 * final fallback:
 *   publicBaseUrl() + "/approval/email"
 */
function frontendBaseUrl() {
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

  // prod: pick https origin if possible
  const https = list.find((x) => /^https:\/\//i.test(x));
  return (https || list[0]).replace(/\/$/, "");
}

/**
 * Prevent misconfiguration loops:
 * If EMAIL_APPROVAL_PATH is mistakenly set to backend api path,
 * force it back to a frontend UI route.
 */
function emailUiPath() {
  const raw = normStr(process.env.EMAIL_APPROVAL_PATH || "/approval/email");
  const p = raw.startsWith("/") ? raw : `/${raw}`;
  if (/^\/api\//i.test(p) || /\/api\/approvals/i.test(p)) return "/approval/email";
  return p;
}

function buildEmailUiActionUrl(token: string, action: EmailAction) {
  const base = frontendBaseUrl() || publicBaseUrl();
  return `${base}${emailUiPath()}?t=${encodeURIComponent(token)}&a=${encodeURIComponent(
    action,
  )}`;
}

function setNoStore(res: any) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

/* ────────────────────────────────────────────────────────────────
 * Email templates
 * ──────────────────────────────────────────────────────────────── */
function escapeHtml(v: any) {
  const s = String(v ?? "");
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function moneyINR(v: any) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  try {
    return n.toLocaleString("en-IN");
  } catch {
    return String(n);
  }
}

function firstLine(v: any, max = 180) {
  const s = normStr(v);
  if (!s) return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function buildApproverEmailHtml(opts: {
  requestId: string;
  requesterName: string;
  requesterEmail: string;
  customerName: string;
  ticketId?: string;
  items: any[];
  comments?: string;
  approveUrl: string;
  declineUrl: string;
  holdUrl: string;
}) {
  const brand = "#00477f";
  const accent = "#d06549";

  const requesterName = escapeHtml(opts.requesterName || "User");
  const requesterEmail = escapeHtml(opts.requesterEmail || "");
  const customerName = escapeHtml(opts.customerName || "Workspace");
  const ticketId = escapeHtml(opts.ticketId || "");
  const comments = escapeHtml(opts.comments || "");

  const rows = (Array.isArray(opts.items) ? opts.items : [])
    .map((it) => {
      const title = escapeHtml(normStr(it?.title || it?.type || "Item"));
      const desc = escapeHtml(firstLine(it?.description || ""));
      const qty = it?.qty != null ? escapeHtml(String(it.qty)) : "—";
      const price = it?.price != null ? `₹${escapeHtml(moneyINR(it.price))}` : "—";

      const metaHint = it?.meta ? " • has details" : "";
      const details = desc ? desc : `Requested service${metaHint}`;

      return `
      <tr>
        <td style="padding:12px 12px;border-top:1px solid #eef2f7;">
          <div style="font-size:14px;font-weight:700;color:#0f172a;">${title}</div>
          <div style="margin-top:4px;font-size:12px;line-height:1.45;color:#475569;">${details}</div>
        </td>
        <td align="center" style="padding:12px 10px;border-top:1px solid #eef2f7;font-size:13px;color:#0f172a;">
          ${qty}
        </td>
        <td align="right" style="padding:12px 12px;border-top:1px solid #eef2f7;font-size:13px;color:#0f172a;font-weight:700;">
          ${price}
        </td>
      </tr>
    `;
    })
    .join("");

  const itemsTable = rows
    ? `
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border:1px solid #eef2f7;border-radius:14px;overflow:hidden;">
        <tr>
          <th align="left" style="padding:12px 12px;background:#f8fafc;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#64748b;">Items</th>
          <th align="center" style="padding:12px 10px;background:#f8fafc;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#64748b;">Qty</th>
          <th align="right" style="padding:12px 12px;background:#f8fafc;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#64748b;">Amount</th>
        </tr>
        ${rows}
      </table>
    `
    : `
      <div style="padding:12px 14px;border:1px dashed #e2e8f0;border-radius:14px;color:#64748b;font-size:13px;">
        No items found in this request.
      </div>
    `;

  const commentBlock = comments
    ? `
      <div style="margin-top:14px;padding:12px 14px;border:1px solid #fde6df;background:#fff7f4;border-radius:14px;">
        <div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:${accent};font-weight:800;">Comment</div>
        <div style="margin-top:6px;font-size:13px;line-height:1.55;color:#0f172a;">${comments}</div>
      </div>
    `
    : "";

  return `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Approval Needed</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f7fb;">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f5f7fb;padding:28px 12px;">
      <tr>
        <td align="center">

          <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="width:600px;max-width:600px;">
            <tr>
              <td style="padding:0 6px 12px 6px;">
                <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                  style="background:${brand};border-radius:18px;overflow:hidden;">
                  <tr>
                    <td style="padding:18px 18px 14px 18px;">
                      <div style="font-family:Arial,sans-serif;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.82);font-weight:800;">
                        PlumTrips HRMS
                      </div>
                      <div style="font-family:Arial,sans-serif;font-size:22px;line-height:1.25;color:#ffffff;font-weight:800;margin-top:6px;">
                        Approval Needed
                      </div>
                      <div style="font-family:Arial,sans-serif;font-size:13px;line-height:1.45;color:rgba(255,255,255,.88);margin-top:6px;">
                        Review and take action — this will route the request to Admin after approval.
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td style="height:4px;background:${accent};"></td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:0 6px;">
                <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                  style="background:#ffffff;border:1px solid #e8eef6;border-radius:18px;box-shadow:0 8px 24px rgba(15,23,42,.06);">
                  <tr>
                    <td style="padding:18px 18px 6px 18px;font-family:Arial,sans-serif;">

                      <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                        <tr>
                          <td style="padding:0 0 10px 0;">
                            <span style="display:inline-block;padding:8px 10px;border-radius:999px;background:#f1f5ff;color:${brand};font-size:12px;font-weight:800;">
                              ${customerName}
                            </span>
                            ${
                              ticketId
                                ? `<span style="display:inline-block;margin-left:8px;padding:8px 10px;border-radius:999px;background:#fff7f4;color:${accent};font-size:12px;font-weight:800;">
                                    Ticket: ${ticketId}
                                  </span>`
                                : ""
                            }
                          </td>
                        </tr>
                      </table>

                      <div style="font-size:13px;color:#475569;line-height:1.6;margin-bottom:12px;">
                        <div><span style="color:#0f172a;font-weight:800;">Requested by:</span> ${requesterName} &lt;${requesterEmail}&gt;</div>
                      </div>

                      ${commentBlock}

                      <div style="height:14px;"></div>

                      ${itemsTable}

                      <div style="height:18px;"></div>
                      <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                        <tr>
                          <td align="left" style="padding:0;">
                            <a href="${opts.approveUrl}"
                              style="display:inline-block;text-decoration:none;background:${brand};color:#ffffff;
                                     padding:12px 16px;border-radius:12px;font-size:14px;font-weight:800;font-family:Arial,sans-serif;">
                              Approve
                            </a>
                            <a href="${opts.declineUrl}"
                              style="display:inline-block;text-decoration:none;background:#ffffff;color:#b42318;
                                     padding:12px 16px;border-radius:12px;font-size:14px;font-weight:800;font-family:Arial,sans-serif;
                                     border:1px solid #f2c3be;margin-left:10px;">
                              Reject
                            </a>
                            <a href="${opts.holdUrl}"
                              style="display:inline-block;text-decoration:none;background:#ffffff;color:#334155;
                                     padding:12px 16px;border-radius:12px;font-size:14px;font-weight:800;font-family:Arial,sans-serif;
                                     border:1px solid #e2e8f0;margin-left:10px;">
                              On Hold
                            </a>
                          </td>
                        </tr>
                      </table>

                      <div style="height:16px;"></div>

                      <div style="font-size:12px;line-height:1.55;color:#64748b;">
                        For security, do not forward this email. The action links are intended for the assigned approver only.
                      </div>

                      <div style="height:10px;"></div>
                    </td>
                  </tr>
                </table>

                <div style="padding:14px 6px 0 6px;font-family:Arial,sans-serif;font-size:12px;color:#94a3b8;line-height:1.6;text-align:center;">
                  You’re receiving this because you’re listed as an approver for a PlumTrips HRMS request.
                </div>

              </td>
            </tr>
          </table>

        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
}

function buildLeaderFyiHtml(opts: {
  requesterName: string;
  requesterEmail: string;
  customerName: string;
  ticketId?: string;
  items: any[];
  comments?: string;
}) {
  const brand = "#00477f";
  const accent = "#d06549";

  const requesterName = escapeHtml(opts.requesterName || "User");
  const requesterEmail = escapeHtml(opts.requesterEmail || "");
  const customerName = escapeHtml(opts.customerName || "Workspace");
  const ticketId = escapeHtml(opts.ticketId || "");
  const comments = escapeHtml(opts.comments || "");

  const bullets = (Array.isArray(opts.items) ? opts.items : [])
    .slice(0, 6)
    .map((it) => {
      const title = escapeHtml(normStr(it?.title || it?.type || "Item"));
      const desc = escapeHtml(firstLine(it?.description || "", 90));
      return `<li style="margin:8px 0;color:#0f172a;font-size:13px;line-height:1.5;">
        <b>${title}</b>${desc ? ` — <span style="color:#475569;">${desc}</span>` : ""}
      </li>`;
    })
    .join("");

  return `
  <!doctype html>
  <html>
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
  <body style="margin:0;padding:0;background:#f5f7fb;">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f5f7fb;padding:28px 12px;">
      <tr><td align="center">
        <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="width:600px;max-width:600px;">
          <tr><td style="padding:0 6px 12px 6px;">
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${brand};border-radius:18px;overflow:hidden;">
              <tr><td style="padding:18px;">
                <div style="font-family:Arial,sans-serif;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.82);font-weight:800;">
                  PlumTrips HRMS
                </div>
                <div style="font-family:Arial,sans-serif;font-size:20px;line-height:1.25;color:#fff;font-weight:800;margin-top:6px;">
                  FYI: New Request Submitted
                </div>
                <div style="font-family:Arial,sans-serif;font-size:13px;line-height:1.45;color:rgba(255,255,255,.88);margin-top:6px;">
                  Action buttons are sent only to the assigned approver.
                </div>
              </td></tr>
              <tr><td style="height:4px;background:${accent};"></td></tr>
            </table>
          </td></tr>

          <tr><td style="padding:0 6px;">
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
              style="background:#fff;border:1px solid #e8eef6;border-radius:18px;box-shadow:0 8px 24px rgba(15,23,42,.06);">
              <tr><td style="padding:18px;font-family:Arial,sans-serif;">
                <div style="font-size:12px;color:#64748b;letter-spacing:.04em;text-transform:uppercase;font-weight:800;">
                  Workspace
                </div>
                <div style="font-size:16px;color:#0f172a;font-weight:900;margin-top:6px;">${customerName}</div>

                ${
                  ticketId
                    ? `<div style="margin-top:8px;font-size:13px;color:#475569;"><b style="color:#0f172a;">Ticket:</b> ${ticketId}</div>`
                    : ""
                }

                <div style="margin-top:8px;font-size:13px;color:#475569;">
                  <b style="color:#0f172a;">Requested by:</b> ${requesterName} &lt;${requesterEmail}&gt;
                </div>

                ${
                  comments
                    ? `<div style="margin-top:14px;padding:12px 14px;border:1px solid #fde6df;background:#fff7f4;border-radius:14px;">
                         <div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:${accent};font-weight:800;">Comment</div>
                         <div style="margin-top:6px;font-size:13px;line-height:1.55;color:#0f172a;">${comments}</div>
                       </div>`
                    : ""
                }

                <div style="height:12px;"></div>
                <div style="font-size:12px;color:#64748b;letter-spacing:.04em;text-transform:uppercase;font-weight:800;">Items</div>
                <ul style="padding-left:18px;margin:8px 0;">
                  ${bullets || `<li style="color:#64748b;font-size:13px;">No items</li>`}
                </ul>

                <div style="margin-top:14px;font-size:12px;color:#64748b;line-height:1.55;">
                  This is an FYI notification for leaders.
                </div>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
  </html>
  `;
}

/* ────────────────────────────────────────────────────────────────
 * Workspace helpers
 * ──────────────────────────────────────────────────────────────── */

async function resolveCustomerWorkspaceByAnyId(customerId: string) {
  const raw = String(customerId || "").trim();
  if (!raw) return null;

  const byCustomerId = await CustomerWorkspace.findOne({ customerId: raw })
    .lean()
    .exec();
  if (byCustomerId) return byCustomerId as any;

  if (isValidObjectId(raw)) {
    const byId = await CustomerWorkspace.findById(raw).lean().exec();
    if (byId) return byId as any;
  }

  return null;
}

async function resolveCustomerNameFromMasterData(customerId: string) {
  const raw = String(customerId || "").trim();
  if (!raw) return null;

  if (isValidObjectId(raw)) {
    const doc = await MasterData.findById(raw).lean().exec();
    if (doc) {
      const name =
        normStr((doc as any).businessName) ||
        normStr((doc as any).name) ||
        normStr((doc as any).companyName) ||
        normStr((doc as any)?.payload?.businessName) ||
        normStr((doc as any)?.payload?.name) ||
        "Workspace";
      return { doc, name };
    }
  }
  return null;
}

async function pickApproverEmail(opts: { customerId: string; actorEmail: string }) {
  const { customerId, actorEmail } = opts;

  const ws = await resolveCustomerWorkspaceByAnyId(customerId);
  if (!ws) return { ws: null as any, approverEmail: "", leaderEmails: [] as string[] };

  const wsCustomerId = String(ws.customerId || "").trim() || customerId;

  const leaders = await CustomerMember.find({
    customerId: wsCustomerId,
    role: "WORKSPACE_LEADER",
    isActive: { $ne: false },
  })
    .lean()
    .exec();

  const leaderEmails = leaders.map((m: any) => normEmail(m.email)).filter(Boolean);

  const wsApprovers = (Array.isArray((ws as any).defaultApproverEmails)
    ? (ws as any).defaultApproverEmails
    : normalizeList((ws as any).defaultApproverEmails)
  )
    .map(normEmail)
    .filter(Boolean);

  let approverEmail = wsApprovers[0] || "";

  if (!approverEmail) {
    // fallback to leader as approver
    approverEmail = leaderEmails[0] || "";
  }

  // Absolute last resort (dev safety): if actor is leader, allow self
  if (!approverEmail && leaderEmails.includes(normEmail(actorEmail))) {
    approverEmail = normEmail(actorEmail);
  }

  return { ws, approverEmail, leaderEmails };
}

function isOwnerOfRequest(doc: any, user: any) {
  const sub = String(user?.sub || user?._id || "");
  const email = normEmail(user?.email);
  return (
    String(doc.frontlinerId || "") === sub ||
    exactIRegex(email).test(String(doc.frontlinerEmail || ""))
  );
}

function isManagerOrLeaderOfRequest(doc: any, user: any) {
  const email = normEmail(user?.email);
  if (exactIRegex(email).test(String(doc.managerEmail || ""))) return true;

  const ccLeaders: string[] = normalizeList(doc?.meta?.ccLeaders || []).map(normEmail);
  return ccLeaders.some((e) => exactIRegex(email).test(e));
}

/* ────────────────────────────────────────────────────────────────
 * Admin auth helper for approvals
 * ──────────────────────────────────────────────────────────────── */

const DISABLE_AUTH = parseBool(process.env.DISABLE_AUTH);
const DISABLE_EMAILS = parseBool(process.env.DISABLE_EMAILS);

/**
 * If JWT payload is minimal (sub only), hydrate missing fields from DB.
 * This avoids "leader denied because email/roles missing".
 */
async function hydrateUserFromDb(user: AnyObj | null | undefined): Promise<AnyObj> {
  const u: AnyObj = user ? { ...user } : {};
  const sub = String(u.sub || u._id || u.id || "").trim();
  if (u.email) u.email = normEmail(u.email);

  const rolesNow = collectRoles(u);
  if (u.email && rolesNow.length) return u;

  try {
    let doc: any = null;

    if (sub && isValidObjectId(sub)) {
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

async function resolveLeaderCustomerIds(email: string): Promise<string[]> {
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

/**
 * READ access middleware:
 * - Staff admin: allowed (global view)
 * - Workspace leader: allowed but scoped by customerId(s)
 */
async function requireApprovalsAdminRead(req: AnyObj, res: any, next: any) {
  try {
    if (DISABLE_AUTH) {
      (req as AnyObj).user = {
        sub: "dev-user",
        email: "dev@local",
        roles: ["ADMIN"],
        name: "Dev Admin",
      };
      return next();
    }

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

/**
 * WRITE access middleware (STAFF ONLY)
 */
async function requireApprovalsAdminWrite(req: AnyObj, res: any, next: any) {
  try {
    if (DISABLE_AUTH) {
      (req as AnyObj).user = {
        sub: "dev-user",
        email: "dev@local",
        roles: ["ADMIN"],
        name: "Dev Admin",
      };
      return next();
    }

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
 * Admin queue query helpers
 * ──────────────────────────────────────────────────────────────── */

function adminStateIn(list: Array<string | null>) {
  return { $in: list };
}

function adminQueueFilter(kind: "approved_active" | "pending" | "done" | "rejected") {
  if (kind === "pending") {
    return {
      status: "approved",
      adminState: adminStateIn([null, "", "pending"]),
    };
  }

  if (kind === "approved_active") {
    return {
      status: "approved",
      adminState: adminStateIn([null, "", "pending", "assigned", "on_hold"]),
    };
  }

  if (kind === "done") {
    return {
      status: "approved",
      $or: [{ adminState: "done" }, { "history.action": "admin_done" }],
    };
  }

  return {
    $or: [
      { status: "declined" },
      { adminState: "cancelled" },
      { "meta.revoked": true },
      { "history.action": "admin_cancelled" },
    ],
  };
}

function buildAdminApprovedQueryFromParams(req: AnyObj) {
  const includeClosed = parseBool(req.query?.includeClosed);
  const adminStateRaw = normStr(req.query?.adminState || "").toLowerCase();
  const q = normStr(req.query?.q || "");

  let filter: AnyObj = includeClosed
    ? {
        $or: [
          { status: "approved" },
          { status: "declined" },
          { adminState: "cancelled" },
          { "meta.revoked": true },
          { "history.action": "admin_cancelled" },
        ],
      }
    : { status: "approved" };

  if (adminStateRaw) {
    if (adminStateRaw === "done") {
      filter = {
        status: "approved",
        $or: [{ adminState: "done" }, { "history.action": "admin_done" }],
      };
    } else if (adminStateRaw === "pending") {
      filter = { status: "approved", adminState: adminStateIn([null, "", "pending"]) };
    } else if (adminStateRaw === "active" || adminStateRaw === "open") {
      filter = {
        status: "approved",
        adminState: adminStateIn([null, "", "pending", "assigned", "on_hold"]),
      };
    } else if (adminStateRaw === "assigned") {
      filter = { status: "approved", adminState: "assigned" };
    } else if (adminStateRaw === "on_hold" || adminStateRaw === "hold") {
      filter = { status: "approved", adminState: "on_hold" };
    } else if (adminStateRaw === "cancelled" || adminStateRaw === "canceled") {
      filter = {
        $or: [
          { status: "declined" },
          { adminState: "cancelled" },
          { "meta.revoked": true },
          { "history.action": "admin_cancelled" },
        ],
      };
    } else if (adminStateRaw === "any" || adminStateRaw === "all") {
      filter = includeClosed
        ? {
            $or: [
              { status: "approved" },
              { status: "declined" },
              { adminState: "cancelled" },
              { "meta.revoked": true },
              { "history.action": "admin_cancelled" },
            ],
          }
        : { status: "approved" };
    }
  } else if (!includeClosed) {
    filter = adminQueueFilter("approved_active");
  }

  if (q) {
    const rx = new RegExp(escapeRegExp(q), "i");
    filter = {
      $and: [
        filter,
        {
          $or: [
            { ticketId: rx },
            { customerName: rx },
            { customerId: rx },
            { frontlinerEmail: rx },
            { managerEmail: rx },
            { approvedByEmail: rx },
          ],
        },
      ],
    };
  }

  return { includeClosed, adminState: adminStateRaw, q, filter };
}

function applyLeaderScopeIfNeeded(req: AnyObj, baseFilter: AnyObj) {
  const user = req.user;
  if (isStaffAdmin(user)) return baseFilter;

  const ids: string[] = Array.isArray(req.__leaderCustomerIds) ? req.__leaderCustomerIds : [];
  if (!ids.length) return { $and: [baseFilter, { _id: null }] };

  return { $and: [baseFilter, { customerId: { $in: ids } }] };
}

/* ────────────────────────────────────────────────────────────────
 * L1: Submit approval request
 * POST /api/approvals/requests
 * ──────────────────────────────────────────────────────────────── */

router.post("/requests", requireAuth, async (req: AnyObj, res, next) => {
  try {
    const user = req.user;
    const sub = String(user?.sub || user?._id || "");
    const email = normEmail(user?.email);
    const name = normStr(user?.name || user?.firstName || "");

    const { customerId, cartItems, comments, ticketId } = req.body || {};
    const cid = String(customerId || "").trim();

    if (!cid) return res.status(400).json({ error: "customerId is required" });
    if (!Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({ error: "cartItems is required" });
    }

    const { ws, approverEmail, leaderEmails } = await pickApproverEmail({
      customerId: cid,
      actorEmail: email,
    });

    let customerName = "Workspace";
    let customerEmailDomain = "";
    let finalCustomerId = cid;
    let wsInternalId: string | null = null;

    if (ws) {
      customerName =
        normStr((ws as any).name || (ws as any).displayName || "") || "Workspace";
      customerEmailDomain = leaderEmails[0] ? getEmailDomain(leaderEmails[0]) : "";
      finalCustomerId = String((ws as any).customerId || cid);
      wsInternalId = String((ws as any)._id || "");
    } else {
      const legacy = await resolveCustomerNameFromMasterData(cid);
      if (legacy) {
        customerName = legacy.name;
        customerEmailDomain =
          getEmailDomain(normEmail((legacy.doc as any).email)) ||
          getEmailDomain(normEmail((legacy.doc as any)?.payload?.email));
      }
    }

    if (!approverEmail) {
      return res.status(400).json({
        error:
          "Approver not configured. Please set defaultApproverEmails in customerworkspaces (or ensure a WORKSPACE_LEADER exists).",
        debug:
          process.env.NODE_ENV !== "production"
            ? {
                customerId: cid,
                resolvedWorkspace: Boolean(ws),
                workspaceId: wsInternalId,
                leaders: leaderEmails,
                defaultApproverEmails: ws ? (ws as any).defaultApproverEmails || [] : [],
              }
            : undefined,
      });
    }

    const mgrUser: any = await User.findOne({ email: exactIRegex(approverEmail) })
      .lean()
      .exec();

    const managerId = String(mgrUser?.sub || mgrUser?._id || "");
    const managerName = normStr(mgrUser?.name || mgrUser?.firstName || "") || "Approver";

    const doc: any = await ApprovalRequest.create({
      ticketId: ticketId ? String(ticketId) : undefined,

      customerId: finalCustomerId,
      customerName,
      customerEmailDomain: customerEmailDomain || undefined,

      frontlinerId: sub,
      frontlinerEmail: email,
      frontlinerName: name || undefined,

      managerId: managerId || undefined,
      managerEmail: approverEmail,
      managerName,

      status: "pending",
      cartItems,
      comments: comments ? String(comments) : undefined,

      meta: {
        ...(wsInternalId ? { customerWorkspaceId: wsInternalId } : {}),
        ccLeaders: leaderEmails,
      },

      history: [
        {
          action: "submitted",
          at: new Date(),
          by: sub || "unknown",
          comment: comments ? String(comments).trim() : undefined,
          userEmail: email,
          userName: name,
        },
      ],
    });

    // ✅ Action URLs should open FRONTEND approval page
    const tokenApprove = signEmailActionToken({ rid: String(doc._id), approverEmail });
    const tokenDecline = signEmailActionToken({ rid: String(doc._id), approverEmail });
    const tokenHold = signEmailActionToken({ rid: String(doc._id), approverEmail });

    const approveUrl = buildEmailUiActionUrl(tokenApprove, "approved");
    const declineUrl = buildEmailUiActionUrl(tokenDecline, "declined");
    const holdUrl = buildEmailUiActionUrl(tokenHold, "on_hold");

    const subject = `Approval Needed — ${customerName}${doc.ticketId ? ` (${doc.ticketId})` : ""}`;

    try {
      if (!DISABLE_EMAILS) {
        await sendMail({
          kind: "APPROVALS",
          to: approverEmail,
          subject,
          replyTo: email || undefined,
          html: buildApproverEmailHtml({
            requestId: String(doc._id),
            requesterName: name || "User",
            requesterEmail: email,
            customerName,
            ticketId: doc.ticketId,
            items: cartItems,
            comments: doc.comments,
            approveUrl,
            declineUrl,
            holdUrl,
          }),
        });

        const leaderTargets = leaderEmails
          .map(normEmail)
          .filter((x) => x && x !== normEmail(approverEmail));

        for (const leaderEmail of leaderTargets) {
          await sendMail({
            kind: "APPROVALS",
            to: leaderEmail,
            subject: `FYI — New Request Submitted — ${customerName}`,
            replyTo: email || undefined,
            html: buildLeaderFyiHtml({
              requesterName: name || "User",
              requesterEmail: email,
              customerName,
              ticketId: doc.ticketId,
              items: cartItems,
              comments: doc.comments,
            }),
          });
        }
      } else {
        doc.history = Array.isArray(doc.history) ? doc.history : [];
        doc.history.push({
          action: "email_skipped",
          at: new Date(),
          by: sub || "unknown",
          comment: "DISABLE_EMAILS enabled — skipped sending emails.",
          userEmail: email,
          userName: name,
        });
        await doc.save();
      }
    } catch (_e) {
      doc.history = Array.isArray(doc.history) ? doc.history : [];
      doc.history.push({
        action: "email_failed",
        at: new Date(),
        by: sub || "unknown",
        comment: "Email send failed (non-blocking).",
        userEmail: email,
        userName: name,
      });
      await doc.save();
    }

    res.json({ ok: true, request: doc, message: "Submitted for approval" });
  } catch (err) {
    next(err);
  }
});

/* ────────────────────────────────────────────────────────────────
 * L1: My requests
 * GET /api/approvals/requests/mine
 * ──────────────────────────────────────────────────────────────── */

router.get("/requests/mine", requireAuth, async (req: AnyObj, res, next) => {
  try {
    const sub = String(req.user?.sub || req.user?._id || "");
    const email = normEmail(req.user?.email);

    const rows = await ApprovalRequest.find({
      $or: [{ frontlinerId: sub }, { frontlinerEmail: exactIRegex(email) }],
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean()
      .exec();

    res.json({ rows });
  } catch (err) {
    next(err);
  }
});

/* ────────────────────────────────────────────────────────────────
 * L2: Inbox (Approver + Workspace Leader visibility)
 * GET /api/approvals/requests/inbox
 * ──────────────────────────────────────────────────────────────── */

router.get("/requests/inbox", requireAuth, async (req: AnyObj, res, next) => {
  try {
    const email = normEmail(req.user?.email);

    const rows = await ApprovalRequest.find({
      status: { $in: ["pending", "on_hold"] },
      $or: [{ managerEmail: exactIRegex(email) }, { "meta.ccLeaders": exactIRegex(email) }],
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean()
      .exec();

    res.json({ rows });
  } catch (err) {
    next(err);
  }
});

/* ────────────────────────────────────────────────────────────────
 * L1: Get single request
 * GET /api/approvals/requests/:id
 * ──────────────────────────────────────────────────────────────── */

router.get("/requests/:id", requireAuth, async (req: AnyObj, res, next) => {
  try {
    const id = String(req.params.id || "");
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const doc: any = await ApprovalRequest.findById(id).lean().exec();
    if (!doc) return res.status(404).json({ error: "Request not found" });

    const user = req.user;
    const canView = isStaffAdmin(user) || isOwnerOfRequest(doc, user) || isManagerOrLeaderOfRequest(doc, user);

    if (!canView) return res.status(403).json({ error: "Not allowed" });

    res.json({ ok: true, request: doc });
  } catch (err) {
    next(err);
  }
});

/* ────────────────────────────────────────────────────────────────
 * L1: Edit existing request (owner)
 * PUT /api/approvals/requests/:id
 * ──────────────────────────────────────────────────────────────── */

router.put("/requests/:id", requireAuth, async (req: AnyObj, res, next) => {
  try {
    const id = String(req.params.id || "");
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const doc: any = await ApprovalRequest.findById(id);
    if (!doc) return res.status(404).json({ error: "Request not found" });

    const user = req.user;
    if (!isOwnerOfRequest(doc, user) && !isStaffAdmin(user)) {
      return res.status(403).json({ error: "Only requester can edit this" });
    }

    const status = String(doc.status || "").toLowerCase();
    if (!["pending", "on_hold"].includes(status)) {
      return res.status(400).json({ error: "Only pending / on-hold requests can be edited" });
    }

    const { cartItems, comments } = req.body || {};
    if (!Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({ error: "cartItems is required" });
    }

    const email = normEmail(user?.email);
    const userName = normStr(user?.name || user?.firstName || "");
    const sub = String(user?.sub || user?._id || "");

    doc.cartItems = cartItems;
    if (typeof comments === "string") doc.comments = comments;

    doc.history = Array.isArray(doc.history) ? doc.history : [];
    doc.history.push({
      action: "edited",
      at: new Date(),
      by: sub || "unknown",
      comment: comments ? String(comments).trim() : undefined,
      userEmail: email,
      userName,
    });

    await doc.save();
    res.json({ ok: true, request: doc, message: "Updated" });
  } catch (err) {
    next(err);
  }
});

/* ────────────────────────────────────────────────────────────────
 * L2: Action (approve/decline/on_hold)
 * PUT /api/approvals/requests/:id/action
 * ──────────────────────────────────────────────────────────────── */

router.put("/requests/:id/action", requireAuth, async (req: AnyObj, res, next) => {
  try {
    const id = String(req.params.id || "");
    const sub = String(req.user?.sub || req.user?._id || "");
    const email = normEmail(req.user?.email);
    const userName = normStr(req.user?.name || req.user?.firstName || "");
    const action = normalizeAction(req.body?.action);
    const comment = normStr(req.body?.comment || "") || undefined;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid request id" });
    }
    if (!["approved", "declined", "on_hold"].includes(action)) {
      return res.status(400).json({ error: "Invalid action" });
    }

    const doc: any = await ApprovalRequest.findById(id);
    if (!doc) return res.status(404).json({ error: "Request not found" });

    if (!exactIRegex(email).test(String(doc.managerEmail || ""))) {
      return res.status(403).json({ error: "Not allowed (not assigned approver)" });
    }

    if (!["pending", "on_hold"].includes(String(doc.status))) {
      return res.status(400).json({ error: "Request is not actionable" });
    }

    doc.status = action;
    if (action === "approved") doc.adminState = "pending";
    if (action === "declined") doc.adminState = "cancelled";
    if (action === "on_hold") doc.adminState = "on_hold";

    doc.approvedByEmail = email;
    doc.approvedByName = userName || doc.managerName || "Approver";

    doc.history = Array.isArray(doc.history) ? doc.history : [];
    doc.history.push({
      action,
      at: new Date(),
      by: sub || "unknown",
      comment,
      userEmail: email,
      userName,
    });

    await doc.save();
    res.json({ ok: true, request: doc, message: "Updated" });
  } catch (err) {
    next(err);
  }
});

/* ────────────────────────────────────────────────────────────────
 * L1: Revoke (owner cancels pending/on-hold request)
 * PUT /api/approvals/requests/:id/revoke
 * ──────────────────────────────────────────────────────────────── */

router.put("/requests/:id/revoke", requireAuth, async (req: AnyObj, res, next) => {
  try {
    const id = String(req.params.id || "");
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const doc: any = await ApprovalRequest.findById(id);
    if (!doc) return res.status(404).json({ error: "Request not found" });

    const user = req.user;
    if (!isOwnerOfRequest(doc, user) && !isStaffAdmin(user)) {
      return res.status(403).json({ error: "Only requester can revoke this" });
    }

    const status = String(doc.status || "").toLowerCase();
    if (!["pending", "on_hold"].includes(status)) {
      return res.status(400).json({ error: "Only pending / on-hold requests can be revoked" });
    }

    const email = normEmail(user?.email);
    const userName = normStr(user?.name || user?.firstName || "");
    const sub = String(user?.sub || user?._id || "");
    const comment = normStr(req.body?.comment || "") || "Request revoked by requester";

    doc.status = "declined";
    doc.adminState = "cancelled";
    doc.meta = doc.meta || {};
    doc.meta.revoked = true;

    doc.history = Array.isArray(doc.history) ? doc.history : [];
    doc.history.push({
      action: "revoked",
      at: new Date(),
      by: sub || "unknown",
      comment,
      userEmail: email,
      userName,
    });

    await doc.save();
    res.json({ ok: true, request: doc, message: "Revoked" });
  } catch (err) {
    next(err);
  }
});

/* ────────────────────────────────────────────────────────────────
 * L1: Resubmit (only on_hold)
 * PUT /api/approvals/requests/:id/resubmit
 * ──────────────────────────────────────────────────────────────── */

router.put("/requests/:id/resubmit", requireAuth, async (req: AnyObj, res, next) => {
  try {
    const id = String(req.params.id || "");
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const sub = String(req.user?.sub || req.user?._id || "");
    const email = normEmail(req.user?.email);

    const { cartItems, comment } = req.body || {};
    if (!Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({ error: "cartItems is required" });
    }

    const doc: any = await ApprovalRequest.findById(id);
    if (!doc) return res.status(404).json({ error: "Request not found" });

    const isOwner =
      String(doc.frontlinerId) === sub || exactIRegex(email).test(String(doc.frontlinerEmail || ""));
    if (!isOwner) return res.status(403).json({ error: "Not allowed" });

    if (String(doc.status) !== "on_hold") {
      return res.status(400).json({ error: "Only on-hold requests can be resubmitted" });
    }

    doc.cartItems = cartItems;
    doc.status = "pending";
    doc.adminState = undefined;

    doc.history = Array.isArray(doc.history) ? doc.history : [];
    doc.history.push({
      action: "resubmitted",
      at: new Date(),
      by: sub,
      comment: String(comment || "").trim() || undefined,
      userEmail: email,
      userName: req.user?.name || req.user?.firstName || "",
    });

    await doc.save();
    res.json({ ok: true, request: doc, message: "Resubmitted" });
  } catch (err) {
    next(err);
  }
});

/* ────────────────────────────────────────────────────────────────
 * Admin: queues (READ)
 * ──────────────────────────────────────────────────────────────── */

router.get("/admin/pending", requireApprovalsAdminRead, async (req: AnyObj, res, next) => {
  try {
    setNoStore(res);

    const scoped = applyLeaderScopeIfNeeded(req, adminQueueFilter("pending"));
    const rows = await ApprovalRequest.find(scoped)
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean()
      .exec();

    res.json({ rows });
  } catch (err) {
    next(err);
  }
});

router.get("/admin/approved", requireApprovalsAdminRead, async (req: AnyObj, res, next) => {
  try {
    setNoStore(res);

    const { includeClosed, adminState, q, filter } = buildAdminApprovedQueryFromParams(req);

    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.log("[approvals] /admin/approved user", {
        email: req.user?.email,
        roles: collectRoles(req.user),
        includeClosed,
        adminState,
        q,
        leaderCustomerIds: req.__leaderCustomerIds || undefined,
      });
    }

    const scoped = applyLeaderScopeIfNeeded(req, filter);
    const rows = await ApprovalRequest.find(scoped)
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean()
      .exec();

    res.json({ rows });
  } catch (err) {
    next(err);
  }
});

router.get("/admin/done", requireApprovalsAdminRead, async (req: AnyObj, res, next) => {
  try {
    setNoStore(res);

    const scoped = applyLeaderScopeIfNeeded(req, adminQueueFilter("done"));
    const rows = await ApprovalRequest.find(scoped)
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean()
      .exec();

    res.json({ rows });
  } catch (err) {
    next(err);
  }
});

router.get("/admin/rejected", requireApprovalsAdminRead, async (req: AnyObj, res, next) => {
  try {
    setNoStore(res);

    const scoped = applyLeaderScopeIfNeeded(req, adminQueueFilter("rejected"));
    const rows = await ApprovalRequest.find(scoped)
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean()
      .exec();

    res.json({ rows });
  } catch (err) {
    next(err);
  }
});

/* ────────────────────────────────────────────────────────────────
 * Admin: actions (WRITE — STAFF ONLY)
 * ──────────────────────────────────────────────────────────────── */

router.put("/admin/:id/assign", requireApprovalsAdminWrite, async (req: AnyObj, res, next) => {
  try {
    setNoStore(res);

    const id = String(req.params.id || "");
    const { agentType, agentName, comment } = req.body || {};

    const doc: any = await ApprovalRequest.findById(id);
    if (!doc) return res.status(404).json({ error: "Request not found" });

    doc.adminState = "assigned";
    doc.meta = doc.meta || {};
    doc.meta.adminAssigned = {
      agentType: agentType || "human",
      agentName: String(agentName || "").trim(),
      at: new Date().toISOString(),
    };

    doc.history = Array.isArray(doc.history) ? doc.history : [];
    doc.history.push({
      action: "admin_assigned",
      at: new Date(),
      by: String(req.user?.sub || req.user?._id || ""),
      comment: String(comment || "").trim() || undefined,
      userEmail: normEmail(req.user?.email),
      userName: req.user?.name || req.user?.firstName || "",
    });

    await doc.save();
    res.json({ ok: true, request: doc, message: "Assigned" });
  } catch (err) {
    next(err);
  }
});

router.put("/admin/:id/done", requireApprovalsAdminWrite, async (req: AnyObj, res, next) => {
  try {
    setNoStore(res);

    const id = String(req.params.id || "");
    const { comment } = req.body || {};

    const doc: any = await ApprovalRequest.findById(id);
    if (!doc) return res.status(404).json({ error: "Request not found" });

    doc.adminState = "done";
    doc.history = Array.isArray(doc.history) ? doc.history : [];
    doc.history.push({
      action: "admin_done",
      at: new Date(),
      by: String(req.user?.sub || req.user?._id || ""),
      comment: String(comment || "").trim() || undefined,
      userEmail: normEmail(req.user?.email),
      userName: req.user?.name || req.user?.firstName || "",
    });

    await doc.save();
    res.json({ ok: true, request: doc, message: "Marked done" });
  } catch (err) {
    next(err);
  }
});

router.put("/admin/:id/on-hold", requireApprovalsAdminWrite, async (req: AnyObj, res, next) => {
  try {
    setNoStore(res);

    const id = String(req.params.id || "");
    const { comment } = req.body || {};

    const doc: any = await ApprovalRequest.findById(id);
    if (!doc) return res.status(404).json({ error: "Request not found" });

    doc.adminState = "on_hold";
    doc.history = Array.isArray(doc.history) ? doc.history : [];
    doc.history.push({
      action: "admin_on_hold",
      at: new Date(),
      by: String(req.user?.sub || req.user?._id || ""),
      comment: String(comment || "").trim() || undefined,
      userEmail: normEmail(req.user?.email),
      userName: req.user?.name || req.user?.firstName || "",
    });

    await doc.save();
    res.json({ ok: true, request: doc, message: "Put on hold" });
  } catch (err) {
    next(err);
  }
});

router.put("/admin/:id/cancel", requireApprovalsAdminWrite, async (req: AnyObj, res, next) => {
  try {
    setNoStore(res);

    const id = String(req.params.id || "");
    const { comment } = req.body || {};

    const doc: any = await ApprovalRequest.findById(id);
    if (!doc) return res.status(404).json({ error: "Request not found" });

    doc.adminState = "cancelled";
    doc.history = Array.isArray(doc.history) ? doc.history : [];
    doc.history.push({
      action: "admin_cancelled",
      at: new Date(),
      by: String(req.user?.sub || req.user?._id || ""),
      comment: String(comment || "").trim() || undefined,
      userEmail: normEmail(req.user?.email),
      userName: req.user?.name || req.user?.firstName || "",
    });

    await doc.save();
    res.json({ ok: true, request: doc, message: "Cancelled" });
  } catch (err) {
    next(err);
  }
});

/* ────────────────────────────────────────────────────────────────
 * Admin: upload attachment PDF for a request (WRITE — STAFF ONLY)
 * POST /api/approvals/admin/:id/attachment
 * field name: file (PDF)
 * ──────────────────────────────────────────────────────────────── */

router.post(
  "/admin/:id/attachment",
  requireApprovalsAdminWrite,
  approvalsUpload.single("file"),
  async (req: AnyObj, res, next) => {
    try {
      setNoStore(res);

      const id = String(req.params.id || "");
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid request id" });
      }

      const file = (req as any).file as
        | {
            filename: string;
            originalname: string;
            mimetype: string;
            size: number;
          }
        | undefined;

      if (!file) {
        return res.status(400).json({ error: "File is required" });
      }

      const doc: any = await ApprovalRequest.findById(id);
      if (!doc) return res.status(404).json({ error: "Request not found" });

      const relativePath = `/uploads/approvals/${file.filename}`;
      const base = publicBaseUrl().replace(/\/$/, "");
      const fullUrl = `${base}${relativePath}`;

      doc.meta = doc.meta || {};
      if (!Array.isArray(doc.meta.attachments)) doc.meta.attachments = [];

      const attachment = {
        kind: "admin_pdf",
        url: fullUrl,
        path: relativePath,
        filename: file.originalname,
        mime: file.mimetype,
        size: file.size,
        uploadedAt: new Date().toISOString(),
        uploadedBy: normEmail(req.user?.email),
      };

      doc.meta.attachments.push(attachment);

      doc.history = Array.isArray(doc.history) ? doc.history : [];
      doc.history.push({
        action: "admin_attachment_uploaded",
        at: new Date(),
        by: String(req.user?.sub || req.user?._id || ""),
        userEmail: normEmail(req.user?.email),
        userName: req.user?.name || req.user?.firstName || "",
        comment: `Attachment uploaded: ${file.originalname}`,
      });

      await doc.save();

      return res.json({
        ok: true,
        url: fullUrl,
        attachmentUrl: fullUrl,
        path: relativePath,
        filename: file.originalname,
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ────────────────────────────────────────────────────────────────
 * EMAIL ACTION (public)
 *
 * ✅ Support BOTH:
 * 1) Old links that hit backend:
 *    GET /api/approvals/email/action?t=...&a=approved
 *    -> redirects to frontend UI (or shows a minimal fallback page)
 *
 * 2) Frontend UI posts decision:
 *    POST /api/approvals/email/consume
 * ──────────────────────────────────────────────────────────────── */

router.get("/email/action", async (req: AnyObj, res) => {
  try {
    setNoStore(res);

    const token = String(req.query?.t || req.query?.token || "");
    const action = normalizeAction(req.query?.a || req.query?.action);

    if (!token) return res.status(400).send("Missing token");
    if (!["approved", "declined", "on_hold"].includes(action)) {
      return res.status(400).send("Invalid action");
    }

    // verify token shape early (avoid redirecting junk)
    try {
      verifyEmailActionToken(token);
    } catch {
      return res.status(400).send("Invalid or expired token");
    }

    // Always redirect to FRONTEND UI page (safe, no loops)
    const base = frontendBaseUrl() || "";
    const uiPath = emailUiPath() || "/approval/email";

    if (base) {
      const url = `${base}${uiPath}?t=${encodeURIComponent(token)}&a=${encodeURIComponent(
        action,
      )}`;
      return res.redirect(302, url);
    }

    // Fallback minimal HTML (only if frontend base isn't configured)
    return res
      .status(200)
      .type("html")
      .send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Approval Decision</title>
</head>
<body style="font-family:Arial,sans-serif;background:#f5f7fb;padding:24px;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e8eef6;border-radius:16px;padding:18px;">
    <h2 style="margin:0 0 8px 0;color:#0f172a;">Decision link opened</h2>
    <p style="margin:0 0 14px 0;color:#475569;line-height:1.5;">
      This server doesn’t know your frontend URL. We can still record your decision.
    </p>
    <button id="btn" style="background:#00477f;color:#fff;border:none;border-radius:10px;padding:10px 14px;font-weight:800;cursor:pointer;">
      Confirm: ${action.toUpperCase()}
    </button>
    <div id="msg" style="margin-top:12px;color:#334155;"></div>
  </div>
<script>
  const token = ${JSON.stringify(token)};
  const action = ${JSON.stringify(action)};
  document.getElementById('btn').addEventListener('click', async () => {
    const msg = document.getElementById('msg');
    msg.textContent = 'Submitting...';
    const r = await fetch('/api/approvals/email/consume', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ token, action })
    });
    const j = await r.json().catch(() => ({}));
    msg.textContent = r.ok ? 'Done. You can close this tab.' : (j.error || 'Failed.');
  });
</script>
</body>
</html>`);
  } catch {
    return res.status(500).send("Server error");
  }
});

router.post("/email/consume", async (req: AnyObj, res) => {
  try {
    setNoStore(res);

    const token = String(req.body?.token || "");
    if (!token) return res.status(400).json({ error: "Missing token" });

    const action = assertEmailAction(req.body?.action);
    const comment = String(req.body?.comment || "").trim() || undefined;

    const payload: any = verifyEmailActionToken(token);
    const rid = String(payload?.rid || "");
    const approverEmail = normEmail(payload?.approverEmail || "");

    if (!rid || !approverEmail) {
      return res.status(400).json({ error: "Invalid token payload" });
    }

    const doc: any = await ApprovalRequest.findById(rid);
    if (!doc) return res.status(404).json({ error: "Request not found" });

    if (!exactIRegex(approverEmail).test(String(doc.managerEmail || ""))) {
      return res.status(403).json({ error: "Token not valid for this request" });
    }

    if (!["pending", "on_hold"].includes(String(doc.status))) {
      return res.status(400).json({ error: "Request is not actionable" });
    }

    doc.status = action;
    if (action === "approved") doc.adminState = "pending";
    if (action === "declined") doc.adminState = "cancelled";
    if (action === "on_hold") doc.adminState = "on_hold";

    doc.approvedByEmail = approverEmail;
    doc.approvedByName = doc.managerName || "Approver";

    doc.history = Array.isArray(doc.history) ? doc.history : [];
    doc.history.push({
      action: `email_${action}`,
      at: new Date(),
      by: `email:${approverEmail}`,
      comment,
      userEmail: approverEmail,
      userName: doc.managerName || "Approver",
    });

    await doc.save();
    return res.json({
      ok: true,
      request: doc,
      message: "Decision recorded successfully.",
    });
  } catch (err: any) {
    const code = Number(err?.statusCode) || 500;
    const msg = err?.publicMessage || "Failed to process decision.";
    return res.status(code).json({
      error: msg,
      debug:
        process.env.NODE_ENV !== "production"
          ? { message: String(err?.message || err), stack: err?.stack }
          : undefined,
    });
  }
});

export default router;
