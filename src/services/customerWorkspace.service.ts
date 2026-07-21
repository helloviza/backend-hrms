// apps/backend/src/services/customerWorkspace.service.ts
import CustomerWorkspace, { type CustomerWorkspaceDocument } from "../models/CustomerWorkspace.js";
import Customer from "../models/Customer.js";

/**
 * ensureCustomerWorkspace — THE single place a CustomerWorkspace document
 * gets lazily created for a customerId. Previously duplicated (routes/auth.ts
 * ensureWorkspaceAndLeader, routes/customerUsers.ts ensureWorkspace) with two
 * independent $setOnInsert blocks — same drift shape as the requireWorkspace
 * vs /auth/me bug fixed earlier on this branch. Both call sites now delegate
 * the "does the workspace doc exist, and does it have a real companyName"
 * concern here; each keeps its OWN additional behavior (auth.ts also upserts
 * a CustomerMember; customerUsers.ts also heals legacy allowlist field
 * types) on top of this shared core — those weren't merged, only the
 * workspace-creation logic that had actually drifted.
 *
 * companyName: set from Customer.legalName (falling back to name/companyName)
 * on insert, AND filled once for a pre-existing doc if it's still empty.
 * Safe to fill-if-empty: the only place companyName is user-editable is
 * PUT /api/workspace/branding, which enforces a 2-100 char length — so an
 * empty companyName can only mean "never set," never a deliberate customer
 * edit. Never overwrites a non-empty value.
 */
export async function ensureCustomerWorkspace(customerId: string): Promise<CustomerWorkspaceDocument> {
  const cid = String(customerId || "").trim();

  const customer: any = await Customer.findById(cid).select("legalName name companyName workspaceId").lean();
  const realCompanyName = String(customer?.legalName || customer?.name || customer?.companyName || "").trim();

  let ws: any = await CustomerWorkspace.findOneAndUpdate(
    { customerId: cid },
    {
      $setOnInsert: {
        customerId: cid,
        allowedDomains: [],
        allowedEmails: [],
        defaultApproverEmails: [],
        canApproverCreateUsers: true,
        userCreationEnabled: false,
        accessMode: "INVITE_ONLY",
        userCreationAllowlistEmails: [],
        userCreationAllowlistDomains: [],
        userCreationAllowlistUpdatedBy: "",
        userCreationAllowlistUpdatedAt: null,
        status: "ACTIVE",
        ...(realCompanyName ? { companyName: realCompanyName } : {}),
      },
    },
    { upsert: true, new: true },
  ).exec();

  if (!ws.companyName && realCompanyName) {
    ws = (await CustomerWorkspace.findOneAndUpdate(
      { _id: ws._id, $or: [{ companyName: { $exists: false } }, { companyName: "" }] },
      { $set: { companyName: realCompanyName } },
      { new: true },
    ).exec()) || ws;
  }

  // Self-healing: Customer.workspaceId must always equal its own
  // CustomerWorkspace._id — nothing else in this codebase gives it a
  // different meaning. This function is the one chokepoint every customer
  // session passes through (called on login via auth.ts/customerUsers.ts),
  // so reconciling here closes the loop on any writer — past, present, or a
  // future one nobody's found yet — that creates/updates a Customer with the
  // wrong or missing workspaceId. Compares rather than only filling in blank,
  // since the actual bug this fixes is a WRONG stamped value (the internal
  // HOUSE workspace), not just a missing one.
  if (customer && String(customer.workspaceId || "") !== String(ws._id)) {
    await Customer.findByIdAndUpdate(cid, { $set: { workspaceId: ws._id } });
  }

  return ws;
}
