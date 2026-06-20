// apps/backend/src/routes/expenseAdvances.ts
//
// Expense Advances — System B (cash advances). A PEER of the claim (Report)
// flow, NOT an extension of it: request → approve (reuses the claim chain
// resolvers + chain-advance lifecycle) → finance disburse → outstanding balance.
// Settlement/recovery of an advance against later expenses is Phase 2 (the
// model carries empty settlements[]/recoveries[] placeholders).
//
// Mounted at /api/expense-advances behind:
//   requireAuth → requireWorkspace → requireExpenseAdvancesFeature
// (requireExpenseAdvancesFeature = expensesEnabled THEN advancesEnabled — see
// middleware/requireFeature.ts; advances live inside the expense module).
//
// Scoping (NON-NEGOTIABLE): every query stamps workspaceId via
// req.workspaceObjectId. Reads use the seesAll admin/finance-all pattern;
// request/resubmit are owner-only; approve/decline/clarify are approver-or-admin;
// disburse is finance-only with whole-chain SoD (canDisburse).

import express from "express";
import mongoose from "mongoose";
import {
  seesAll,
  isFinance as isFinanceUser,
  isAdmin as isAdminUser,
  canDecideAdvance as canDecideAdvanceUser,
  canDisburse as canDisburseUser,
  userIdOf,
} from "../services/expense.access.js";
import { resolveAdvanceApprovalChain } from "../services/reports.service.js";
import ExpenseAdvance from "../models/ExpenseAdvance.js";
import ExpenseActivity, { type ExpenseActivityEvent } from "../models/ExpenseActivity.js";
import User from "../models/User.js";
import { refFromId } from "../utils/refFromId.js";
import { sendAdvanceSubmittedEmail } from "../utils/advanceEmails.js";

const router = express.Router();

/* ── Access predicates: delegated to the single source of truth ─────── */
function seesAllAdvances(req: any): boolean {
  return seesAll(req.user);
}
function ownRequesterId(req: any): string {
  return userIdOf(req.user);
}
function isFinance(req: any): boolean {
  return isFinanceUser(req.user);
}
function isAdmin(req: any): boolean {
  return isAdminUser(req.user);
}

function employeeNameOf(u: any): string {
  if (!u || typeof u !== "object") return "";
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return full || u.name || u.email || "";
}

/** Acting user's display name for the activity log (falls back to "System"). */
function actorNameOf(req: any): string {
  return employeeNameOf(req.user) || "System";
}

/* ── Activity / audit log for advances ───────────────────────────────
 * Append-only, co-located here (the advance lifecycle is route-resident).
 * Mirrors reports.service.logActivity but keyed by advanceId (NOT reportId).
 * Non-fatal: a logging failure is swallowed so it can never block an action. */
async function logAdvanceActivity(params: {
  workspaceId: mongoose.Types.ObjectId | string;
  advanceId: mongoose.Types.ObjectId | string;
  event: ExpenseActivityEvent;
  actorName: string;
  actorId?: mongoose.Types.ObjectId | string | null;
  note?: string | null;
}): Promise<void> {
  try {
    const actorId =
      params.actorId && mongoose.Types.ObjectId.isValid(String(params.actorId))
        ? new mongoose.Types.ObjectId(String(params.actorId))
        : null;
    await ExpenseActivity.create({
      workspaceId: new mongoose.Types.ObjectId(String(params.workspaceId)),
      advanceId: new mongoose.Types.ObjectId(String(params.advanceId)),
      event: params.event,
      actorId,
      actorName: params.actorName || "System",
      note: params.note ?? null,
    });
  } catch (err: any) {
    console.error("[advance activity log]", params.event, err?.message || err);
  }
}

/** Load an advance by id within the tenant, WITHOUT an owner restriction —
 *  for approval/disburse the actor is the approver/finance, not the requester. */
async function loadAdvanceAny(req: any, id: string) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return ExpenseAdvance.findOne({
    _id: new mongoose.Types.ObjectId(id),
    workspaceId: req.workspaceObjectId,
  });
}

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/expense-advances  — request an advance (own).
 * Resolves the approval chain by REUSING the claim resolvers
 * (resolveAdvanceApprovalChain → advanceEscalationThreshold + amount gate). Same
 * never-null / 409 routing as a claim submit: if no approver can be found the
 * advance is NOT created (it would strand in awaiting_approval with nobody able
 * to act).
 * ───────────────────────────────────────────────────────────────────── */
router.post("/", async (req: any, res: any) => {
  try {
    const requesterId = ownRequesterId(req);
    if (!req.workspaceObjectId || !requesterId) {
      return res.status(400).json({ error: "Missing workspace or user context" });
    }

    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "amount must be a positive number" });
    }
    const purpose = String(req.body?.purpose || "").trim();
    if (!purpose) return res.status(400).json({ error: "purpose is required" });

    const currency = String(req.body?.currency || "INR").trim().toUpperCase() || "INR";
    let neededBy: Date | null = null;
    if (req.body?.neededBy) {
      const d = new Date(req.body.neededBy);
      if (!Number.isNaN(d.getTime())) neededBy = d;
    }

    // Resolve the chain BEFORE creating — refuse (409) if no approver, exactly
    // like a claim submit, so we never persist an unroutable advance.
    const { chain, approverId, approver } = await resolveAdvanceApprovalChain(
      req.workspaceObjectId,
      requesterId,
      amount,
    );
    if (!approverId) {
      return res.status(409).json({
        error:
          "No approver available — set a manager for this employee, or add an admin to the workspace.",
      });
    }

    const advance = new ExpenseAdvance({
      workspaceId: req.workspaceObjectId,
      requesterId: new mongoose.Types.ObjectId(requesterId),
      amount,
      currency,
      purpose,
      neededBy,
      status: "awaiting_approval",
      approvalChain: chain,
      currentLevel: 1,
      approverId,
      submittedAt: new Date(),
    });
    advance.ref = refFromId("ADV", advance._id as mongoose.Types.ObjectId);
    await advance.save();

    await logAdvanceActivity({
      workspaceId: req.workspaceObjectId,
      advanceId: advance._id as mongoose.Types.ObjectId,
      event: "requested",
      actorId: requesterId,
      actorName: actorNameOf(req),
    });

    // Approver email — best-effort, never blocks the request.
    if (approver?.email) {
      try {
        await sendAdvanceSubmittedEmail({
          to: approver.email,
          approverName: employeeNameOf(approver),
          requesterName: actorNameOf(req) || "An employee",
          advanceRef: advance.ref,
          advanceId: String(advance._id),
          amount,
          purpose,
        });
      } catch (mailErr: any) {
        console.error("[advance request email]", mailErr?.message || mailErr);
      }
    }

    res.status(201).json({ ok: true, advance: advance.toObject() });
  } catch (err: any) {
    console.error("[Advances POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to request advance" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expense-advances/pending-count  — sidebar badge.
 * Declared before /:id so ":id" can't capture "pending-count".
 *  - approvals: advances awaiting MY approval (approverId==me; seesAll → all)
 *  - disburse : approved advances awaiting disbursement (FINANCE; SoD-filtered)
 * ───────────────────────────────────────────────────────────────────── */
router.get("/pending-count", async (req: any, res: any) => {
  try {
    const ws = req.workspaceObjectId;
    const approvalsFilter: Record<string, any> = { workspaceId: ws, status: "awaiting_approval" };
    if (!seesAllAdvances(req)) {
      approvalsFilter.approverId = new mongoose.Types.ObjectId(ownRequesterId(req));
    }
    const approvals = await ExpenseAdvance.countDocuments(approvalsFilter);

    let disburse = 0;
    if (isFinance(req)) {
      const disburseFilter: Record<string, any> = { workspaceId: ws, status: "approved" };
      // Whole-chain SoD (mirrors canDisburse): a non-admin finance user may not
      // disburse an advance they approved at any level. Admin bypasses SoD.
      if (!isAdmin(req)) {
        const me = new mongoose.Types.ObjectId(ownRequesterId(req));
        disburseFilter.approverId = { $ne: me };
        disburseFilter["approvalChain.approverId"] = { $ne: me };
      }
      disburse = await ExpenseAdvance.countDocuments(disburseFilter);
    }

    res.json({ ok: true, approvals, disburse });
  } catch (err: any) {
    console.error("[Advances pending-count]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load count" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expense-advances
 *  - default       : own (admin/finance: all, optionally ?requesterId=)
 *  - ?queue=approve: advances routed to ME (approverId==me); seesAll → all awaiting
 *  - ?queue=disburse: approved advances awaiting disbursement — FINANCE only,
 *                     SoD-filtered (excludes ones the finance user approved)
 * ───────────────────────────────────────────────────────────────────── */
router.get("/", async (req: any, res: any) => {
  try {
    const queue = String(req.query.queue || "");
    const filter: Record<string, any> = { workspaceId: req.workspaceObjectId };

    if (queue === "approve") {
      filter.status = "awaiting_approval";
      if (!seesAllAdvances(req)) {
        filter.approverId = new mongoose.Types.ObjectId(ownRequesterId(req));
      }
    } else if (queue === "disburse") {
      if (!isFinance(req)) return res.status(403).json({ error: "Finance access required" });
      filter.status = "approved";
      // SoD-filtered from day one (non-admin finance): exclude advances the
      // requesting user approved at ANY level. Admin sees all approved.
      if (!isAdmin(req)) {
        const me = new mongoose.Types.ObjectId(ownRequesterId(req));
        filter.approverId = { $ne: me };
        filter["approvalChain.approverId"] = { $ne: me };
      }
    } else {
      if (!seesAllAdvances(req)) {
        filter.requesterId = new mongoose.Types.ObjectId(ownRequesterId(req));
      } else if (
        req.query.requesterId &&
        mongoose.Types.ObjectId.isValid(String(req.query.requesterId))
      ) {
        filter.requesterId = new mongoose.Types.ObjectId(String(req.query.requesterId));
      }
      if (req.query.status) filter.status = String(req.query.status);
    }

    const advances = await ExpenseAdvance.find(filter)
      .populate("requesterId", "firstName lastName email name")
      .sort({ createdAt: -1 })
      .lean();

    const docs = advances.map((a: any) => {
      const r = a.requesterId;
      return {
        ...a,
        requesterId: r && typeof r === "object" ? r._id : r,
        requesterName: employeeNameOf(r),
      };
    });

    res.json({ ok: true, docs });
  } catch (err: any) {
    console.error("[Advances GET list]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to list advances" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expense-advances/:id  — detail.
 * Visible to: the REQUESTER, an admin/finance (seesAll), or an approver on its
 * chain. Includes requester + approver names, a name-enriched chain, the
 * activity timeline, and canApprove/canDisburse UI hints.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/:id", async (req: any, res: any) => {
  try {
    const advance = await loadAdvanceAny(req, req.params.id);
    if (!advance) return res.status(404).json({ error: "Advance not found" });

    const me = ownRequesterId(req);
    const isOwner = String(advance.requesterId) === me;
    const chainRaw: any[] = Array.isArray((advance as any).approvalChain)
      ? (advance as any).approvalChain
      : [];
    const isApprover =
      (advance.approverId && String(advance.approverId) === me) ||
      chainRaw.some((l) => l?.approverId && String(l.approverId) === me);
    if (!isOwner && !seesAllAdvances(req) && !isApprover) {
      return res.status(404).json({ error: "Advance not found" });
    }

    // Resolve requester + current approver display names.
    const [requester, approver] = await Promise.all([
      User.findById(advance.requesterId).select("firstName lastName email name").lean(),
      advance.approverId
        ? User.findById(advance.approverId).select("firstName lastName email name").lean()
        : Promise.resolve(null),
    ]);

    // Chain-progress stepper: enrich each level with its approver display name.
    const chainNameById = new Map<string, string>();
    const chainApproverIds = chainRaw.map((l) => l.approverId).filter(Boolean);
    if (chainApproverIds.length) {
      const chainUsers = await User.find({
        workspaceId: req.workspaceObjectId,
        _id: { $in: chainApproverIds },
      })
        .select("firstName lastName email name")
        .lean();
      chainUsers.forEach((u: any) => chainNameById.set(String(u._id), employeeNameOf(u)));
    }
    const approvalChain = chainRaw.map((l: any) => ({
      level: l.level,
      approverId: l.approverId ? String(l.approverId) : null,
      approverName: l.approverId ? chainNameById.get(String(l.approverId)) || "" : "",
      status: l.status,
      decidedAt: l.decidedAt ?? null,
      note: l.note ?? null,
    }));

    const decision = canDecideAdvanceUser(req.user, advance);
    const out = {
      ...advance.toObject(),
      requesterName: employeeNameOf(requester),
      approverName: employeeNameOf(approver),
      approvalChain,
      viewerIsOwner: isOwner,
      canApprove: advance.status === "awaiting_approval" && decision.ok,
      canDisburse: canDisburseUser(req.user, advance),
    };

    // Activity timeline (oldest → newest), tenant-scoped + keyed by advanceId.
    const activityDocs = await ExpenseActivity.find({
      workspaceId: req.workspaceObjectId,
      advanceId: advance._id,
    })
      .sort({ createdAt: 1 })
      .lean();
    const activity = activityDocs.map((a: any) => ({
      _id: String(a._id),
      event: a.event,
      actorName: a.actorName,
      actorId: a.actorId ? String(a.actorId) : null,
      note: a.note ?? null,
      createdAt: a.createdAt,
    }));

    res.json({ ok: true, advance: out, activity });
  } catch (err: any) {
    console.error("[Advances GET one]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load advance" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/expense-advances/:id/approve  — awaiting_approval → (next level) or
 * approved. Reuses the claim chain-advance lifecycle: stamp the current level,
 * repoint approverId to the next approver (status stays awaiting_approval) or
 * finalize on the last level.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/approve", async (req: any, res: any) => {
  try {
    const advance = await loadAdvanceAny(req, req.params.id);
    if (!advance) return res.status(404).json({ error: "Advance not found" });
    if (advance.status !== "awaiting_approval") {
      return res.status(409).json({ error: "Only advances awaiting approval can be approved" });
    }

    const { ok, isSelf } = canDecideAdvanceUser(req.user, advance);
    if (!ok) return res.status(403).json({ error: "You are not authorized to approve this advance" });

    const me = ownRequesterId(req);
    const note = String(req.body?.decisionNote || "").trim() || null;

    const chain: any[] = Array.isArray(advance.approvalChain) ? advance.approvalChain : [];
    const totalLevels = chain.length || 1;
    const idx = Math.min(Math.max((advance.currentLevel || 1) - 1, 0), Math.max(chain.length - 1, 0));
    const levelNo = idx + 1;

    if (chain[idx]) {
      chain[idx].status = "approved";
      chain[idx].decidedAt = new Date();
      chain[idx].approverId = new mongoose.Types.ObjectId(me);
      if (note) chain[idx].note = note;
    }
    advance.markModified("approvalChain");

    const hasNext = idx < chain.length - 1;

    if (hasNext) {
      const next = chain[idx + 1];
      advance.currentLevel = levelNo + 1;
      advance.approverId = next.approverId; // denorm pointer → next pending approver
      advance.selfApproved = isSelf;
      await advance.save();

      await logAdvanceActivity({
        workspaceId: req.workspaceObjectId,
        advanceId: advance._id as mongoose.Types.ObjectId,
        event: "approved",
        actorId: me,
        actorName: actorNameOf(req),
        note: `Approved (L${levelNo}) → awaiting L${levelNo + 1}`,
      });

      // Notify the next approver (best-effort).
      if (next?.approverId) {
        try {
          const [nextApprover, requester] = await Promise.all([
            User.findById(next.approverId).select("firstName lastName name email").lean(),
            User.findById(advance.requesterId).select("firstName lastName name email").lean(),
          ]);
          if ((nextApprover as any)?.email) {
            await sendAdvanceSubmittedEmail({
              to: (nextApprover as any).email,
              approverName: employeeNameOf(nextApprover),
              requesterName: employeeNameOf(requester) || "An employee",
              advanceRef: advance.ref,
              advanceId: String(advance._id),
              amount: advance.amount,
              purpose: advance.purpose,
            });
          }
        } catch (mailErr: any) {
          console.error("[advance advance email]", mailErr?.message || mailErr);
        }
      }

      return res.json({ ok: true, advance: advance.toObject() });
    }

    // Final level → approve the advance.
    advance.status = "approved";
    advance.approvedAt = new Date();
    advance.approverId = new mongoose.Types.ObjectId(me); // actual decider
    advance.selfApproved = isSelf;
    if (isSelf) advance.decisionNote = advance.decisionNote || "Self-approved by admin";
    await advance.save();

    await logAdvanceActivity({
      workspaceId: req.workspaceObjectId,
      advanceId: advance._id as mongoose.Types.ObjectId,
      event: "approved",
      actorId: me,
      actorName: actorNameOf(req),
      note:
        totalLevels > 1
          ? `Approved (final, L${levelNo})`
          : isSelf
            ? "Self-approved by admin"
            : null,
    });

    res.json({ ok: true, advance: advance.toObject() });
  } catch (err: any) {
    console.error("[Advances approve]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to approve advance" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/expense-advances/:id/decline  — awaiting_approval → declined.
 * decisionNote (reason) REQUIRED. TERMINAL.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/decline", async (req: any, res: any) => {
  try {
    const advance = await loadAdvanceAny(req, req.params.id);
    if (!advance) return res.status(404).json({ error: "Advance not found" });
    if (advance.status !== "awaiting_approval") {
      return res.status(409).json({ error: "Only advances awaiting approval can be declined" });
    }

    const { ok, isSelf } = canDecideAdvanceUser(req.user, advance);
    if (!ok) return res.status(403).json({ error: "You are not authorized to decline this advance" });

    const note = String(req.body?.decisionNote || "").trim();
    if (!note) return res.status(400).json({ error: "A reason is required to decline." });

    const me = ownRequesterId(req);
    const chain: any[] = Array.isArray(advance.approvalChain) ? advance.approvalChain : [];
    const idx = Math.min(Math.max((advance.currentLevel || 1) - 1, 0), Math.max(chain.length - 1, 0));
    const levelNo = idx + 1;
    if (chain[idx]) {
      chain[idx].status = "declined";
      chain[idx].decidedAt = new Date();
      chain[idx].approverId = new mongoose.Types.ObjectId(me);
      chain[idx].note = note;
    }
    advance.markModified("approvalChain");

    advance.status = "declined";
    advance.approverId = new mongoose.Types.ObjectId(me);
    advance.decisionNote = note;
    advance.selfApproved = isSelf;
    await advance.save();

    await logAdvanceActivity({
      workspaceId: req.workspaceObjectId,
      advanceId: advance._id as mongoose.Types.ObjectId,
      event: "declined",
      actorId: me,
      actorName: actorNameOf(req),
      note: (chain.length || 1) > 1 ? `Declined (L${levelNo}): ${note}` : note,
    });

    res.json({ ok: true, advance: advance.toObject() });
  } catch (err: any) {
    console.error("[Advances decline]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to decline advance" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/expense-advances/:id/clarify  — awaiting_approval →
 * clarification_required. decisionNote (the question) REQUIRED. Returns to the
 * requester, who edits nothing here but Resubmits (chain re-resolves).
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/clarify", async (req: any, res: any) => {
  try {
    const advance = await loadAdvanceAny(req, req.params.id);
    if (!advance) return res.status(404).json({ error: "Advance not found" });
    if (advance.status !== "awaiting_approval") {
      return res.status(409).json({ error: "Only advances awaiting approval can be sent back for clarification" });
    }

    const { ok, isSelf } = canDecideAdvanceUser(req.user, advance);
    if (!ok) return res.status(403).json({ error: "You are not authorized to action this advance" });

    const note = String(req.body?.decisionNote || "").trim();
    if (!note) return res.status(400).json({ error: "A note is required to request clarification." });

    const me = ownRequesterId(req);
    const chain: any[] = Array.isArray(advance.approvalChain) ? advance.approvalChain : [];
    const idx = Math.min(Math.max((advance.currentLevel || 1) - 1, 0), Math.max(chain.length - 1, 0));
    const levelNo = idx + 1;
    if (chain[idx]) {
      chain[idx].status = "clarification_required";
      chain[idx].decidedAt = new Date();
      chain[idx].approverId = new mongoose.Types.ObjectId(me);
      chain[idx].note = note;
    }
    advance.markModified("approvalChain");

    advance.status = "clarification_required";
    advance.approverId = new mongoose.Types.ObjectId(me);
    advance.decisionNote = note;
    advance.selfApproved = isSelf;
    advance.approvedAt = null;
    await advance.save();

    await logAdvanceActivity({
      workspaceId: req.workspaceObjectId,
      advanceId: advance._id as mongoose.Types.ObjectId,
      event: "clarification_requested",
      actorId: me,
      actorName: actorNameOf(req),
      note: (chain.length || 1) > 1 ? `Clarification (L${levelNo}): ${note}` : note,
    });

    res.json({ ok: true, advance: advance.toObject() });
  } catch (err: any) {
    console.error("[Advances clarify]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to request clarification" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/expense-advances/:id/resubmit  — clarification_required →
 * awaiting_approval (REQUESTER only). Re-resolves the chain fresh (mirrors a
 * claim resubmit), so a changed manager/threshold is picked up. Same never-null
 * 409 routing as request.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/resubmit", async (req: any, res: any) => {
  try {
    const advance = await loadAdvanceAny(req, req.params.id);
    if (!advance) return res.status(404).json({ error: "Advance not found" });

    const me = ownRequesterId(req);
    if (String(advance.requesterId) !== me) {
      return res.status(403).json({ error: "Only the requester can resubmit this advance" });
    }
    if (advance.status !== "clarification_required") {
      return res.status(409).json({ error: "Only advances in clarification can be resubmitted" });
    }

    const { chain, approverId } = await resolveAdvanceApprovalChain(
      req.workspaceObjectId,
      me,
      advance.amount,
    );
    if (!approverId) {
      return res.status(409).json({
        error:
          "No approver available — set a manager for this employee, or add an admin to the workspace.",
      });
    }

    advance.approvalChain = chain;
    advance.currentLevel = 1;
    advance.approverId = approverId;
    advance.status = "awaiting_approval";
    advance.submittedAt = new Date();
    advance.decisionNote = null;
    advance.selfApproved = false;
    advance.approvedAt = null;
    await advance.save();

    await logAdvanceActivity({
      workspaceId: req.workspaceObjectId,
      advanceId: advance._id as mongoose.Types.ObjectId,
      event: "resubmitted",
      actorId: me,
      actorName: actorNameOf(req),
    });

    // Notify the (re-resolved) L1 approver — best-effort.
    try {
      const [approver, requester] = await Promise.all([
        User.findById(approverId).select("firstName lastName name email").lean(),
        User.findById(advance.requesterId).select("firstName lastName name email").lean(),
      ]);
      if ((approver as any)?.email) {
        await sendAdvanceSubmittedEmail({
          to: (approver as any).email,
          approverName: employeeNameOf(approver),
          requesterName: employeeNameOf(requester) || "An employee",
          advanceRef: advance.ref,
          advanceId: String(advance._id),
          amount: advance.amount,
          purpose: advance.purpose,
        });
      }
    } catch (mailErr: any) {
      console.error("[advance resubmit email]", mailErr?.message || mailErr);
    }

    res.json({ ok: true, advance: advance.toObject() });
  } catch (err: any) {
    console.error("[Advances resubmit]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to resubmit advance" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/expense-advances/:id/disburse  — approved → disbursed (FINANCE).
 * canDisburse: finance-only + whole-chain SoD (a finance user may not disburse
 * an advance they approved); an admin bypasses SoD (owner-operator, logged).
 * Sets amountDisbursed = amount and outstandingBalance = amount (no settlement
 * logic in Phase 1).
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/disburse", async (req: any, res: any) => {
  try {
    const advance = await loadAdvanceAny(req, req.params.id);
    if (!advance) return res.status(404).json({ error: "Advance not found" });
    if (advance.status !== "approved") {
      return res.status(409).json({ error: "Only approved advances can be disbursed" });
    }

    if (!canDisburseUser(req.user, advance)) {
      if (!isFinance(req)) return res.status(403).json({ error: "Finance access required" });
      return res.status(403).json({
        error: "You approved this advance — a different finance user must disburse it.",
      });
    }

    const me = ownRequesterId(req);
    const wasApprover =
      (advance.approverId && String(advance.approverId) === me) ||
      (Array.isArray(advance.approvalChain) &&
        advance.approvalChain.some((l: any) => l?.approverId && String(l.approverId) === me));

    // Optional disbursement metadata.
    const modeRaw = String(req.body?.disbursementMode || "").trim();
    const VALID_MODES = new Set(["bank_transfer", "upi", "cash", "cheque", "other"]);
    const disbursementMode = VALID_MODES.has(modeRaw) ? modeRaw : null;
    const disbursementRef = String(req.body?.disbursementRef || "").trim() || null;

    advance.status = "disbursed";
    advance.amountDisbursed = advance.amount;
    advance.outstandingBalance = advance.amount;
    advance.disbursedAt = new Date();
    advance.disbursedBy = new mongoose.Types.ObjectId(me);
    advance.disbursementMode = disbursementMode as any;
    advance.disbursementRef = disbursementRef;
    await advance.save();

    await logAdvanceActivity({
      workspaceId: req.workspaceObjectId,
      advanceId: advance._id as mongoose.Types.ObjectId,
      event: "disbursed",
      actorId: me,
      actorName: actorNameOf(req),
      note: isAdmin(req) && wasApprover ? "Disbursed (admin SoD override)" : disbursementRef || null,
    });

    res.json({ ok: true, advance: advance.toObject() });
  } catch (err: any) {
    console.error("[Advances disburse]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to disburse advance" });
  }
});

export default router;
