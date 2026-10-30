// apps/backend/src/services/loyaltyUnlockEmail.ts
//
// Plumtrips Rewards (loyalty Phase 2) — the "You've unlocked your points"
// email. services/loyalty.ts reconcileAccount() calls notifyLoyaltyUnlock()
// once, right after a run that newly set the account's eligibleAt.
//
// ONCE PER UNLOCK, EVER. The account's unlockNotice is claimed with a
// conditional update keyed on the eligibleAt value before anything is queued:
// a second run, a second instance or a retry finds it claimed and sends
// nothing. The claim is written even when no member workspace has the client
// view on — so switching loyaltyRewardsEnabled on later never back-fills the email.
//
// WHO. Per member workspace whose loyaltyRewardsEnabled switch is on (and that is
// ACTIVE — requireFeature refuses an inactive one) at the moment of the claim:
// the client users who pass middleware/requireInvoiceAccess.ts, the rule that
// also guards GET /api/my-rewards —
//   • active Workspace Leaders of the workspace's customer (CustomerMember
//     role WORKSPACE_LEADER — the list the Business Wallet alerts use), and
//     Users of the workspace holding the WORKSPACE_LEADER role;
//   • Users of the workspace with canViewBilling === true whose customerId,
//     when set, is the workspace's customer (the rule's ownership check);
//   • users who joined the workspace as a second company (company switcher),
//     by that membership's roles and canViewBilling.
// The rule's staff bypass (ADMIN / SUPERADMIN / HR / HRADMIN / OPS) is NOT a
// recipient: those are Plumtrips staff, not the client. INACTIVE users and
// fully-deactivated members are dropped (approvalDeciders.inactiveEmails).
// One email per address, however many member workspaces list it.
import mongoose from "mongoose";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import LoyaltyAccount from "../models/LoyaltyAccount.js";
import User from "../models/User.js";
import { activeLeaderEmails, inactiveEmails } from "./approvalDeciders.js";
import { secondCompanyMembers } from "./activeMembership.js";
import { companyNameFor } from "./companyNames.js";
import { enqueueEmail } from "./emailOutbox.js";
import { renderLayout, card, factsGrid, para, buttonGroup, DESK_MAILBOX } from "./approvalEmails/layout.js";
import { escapeHtml } from "../routes/approvals.email.js";
import { frontendBaseUrl } from "../routes/approvals.security.js";
import logger from "../utils/logger.js";

export const UNLOCK_SUBJECT = "You've unlocked your Plumtrips Rewards points";
const STAFF_ROLES = new Set(["ADMIN", "SUPERADMIN", "HR", "HRADMIN", "OPS"]);
const normRole = (r: unknown) => String(r ?? "").toUpperCase().replace(/[\s_-]/g, "");
const normEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();
const inr = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n || 0);
const pts = (n: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(n || 0));

/** Client users of one workspace who pass the billing access rule (see the header). */
export async function rewardsRecipients(ws: { _id: unknown; customerId?: unknown }): Promise<string[]> {
  const customerId = String(ws.customerId ?? "");
  const wsOid = mongoose.Types.ObjectId.isValid(String(ws._id)) ? new mongoose.Types.ObjectId(String(ws._id)) : null;
  const leaders = await activeLeaderEmails(ws as any);
  const scope = [
    ...(wsOid ? [{ workspaceId: wsOid }] : []),
    ...(customerId ? [{ customerId }] : []),
  ];
  const users: any[] = scope.length
    ? await User.find({
        $or: scope,
        status: { $ne: "INACTIVE" },
        $and: [{ $or: [{ canViewBilling: true }, { roles: "WORKSPACE_LEADER" }] }],
      }).select("email roles customerId canViewBilling").lean()
    : [];
  const fromUsers = users
    .filter((u) => !(u.roles || []).some((r: unknown) => STAFF_ROLES.has(normRole(r))))
    .filter((u) => {
      if ((u.roles || []).some((r: unknown) => normRole(r) === "WORKSPACELEADER")) return true;
      // The rule's ownership check: a set customerId must be this workspace's.
      return u.canViewBilling === true && (!u.customerId || !customerId || String(u.customerId) === customerId);
    })
    .map((u) => normEmail(u.email));
  // Company switcher Phase 3c: a user who joined this workspace as a SECOND
  // company passes the same rule on that membership's roles and flags (their
  // User document describes another company, so the query above skips them).
  const fromMemberships = (await secondCompanyMembers(ws._id))
    .map(({ user, membership: m }) => ({ email: user.email, roles: [...(m.roles || []), m.memberRole].filter(Boolean), m }))
    .filter((x) => !x.roles.some((r: unknown) => STAFF_ROLES.has(normRole(r))))
    .filter((x) => x.roles.some((r: unknown) => normRole(r) === "WORKSPACELEADER") || x.m.flags?.canViewBilling === true)
    .map((x) => normEmail(x.email));
  const all = [...new Set([...leaders, ...fromUsers, ...fromMemberships].map(normEmail).filter((e) => e.includes("@")))];
  const skip = await inactiveEmails(all);
  return all.filter((e) => !skip.has(e));
}

export function unlockEmailHtml(x: {
  companyName: string;
  ready: number;
  onTheWay: number;
  linkedNames: string[];
  href: string;
  thresholdInr: number;
  validityMonths: number;
}): string {
  const facts = [
    { label: "Ready to use", value: `${pts(x.ready)} points` },
    { label: "On the way", value: `${pts(x.onTheWay)} points` },
  ];
  if (x.linkedNames.length > 1) facts.push({ label: "Shared across", value: x.linkedNames.map(escapeHtml).join(", ") });
  return renderLayout({
    title: UNLOCK_SUBJECT,
    preheader: `${pts(x.ready)} points are ready to use on your next booking with Plumtrips.`,
    hero: {
      badge: "Plumtrips Rewards",
      tone: "green",
      headline: "Your rewards are unlocked",
      instruction: `${escapeHtml(x.companyName)} has reached ${inr(x.thresholdInr)} of business with Plumtrips.`,
    },
    blocks: [
      para(
        "Points on paid invoices are now ready to use. Points on invoices that are still awaiting payment " +
          "become ready as soon as those invoices are paid.",
      ),
      card(factsGrid(facts)),
      buttonGroup({ label: "See your rewards", href: x.href }),
      para(`Points stay valid for ${x.validityMonths} months from the date they were earned.`),
    ],
    footer: "customer",
  });
}

export interface UnlockNotifyResult {
  claimed: boolean;
  workspaceIds: string[];
  recipients: string[];
}

/**
 * Claims the account's unlock notice for its current eligibleAt and queues the
 * email to every recipient. Safe to call any number of times: only the call
 * that wins the claim queues anything. Throws only on a database error.
 */
export async function notifyLoyaltyUnlock(
  accountId: unknown,
  settings: { thresholdInr: number; validityMonths: number },
): Promise<UnlockNotifyResult> {
  const none: UnlockNotifyResult = { claimed: false, workspaceIds: [], recipients: [] };
  if (!mongoose.Types.ObjectId.isValid(String(accountId))) return none;
  const acct: any = await LoyaltyAccount.findById(String(accountId)).select("name memberCustomerIds eligibleAt balances").lean();
  if (!acct?.eligibleAt) return none;

  // Who is switched on — read BEFORE the claim, recorded WITH it.
  const members: string[] = (acct.memberCustomerIds || []).map(String);
  const workspaces: any[] = members.length
    ? await CustomerWorkspace.find({ customerId: { $in: members }, status: "ACTIVE", "config.features.loyaltyRewardsEnabled": true })
        .select("_id customerId companyName name slug")
        .lean()
    : [];
  const workspaceIds = workspaces.map((w) => String(w._id));

  const claim = await LoyaltyAccount.updateOne(
    { _id: acct._id, eligibleAt: acct.eligibleAt, "unlockNotice.eligibleAt": { $ne: acct.eligibleAt } },
    { $set: { unlockNotice: { eligibleAt: acct.eligibleAt, claimedAt: new Date(), workspaceIds, recipients: 0 } } },
  );
  if (claim.modifiedCount !== 1) return none;
  if (!workspaces.length) {
    logger.info("[Loyalty] unlock: client view off for every member, no email", { accountId: String(acct._id) });
    return { claimed: true, workspaceIds, recipients: [] };
  }

  const linkedNames = await memberNames(members);
  const href = `${frontendBaseUrl()}/profile/customer?tab=rewards`;
  const sent = new Set<string>();
  for (const ws of workspaces) {
    const to = (await rewardsRecipients(ws)).filter((e) => !sent.has(e));
    if (!to.length) continue;
    const companyName = await companyNameFor(ws);
    const html = unlockEmailHtml({
      companyName, ready: acct.balances?.ready ?? 0, onTheWay: acct.balances?.onTheWay ?? 0, linkedNames, href,
      thresholdInr: settings.thresholdInr, validityMonths: settings.validityMonths,
    });
    for (const r of to) {
      sent.add(r);
      await enqueueEmail({ event: "loyalty_unlocked", kind: "NOTIFICATIONS", to: [r], replyTo: DESK_MAILBOX, subject: UNLOCK_SUBJECT, html, customerName: companyName });
    }
  }
  await LoyaltyAccount.updateOne({ _id: acct._id }, { $set: { "unlockNotice.recipients": sent.size } });
  logger.info("[Loyalty] unlock email queued", { accountId: String(acct._id), workspaces: workspaceIds.length, recipients: sent.size });
  return { claimed: true, workspaceIds, recipients: [...sent] };
}

async function memberNames(members: string[]): Promise<string[]> {
  const ids = members.filter((c) => mongoose.Types.ObjectId.isValid(c)).map((c) => new mongoose.Types.ObjectId(c));
  if (!ids.length) return [];
  const rows: any[] = await mongoose.connection.collection("customers")
    .find({ _id: { $in: ids } }, { projection: { legalName: 1, companyName: 1, name: 1 } })
    .toArray();
  return rows.map((c) => String(c.legalName || c.companyName || c.name || "").trim()).filter(Boolean);
}
