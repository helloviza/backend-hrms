// apps/backend/src/middleware/requireInvoiceAccess.ts
//
// Who in a client workspace may see its billing: the client invoice pages
// (routes/invoices.ts workspaceRouter) and Plumtrips Rewards (routes/myRewards.ts)
// share this one rule, so the two can never disagree. Moved verbatim out of
// routes/invoices.ts; mount it after requireAuth + requireWorkspace.
import type { Request, Response, NextFunction } from "express";
import User from "../models/User.js";
import { getActiveMembership, isActiveWorkspaceLeader } from "../services/activeMembership.js";

/* Same shape as admin.billing.ts's requireAdminOrSBT (role detection +
 * workspace-ownership check + canViewBilling gate) — this is the invoice
 * domain's version of that same rule, not a new pattern: admin bypasses,
 * WORKSPACE_LEADER bypasses (matches admin.billing.ts's "WL bypasses
 * canViewBilling" comment), everyone else needs User.canViewBilling===true.
 * Deliberately does NOT check sbtEnabled — that flag is about SBT flight/
 * hotel booking capability, unrelated to invoice/billing visibility.
 *
 * This is the actual access boundary. The frontend hiding the Invoices tab
 * (MyProfileCustomer.tsx / Sidebar.tsx) is convenience UI on top of this,
 * not a substitute for it — before this change, /mine had no check beyond
 * "authenticated workspace member", so any REQUESTER-role member with
 * canViewBilling never granted could call the API directly and read every
 * invoice for the tenant. */
export async function requireInvoiceAccess(req: Request, res: Response, next: NextFunction) {
  const user: any = (req as any).user;
  const roles: string[] = [
    ...(Array.isArray(user?.roles) ? user.roles : []),
    ...(user?.role ? [user.role] : []),
  ].map((r: string) => String(r).toUpperCase().replace(/[\s_-]/g, ""));
  const adminRoles = ["ADMIN", "SUPERADMIN", "HR", "HRADMIN", "OPS"];

  // Company switcher Phase 3c: in a SECOND company the admin roles, Workspace
  // Leader and canViewBilling are that company's membership values, not the
  // login's global roles or the User document (another company). Own
  // company: below, unchanged.
  const am = user?.mid ? await getActiveMembership(req) : null;
  if (am?.source === "membership") {
    const leader =
      isActiveWorkspaceLeader(am) ||
      String(am.memberRole || "").toUpperCase().replace(/[\s_-]/g, "") === "WORKSPACELEADER";
    const memberRoles = am.roles.map((r) => String(r).toUpperCase().replace(/[\s_-]/g, ""));
    if (memberRoles.some((r) => adminRoles.includes(r))) return next();
    if (leader || am.flags.canViewBilling === true) return next();
    return res.status(403).json({
      error: "Billing access not enabled for your account.",
      code: "BILLING_ACCESS_DENIED",
    });
  }

  if (roles.some((r) => adminRoles.includes(r))) return next();

  const isWL =
    roles.includes("WORKSPACELEADER") ||
    String(user?.customerMemberRole || "").toUpperCase().replace(/[\s_-]/g, "") === "WORKSPACELEADER";
  if (isWL) return next();

  const sub = String(user?.sub || user?._id || user?.id || "");
  if (!sub) return res.status(403).json({ error: "Access denied" });

  const dbUser: any = await User.findById(sub).select("customerId canViewBilling").lean();

  // Verify this user belongs to the current workspace before trusting their
  // own canViewBilling flag against it.
  const wsCustomerId = (req as any).workspace?.customerId;
  if (dbUser?.customerId && wsCustomerId && String(dbUser.customerId) !== String(wsCustomerId)) {
    return res.status(403).json({ error: "Access denied" });
  }

  if (dbUser?.canViewBilling === true) return next();

  return res.status(403).json({
    error: "Billing access not enabled for your account.",
    code: "BILLING_ACCESS_DENIED",
  });
}
