// apps/backend/src/routes/approvalLinks.ts
//
// PUBLIC (no login) email decision links — mounted at /api/public/approval-links.
//
//   GET  /:token  — what the confirm page shows. READ-ONLY: opening a link
//                   (or an email scanner fetching it) never changes anything.
//   POST /:token  — { action, reason } — applies the decision through the
//                   same service the in-app buttons use.
//
// The token (utils/approvalLinkToken.ts) is bound to one recipient and one
// request/proposal, expires, and is single-use (ApprovalLinkUse). Whether the
// recipient may still decide is re-checked when they act.
//
// Responses are price-free and carry no other person's contact details.
import { Router } from "express";
import ApprovalRequest from "../models/ApprovalRequest.js";
import Proposal from "../models/Proposal.js";
import User from "../models/User.js";
import ApprovalLinkUse from "../models/ApprovalLinkUse.js";
import { verifyApprovalLink, ApprovalLinkError } from "../utils/approvalLinkToken.js";
import {
  applyRequestDecision,
  applyProposalDecision,
  requestDeciders,
  proposalDeciders,
  decidedBy,
  proposalDecidedBy,
  DecisionError,
  REQUEST_ACTIONABLE_STAGES,
} from "../services/approvalDecisions.js";
import { stripPriceText, setNoStore } from "./approvals.security.js";
import { pickTripSummary } from "./approvals.email.js";

const router = Router();

type AnyObj = Record<string, any>;
const str = (v: any) => String(v ?? "").trim();

function travellerNames(cartItems: any[]): string[] {
  const trs = Array.isArray(cartItems?.[0]?.meta?.travellers) ? cartItems[0].meta.travellers : [];
  return trs
    .map((t: any) => [t?.firstName, t?.lastName].map(str).filter(Boolean).join(" "))
    .filter(Boolean);
}

function sendError(res: any, e: any) {
  if (e instanceof ApprovalLinkError || e instanceof DecisionError) {
    return res.status(e.status).json({ ok: false, error: e.message, code: e.code, ...((e as any).extra || {}) });
  }
  return res.status(500).json({ ok: false, error: "Something went wrong. Open Plumbox to decide." });
}

async function displayName(email: string) {
  const rx = new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const u: any = await User.findOne({ email: rx }).select("name firstName lastName").lean().exec();
  return str(u?.name || [u?.firstName, u?.lastName].filter(Boolean).join(" ")) || email;
}

async function requestView(ar: AnyObj, email: string) {
  const actionable =
    str(ar.status).toLowerCase() === "pending" &&
    (REQUEST_ACTIONABLE_STAGES as any[]).includes(ar.stage ? str(ar.stage).toUpperCase() : null);
  const allowed = actionable ? (await requestDeciders(ar)).includes(email) : false;
  return {
    kind: "request",
    ticketId: str(ar.ticketId) || String(ar._id).slice(-6).toUpperCase(),
    requesterName: str(ar.frontlinerName) || "Requester",
    customerName: str(ar.customerName) || undefined,
    tripSummary: stripPriceText(pickTripSummary(ar.cartItems || []).seg),
    travellers: travellerNames(ar.cartItems || []),
    comments: stripPriceText(str(ar.comments)) || undefined,
    state: actionable ? (allowed ? "OPEN" : "NOT_ALLOWED") : "DECIDED",
    decided: actionable ? undefined : decidedBy(ar),
    actions: actionable && allowed ? ["approve", "decline"] : [],
  };
}

async function proposalView(p: AnyObj, email: string) {
  const ar: any = await ApprovalRequest.findOne({ _id: p.requestId }).lean().exec();
  const open = str(p.status) === "SUBMITTED";
  const allowed = open && ar ? (await proposalDeciders(ar)).includes(email) : false;
  const options = (Array.isArray(p.options) ? p.options : []).map((o: any) => ({
    optionNo: o.optionNo,
    title: stripPriceText(str(o.title)),
    notes: stripPriceText(str(o.notes)) || undefined,
    items: (Array.isArray(o.lineItems) ? o.lineItems : []).map((li: any) => ({
      title: stripPriceText(str(li.title)),
      category: str(li.category),
      qty: Number(li.qty || 1),
    })),
  }));
  return {
    kind: "proposal",
    ticketId: str(ar?.ticketId) || String(p.requestId).slice(-6).toUpperCase(),
    requesterName: str(ar?.frontlinerName) || "Requester",
    customerName: str(ar?.customerName) || undefined,
    tripSummary: ar ? stripPriceText(pickTripSummary(ar.cartItems || []).seg) : "",
    travellers: travellerNames(ar?.cartItems || []),
    version: p.version,
    options,
    state: open ? (allowed ? "OPEN" : "NOT_ALLOWED") : "DECIDED",
    decided: open ? undefined : proposalDecidedBy(p),
    actions: open && allowed ? ["approve", "decline"] : [],
  };
}

router.get("/:token", async (req, res) => {
  setNoStore(res);
  try {
    const link = verifyApprovalLink(req.params.token);
    const used: any = await ApprovalLinkUse.findOne({ jti: link.jti }).lean().exec();
    if (link.kind === "request") {
      const ar: any = await ApprovalRequest.findOne({ _id: link.id }).lean().exec();
      if (!ar) return res.status(404).json({ ok: false, error: "Request not found", code: "NOT_FOUND" });
      const view: AnyObj = await requestView(ar, link.email);
      if (used) Object.assign(view, { state: "USED", actions: [] });
      return res.json({ ok: true, link: view });
    }
    const p: any = await Proposal.findOne({ _id: link.id }).lean().exec();
    if (!p) return res.status(404).json({ ok: false, error: "Proposal not found", code: "NOT_FOUND" });
    const view: AnyObj = await proposalView(p, link.email);
    if (used) Object.assign(view, { state: "USED", actions: [] });
    return res.json({ ok: true, link: view });
  } catch (e) {
    return sendError(res, e);
  }
});

router.post("/:token", async (req, res) => {
  setNoStore(res);
  try {
    const link = verifyApprovalLink(req.params.token);
    const action = str(req.body?.action).toLowerCase();
    const reason = str(req.body?.reason);

    if (await ApprovalLinkUse.findOne({ jti: link.jti }).lean().exec()) {
      return res.status(409).json({ ok: false, error: "This link has already been used.", code: "LINK_USED" });
    }

    const actor = { email: link.email, name: await displayName(link.email), via: "email" as const };
    let targetId: any;
    if (link.kind === "request") {
      const map: AnyObj = { approve: "approved", decline: "declined" };
      if (!map[action]) return res.status(400).json({ ok: false, error: "Invalid action", code: "INVALID_ACTION" });
      const doc = await applyRequestDecision({ requestId: link.id, actor, action: map[action], reason });
      targetId = doc._id;
    } else {
      if (action !== "approve" && action !== "decline") {
        return res.status(400).json({ ok: false, error: "Invalid action", code: "INVALID_ACTION" });
      }
      const out = await applyProposalDecision({ proposalId: link.id, actor, action, reason });
      targetId = out.proposal._id;
    }

    try {
      await ApprovalLinkUse.create({ jti: link.jti, kind: link.kind, targetId, email: link.email, action });
    } catch {
      /* a concurrent use of the same link lost the race on the decision already */
    }
    return res.json({ ok: true, message: "Your decision has been recorded." });
  } catch (e) {
    return sendError(res, e);
  }
});

export default router;
