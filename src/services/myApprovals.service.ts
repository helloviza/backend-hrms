// apps/backend/src/services/myApprovals.service.ts
//
// "What is waiting on ME as the approver?" — one read across every approval
// source that names a specific approver (docs/design/my-space-v3/build-plan.md
// §2). Read-only: this never approves anything. Inline Approve in the UI calls
// the source's OWN approve endpoint, and only for sources whose endpoint
// enforces the approver server-side AND that were cleared for inline use
// (decision 2026-11-08: expense claims, advances, visa).
//
// Rules (decisions 2026-11-08; travel/proposal rule changed at the port to
// origin/main 74ecfd07):
//   - Every query is bound to ONE resolved workspace (the caller's), passed in
//     explicitly — never an undefined workspace filter.
//   - Travel requests (#3) and proposals (#4) list EXACTLY what the live
//     approver inboxes list for this caller: they call the same functions the
//     inbox routes call (services/approvalInbox.service.ts —
//     travelRequestInboxQuery / proposalInboxFor, i.e. proposalDeciders), so a
//     Workspace Leader sees the whole workspace's pending requests, as in the
//     inbox. Review-only (no inline Approve).
//   - Every other source is assigned-to-me only; the admin / HR "sees all"
//     widening of those queues is NOT applied.
//   - SBT booker status comes from the caller's ACTIVE membership
//     (services/activeMembership.ts), as the SBT inbox reads it.
//   - CSTEP excluded (no review page). CustomerApprovalRequest / Approval /
//     TravelForm excluded (dead or no approver field).
//   - Items the caller raised themselves are dropped (the source approve
//     routes refuse self-approval for non-admins).
//
// Currency (decision Q12, evidence 2026-11-08):
//   - Travel requests: no currency anywhere on ApprovalRequest; bookingAmount
//     is only written at the admin "done" step (approvals.ts /done) and cart
//     prices are free numbers → amount hidden.
//   - SBT requests: selectedOption is the TBO search result, whose Fare carries
//     its own Currency (tbo.flight.service.ts Fare.Currency) → amount shown
//     only when that Currency field is present on the stored option.
import mongoose from "mongoose";
import Employee from "../models/Employee.js";
import User from "../models/User.js";
import LeaveRequest from "../models/LeaveRequest.js";
import Attendance from "../models/Attendance.js";
import ApprovalRequest from "../models/ApprovalRequest.js";
import SBTRequest from "../models/SBTRequest.js";
import Report from "../models/Report.js";
import ExpenseAdvance from "../models/ExpenseAdvance.js";
import VisaRequest from "../models/VisaRequest.js";
import Expense from "../models/Expense.js";
import { exactIRegex } from "../routes/approvals.security.js";
import { proposalInboxFor, travelRequestInboxQuery, TRAVEL_INBOX_SORT } from "./approvalInbox.service.js";
import { getActiveMembership, isActiveWorkspaceLeader } from "./activeMembership.js";
import { UNKNOWN_USER } from "./actorNames.js";
import { amountBaseExpr, getWorkspaceBaseCurrency, round2 } from "./expenseFx.service.js";

export type ApprovalSourceKey =
  | "leave"
  | "attendanceOd"
  | "travelRequest"
  | "proposal"
  | "sbtRequest"
  | "expenseClaim"
  | "advance"
  | "visa";

export type SourceState = "ok" | "off" | "error";

export type ApprovalItem = {
  source: ApprovalSourceKey;
  id: string;
  requester: { id: string | null; name: string; designation?: string };
  summary: string;
  amount?: number;
  currency?: string;
  submittedAt: string | null;
  reviewHref: string;
  inline?: { method: "POST"; path: string };
};

export type MyApprovalsResult = {
  isApprover: boolean;
  total: number;
  items: ApprovalItem[];
  sources: Record<ApprovalSourceKey, SourceState>;
};

export type SourceEnablement = Record<ApprovalSourceKey, boolean>;

export const ITEM_LIMIT = 10;

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

function fmtDay(d: any): string {
  if (!d) return "";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" });
}

function range(a: any, b: any): string {
  const x = fmtDay(a);
  const y = fmtDay(b);
  if (!x) return "";
  return y && y !== x ? `${x}–${y}` : x;
}

const LEAVE_LABEL: Record<string, string> = {
  CL: "Casual leave",
  SL: "Sick leave",
  EL: "Earned leave",
};

/** Thrown by a source whose own route would refuse this caller (e.g. the
 *  travel inbox's 403 for an SBT user): reported as "off", not as an error. */
class SourceOff extends Error {}

type Pending = Omit<ApprovalItem, "requester"> & { requesterId: string | null; requesterFallback?: string };

export async function collectMyApprovals(args: {
  /** The authenticated request (req.user + resolved req.workspaceObjectId) —
   *  the inbox helpers and the active-membership lookup read it. */
  req: any;
  userId: string;
  workspaceObjectId: mongoose.Types.ObjectId;
  enabled: SourceEnablement;
}): Promise<MyApprovalsResult> {
  const { req, userId, workspaceObjectId: ws, enabled } = args;
  if (!ws) throw new Error("collectMyApprovals requires a resolved workspace");
  const me = oid(userId);
  const meStr = String(me);

  const am = await getActiveMembership(req);
  const myEmail = String(req.user?.email || am?.user?.email || "").trim().toLowerCase();

  // Direct reports (Employee id-space → User ids), workspace-scoped.
  const myEmployeeRows: any[] = await Employee.find({ ownerId: me, workspaceId: ws }).select("_id").lean();
  const reportRows: any[] = myEmployeeRows.length
    ? await Employee.find({ managerId: { $in: myEmployeeRows.map((e) => e._id) }, workspaceId: ws })
        .select("ownerId")
        .lean()
    : [];
  const reportUserIds = reportRows.filter((r) => r.ownerId).map((r) => oid(r.ownerId));

  const sources = {} as Record<ApprovalSourceKey, SourceState>;
  const pending: Pending[] = [];

  async function run(key: ApprovalSourceKey, fn: () => Promise<Pending[]>) {
    if (!enabled[key]) {
      sources[key] = "off";
      return;
    }
    try {
      const rows = await fn();
      // Inbox-mirrored sources already apply the inbox's own "not your own
      // request" rule; the assigned-to-me sources drop the caller's own items.
      const mirrored = key === "travelRequest" || key === "proposal";
      pending.push(...(mirrored ? rows : rows.filter((r) => r.requesterId !== meStr)));
      sources[key] = "ok";
    } catch (err) {
      if (err instanceof SourceOff) {
        sources[key] = "off";
        return;
      }
      console.error(`[my-approvals] source ${key} failed:`, err);
      sources[key] = "error";
    }
  }

  await Promise.all([
    run("leave", async () => {
      if (!reportUserIds.length) return [];
      const docs: any[] = await LeaveRequest.find({ workspaceId: ws, userId: { $in: reportUserIds }, status: "PENDING" })
        .select("userId type from to days createdAt")
        .lean();
      return docs.map((d) => ({
        source: "leave" as const,
        id: String(d._id),
        requesterId: d.userId ? String(d.userId) : null,
        summary: [`${LEAVE_LABEL[String(d.type)] || `${d.type || "Leave"} leave`}`, range(d.from, d.to), d.days ? `${d.days}d` : ""]
          .filter(Boolean)
          .join(" · "),
        submittedAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
        reviewHref: "/leaves/team",
      }));
    }),
    run("attendanceOd", async () => {
      if (!reportUserIds.length) return [];
      const docs: any[] = await Attendance.find({ workspaceId: ws, userId: { $in: reportUserIds }, "odRequests.status": "PENDING" })
        .select("userId date odRequests")
        .lean();
      const out: Pending[] = [];
      for (const d of docs) {
        for (const od of (d.odRequests || []) as any[]) {
          if (od?.status !== "PENDING") continue;
          out.push({
            source: "attendanceOd",
            id: `${d._id}:${od._id}`,
            requesterId: d.userId ? String(d.userId) : null,
            summary: ["Attendance regularisation", fmtDay(`${d.date}T00:00:00+05:30`), od.from && od.to ? `${od.from}–${od.to}` : ""]
              .filter(Boolean)
              .join(" · "),
            submittedAt: od.requestedAt ? new Date(od.requestedAt).toISOString() : null,
            reviewHref: "/attendance/regularize",
          });
        }
      }
      return out;
    }),
    run("travelRequest", async () => {
      // The live inbox's own scope (incl. its 403s — an SBT user, no account).
      const scope = await travelRequestInboxQuery(req);
      if (scope.ok === false) throw new SourceOff();
      const docs: any[] = await ApprovalRequest.find((scope as { query: Record<string, any> }).query)
        .sort(TRAVEL_INBOX_SORT)
        .select("frontlinerId frontlinerName frontlinerEmail ticketId customerName cartItems createdAt updatedAt")
        .lean();
      return docs.map((d) => {
        const firstItem = Array.isArray(d.cartItems) && d.cartItems[0] ? d.cartItems[0] : null;
        const what = firstItem?.title || firstItem?.type || "";
        return {
          source: "travelRequest" as const,
          id: String(d._id),
          requesterId: d.frontlinerId && mongoose.isValidObjectId(d.frontlinerId) ? String(d.frontlinerId) : null,
          requesterFallback: d.frontlinerName || d.frontlinerEmail || "",
          summary: ["Travel request", what, d.ticketId ? `#${d.ticketId}` : ""].filter(Boolean).join(" · "),
          submittedAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
          reviewHref: "/customer/approvals/inbox",
        };
      });
    }),
    run("proposal", async () => {
      // The live proposals inbox's own list (proposalDeciders, filter-then-cap).
      const { items, requests } = await proposalInboxFor({ workspaceObjectId: ws, email: myEmail });
      return items.map((p: any) => {
        const ar: any = requests.get(String(p.requestId)) || {};
        const amt = Number(p.totalAmount);
        return {
          source: "proposal" as const,
          id: String(p._id),
          requesterId: ar.frontlinerId && mongoose.isValidObjectId(ar.frontlinerId) ? String(ar.frontlinerId) : null,
          requesterFallback: ar.frontlinerName || ar.frontlinerEmail || "",
          summary: ["Travel proposal", p.title || "", ar.ticketId ? `#${ar.ticketId}` : ""].filter(Boolean).join(" · "),
          ...(Number.isFinite(amt) && amt > 0 && p.currency ? { amount: amt, currency: String(p.currency) } : {}),
          submittedAt: new Date(p.updatedAt || p.createdAt || Date.now()).toISOString(),
          reviewHref: "/customer/approvals/proposals",
        };
      });
    }),
    run("sbtRequest", async () => {
      const docs: any[] = await SBTRequest.find({ workspaceId: ws, assignedBookerId: me, status: "PENDING" })
        .select("requesterId type searchParams selectedOption requestedAt")
        .lean();
      return docs.map((d) => {
        const opt = d.selectedOption || {};
        const fare = opt?.Fare ?? {};
        const total = Number(fare?.TotalFare ?? fare?.PublishedFare);
        const cur = typeof fare?.Currency === "string" && fare.Currency.trim() ? fare.Currency.trim() : null;
        const sp = d.searchParams || {};
        const route =
          d.type === "flight"
            ? [sp.origin || sp.Origin || sp.from, sp.destination || sp.Destination || sp.to].filter(Boolean).join("→")
            : opt?.HotelName || sp.cityName || sp.city || "";
        return {
          source: "sbtRequest" as const,
          id: String(d._id),
          requesterId: d.requesterId ? String(d.requesterId) : null,
          summary: [d.type === "hotel" ? "Hotel booking request" : "Flight booking request", String(route || "")]
            .filter(Boolean)
            .join(" · "),
          ...(cur && Number.isFinite(total) && total > 0 ? { amount: total, currency: cur } : {}),
          submittedAt: d.requestedAt ? new Date(d.requestedAt).toISOString() : null,
          reviewHref: "/sbt/inbox",
        };
      });
    }),
    run("expenseClaim", async () => {
      const docs: any[] = await Report.find({ workspaceId: ws, status: "submitted", approverId: me })
        .select("employeeId name ref submittedAt")
        .lean();
      if (!docs.length) return [];
      const base = await getWorkspaceBaseCurrency(ws);
      const sums: any[] = await Expense.aggregate([
        { $match: { workspaceId: ws, reportId: { $in: docs.map((d) => d._id) } } },
        { $group: { _id: "$reportId", amount: { $sum: amountBaseExpr(base) }, n: { $sum: 1 } } },
      ]);
      const sumMap = new Map(sums.map((s) => [String(s._id), s]));
      return docs.map((d) => {
        const s = sumMap.get(String(d._id));
        return {
          source: "expenseClaim" as const,
          id: String(d._id),
          requesterId: d.employeeId ? String(d.employeeId) : null,
          summary: ["Expense claim", d.name || "", s?.n ? `${s.n} item${s.n === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · "),
          ...(s ? { amount: round2(s.amount || 0), currency: base } : {}),
          submittedAt: d.submittedAt ? new Date(d.submittedAt).toISOString() : null,
          reviewHref: `/expenses/claims/${d._id}`,
          inline: { method: "POST" as const, path: `/reports/${d._id}/approve` },
        };
      });
    }),
    run("advance", async () => {
      const docs: any[] = await ExpenseAdvance.find({ workspaceId: ws, status: "awaiting_approval", approverId: me })
        .select("requesterId ref purpose amount currency submittedAt createdAt")
        .lean();
      return docs.map((d) => ({
        source: "advance" as const,
        id: String(d._id),
        requesterId: d.requesterId ? String(d.requesterId) : null,
        summary: ["Cash advance", d.purpose || "", d.ref || ""].filter(Boolean).join(" · "),
        ...(Number.isFinite(Number(d.amount)) ? { amount: Number(d.amount), currency: d.currency || "INR" } : {}),
        submittedAt: new Date(d.submittedAt || d.createdAt || Date.now()).toISOString(),
        reviewHref: `/expenses/advances/${d._id}`,
        inline: { method: "POST" as const, path: `/expense-advances/${d._id}/approve` },
      }));
    }),
    run("visa", async () => {
      const docs: any[] = await VisaRequest.find({ workspaceId: ws, approvalStatus: "pending_approval", approverId: me })
        .select("raisedByUserId referenceNumber destinationIso2 purpose travelDateFrom travelDateTo submittedAt createdAt")
        .lean();
      return docs.map((d) => ({
        source: "visa" as const,
        id: String(d._id),
        requesterId: d.raisedByUserId ? String(d.raisedByUserId) : null,
        summary: ["Visa request", d.destinationIso2 || "", range(d.travelDateFrom, d.travelDateTo), d.referenceNumber || ""]
          .filter(Boolean)
          .join(" · "),
        submittedAt: new Date(d.submittedAt || d.createdAt || Date.now()).toISOString(),
        reviewHref: `/visa/track/${d._id}`,
        inline: { method: "POST" as const, path: `/visa/requests/${d._id}/approve` },
      }));
    }),
  ]);

  // Requester display names (only ids we actually need).
  const ids = [...new Set(pending.map((p) => p.requesterId).filter(Boolean) as string[])];
  const people: any[] = ids.length
    ? await User.find({ _id: { $in: ids.map(oid) } }).select("name firstName lastName email designation").lean()
    : [];
  const pMap = new Map(people.map((u) => [String(u._id), u]));

  pending.sort((a, b) => String(a.submittedAt || "").localeCompare(String(b.submittedAt || "")));
  const items: ApprovalItem[] = pending.slice(0, ITEM_LIMIT).map(({ requesterId, requesterFallback, ...rest }) => {
    const u = requesterId ? pMap.get(requesterId) : null;
    const name =
      (u && (u.name || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email)) || requesterFallback || UNKNOWN_USER;
    return {
      ...rest,
      requester: { id: requesterId, name: String(name), ...(u?.designation ? { designation: String(u.designation) } : {}) },
    };
  });

  let isApprover = pending.length > 0;
  if (!isApprover) {
    const checks = await Promise.all([
      Promise.resolve(reportUserIds.length > 0),
      Promise.resolve(enabled.sbtRequest && (am?.flags.sbtRole === "L2" || am?.flags.sbtRole === "BOTH")),
      // A Workspace Leader decides every request / proposal of the workspace.
      Promise.resolve((enabled.travelRequest || enabled.proposal) && isActiveWorkspaceLeader(am)),
      enabled.travelRequest && myEmail
        ? ApprovalRequest.exists({ workspaceId: ws, managerEmail: exactIRegex(myEmail) }).then(Boolean)
        : Promise.resolve(false),
      enabled.expenseClaim ? Report.exists({ workspaceId: ws, approverId: me }).then(Boolean) : Promise.resolve(false),
      enabled.advance ? ExpenseAdvance.exists({ workspaceId: ws, approverId: me }).then(Boolean) : Promise.resolve(false),
      enabled.visa ? VisaRequest.exists({ workspaceId: ws, approverId: me }).then(Boolean) : Promise.resolve(false),
    ]);
    isApprover = checks.some(Boolean);
  }

  return { isApprover, total: pending.length, items, sources };
}
