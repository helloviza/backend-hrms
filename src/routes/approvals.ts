// apps/backend/src/routes/approvals.ts
import { Router } from "express";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import multer from "multer";
import { requireAuth } from "../middleware/auth.js";

import ApprovalRequest from "../models/ApprovalRequest.js";
import MasterData from "../models/MasterData.js";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import CustomerMember from "../models/CustomerMember.js";

import { sendMail } from "../utils/mailer.js";
import {
  signEmailActionToken,
  verifyEmailActionToken,
} from "../utils/emailActionToken.js";

import {
  AnyObj,
  EmailAction,
  DISABLE_EMAILS,
  applyLeaderScopeIfNeeded,
  assertEmailAction,
  buildEmailUiActionUrl,
  emailUiPath,
  exactIRegex,
  escapeRegExp,
  frontendBaseUrl,
  getEmailDomain,
  hydrateUserFromDb,
  isManagerOrLeaderOfRequest,
  isOwnerOfRequest,
  isStaffAdmin,
  isValidObjectId,
  normEmail,
  normStr,
  normalizeAction,
  normalizeList,
  parseBool,
  requireApprovalsAdminRead,
  requireApprovalsAdminWrite,
  setNoStore,
  uniqEmails,
  collectRoles,
} from "./approvals.security.js";

import {
  buildAdminProcessedEmailHtml,
  buildApproverEmailHtml,
  buildLeaderFyiHtml,
  buildRequesterApprovedHtml,
  buildEmailAttachmentsFromMeta,
  sanitizeAdminCommentForEmail,
  sumBookingAmount,
  pickTripSummary,
  getItemBookingAmount,
  getItemEstimate,
  moneyINR,
  escapeHtml,
} from "./approvals.email.js";

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
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") return cb(null, true);
    const err: any = new Error("Only PDF files are allowed");
    err.statusCode = 400;
    return cb(err, false);
  },
});

/* ────────────────────────────────────────────────────────────────
 * Workspace helpers
 * ──────────────────────────────────────────────────────────────── */

async function resolveCustomerWorkspaceByAnyId(customerId: string) {
  const raw = String(customerId || "").trim();
  if (!raw) return null;

  const byCustomerId = await CustomerWorkspace.findOne({ customerId: raw }).lean().exec();
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
    approverEmail = leaderEmails[0] || "";
  }

  if (!approverEmail && leaderEmails.includes(normEmail(actorEmail))) {
    approverEmail = normEmail(actorEmail);
  }

  return { ws, approverEmail, leaderEmails };
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
      adminState: adminStateIn([null, "", "pending", "assigned", "in_progress", "on_hold"]),
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
        adminState: adminStateIn([null, "", "pending", "assigned", "in_progress", "on_hold"]),
      };
    } else if (adminStateRaw === "assigned") {
      filter = { status: "approved", adminState: "assigned" };
    } else if (adminStateRaw === "in_progress") {
      filter = { status: "approved", adminState: "in_progress" };
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
      customerName = normStr((ws as any).name || (ws as any).displayName || "") || "Workspace";
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

    const mgrUser: any = await User.findOne({ email: exactIRegex(approverEmail) }).lean().exec();

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
      stage: "REQUEST_RAISED",
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

    const tokenApprove = signEmailActionToken({
      rid: String(doc._id),
      approverEmail,
      action: "approved",
    });
    const tokenDecline = signEmailActionToken({
      rid: String(doc._id),
      approverEmail,
      action: "declined",
    });
    const tokenHold = signEmailActionToken({
      rid: String(doc._id),
      approverEmail,
      action: "on_hold",
    });

    const approveUrl = buildEmailUiActionUrl(tokenApprove, "approved");
    const declineUrl = buildEmailUiActionUrl(tokenDecline, "declined");
    const holdUrl = buildEmailUiActionUrl(tokenHold, "on_hold");

    const subject = `Approval Needed — ${customerName}${doc.ticketId ? ` (${doc.ticketId})` : ""}`;

    try {
      if (!DISABLE_EMAILS) {
        await sendMail({
          kind: "REQUESTS",
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
            kind: "REQUESTS",
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

    // sanitize on response for non-admin
    const safeRows = rows.map((r: any) =>
      isStaffAdmin(req.user) ? r : JSON.parse(JSON.stringify(r)),
    );
    res.json({ rows: safeRows });
  } catch (err) {
    next(err);
  }
});

router.get("/requests/inbox", requireAuth, async (req: AnyObj, res, next) => {
  try {
    const email = normEmail(req.user?.email);

    const rows = await ApprovalRequest.find({
      $and: [
        {
          status: "pending",
          stage: { $in: ["REQUEST_RAISED", "REQUEST_ON_HOLD"] },
        },
        {
          $or: [{ managerEmail: exactIRegex(email) }, { "meta.ccLeaders": exactIRegex(email) }],
        },
      ],
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean()
      .exec();

    const safeRows = rows.map((r: any) =>
      isStaffAdmin(req.user) ? r : JSON.parse(JSON.stringify(r)),
    );
    res.json({ rows: safeRows });
  } catch (err) {
    next(err);
  }
});

router.get("/requests/:id", requireAuth, async (req: AnyObj, res, next) => {
  try {
    const id = String(req.params.id || "");
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const doc: any = await ApprovalRequest.findById(id).lean().exec();
    if (!doc) return res.status(404).json({ error: "Request not found" });

    const user = req.user;
    const canView =
      isStaffAdmin(user) || isOwnerOfRequest(doc, user) || isManagerOrLeaderOfRequest(doc, user);

    if (!canView) return res.status(403).json({ error: "Not allowed" });

    res.json({ ok: true, request: doc });
  } catch (err) {
    next(err);
  }
});

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
    const stage = String(doc.stage || "").toUpperCase();

    const editable =
      status === "pending" && (stage === "REQUEST_RAISED" || stage === "REQUEST_ON_HOLD" || !stage);

    if (!editable) {
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

    if (!["approved", "declined", "on_hold", "resend_email"].includes(String(action))) {
      return res.status(400).json({ error: "Invalid action" });
    }

    const doc: any = await ApprovalRequest.findById(id);
    if (!doc) return res.status(404).json({ error: "Request not found" });

    // resend logic (unchanged)
    if (action === "resend_email") {
      if (!isOwnerOfRequest(doc, req.user) && !isStaffAdmin(req.user)) {
        return res.status(403).json({ error: "Only requester can resend approval email" });
      }

      const st = String(doc.status || "").toLowerCase();
      const stageNow = String(doc.stage || "").toUpperCase();
      const canResend =
        st === "pending" && (stageNow === "REQUEST_RAISED" || stageNow === "REQUEST_ON_HOLD" || !stageNow);

      if (!canResend) {
        return res.status(400).json({ error: "Resend allowed only in Pending / On Hold stage" });
      }

      const approverEmail = normEmail(doc.managerEmail || "");
      if (!approverEmail) {
        return res.status(400).json({ error: "Approver email missing on this request" });
      }

      const tokenApprove = signEmailActionToken({
        rid: String(doc._id),
        approverEmail,
        action: "approved",
      });
      const tokenDecline = signEmailActionToken({
        rid: String(doc._id),
        approverEmail,
        action: "declined",
      });
      const tokenHold = signEmailActionToken({
        rid: String(doc._id),
        approverEmail,
        action: "on_hold",
      });

      const approveUrl = buildEmailUiActionUrl(tokenApprove, "approved");
      const declineUrl = buildEmailUiActionUrl(tokenDecline, "declined");
      const holdUrl = buildEmailUiActionUrl(tokenHold, "on_hold");

      const subject = `Approval Needed — ${doc.customerName || "Workspace"}${
        doc.ticketId ? ` (${doc.ticketId})` : ""
      }`;

      try {
        if (!DISABLE_EMAILS) {
          await sendMail({
            kind: "REQUESTS",
            to: approverEmail,
            subject,
            replyTo: normEmail(doc.frontlinerEmail) || undefined,
            html: buildApproverEmailHtml({
              requestId: String(doc._id),
              requesterName: doc.frontlinerName || "User",
              requesterEmail: normEmail(doc.frontlinerEmail),
              customerName: doc.customerName || "Workspace",
              ticketId: doc.ticketId,
              items: Array.isArray(doc.cartItems) ? doc.cartItems : [],
              comments: doc.comments,
              approveUrl,
              declineUrl,
              holdUrl,
            }),
          });
        }

        doc.history = Array.isArray(doc.history) ? doc.history : [];
        doc.history.push({
          action: "resend_email",
          at: new Date(),
          by: sub || "unknown",
          comment: comment || "Approval email resent by requester",
          userEmail: email,
          userName,
        });

        doc.meta = doc.meta || {};
        doc.meta.lastResentAt = new Date().toISOString();
        doc.meta.resendCount = Number(doc.meta.resendCount || 0) + 1;

        await doc.save();
        return res.json({ ok: true, request: doc, message: "Resent approval email" });
      } catch (e) {
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.error("[approvals] resend_email failed", e);
        }
        return res.status(500).json({ error: "Failed to resend approval email" });
      }
    }

    // normal approver action
    if (!exactIRegex(email).test(String(doc.managerEmail || ""))) {
      return res.status(403).json({ error: "Not allowed (not assigned approver)" });
    }

    const statusNow = String(doc.status || "").toLowerCase();
    const stageNow = String(doc.stage || "").toUpperCase();

    const actionable =
      statusNow === "pending" &&
      (stageNow === "REQUEST_RAISED" ||
        stageNow === "REQUEST_ON_HOLD" ||
        stageNow === "" ||
        stageNow === "UNDEFINED");

    if (!actionable) {
      return res.status(400).json({ error: "Request is not actionable" });
    }

    if (action === "on_hold") {
      doc.status = "pending";
    } else {
      doc.status = action;
    }

    if (action === "approved") doc.stage = "PROPOSAL_PENDING";
    if (action === "declined") doc.stage = "REQUEST_DECLINED";
    if (action === "on_hold") doc.stage = "REQUEST_ON_HOLD";

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

    // ✅ Notify requester when approved
    if (action === "approved" && !DISABLE_EMAILS) {
      const requesterEmail = normEmail(doc.frontlinerEmail || "");
      if (requesterEmail) {
        const subject2 = `Approved — moved to Admin Queue — ${doc.customerName || "Workspace"}${
          doc.ticketId ? ` (${doc.ticketId})` : ""
        }`;

        try {
          await sendMail({
            kind: "APPROVALS",
            to: requesterEmail,
            replyTo: email || undefined,
            subject: subject2,
            html: buildRequesterApprovedHtml({
              customerName: doc.customerName || "Workspace",
              ticketId: doc.ticketId,
              requesterName: doc.frontlinerName || "User",
              requesterEmail,
              approverName: doc.approvedByName || userName || doc.managerName,
              approverEmail: email,
              items: Array.isArray(doc.cartItems) ? doc.cartItems : [],
            }),
          });

          doc.history.push({
            action: "l2_approved_email_sent",
            at: new Date(),
            by: sub || "unknown",
            comment: `Approval mail sent to requester: ${requesterEmail}`,
            userEmail: email,
            userName,
          });
          await doc.save();
        } catch (e: any) {
          doc.history.push({
            action: "l2_approved_email_failed",
            at: new Date(),
            by: sub || "unknown",
            comment: `Failed sending approval mail to requester: ${String(e?.message || e)}`,
            userEmail: email,
            userName,
          });
          await doc.save();
        }
      }
    }

    res.json({ ok: true, request: doc, message: "Updated" });
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

router.put(
  "/admin/:id/under-process",
  requireApprovalsAdminWrite,
  async (req: AnyObj, res, next) => {
    try {
      setNoStore(res);

      const id = String(req.params.id || "");
      const { comment } = req.body || {};

      const doc: any = await ApprovalRequest.findById(id);
      if (!doc) return res.status(404).json({ error: "Request not found" });

      const st = String(doc.stage || "").toUpperCase();
      const legacyOk = !st && String(doc.status || "").toLowerCase() === "approved";

      if (!["PROPOSAL_APPROVED", "BOOKING_ON_HOLD", "PROPOSAL_ON_HOLD"].includes(st) && !legacyOk) {
        return res.status(400).json({ error: "Only proposal-approved requests can start booking" });
      }
      if (st === "PROPOSAL_ON_HOLD" && !legacyOk) {
        return res.status(400).json({
          error: "Cannot start booking while proposal is on hold. Approve proposal first.",
        });
      }

      doc.stage = "BOOKING_IN_PROGRESS";
      doc.adminState = "in_progress";

      doc.history = Array.isArray(doc.history) ? doc.history : [];
      doc.history.push({
        action: "admin_under_process",
        at: new Date(),
        by: String(req.user?.sub || req.user?._id || ""),
        comment: String(comment || "").trim() || undefined,
        userEmail: normEmail(req.user?.email),
        userName: req.user?.name || req.user?.firstName || "",
      });

      await doc.save();
      return res.json({ ok: true, request: doc, message: "Marked as under process" });
    } catch (err) {
      next(err);
    }
  },
);

router.put("/admin/:id/done", requireApprovalsAdminWrite, async (req: AnyObj, res, next) => {
  try {
    setNoStore(res);

    const id = String(req.params.id || "");
    const { comment, notifyEmail, bookingAmount, actualBookingPrice } = req.body || {};

    const doc: any = await ApprovalRequest.findById(id);
    if (!doc) return res.status(404).json({ error: "Request not found" });

    if (doc.stage !== "BOOKING_IN_PROGRESS") {
      return res.status(400).json({ error: "Only in-progress bookings can be marked done" });
    }

    const adminSub = String(req.user?.sub || req.user?._id || "");
    const adminEmail = normEmail(req.user?.email);
    const adminName = normStr(req.user?.name || req.user?.firstName || "");

    if (Number.isFinite(Number(bookingAmount))) doc.bookingAmount = Number(bookingAmount);
    if (Number.isFinite(Number(actualBookingPrice))) doc.actualBookingPrice = Number(actualBookingPrice);

    doc.adminState = "done";
    doc.stage = "COMPLETED";

    doc.history = Array.isArray(doc.history) ? doc.history : [];
    doc.history.push({
      action: "admin_done",
      at: new Date(),
      by: adminSub || "unknown",
      comment: String(comment || "").trim() || undefined,
      userEmail: adminEmail,
      userName: adminName,
    });

    await doc.save();

    const shouldNotify =
      notifyEmail === false || notifyEmail === "false" || notifyEmail === 0 || notifyEmail === "0"
        ? false
        : true;

    if (!shouldNotify) {
      doc.history.push({
        action: "admin_notify_skipped",
        at: new Date(),
        by: adminSub || "unknown",
        comment: "NOTIFY_EMAIL not requested",
        userEmail: adminEmail,
        userName: adminName,
      });
      await doc.save();
      return res.json({ ok: true, request: doc, message: "Marked done (notification skipped)" });
    }

    if (DISABLE_EMAILS) {
      doc.history.push({
        action: "admin_notify_skipped",
        at: new Date(),
        by: adminSub || "unknown",
        comment: "DISABLE_EMAILS enabled — skipped admin notification email.",
        userEmail: adminEmail,
        userName: adminName,
      });
      await doc.save();
      return res.json({ ok: true, request: doc, message: "Marked done (emails disabled)" });
    }

    const to = normEmail(doc.frontlinerEmail || "");
    const cc = uniqEmails([
      normEmail(doc.managerEmail || ""),
      ...(Array.isArray(doc?.meta?.ccLeaders) ? doc.meta.ccLeaders : []),
    ]).filter((e) => e && e !== to);

    if (!to) {
      doc.history.push({
        action: "admin_notify_failed",
        at: new Date(),
        by: adminSub || "unknown",
        comment: "Requester email missing; cannot notify.",
        userEmail: adminEmail,
        userName: adminName,
      });
      await doc.save();
      return res.json({ ok: true, request: doc, message: "Marked done (no requester email)" });
    }

    const emailAtts = buildEmailAttachmentsFromMeta(doc);
    const attachmentsForHtml = emailAtts.map((a) => ({ filename: a.filename || "attachment.pdf" }));

    const subject = `Your Booking has been Processed — ${doc.customerName || "Workspace"}${
      doc.ticketId ? ` (${doc.ticketId})` : ""
    }`;

    try {
      const mailPayload: any = {
        kind: "CONFIRMATIONS",
        to,
        cc: cc.length ? cc : undefined,
        subject,
        replyTo: adminEmail || undefined,
        html: buildAdminProcessedEmailHtml({
          customerName: doc.customerName || "Workspace",
          ticketId: doc.ticketId,
          requesterEmail: to,
          processedByEmail: adminEmail,
          processedByName: adminName,
          comment: sanitizeAdminCommentForEmail(comment),
          items: Array.isArray(doc.cartItems) ? doc.cartItems : [],
          bookingAmount: doc.bookingAmount,
          attachments: attachmentsForHtml,
        }),
        attachments: emailAtts.length ? emailAtts : undefined,
      };

      await (sendMail as any)(mailPayload);

      doc.history.push({
        action: "admin_notify_sent",
        at: new Date(),
        by: adminSub || "unknown",
        comment: `Notified: to=${to}${cc.length ? ` cc=${cc.join(",")}` : ""}${
          emailAtts.length ? ` attachments=${emailAtts.length}` : ""
        }`,
        userEmail: adminEmail,
        userName: adminName,
      });
      await doc.save();
    } catch (e: any) {
      doc.history.push({
        action: "admin_notify_failed",
        at: new Date(),
        by: adminSub || "unknown",
        comment: `Notify send failed: ${String(e?.message || e)}`,
        userEmail: adminEmail,
        userName: adminName,
      });
      await doc.save();
    }

    return res.json({ ok: true, request: doc, message: "Marked done" });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/admin/:id/attachment",
  requireApprovalsAdminWrite,
  (req, res, next) => {
    approvalsUpload.single("file")(req as any, res as any, (err: any) => {
      if (err) {
        return res
          .status(Number(err?.statusCode) || 400)
          .json({ error: String(err?.message || "Upload failed") });
      }
      next();
    });
  },
  async (req: AnyObj, res, next) => {
    try {
      setNoStore(res);

      const id = String(req.params.id || "");
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid request id" });
      }

      const file = (req as any).file as
        | { filename: string; originalname: string; mimetype: string; size: number }
        | undefined;

      if (!file) return res.status(400).json({ error: "File is required" });

      const doc: any = await ApprovalRequest.findById(id);
      if (!doc) return res.status(404).json({ error: "Request not found" });

      const base = (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8080}`).replace(
        /\/$/,
        "",
      );
      const safeFile = encodeURIComponent(file.filename);
      const protectedUrl = `${base}/api/approvals/attachments/${safeFile}/download`;
      const relativePath = `/uploads/approvals/${file.filename}`;

      doc.meta = doc.meta || {};
      if (!Array.isArray(doc.meta.attachments)) doc.meta.attachments = [];

      const attachment = {
        kind: "admin_pdf",
        rid: String(doc._id),
        url: protectedUrl,
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

      doc.markModified("meta.attachments");
      doc.markModified("meta");

      await doc.save();

      return res.json({
        ok: true,
        url: protectedUrl,
        attachmentUrl: protectedUrl,
        path: relativePath,
        filename: file.originalname,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get("/attachments/:filename/download", requireAuth, async (req: AnyObj, res, next) => {
  try {
    setNoStore(res);

    const user0 = await hydrateUserFromDb(req.user);
    req.user = user0;

    const filenameRaw = String(req.params.filename || "").trim();
    if (!filenameRaw) return res.status(400).json({ error: "Missing filename" });

    const filename = path.basename(filenameRaw);
    if (filename !== filenameRaw) return res.status(400).json({ error: "Invalid filename" });

    const relativePath = `/uploads/approvals/${filename}`;

    const doc: any = await ApprovalRequest.findOne({
      "meta.attachments.path": relativePath,
    })
      .lean()
      .exec();

    if (!doc) return res.status(404).json({ error: "Attachment not found" });

    const canView =
      isStaffAdmin(req.user) || isOwnerOfRequest(doc, req.user) || isManagerOrLeaderOfRequest(doc, req.user);

    if (!canView) return res.status(403).json({ error: "Not allowed" });

    const filePath = path.join(approvalsUploadRoot, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File missing on server" });
    }

    const atts = Array.isArray(doc?.meta?.attachments) ? doc.meta.attachments : [];
    const found = atts.find((a: any) => String(a?.path || "") === relativePath) || null;
    const downloadName = String(found?.filename || filename);

    res.setHeader("Content-Type", "application/pdf");
    return res.download(filePath, downloadName);
  } catch (err) {
    next(err);
  }
});

/* ────────────────────────────────────────────────────────────────
 * EMAIL ACTION (public)
 * ──────────────────────────────────────────────────────────────── */

router.get("/email/action", async (req: AnyObj, res) => {
  try {
    setNoStore(res);

    const token = String(req.query?.t || req.query?.token || "");
    const action = normalizeAction(req.query?.a || req.query?.action);

    if (!token) return res.status(400).send("Missing token");
    if (!["approved", "declined", "on_hold"].includes(String(action))) {
      return res.status(400).send("Invalid action");
    }

    try {
      verifyEmailActionToken(token);
    } catch {
      return res.status(400).send("Invalid or expired token");
    }

    const base = frontendBaseUrl() || "";
    const uiPath = emailUiPath() || "/approval/email";

    if (base) {
      const url = `${base}${uiPath}?t=${encodeURIComponent(token)}&a=${encodeURIComponent(
        String(action),
      )}`;
      return res.redirect(302, url);
    }

    return res.status(200).type("html").send(`<!doctype html>
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
      Confirm: ${String(action).toUpperCase()}
    </button>
    <div id="msg" style="margin-top:12px;color:#334155;"></div>
  </div>
<script>
  const token = ${JSON.stringify(token)};
  const action = ${JSON.stringify(action)};
  document.getElementById('btn').addEventListener('click', async () => {
    const msg = document.getElementById('msg');
    msg.textContent = 'Submitting...';
    const r = await fetch('./consume', {
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
    const tokenAction = normalizeAction(payload?.action);

    if (!rid || !approverEmail) {
      return res.status(400).json({ error: "Invalid token payload" });
    }

    if (tokenAction && tokenAction !== action) {
      return res.status(400).json({ error: "Token/action mismatch" });
    }

    const doc: any = await ApprovalRequest.findById(rid);
    if (!doc) return res.status(404).json({ error: "Request not found" });

    if (!exactIRegex(approverEmail).test(String(doc.managerEmail || ""))) {
      return res.status(403).json({ error: "Token not valid for this request" });
    }

    const statusNow = String(doc.status || "").toLowerCase();
    const stageNow = String(doc.stage || "").toUpperCase();

    const actionable =
      statusNow === "pending" &&
      (stageNow === "REQUEST_RAISED" ||
        stageNow === "REQUEST_ON_HOLD" ||
        stageNow === "" ||
        stageNow === "UNDEFINED");

    if (!actionable) {
      return res.status(400).json({ error: "Request is not actionable" });
    }

    if (action === "on_hold") {
      doc.status = "pending";
    } else {
      doc.status = action;
    }

    if (action === "approved") doc.stage = "PROPOSAL_PENDING";
    if (action === "declined") doc.stage = "REQUEST_DECLINED";
    if (action === "on_hold") doc.stage = "REQUEST_ON_HOLD";

    if (action === "approved") doc.adminState = "pending";
    if (action === "declined") doc.adminState = "cancelled";
    if (action === "on_hold") doc.adminState = "on_hold";

    doc.approvedByEmail = approverEmail;
    doc.approvedByName = doc.approvedByName || doc.managerName || "Approver";

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

    // notify requester if approved via email link
    if (action === "approved" && !DISABLE_EMAILS) {
      const requesterEmail = normEmail(doc.frontlinerEmail || "");
      if (requesterEmail) {
        const subject2 = `Approved — moved to Admin Queue — ${doc.customerName || "Workspace"}${
          doc.ticketId ? ` (${doc.ticketId})` : ""
        }`;

        try {
          await sendMail({
            kind: "APPROVALS",
            to: requesterEmail,
            replyTo: approverEmail || undefined,
            subject: subject2,
            html: buildRequesterApprovedHtml({
              customerName: doc.customerName || "Workspace",
              ticketId: doc.ticketId,
              requesterName: doc.frontlinerName || "User",
              requesterEmail,
              approverName: doc.approvedByName || doc.managerName || "Approver",
              approverEmail: approverEmail,
              items: Array.isArray(doc.cartItems) ? doc.cartItems : [],
            }),
          });

          doc.history = Array.isArray(doc.history) ? doc.history : [];
          doc.history.push({
            action: "l2_approved_email_sent",
            at: new Date(),
            by: `email:${approverEmail}`,
            comment: `Approval mail sent to requester: ${requesterEmail}`,
            userEmail: approverEmail,
            userName: doc.managerName || "Approver",
          });
          await doc.save();
        } catch (e: any) {
          doc.history = Array.isArray(doc.history) ? doc.history : [];
          doc.history.push({
            action: "l2_approved_email_failed",
            at: new Date(),
            by: `email:${approverEmail}`,
            comment: `Failed sending approval mail to requester: ${String(e?.message || e)}`,
            userEmail: approverEmail,
            userName: doc.managerName || "Approver",
          });
          await doc.save();
        }
      }
    }

    return res.json({
      ok: true,
      request: doc.toObject(),
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
