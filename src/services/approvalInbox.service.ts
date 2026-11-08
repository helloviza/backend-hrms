// apps/backend/src/services/approvalInbox.service.ts
//
// The approver inboxes' "what is waiting on this caller" rules, in ONE place.
// Each function is used by BOTH the live inbox route and My Space's
// GET /api/my-approvals, so the My Space card lists exactly what the inbox
// lists — by construction, not by a re-implemented copy of the rule.
//
//   travelRequestInboxQuery → GET /api/approvals/requests/inbox (routes/approvals.ts)
//   proposalInboxFor        → GET /api/proposals/inbox          (routes/proposals.ts)
//
// Moved here verbatim from those two handlers (origin/main 74ecfd07), with one
// deliberate change to the proposals inbox: it used to take the 200 most
// recently updated SUBMITTED proposals of the WORKSPACE and only then keep the
// caller's — so a caller whose proposals sat below the newest 200 of other
// people's saw an incomplete inbox. It now keeps the caller's first and caps
// that list at 200 (same order, same cap).
import mongoose from "mongoose";
import ApprovalRequest from "../models/ApprovalRequest.js";
import Proposal from "../models/Proposal.js";
import { exactIRegex, normEmail } from "../routes/approvals.security.js";
import { actsAsWorkspaceLeader, getActiveMembership } from "./activeMembership.js";
import { proposalDeciders } from "./approvalDeciders.js";

type AnyObj = Record<string, any>;

export const ACCOUNT_NOT_FOUND = {
  error: "We couldn't find your account. Please sign in again.",
  code: "ACCOUNT_NOT_FOUND",
};
export const SBT_USER_CANNOT_ACCESS_APPROVALS = {
  error: "SBT users cannot access approval inbox.",
  code: "SBT_USER_CANNOT_ACCESS_APPROVALS",
};

export type TravelInboxScope =
  | {
      ok: true;
      email: string;
      isWL: boolean;
      /** Nobody sees their own request as something to approve. */
      notOwn: AnyObj;
      /** The pending-inbox filter (status pending, stage RAISED/ON_HOLD). */
      query: AnyObj;
    }
  | { ok: false; status: number; body: AnyObj };

/**
 * The travel-request approver inbox for this caller. Must run after
 * requireAuth + requireWorkspace (needs req.user and req.workspaceObjectId).
 * Returns the denial the inbox route answers with, or the query it runs.
 */
export async function travelRequestInboxQuery(req: any): Promise<TravelInboxScope> {
  // SBT users must not access approval flow (see /requests/mine)
  const am = await getActiveMembership(req);
  if (!am) return { ok: false, status: 403, body: ACCOUNT_NOT_FOUND };
  if (am.flags.sbtEnabled === true && !(await actsAsWorkspaceLeader(req))) {
    return { ok: false, status: 403, body: SBT_USER_CANNOT_ACCESS_APPROVALS };
  }

  const email = normEmail(req.user?.email);

  // WORKSPACE_LEADER sees all pending requests in their workspace (a
  // Leader in this company — not a Leader of another company they belong to)
  const isWL = await actsAsWorkspaceLeader(req);

  const notOwn = { frontlinerEmail: { $not: exactIRegex(email) } };

  const query = isWL
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

  return { ok: true, email, isWL, notOwn, query };
}

/** Same order the inbox route uses. */
export const TRAVEL_INBOX_SORT = { updatedAt: -1, createdAt: -1 } as const;

export const PROPOSAL_INBOX_CAP = 200;

/**
 * SUBMITTED proposals of this workspace that `email` may decide
 * (proposalDeciders — the request's approver or any active Workspace Leader),
 * newest update first, at most PROPOSAL_INBOX_CAP. Raw lean docs, before the
 * route's enrich/sanitize step. `requests` maps each item's requestId to its
 * ApprovalRequest (callers that need the requester; the inbox ignores it).
 */
export async function proposalInboxFor(args: {
  workspaceObjectId: mongoose.Types.ObjectId;
  email: string;
}): Promise<{ items: AnyObj[]; requests: Map<string, AnyObj> }> {
  const { workspaceObjectId, email } = args;
  const requests = new Map<string, AnyObj>();
  if (!email) return { items: [], requests };
  const proposals = (await Proposal.find({ status: "SUBMITTED", workspaceId: workspaceObjectId })
    .sort({ updatedAt: -1 })
    .lean()) as AnyObj[];
  if (!proposals.length) return { items: [], requests };

  const reqObjIds: mongoose.Types.ObjectId[] = [];
  for (const p of proposals) {
    const rid = String(p?.requestId || "").trim();
    if (mongoose.Types.ObjectId.isValid(rid)) reqObjIds.push(new mongoose.Types.ObjectId(rid));
  }
  if (!reqObjIds.length) return { items: [], requests };

  const reqDocs = (await ApprovalRequest.find({ _id: { $in: reqObjIds } }).lean()) as AnyObj[];
  for (const r of reqDocs) requests.set(String(r._id), r);

  const out: AnyObj[] = [];
  for (const p of proposals) {
    const ar = requests.get(String(p?.requestId || "").trim());
    if (!ar) continue;
    if (!(await proposalDeciders(ar)).includes(email)) continue;
    out.push({ ...p, _canDecide: true });
    if (out.length >= PROPOSAL_INBOX_CAP) break;
  }
  return { items: out, requests };
}
