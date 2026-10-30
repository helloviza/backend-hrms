// apps/backend/src/services/approvalDeciders.ts
//
// Who may decide a request or a proposal, and who is still active — shared by
// the decision service (approvalDecisions.ts, which re-exports these) and the
// email layer (approvalEmails/), so a person who can no longer decide is
// neither allowed to nor emailed.
import mongoose from "mongoose";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import CustomerMember from "../models/CustomerMember.js";
import User from "../models/User.js";

type AnyObj = Record<string, any>;

const norm = (v: any) => String(v ?? "").trim().toLowerCase();
const str = (v: any) => String(v ?? "").trim();
const exactRx = (email: string) => new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

export async function workspaceOf(ar: AnyObj): Promise<AnyObj | null> {
  const id = ar?.workspaceId || ar?.meta?.customerWorkspaceId;
  if (!id || !mongoose.Types.ObjectId.isValid(String(id))) return null;
  return (await CustomerWorkspace.findOne({ _id: id }).lean().exec()) as AnyObj | null;
}

export async function activeLeaderEmails(ws: AnyObj | null, ar?: AnyObj): Promise<string[]> {
  const customerId = str(ws?.customerId || ar?.customerId);
  if (!customerId) return [];
  const rows: any[] = await CustomerMember.find({
    customerId,
    role: "WORKSPACE_LEADER",
    isActive: { $ne: false },
  })
    .lean()
    .exec();
  return Array.from(new Set(rows.map((r) => norm(r.email)).filter(Boolean)));
}

export async function isUserInactive(email: string): Promise<boolean> {
  if (!email) return true;
  const u: any = await User.findOne({ email: exactRx(email) }).select("status").lean().exec();
  return String(u?.status || "").toUpperCase() === "INACTIVE";
}

/**
 * The subset of `emails` that must not be emailed: a User marked INACTIVE, or
 * someone whose customer memberships all exist and are all deactivated.
 * Addresses with no User and no membership (e.g. the ops desk) are kept.
 */
export async function inactiveEmails(emails: string[]): Promise<Set<string>> {
  const list = Array.from(new Set(emails.map(norm).filter(Boolean)));
  const out = new Set<string>();
  if (!list.length) return out;
  const rxs = list.map(exactRx);
  const [users, members]: any[][] = await Promise.all([
    User.find({ email: { $in: rxs } }).select("email status").lean().exec(),
    CustomerMember.find({ email: { $in: rxs } }).select("email isActive").lean().exec(),
  ]);
  for (const u of users) if (String(u?.status || "").toUpperCase() === "INACTIVE") out.add(norm(u.email));
  const byEmail = new Map<string, boolean[]>();
  for (const m of members) {
    const e = norm(m.email);
    byEmail.set(e, [...(byEmail.get(e) || []), m.isActive !== false]);
  }
  for (const [e, flags] of byEmail) if (flags.length && flags.every((active) => !active)) out.add(e);
  return out;
}

/**
 * Who may decide this request now: the assigned approver while still a
 * workspace approver (defaultApproverEmails) or leader, plus every active
 * Workspace Leader. The requester is never on the list.
 */
export async function requestDeciders(ar: AnyObj): Promise<string[]> {
  const ws = await workspaceOf(ar);
  const leaders = await activeLeaderEmails(ws, ar);
  const approvers: string[] = (Array.isArray(ws?.defaultApproverEmails) ? ws!.defaultApproverEmails : []).map(norm);
  const manager = norm(ar?.managerEmail);
  const requester = norm(ar?.frontlinerEmail);
  const out: string[] = [];
  if (manager && (!ws || approvers.includes(manager) || leaders.includes(manager))) out.push(manager);
  for (const l of leaders) if (!out.includes(l)) out.push(l);
  return out.filter((e) => e && e !== requester);
}

/**
 * Who may decide this request's proposal: the request's approver OR any
 * active Workspace Leader — whoever acts first. The requester is excluded,
 * except a Workspace Leader requester when nobody else could decide (their
 * own request was auto-approved for the same reason: no one above them).
 */
export async function proposalDeciders(ar: AnyObj): Promise<string[]> {
  const ws = await workspaceOf(ar);
  const leaders = await activeLeaderEmails(ws, ar);
  const approvers: string[] = (Array.isArray(ws?.defaultApproverEmails) ? ws!.defaultApproverEmails : []).map(norm);
  const manager = norm(ar?.managerEmail);
  const requester = norm(ar?.frontlinerEmail);
  const all: string[] = [];
  if (manager && (!ws || approvers.includes(manager) || leaders.includes(manager))) all.push(manager);
  for (const l of leaders) if (!all.includes(l)) all.push(l);
  const others = all.filter((e) => e && e !== requester);
  if (others.length) return others;
  return leaders.includes(requester) ? [requester] : [];
}

/**
 * "Ops" for a proposal: the staff who submitted it (latest SUBMITTED entry)
 * and the staff who drafted it.
 */
export function proposalOpsEmails(p: AnyObj): string[] {
  const hist = Array.isArray(p?.history) ? p.history : [];
  const submitter = [...hist].reverse().find((h: any) => str(h?.action) === "SUBMITTED");
  return Array.from(new Set([norm(submitter?.byEmail), norm(p?.requesterEmail)].filter(Boolean)));
}
