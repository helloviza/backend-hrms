// apps/backend/src/routes/approvals.ts
import { Router } from "express";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import multer from "multer";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { requireTravelMode } from "../middleware/travelModeGuard.js";
import { requireAnyFeature } from "../middleware/requireFeature.js";

import ApprovalRequest from "../models/ApprovalRequest.js";
import MasterData from "../models/MasterData.js";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import CustomerMember from "../models/CustomerMember.js";
import Proposal from "../models/Proposal.js";

import { sendMail } from "../utils/mailer.js";
import {
  applyRequestDecision,
  replyToClarification,
  decisionLinkUrl,
  DecisionError,
} from "../services/approvalDecisions.js";

import { scopedFindById } from "../middleware/scopedFindById.js";

import {
  AnyObj,
  EmailAction,
  DISABLE_EMAILS,
  applyLeaderScopeIfNeeded,
  exactIRegex,
  escapeRegExp,
  frontendBaseUrl,
  getEmailDomain,
  hydrateUserFromDb,
  isManagerOrLeaderOfRequest,
  isOwnerOfRequest,
  isValidObjectId,
  adminQueueAccess,
  stampAdminQueueAccess,
  hasQueueView,
  hasQueueWork,
  queueCaseScope,
  caseInQueueScope,
  normEmail,
  normStr,
  normalizeAction,
  normalizeList,
  parseBool,
  requireApprovalsAdminRead,
  requireApprovalsAdminWrite,
  setNoStore,
  collectRoles,
  sanitizeApprovalForViewer,
  maskPassportsForStaff,
  stripPriceText,
  checkCanRaiseRequest,
} from "./approvals.security.js";
import approvalSearchRouter from "./approvals.search.js";
import travelDeskRouter from "./approvals.travelDesk.js";
import { assignCase, autoAllocate, TravelDeskError, flagNeedsReassignment } from "../services/travelDesk.js";
import ApprovalSelectionSnapshot from "../models/ApprovalSelectionSnapshot.js";
import { markRequestDone, notifyRequesterProgress, latestProposalsFor } from "../services/approvalProgress.js";
import {
  prepareCartSelections,
  writeSelectionSnapshots,
  cartHasOptionRefs,
  SelectionError,
} from "../services/approvalSearch/cartSelections.js";
import {
  prepareCartTravellers,
  loadSelfTraveller,
  TravellerError,
} from "../services/approvalTravellers.js";

import {
  buildApproverEmailHtml,
  buildLeaderFyiHtml,
  buildEmailShell,
  eLabel,
  eCard,
  eRow,
  eBtn,
  sumBookingAmount,
  pickTripSummary,
  getItemBookingAmount,
  getItemEstimate,
  moneyINR,
  escapeHtml,
} from "./approvals.email.js";

async function syncProposalBookingStatus(proposalId: string, status: "IN_PROGRESS" | "DONE") {
  try {
    const proposal: any = await Proposal.findById(proposalId);
    if (!proposal) return;
    proposal.booking = proposal.booking || {};
    proposal.booking.status = status;
    await proposal.save();
  } catch {
    // non-blocking
  }
}

function sendSelectionError(res: any, e: SelectionError) {
  return res.status(e.status).json({ error: e.message, code: e.code, itemIndex: e.itemIndex });
}

/**
 * A one-way flight never carries a return date. The request form's default
 * flight state always held one (today + 8) and sent it even when "One Way"
 * hid the field, so one-way requests showed a Return date (REQ-563ECF).
 */
function withoutOneWayReturnDate(items: any[]): any[] {
  return (Array.isArray(items) ? items : []).map((it: any) => {
    const meta = it?.meta;
    const isFlight = String(it?.type || "").toLowerCase() === "flight";
    const roundTrip = String(meta?.tripType || "").toLowerCase() === "roundtrip";
    if (!isFlight || roundTrip || !meta || !("returnDate" in meta)) return it;
    const { returnDate: _drop, ...rest } = meta;
    void _drop;
    return { ...it, meta: rest };
  });
}

function sendTravellerError(res: any, e: TravellerError) {
  return res.status(e.status).json({ error: e.message, code: e.code, missing: e.missing });
}

/**
 * Lookup for one request. Plumtrips staff work every tenant's requests from
 * one ops queue (the queue lists are already cross-tenant), but their token
 * carries the HOUSE workspace — scoping their lookups to it 404'd every
 * customer request (7ea09c05 fixed this once; 9d16b4e5 re-scoped it). Staff
 * look up by id; anyone else stays inside their own workspace.
 */
function requestFilterFor(req: AnyObj, id: string) {
  if (!hasQueueView(req)) return { _id: id, workspaceId: req.workspaceObjectId };
  const scope = queueCaseScope(req);
  if (!Object.keys(scope).length) return { _id: id };
  // OWN grant: the caller's cases, plus (as for anyone) their own workspace's.
  return { _id: id, $or: [scope, { workspaceId: req.workspaceObjectId }] };
}

/**
 * Lookup for one request on an /admin (queue) route: staff are held to their
 * queue scope (queueCaseScope — an OWN grant reaches only cases assigned to
 * them; anything else is "not found"). Workspace Leaders on the read routes
 * stay inside their own workspace.
 */
function queueCaseFilter(req: AnyObj, id: string) {
  return hasQueueView(req) ? { _id: id, ...queueCaseScope(req) } : { _id: id, workspaceId: req.workspaceObjectId };
}

/**
 * What this router returns for a request: customers through the one
 * sanitiser (no prices, passport last 4); staff keep prices but also get
 * passport last 4 — the full number only via the audited passport-reveal.
 */
function forViewer(doc: any, req: AnyObj) {
  return hasQueueView(req) ? maskPassportsForStaff(doc) : sanitizeApprovalForViewer(doc, req.user);
}

const router = Router();
router.use(requireAuth);
router.use(requireWorkspace);
// Ops queue access (Access Console "Admin Queue" grant, or SUPERADMIN / HOUSE
// ADMIN for oversight), resolved once for every route below.
router.use(stampAdminQueueAccess);
// Flow 2 (approvalFlowEnabled) and Flow 3 (approvalDirectEnabled) share this
// router: request form, search, my requests, inbox, booking history. Which
// flow a route serves is decided per-route by requireTravelMode.
router.use(requireAnyFeature("approvalFlowEnabled", "approvalDirectEnabled"));

// Live TBO search for the request form (price-free). Own gates inside.
router.use("/search", approvalSearchRouter);
// Travel Desk team settings + Assign picker (staff only, own guard inside).
router.use("/travel-desk", travelDeskRouter);

/**
 * The caller's ops-queue access — the ONE rule the queue page, its nav link
 * and every queue API share (adminQueueAccess in approvals.security.ts), so
 * page and API can never disagree. Customers get { view: false, work: false }.
 */
router.get("/queue-access", async (req: AnyObj, res) => {
  setNoStore(res);
  const a = await adminQueueAccess(req);
  res.json({ ok: true, view: a.view, work: a.work, via: a.via, scope: a.scope });
});

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

/**
 * Nobody approves their own request (Flow 2 and Flow 3 alike):
 *   - requester is a Workspace Leader → auto-approved, there is no one above
 *   - requester is the resolved approver → routed to a Workspace Leader
 *   - otherwise → the resolved approver
 * Returns approverEmail "" when the requester is the approver and the
 * workspace has no other leader to route to.
 */
function resolveSubmitRouting(opts: {
  approverEmail: string;
  leaderEmails: string[];
  actorEmail: string;
  actorIsLeader: boolean;
}) {
  const actor = normEmail(opts.actorEmail);
  if (opts.actorIsLeader) {
    return { approverEmail: actor, autoApprove: true, routedToLeader: false };
  }
  if (normEmail(opts.approverEmail) === actor) {
    const leader = opts.leaderEmails.map(normEmail).find((e) => e && e !== actor) || "";
    return { approverEmail: leader, autoApprove: false, routedToLeader: true };
  }
  return { approverEmail: normEmail(opts.approverEmail), autoApprove: false, routedToLeader: false };
}

function hasWorkspaceLeaderRole(user: AnyObj) {
  return (user?.roles || [])
    .map((r: string) => String(r).toUpperCase().replace(/[\s_-]/g, ""))
    .includes("WORKSPACELEADER");
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

router.post("/requests", requireAuth, requireWorkspace, requireTravelMode("APPROVAL_FLOW", "APPROVAL_DIRECT"), async (req: AnyObj, res, next) => {
  try {
    const user = req.user;
    const sub = String(user?.sub || user?._id || "");
    const email = normEmail(user?.email);
    const name = normStr(user?.name || user?.firstName || "");

    // Resolve requester display name — JWT may omit name if token was issued before profile was set
    let requesterDisplayName = name;
    if (!requesterDisplayName && (sub || email)) {
      const dbFrontliner = await User.findOne(
        sub ? { _id: sub } : { email: exactIRegex(email) }
      ).select("name firstName lastName").lean();
      if (dbFrontliner) {
        requesterDisplayName = normStr(
          (dbFrontliner as any).name ||
          [(dbFrontliner as any).firstName || "", (dbFrontliner as any).lastName || ""]
            .filter(Boolean).join(" ")
        );
      }
    }
    if (!requesterDisplayName) requesterDisplayName = email?.split("@")[0] || "User";

    // SBT users must book directly — block approval flow
    // WORKSPACE_LEADER always bypasses SBT/canRaiseRequest restrictions
    const refusal = await checkCanRaiseRequest(req);
    if (refusal) return res.status(refusal.status).json(refusal.body);

    const { customerId, cartItems: rawCartItems, comments, ticketId } = req.body || {};
    const cid = String(customerId || "").trim();

    if (!cid) return res.status(400).json({ error: "customerId is required" });
    if (!Array.isArray(rawCartItems) || rawCartItems.length === 0) {
      return res.status(400).json({ error: "cartItems is required" });
    }

    // Client-sent meta.selection is dropped; meta.optionRef → server-built selection.
    // Self traveller comes from the requester's own profile, never the client.
    let prepared: Awaited<ReturnType<typeof prepareCartSelections>>;
    try {
      prepared = await prepareCartSelections({
        cartItems: await prepareCartTravellers({
          cartItems: withoutOneWayReturnDate(rawCartItems),
          workspaceId: req.workspaceObjectId,
          ownerUserId: sub,
        }),
        userId: sub,
        workspaceId: req.workspaceObjectId,
      });
    } catch (e) {
      if (e instanceof TravellerError) return sendTravellerError(res, e);
      if (e instanceof SelectionError) return sendSelectionError(res, e);
      throw e;
    }
    const { cartItems, snapshots } = prepared;

    const picked = await pickApproverEmail({
      customerId: cid,
      actorEmail: email,
    });
    const { ws, leaderEmails } = picked;

    const routing = resolveSubmitRouting({
      approverEmail: picked.approverEmail,
      leaderEmails,
      actorEmail: email,
      actorIsLeader: leaderEmails.includes(email) || hasWorkspaceLeaderRole(user),
    });
    const approverEmail = routing.approverEmail;
    const isSelfApproval = routing.autoApprove;

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

    if (!approverEmail && routing.routedToLeader) {
      return res.status(400).json({
        error:
          "You are this workspace's approver and there is no Workspace Leader to approve your request. Ask your admin to add a Workspace Leader.",
        code: "NO_APPROVER_ABOVE_REQUESTER",
      });
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

    // Resolve workspace travel flow (requireTravelMode attaches req.workspace)
    const wsTravelFlow =
      (req as any).workspace?.config?.travelFlow ||
      (req as any).workspace?.travelMode ||
      "";
    const isDirectFlow = wsTravelFlow === "APPROVAL_DIRECT";

    const doc: any = await ApprovalRequest.create({
      workspaceId: req.workspaceObjectId,
      ticketId: ticketId ? String(ticketId) : undefined,

      customerId: finalCustomerId,
      customerName,
      customerEmailDomain: customerEmailDomain || undefined,

      frontlinerId: sub,
      frontlinerEmail: email,
      frontlinerName: requesterDisplayName || undefined,

      managerId: managerId || undefined,
      managerEmail: approverEmail,
      managerName,

      status: isSelfApproval ? "approved" : "pending",
      adminState: isSelfApproval ? "pending" : undefined,
      stage: !isSelfApproval ? "REQUEST_RAISED" : isDirectFlow ? "REQUEST_APPROVED" : "PROPOSAL_PENDING",
      cartItems,
      comments: comments ? String(comments) : undefined,

      ...(isSelfApproval
        ? { approvedByEmail: approverEmail, approvedByName: managerName }
        : {}),

      meta: {
        ...(wsInternalId ? { customerWorkspaceId: wsInternalId } : {}),
        ccLeaders: leaderEmails,
        travelFlow: wsTravelFlow || "APPROVAL_FLOW",
        ...(isSelfApproval ? { selfApproved: true, selfApprovedReason: "WL_IS_REQUESTER" } : {}),
        ...(routing.routedToLeader ? { routedToLeaderReason: "REQUESTER_IS_APPROVER" } : {}),
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
        ...(isSelfApproval
          ? [
              {
                action: "approved",
                at: new Date(),
                by: sub || "unknown",
                comment: "Auto-approved — requester is a Workspace Leader (no one above to approve).",
                userEmail: email,
                userName: name,
              },
            ]
          : []),
      ],
    });

    if (snapshots.length) {
      await writeSelectionSnapshots({
        requestId: doc._id,
        workspaceId: req.workspaceObjectId,
        userId: sub,
        snapshots,
        prune: false,
      });
    }

    // Auto-approved (Workspace Leader is the requester) → straight into the
    // ops queue: Travel Desk auto-allocation (never throws).
    if (isSelfApproval) await autoAllocate(String(doc._id));

    // Email decision links: no login, single-use, bound to the approver.
    const approveUrl = decisionLinkUrl("request", String(doc._id), approverEmail, req.workspace || null, "approve");
    const declineUrl = decisionLinkUrl("request", String(doc._id), approverEmail, req.workspace || null, "decline");
    const clarifyUrl = decisionLinkUrl("request", String(doc._id), approverEmail, req.workspace || null, "clarify");

    const subject = `Approval Needed — ${customerName}${doc.ticketId ? ` (${doc.ticketId})` : ""}`;

    try {
      if (!DISABLE_EMAILS) {
        if (!isSelfApproval) {
          await sendMail({
            kind: "REQUESTS",
            to: approverEmail,
            subject,
            replyTo: email || undefined,
            html: buildApproverEmailHtml({
              requestId: String(doc._id),
              requesterName: requesterDisplayName,
              requesterEmail: email,
              customerName,
              ticketId: doc.ticketId,
              items: cartItems,
              comments: doc.comments,
              approveUrl,
              declineUrl,
              clarifyUrl,
            }),
          });
        } else {
          const frontendUrl = (process.env.FRONTEND_ORIGIN || "https://plumbox.plumtrips.com").replace(/\/+$/, "");
          const html = buildEmailShell(
            `${eLabel("Request Auto-Approved")}
             ${eCard(`
               <table cellpadding="0" cellspacing="0" width="100%">
                 ${eRow("Request ID", escapeHtml(doc.ticketId || doc._id.toString()))}
                 ${eRow("Status", "Approved — Sent to Admin Queue")}
                 ${eRow("Travel Flow", escapeHtml(doc.meta?.travelFlow || "—"))}
               </table>
             `)}
             ${eBtn(
               "View My Requests",
               frontendUrl + "/approvals/requests/mine",
               "#10b981",
               "#ffffff"
             )}`,
            {
              title: "Your Request Has Been Approved",
              subtitle: "Your request has been auto-approved and sent to the admin queue for processing.",
              badgeText: "APPROVED",
              badgeColor: "#10b981",
            }
          );
          sendMail({
            kind: "APPROVALS",
            to: normEmail(email),
            subject: `Request Approved — ${doc.ticketId || "New Request"}`,
            html,
          }).catch(() => {});
        }

        const leaderTargets = leaderEmails
          .map(normEmail)
          .filter((x) => x && x !== normEmail(approverEmail) && x !== email);

        for (const leaderEmail of leaderTargets) {
          await sendMail({
            kind: "REQUESTS",
            to: leaderEmail,
            subject: `FYI — New Request Submitted — ${customerName}`,
            replyTo: email || undefined,
            html: buildLeaderFyiHtml({
              requesterName: requesterDisplayName,
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

    res.json({ ok: true, request: forViewer(doc, req), message: "Submitted for approval" });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/approvals/self-traveller — the caller's own traveller details for
 * the request form's read-only "You" card: their claimed profile (My Profile),
 * passport last 4 for customers, plus what is missing. Never the company
 * travellers list.
 */
router.get("/self-traveller", requireAuth, requireWorkspace, async (req: AnyObj, res, next) => {
  try {
    const sub = String(req.user?.sub || req.user?._id || "");
    const result = await loadSelfTraveller(req.workspaceObjectId, sub);
    setNoStore(res);
    res.json({
      ok: true,
      ...result,
      traveller: result.traveller ? forViewer(result.traveller, req) : null,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/requests/mine", requireAuth, requireWorkspace, requireTravelMode("APPROVAL_FLOW", "APPROVAL_DIRECT"), async (req: AnyObj, res, next) => {
  try {
    // SBT users must not access approval flow
    const sbtUser = await User.findOne({ _id: req.user?.sub || req.user?._id, workspaceId: req.workspaceObjectId }).select("sbtEnabled").lean();
    if (sbtUser?.sbtEnabled === true) {
      return res.status(403).json({ error: "SBT users cannot access approval requests.", code: "SBT_USER_CANNOT_ACCESS_APPROVALS" });
    }

    const sub = String(req.user?.sub || req.user?._id || "");
    const email = normEmail(req.user?.email);

    const rows = await ApprovalRequest.find({
      $or: [{ frontlinerId: sub }, { frontlinerEmail: exactIRegex(email) }],
      workspaceId: req.workspaceObjectId,
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean()
      .exec();

    // The latest submitted-or-later proposal per request, so My Requests can
    // link to the requester's read-only proposal view.
    const proposals = await latestProposalsFor(rows.map((r: any) => r._id));
    const safeRows = rows.map((r: any) => ({
      ...forViewer(r, req),
      _proposal: proposals.get(String(r._id)) || undefined,
    }));
    res.json({ rows: safeRows });
  } catch (err) {
    next(err);
  }
});

router.get("/requests/inbox", requireAuth, requireWorkspace, requireTravelMode("APPROVAL_FLOW", "APPROVAL_DIRECT"), async (req: AnyObj, res, next) => {
  try {
    // SBT users must not access approval flow
    const sbtUser = await User.findOne({ _id: req.user?.sub || req.user?._id, workspaceId: req.workspaceObjectId }).select("sbtEnabled").lean();
    if (sbtUser?.sbtEnabled === true) {
      return res.status(403).json({ error: "SBT users cannot access approval inbox.", code: "SBT_USER_CANNOT_ACCESS_APPROVALS" });
    }

    const email = normEmail(req.user?.email);

    // WORKSPACE_LEADER sees all pending requests in their workspace
    const isWLInbox = (req.user?.roles || [])
      .map((r: string) => String(r).toUpperCase().replace(/[\s_-]/g, ""))
      .includes("WORKSPACELEADER");

    // Nobody sees their own request as something to approve.
    const notOwn = { frontlinerEmail: { $not: exactIRegex(email) } };

    const inboxQuery = isWLInbox
      ? {
          status: "pending",
          stage: { $in: ["REQUEST_RAISED", "REQUEST_ON_HOLD"] },
          workspaceId: req.workspaceObjectId,
          ...notOwn,
        }
      : {
          $and: [
            {
              status: "pending",
              stage: { $in: ["REQUEST_RAISED", "REQUEST_ON_HOLD"] },
              workspaceId: req.workspaceObjectId,
              ...notOwn,
            },
            {
              $or: [{ managerEmail: exactIRegex(email) }, { "meta.ccLeaders": exactIRegex(email) }],
            },
          ],
        };

    const rows = await ApprovalRequest.find(inboxQuery)
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean()
      .exec();

    const safeRows = rows.map((r: any) => forViewer(r, req));
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

    const detailQuery = requestFilterFor(req, id);
    const doc: any = await ApprovalRequest.findOne(detailQuery).lean().exec();
    if (!doc) return res.status(404).json({ error: "Request not found" });

    const user = req.user;
    const canView =
      hasQueueView(req) || isOwnerOfRequest(doc, user) || isManagerOrLeaderOfRequest(doc, user);

    if (!canView) return res.status(403).json({ error: "Not allowed" });

    res.json({ ok: true, request: forViewer(doc, req) });
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

    // Staff (Admin Queue) edit any tenant's request; everyone else their own.
    const doc: any = await ApprovalRequest.findOne(requestFilterFor(req, id));
    if (!doc) return res.status(404).json({ error: "Request not found" });

    const user = req.user;
    if (!isOwnerOfRequest(doc, user) && !hasQueueWork(req)) {
      return res.status(403).json({ error: "Only requester can edit this" });
    }

    const status = String(doc.status || "").toLowerCase();
    const stage = String(doc.stage || "").toUpperCase();

    // Also while the approver's question is open: the requester may fix the
    // request before replying (the reply sends it back to the approver).
    const editable =
      status === "pending" &&
      (stage === "REQUEST_RAISED" || stage === "REQUEST_ON_HOLD" || stage === "REQUEST_NEEDS_CLARIFICATION" || !stage);

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

    // Self = the request owner's profile (also when staff edit); masked
    // passports sent back by a customer are restored from the stored request.
    let prepared: Awaited<ReturnType<typeof prepareCartSelections>>;
    try {
      prepared = await prepareCartSelections({
        cartItems: await prepareCartTravellers({
          cartItems: withoutOneWayReturnDate(cartItems),
          workspaceId: doc.workspaceId,
          ownerUserId: String(doc.frontlinerId || ""),
          existingCartItems: JSON.parse(JSON.stringify(doc.cartItems || [])),
        }),
        userId: sub,
        workspaceId: doc.workspaceId,
        requestId: doc._id,
      });
    } catch (e) {
      if (e instanceof TravellerError) return sendTravellerError(res, e);
      if (e instanceof SelectionError) return sendSelectionError(res, e);
      throw e;
    }

    const hadOptionRefs = cartHasOptionRefs(doc.cartItems);
    doc.cartItems = prepared.cartItems;
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
    if (hadOptionRefs || prepared.snapshots.length) {
      await writeSelectionSnapshots({
        requestId: doc._id,
        workspaceId: doc.workspaceId,
        userId: sub,
        snapshots: prepared.snapshots,
        prune: true,
      });
    }
    res.json({ ok: true, request: forViewer(doc, req), message: "Updated" });
  } catch (err) {
    next(err);
  }
});

router.put("/requests/:id/action", requireAuth, requireWorkspace, requireTravelMode("APPROVAL_FLOW", "APPROVAL_DIRECT"), async (req: AnyObj, res, next) => {
  try {
    const id = String(req.params.id || "");
    const sub = String(req.user?.sub || req.user?._id || "");
    const email = normEmail(req.user?.email);
    const userName = normStr(req.user?.name || req.user?.firstName || "");
    const rawAction = String(req.body?.action || "").trim().toLowerCase();
    const action: string = rawAction === "clarify" ? "clarify" : normalizeAction(req.body?.action);
    const comment = normStr(req.body?.comment || "") || undefined;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid request id" });
    }

    if (!["approved", "declined", "clarify", "on_hold", "resend_email"].includes(String(action))) {
      return res.status(400).json({ error: "Invalid action" });
    }

    const doc: any = await ApprovalRequest.findOne({ _id: id, workspaceId: req.workspaceObjectId });
    if (!doc) return res.status(404).json({ error: "Request not found" });

    // Resolve frontliner display name from DB if stored name is missing or was "User"
    let frontlinerDisplayName = normStr(doc.frontlinerName || "");
    if (!frontlinerDisplayName || frontlinerDisplayName === "User") {
      const dbFrontliner = doc.frontlinerId
        ? await User.findById(doc.frontlinerId).select("name firstName lastName").lean()
        : doc.frontlinerEmail
          ? await User.findOne({ email: exactIRegex(normEmail(doc.frontlinerEmail)) }).select("name firstName lastName").lean()
          : null;
      if (dbFrontliner) {
        frontlinerDisplayName = normStr(
          (dbFrontliner as any).name ||
          [(dbFrontliner as any).firstName || "", (dbFrontliner as any).lastName || ""]
            .filter(Boolean).join(" ")
        ) || frontlinerDisplayName;
      }
    }
    if (!frontlinerDisplayName) frontlinerDisplayName = normEmail(doc.frontlinerEmail)?.split("@")[0] || "User";

    // resend logic (unchanged)
    if (action === "resend_email") {
      if (!isOwnerOfRequest(doc, req.user) && !hasQueueWork(req)) {
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

      const approveUrl = decisionLinkUrl("request", String(doc._id), approverEmail, req.workspace || null, "approve");
      const declineUrl = decisionLinkUrl("request", String(doc._id), approverEmail, req.workspace || null, "decline");
      const clarifyUrl = decisionLinkUrl("request", String(doc._id), approverEmail, req.workspace || null, "clarify");

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
              requesterName: frontlinerDisplayName,
              requesterEmail: normEmail(doc.frontlinerEmail),
              customerName: doc.customerName || "Workspace",
              ticketId: doc.ticketId,
              items: Array.isArray(doc.cartItems) ? doc.cartItems : [],
              comments: doc.comments,
              approveUrl,
              declineUrl,
              clarifyUrl,
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
        return res.json({ ok: true, request: forViewer(doc, req), message: "Resent approval email" });
      } catch (e) {
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.error("[approvals] resend_email failed", e);
        }
        return res.status(500).json({ error: "Failed to resend approval email" });
      }
    }

    // Approver decision — the same service the email links use: who may
    // decide is re-checked now, first decision wins, a decline needs a reason.
    let decided: any;
    try {
      decided = await applyRequestDecision({
        requestId: id,
        workspaceId: req.workspaceObjectId,
        actor: { email, name: userName, sub, via: "app" },
        action: action as any,
        reason: comment,
      });
    } catch (e) {
      if (e instanceof DecisionError) {
        return res.status(e.status).json({ error: e.message, code: e.code, ...(e.extra || {}) });
      }
      throw e;
    }

    res.json({ ok: true, request: forViewer(decided, req), message: "Updated" });
  } catch (err) {
    next(err);
  }
});

/* ────────────────────────────────────────────────────────────────
 * Requester answers the approver's question
 * POST /requests/:id/clarification  { reply }
 * The request goes back to the same approver as pending. Edits made while the
 * question was open (PUT /requests/:id) are flagged on the reply.
 * ──────────────────────────────────────────────────────────────── */

router.post("/requests/:id/clarification", requireAuth, requireWorkspace, requireTravelMode("APPROVAL_FLOW", "APPROVAL_DIRECT"), async (req: AnyObj, res, next) => {
  try {
    const id = String(req.params.id || "");
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid request id" });

    const doc: any = await ApprovalRequest.findOne({ _id: id, workspaceId: req.workspaceObjectId }).lean();
    if (!doc) return res.status(404).json({ error: "Request not found" });
    if (!isOwnerOfRequest(doc, req.user)) {
      return res.status(403).json({ error: "Only the requester can reply" });
    }

    const lastQuestionAt = [...(doc.clarifications || [])].reverse().find((c: any) => c?.kind === "question")?.at;
    const edited = (doc.history || []).some(
      (h: any) => h?.action === "edited" && lastQuestionAt && new Date(h.at) > new Date(lastQuestionAt),
    );

    try {
      const updated = await replyToClarification({
        requestId: id,
        workspaceId: req.workspaceObjectId,
        actor: {
          email: normEmail(req.user?.email),
          name: normStr(req.user?.name || req.user?.firstName || ""),
          sub: String(req.user?.sub || req.user?._id || ""),
          via: "app",
        },
        reply: req.body?.reply,
        edited,
      });
      return res.json({ ok: true, request: forViewer(updated, req), message: "Reply sent to your approver" });
    } catch (e) {
      if (e instanceof DecisionError) return res.status(e.status).json({ error: e.message, code: e.code });
      throw e;
    }
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
    const baseFilter = adminQueueFilter("pending");
    const qsWs = String(req.query?.workspaceId || "").trim();
    if (qsWs && mongoose.Types.ObjectId.isValid(qsWs)) (baseFilter as any).workspaceId = new mongoose.Types.ObjectId(qsWs);
    const scoped = applyLeaderScopeIfNeeded(req, baseFilter);
    const rows = await ApprovalRequest.find(scoped)
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean()
      .exec();
    if (hasQueueView(req)) await flagNeedsReassignment(rows as any[]);
    res.json({ rows: rows.map((r: any) => forViewer(r, req)) });
  } catch (err) {
    next(err);
  }
});

router.get("/admin/approved", requireApprovalsAdminRead, async (req: AnyObj, res, next) => {
  try {
    setNoStore(res);

    const { includeClosed, adminState, q, filter } = buildAdminApprovedQueryFromParams(req);
    const qsWs = String(req.query?.workspaceId || "").trim();
    if (qsWs && mongoose.Types.ObjectId.isValid(qsWs)) (filter as any).workspaceId = new mongoose.Types.ObjectId(qsWs);

    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console

    }

    const scoped = applyLeaderScopeIfNeeded(req, filter);
    const rows = await ApprovalRequest.find(scoped)
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean()
      .exec();
    if (hasQueueView(req)) await flagNeedsReassignment(rows as any[]);

    res.json({ rows: rows.map((r: any) => forViewer(r, req)) });
  } catch (err) {
    next(err);
  }
});

router.get("/admin/done", requireApprovalsAdminRead, async (req: AnyObj, res, next) => {
  try {
    setNoStore(res);
    const doneFilter = adminQueueFilter("done");
    const qsWsDone = String(req.query?.workspaceId || "").trim();
    if (qsWsDone && mongoose.Types.ObjectId.isValid(qsWsDone)) (doneFilter as any).workspaceId = new mongoose.Types.ObjectId(qsWsDone);
    const scoped = applyLeaderScopeIfNeeded(req, doneFilter);
    const rows = await ApprovalRequest.find(scoped)
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean()
      .exec();
    res.json({ rows: rows.map((r: any) => forViewer(r, req)) });
  } catch (err) {
    next(err);
  }
});

router.get("/admin/rejected", requireApprovalsAdminRead, async (req: AnyObj, res, next) => {
  try {
    setNoStore(res);
    const rejFilter = adminQueueFilter("rejected");
    const qsWsRej = String(req.query?.workspaceId || "").trim();
    if (qsWsRej && mongoose.Types.ObjectId.isValid(qsWsRej)) (rejFilter as any).workspaceId = new mongoose.Types.ObjectId(qsWsRej);
    const scoped = applyLeaderScopeIfNeeded(req, rejFilter);
    const rows = await ApprovalRequest.find(scoped)
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean()
      .exec();
    res.json({ rows: rows.map((r: any) => forViewer(r, req)) });
  } catch (err) {
    next(err);
  }
});

/* ────────────────────────────────────────────────────────────────
 * Admin: single request detail (READ)
 * ──────────────────────────────────────────────────────────────── */

router.get("/admin/requests/:id", requireApprovalsAdminRead, async (req: AnyObj, res, next) => {
  try {
    const doc = await ApprovalRequest
      .findOne(queueCaseFilter(req, String(req.params.id || "")))
      .populate("workspaceId", "name companyName config")
      .lean();

    if (!doc) return res.status(404).json({ error: "Request not found" });

    res.json(forViewer(doc, req));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Staff only: the raw live-search option(s) attached to this request's items,
 * prices included. Deliberately NOT requireApprovalsAdminRead — that also
 * admits Workspace Leaders.
 */
router.get("/admin/requests/:id/selection-snapshot", async (req: AnyObj, res, next) => {
  try {
    if (!hasQueueView(req)) {
      return res.status(403).json({ error: "Admin Queue access required", reason: "NO_ADMIN_QUEUE_ACCESS" });
    }
    const id = String(req.params.id || "");
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid request id" });
    }
    const found: any = await ApprovalRequest.findOne(queueCaseFilter(req, id)).select("workspaceId").lean();
    if (!found) return res.status(404).json({ error: "Request not found" });

    const rows = await ApprovalSelectionSnapshot.find({ requestId: id, workspaceId: found.workspaceId })
      .sort({ itemKey: 1 })
      .lean();
    setNoStore(res);
    res.json({ ok: true, snapshots: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * Staff only: one traveller's full passport number on this request. Every
 * payload above masks it (last 4); this is the one way to read it, and each
 * read is recorded in passportReveals (who, which request, which traveller,
 * when) BEFORE the number is returned — no audit, no number. Customers and
 * Workspace Leaders get 403 (requireApprovalsAdminWrite = Admin Queue WRITE).
 */
router.post("/admin/requests/:id/passport-reveal", requireApprovalsAdminWrite, async (req: AnyObj, res, next) => {
  try {
    const id = String(req.params.id || "");
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid request id" });
    }
    const itemIndex = Number(req.body?.itemIndex);
    const travellerIndex = Number(req.body?.travellerIndex);
    if (!Number.isInteger(itemIndex) || itemIndex < 0 || !Number.isInteger(travellerIndex) || travellerIndex < 0) {
      return res.status(400).json({ error: "itemIndex and travellerIndex are required" });
    }

    const doc: any = await ApprovalRequest.findOne(queueCaseFilter(req, id))
      .select("cartItems")
      .lean();
    if (!doc) return res.status(404).json({ error: "Request not found" });

    const t = doc.cartItems?.[itemIndex]?.meta?.travellers?.[travellerIndex];
    const full = String(t?.passportNumber || t?.passportNo || "").trim();
    if (!t || !full || full.startsWith("*")) {
      return res.status(404).json({ error: "No passport number on this traveller" });
    }

    const user = req.user || {};
    const entry = {
      at: new Date(),
      byUserId: String(user.sub || user._id || ""),
      byEmail: normEmail(user.email),
      byName: normStr(user.name || user.firstName || ""),
      itemIndex,
      travellerIndex,
      travellerName: [t.firstName, t.middleName, t.lastName].map((v: any) => normStr(v)).filter(Boolean).join(" "),
    };
    // timestamps:false — a reveal must not move "Last update" or the queue order.
    const written = await ApprovalRequest.updateOne(
      queueCaseFilter(req, id),
      { $push: { passportReveals: entry } },
      { timestamps: false },
    );
    if (!written.modifiedCount) {
      return res.status(500).json({ error: "Could not record the reveal" });
    }

    setNoStore(res);
    res.json({ ok: true, passportNumber: full, travellerName: entry.travellerName, reveal: entry });
  } catch (err) {
    next(err);
  }
});

/** Staff only: the passport-reveal audit for this request, newest first. */
router.get("/admin/requests/:id/passport-reveals", requireApprovalsAdminWrite, async (req: AnyObj, res, next) => {
  try {
    const id = String(req.params.id || "");
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid request id" });
    }
    const doc: any = await ApprovalRequest.findOne(queueCaseFilter(req, id))
      .select("+passportReveals")
      .lean();
    if (!doc) return res.status(404).json({ error: "Request not found" });
    const reveals = (Array.isArray(doc.passportReveals) ? doc.passportReveals : []).slice().reverse();
    setNoStore(res);
    res.json({ ok: true, reveals });
  } catch (err) {
    next(err);
  }
});

/* ────────────────────────────────────────────────────────────────
 * Admin: actions (WRITE — STAFF ONLY)
 * ──────────────────────────────────────────────────────────────── */

router.put("/admin/:id/start-booking", requireApprovalsAdminWrite, async (req: AnyObj, res, next) => {
  try {
    const doc: any = await ApprovalRequest.findOne(queueCaseFilter(req, String(req.params.id || "")));
    if (!doc) return res.status(404).json({ error: "Not found" });
    const wasInProgress = doc.stage === "BOOKING_IN_PROGRESS";

    doc.adminState = "in_progress";
    doc.stage = "BOOKING_IN_PROGRESS";
    doc.history = [
      ...(doc.history || []),
      {
        action: "booking_started",
        by: (req as AnyObj).user?.email || "admin",
        at: new Date(),
        note: "Admin started direct booking via SBT",
      },
    ];
    await doc.save();
    if (!wasInProgress) await notifyRequesterProgress(doc, "booking_started");

    res.json({ success: true, doc: forViewer(doc, req) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function sendTravelDeskError(res: any, e: TravelDeskError) {
  return res.status(e.status).json({ error: e.message, code: e.code });
}

/**
 * Assign (or reassign) a case to a Travel Desk agent. `agentUserId` must be an
 * eligible agent on the team (Away agents may be picked by hand; only
 * auto-allocation skips them). The assignee is emailed; the change is a
 * history row with a staff-only note.
 */
router.put("/admin/:id/assign", requireApprovalsAdminWrite, async (req: AnyObj, res, next) => {
  try {
    setNoStore(res);
    const id = String(req.params.id || "");
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid request id" });
    const agentUserId = String(req.body?.agentUserId || "").trim();
    if (!agentUserId) return res.status(400).json({ error: "Pick a Travel Desk agent", code: "AGENT_REQUIRED" });

    const exists = await ApprovalRequest.exists(queueCaseFilter(req, id));
    if (!exists) return res.status(404).json({ error: "Request not found" });

    const doc = await assignCase({
      requestId: id,
      agentUserId,
      actor: {
        sub: String(req.user?.sub || req.user?._id || ""),
        email: normEmail(req.user?.email),
        name: normStr(req.user?.name || req.user?.firstName || ""),
      },
      note: req.body?.comment,
      via: "manual",
    });
    res.json({ ok: true, request: forViewer(doc, req), message: "Assigned" });
  } catch (err) {
    if (err instanceof TravelDeskError) return sendTravelDeskError(res, err);
    next(err);
  }
});

/** Unassign: the case goes back to Unassigned (adminState assigned → pending). */
router.put("/admin/:id/unassign", requireApprovalsAdminWrite, async (req: AnyObj, res, next) => {
  try {
    setNoStore(res);
    const id = String(req.params.id || "");
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid request id" });
    const exists = await ApprovalRequest.exists(queueCaseFilter(req, id));
    if (!exists) return res.status(404).json({ error: "Request not found" });

    const doc = await assignCase({
      requestId: id,
      agentUserId: null,
      actor: {
        sub: String(req.user?.sub || req.user?._id || ""),
        email: normEmail(req.user?.email),
        name: normStr(req.user?.name || req.user?.firstName || ""),
      },
      note: req.body?.comment,
      via: "manual",
    });
    res.json({ ok: true, request: forViewer(doc, req), message: "Unassigned" });
  } catch (err) {
    if (err instanceof TravelDeskError) return sendTravelDeskError(res, err);
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

      const doc: any = await ApprovalRequest.findOne(queueCaseFilter(req, id));
      if (!doc) return res.status(404).json({ error: "Request not found" });

      const st = String(doc.stage || "").toUpperCase();
      const legacyOk = !st && String(doc.status || "").toLowerCase() === "approved";

      if (!["APPROVED", "PROPOSAL_APPROVED", "REQUEST_APPROVED", "BOOKING_ON_HOLD", "PROPOSAL_ON_HOLD"].includes(st) && !legacyOk) {
        return res.status(400).json({ error: "Only proposal-approved requests can start booking" });
      }
      if (st === "PROPOSAL_ON_HOLD" && !legacyOk) {
        return res.status(400).json({
          error: "Cannot start booking while proposal is on hold. Approve proposal first.",
        });
      }

      const wasInProgress = st === "BOOKING_IN_PROGRESS";
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
      if (!wasInProgress) await notifyRequesterProgress(doc, "booking_started");

      // Sync proposal booking status if a proposal is linked
      const linkedProposalUp = await Proposal.findOne({ requestId: doc._id }).select("_id").lean();
      if (linkedProposalUp) {
        await syncProposalBookingStatus(String((linkedProposalUp as any)._id), "IN_PROGRESS");
      }

      return res.json({ ok: true, request: forViewer(doc, req), message: "Marked as under process" });
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

    const doc: any = await ApprovalRequest.findOne(queueCaseFilter(req, id));
    if (!doc) return res.status(404).json({ error: "Request not found" });

    if (doc.stage !== "BOOKING_IN_PROGRESS") {
      return res.status(400).json({ error: "Only in-progress bookings can be marked done" });
    }

    // The one "booking done" path (also used by the proposal page's Done).
    const out = await markRequestDone({
      doc,
      admin: {
        sub: String(req.user?.sub || req.user?._id || ""),
        email: normEmail(req.user?.email),
        name: normStr(req.user?.name || req.user?.firstName || ""),
      },
      comment,
      notifyEmail,
      bookingAmount,
      actualBookingPrice,
    });
    return res.json({ ok: true, request: forViewer(out.doc, req), message: out.message });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/admin/:id/attachment",
  requireApprovalsAdminWrite,
  // Scope check BEFORE multer, so a refused upload never lands on disk.
  async (req: AnyObj, res, next) => {
    try {
      const id = String(req.params.id || "");
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid request id" });
      if (!(await ApprovalRequest.exists(queueCaseFilter(req, id)))) return res.status(404).json({ error: "Request not found" });
      next();
    } catch (err) {
      next(err);
    }
  },
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

      const doc: any = await ApprovalRequest.findOne(queueCaseFilter(req, id));
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
      caseInQueueScope(req, doc) || isOwnerOfRequest(doc, req.user) || isManagerOrLeaderOfRequest(doc, req.user);

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
 * EMAIL DECISION LINKS live in routes/approvalLinks.ts (public, no login,
 * mounted at /api/public/approval-links). The old /email/action and
 * /email/consume pair sat behind requireAuth here, so emailed links never
 * worked for a logged-out approver.
 * ──────────────────────────────────────────────────────────────── */

/* ────────────────────────────────────────────────────────────────
 * Admin: on-hold
 * PUT /admin/:id/on-hold
 * ──────────────────────────────────────────────────────────────── */

router.put("/admin/:id/on-hold", requireApprovalsAdminWrite, async (req: AnyObj, res, next) => {
  try {
    setNoStore(res);

    const id = String(req.params.id || "");
    const { comment } = req.body || {};

    const doc: any = await ApprovalRequest.findOne(queueCaseFilter(req, id));
    if (!doc) return res.status(404).json({ error: "Request not found" });

    const wasOnHold = doc.adminState === "on_hold";
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
    if (!wasOnHold) await notifyRequesterProgress(doc, "ops_on_hold", comment);
    res.json({ ok: true, request: forViewer(doc, req), message: "Placed on hold" });
  } catch (err) {
    next(err);
  }
});

/* ────────────────────────────────────────────────────────────────
 * Admin: cancel
 * PUT /admin/:id/cancel
 * ──────────────────────────────────────────────────────────────── */

router.put("/admin/:id/cancel", requireApprovalsAdminWrite, async (req: AnyObj, res, next) => {
  try {
    setNoStore(res);

    const id = String(req.params.id || "");
    const { comment } = req.body || {};

    const doc: any = await ApprovalRequest.findOne(queueCaseFilter(req, id));
    if (!doc) return res.status(404).json({ error: "Request not found" });

    doc.adminState = "cancelled";
    doc.stage = "BOOKING_CANCELLED";

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
    await notifyRequesterProgress(doc, "cancelled", comment);
    res.json({ ok: true, request: forViewer(doc, req), message: "Cancelled" });
  } catch (err) {
    next(err);
  }
});

/* ────────────────────────────────────────────────────────────────
 * L1: Revoke (owner-only, pending requests)
 * PUT /requests/:id/revoke
 * ──────────────────────────────────────────────────────────────── */

router.put("/requests/:id/revoke", requireAuth, requireWorkspace, async (req: AnyObj, res, next) => {
  try {
    const id = String(req.params.id || "");
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const doc: any = await ApprovalRequest.findOne({ _id: id, workspaceId: req.workspaceObjectId });
    if (!doc) return res.status(404).json({ error: "Request not found" });

    if (!isOwnerOfRequest(doc, req.user) && !hasQueueWork(req)) {
      return res.status(403).json({ error: "Only the requester can revoke this request" });
    }

    const statusNow = String(doc.status || "").toLowerCase();
    if (statusNow !== "pending") {
      return res.status(400).json({ error: "Only pending requests can be revoked" });
    }

    const sub = String(req.user?.sub || req.user?._id || "");
    const comment = normStr(req.body?.comment || "");

    const updated = await ApprovalRequest.findOneAndUpdate(
      { _id: id, workspaceId: req.workspaceObjectId },
      {
        $set: { status: "declined", stage: "REQUEST_DECLINED", adminState: "cancelled", "meta.revoked": true },
        $push: {
          history: {
            action: "revoked",
            at: new Date(),
            by: sub || "unknown",
            comment: comment || "Revoked by requester",
            userEmail: normEmail(req.user?.email),
            userName: normStr(req.user?.name || req.user?.firstName || ""),
          },
        },
      },
      { new: true }
    );

    res.json({ ok: true, request: forViewer(updated, req), message: "Request revoked" });
  } catch (err) {
    next(err);
  }
});

/* ────────────────────────────────────────────────────────────────
 * L1: Resubmit (owner-only, declined requests)
 * PUT /requests/:id/resubmit
 * ──────────────────────────────────────────────────────────────── */

router.put("/requests/:id/resubmit", requireAuth, requireWorkspace, requireTravelMode("APPROVAL_FLOW", "APPROVAL_DIRECT"), async (req: AnyObj, res, next) => {
  try {
    const id = String(req.params.id || "");
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const doc: any = await ApprovalRequest.findOne({ _id: id, workspaceId: req.workspaceObjectId });
    if (!doc) return res.status(404).json({ error: "Request not found" });

    if (!isOwnerOfRequest(doc, req.user) && !hasQueueWork(req)) {
      return res.status(403).json({ error: "Only the requester can resubmit this request" });
    }

    const statusNow = String(doc.status || "").toLowerCase();
    if (statusNow !== "declined") {
      return res.status(400).json({ error: "Only declined requests can be resubmitted" });
    }

    const sub = String(req.user?.sub || req.user?._id || "");
    const email = normEmail(req.user?.email);
    const userName = normStr(req.user?.name || req.user?.firstName || "");
    const { cartItems, comment } = req.body || {};

    const approverEmail = normEmail(doc.managerEmail || "");
    if (!approverEmail) {
      return res.status(400).json({ error: "Approver email missing on this request" });
    }

    const setFields: AnyObj = {
      status: "pending",
      stage: "REQUEST_RAISED",
      "meta.revoked": false,
    };
    // Travellers are rebuilt on every resubmit — with the stored items when
    // none are sent — so self always reflects the owner's current profile.
    const storedCart = JSON.parse(JSON.stringify(doc.cartItems || []));
    let preparedResubmit: Awaited<ReturnType<typeof prepareCartSelections>> | null = null;
    try {
      const withTravellers = await prepareCartTravellers({
        cartItems: withoutOneWayReturnDate(Array.isArray(cartItems) && cartItems.length > 0 ? cartItems : storedCart),
        workspaceId: req.workspaceObjectId,
        ownerUserId: String(doc.frontlinerId || ""),
        existingCartItems: storedCart,
      });
      if (Array.isArray(cartItems) && cartItems.length > 0) {
        preparedResubmit = await prepareCartSelections({
          cartItems: withTravellers,
          userId: sub,
          workspaceId: req.workspaceObjectId,
          requestId: id,
        });
        setFields.cartItems = preparedResubmit.cartItems;
      } else {
        setFields.cartItems = withTravellers;
      }
    } catch (e) {
      if (e instanceof TravellerError) return sendTravellerError(res, e);
      if (e instanceof SelectionError) return sendSelectionError(res, e);
      throw e;
    }

    const updated: any = await ApprovalRequest.findOneAndUpdate(
      { _id: id, workspaceId: req.workspaceObjectId },
      {
        $set: setFields,
        $unset: { adminState: "" },
        $push: {
          history: {
            action: "resubmitted",
            at: new Date(),
            by: sub || "unknown",
            comment: String(comment || "").trim() || "Resubmitted by requester",
            userEmail: email,
            userName,
          },
        },
      },
      { new: true }
    );

    if (preparedResubmit && (preparedResubmit.snapshots.length || cartHasOptionRefs(doc.cartItems))) {
      await writeSelectionSnapshots({
        requestId: id,
        workspaceId: req.workspaceObjectId,
        userId: sub,
        snapshots: preparedResubmit.snapshots,
        prune: true,
      });
    }

    // Re-send approval email to L2
    try {
      if (!DISABLE_EMAILS) {
        const requesterDisplayName = normStr(doc.frontlinerName || email.split("@")[0] || "User");
        const items = Array.isArray(updated.cartItems) ? updated.cartItems : Array.isArray(doc.cartItems) ? doc.cartItems : [];

        const approveUrl = decisionLinkUrl("request", id, approverEmail, req.workspace || null, "approve");
        const declineUrl = decisionLinkUrl("request", id, approverEmail, req.workspace || null, "decline");
        const clarifyUrl = decisionLinkUrl("request", id, approverEmail, req.workspace || null, "clarify");

        await sendMail({
          kind: "REQUESTS",
          to: approverEmail,
          subject: `Approval Needed (Resubmit) — ${doc.customerName || "Workspace"}${doc.ticketId ? ` (${doc.ticketId})` : ""}`,
          replyTo: email || undefined,
          html: buildApproverEmailHtml({
            requestId: id,
            requesterName: requesterDisplayName,
            requesterEmail: email,
            customerName: doc.customerName || "Workspace",
            ticketId: updated.ticketId,
            items,
            comments: updated.comments,
            approveUrl,
            declineUrl,
            clarifyUrl,
          }),
        });
      }
    } catch { /* non-blocking */ }

    res.json({ ok: true, request: forViewer(updated, req), message: "Resubmitted" });
  } catch (err) {
    next(err);
  }
});

export default router;
