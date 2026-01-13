import mongoose from "mongoose";
import MasterData from "../models/MasterData.js";
import CustomerWhitelistDomain from "../models/CustomerWhitelistDomain.js";
import CustomerWhitelistEmail from "../models/CustomerWhitelistEmail.js";

function normalizeEmail(e: string) {
  return String(e || "").trim().toLowerCase();
}

function getEmailDomain(email: string) {
  const m = normalizeEmail(email).match(/@([a-z0-9.-]+\.[a-z]{2,})$/i);
  return m ? m[1] : null;
}

function hasRole(user: any, role: string) {
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  const r0 = user?.role ? [user.role] : [];
  const all = [...roles, ...r0].map((x) => String(x).toUpperCase());
  return all.includes(String(role).toUpperCase());
}

/**
 * Resolve workspaceId for Customer:
 * - Prefer user.customerWorkspaceId (recommended for sub-users)
 * - Else fallback to MasterData(Business) match by email/ownerId (works for primary owner accounts)
 */
export async function resolveCustomerWorkspaceId(user: any): Promise<string | null> {
  const direct = user?.customerWorkspaceId || user?.workspaceId || null;
  if (direct && mongoose.isValidObjectId(direct)) return String(direct);

  const email = normalizeEmail(user?.email || user?.officialEmail || "");
  const ownerId = String(user?.sub || user?._id || user?.id || "");

  if (!email && !ownerId) return null;

  const or: any[] = [];
  if (email) {
    const rx = new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    or.push(
      { email: rx },
      { officialEmail: rx },
      { "payload.email": rx },
      { "payload.officialEmail": rx },
      { "payload.contact.email": rx }
    );
  }
  if (ownerId) {
    or.push({ ownerId }, { "payload.ownerId": ownerId }, { "payload.userId": ownerId });
  }

  const doc = await MasterData.findOne({ type: "Business", $or: or })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean()
    .exec();

  return doc?._id ? String(doc._id) : null;
}

/** Enforce workspace whitelist */
export async function assertWorkspaceEmailAllowed(workspaceId: string, email: string) {
  const e = normalizeEmail(email);
  const domain = getEmailDomain(e);
  if (!domain) throw new Error("Invalid email");

  const [emailOk, domainOk] = await Promise.all([
    CustomerWhitelistEmail.exists({ workspaceId, email: e }),
    CustomerWhitelistDomain.exists({ workspaceId, domain }),
  ]);

  // allow if either match exists
  if (!emailOk && !domainOk) {
    throw new Error("Email is not whitelisted for this workspace");
  }
  return true;
}

export function requireCustomer(req: any, res: any, next: any) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (!hasRole(req.user, "CUSTOMER")) {
    return res.status(403).json({ error: "Customer access only" });
  }
  next();
}

export function requireHrmsAdmin(req: any, res: any, next: any) {
  const ok =
    hasRole(req.user, "ADMIN") ||
    hasRole(req.user, "SUPERADMIN") ||
    hasRole(req.user, "SUPER_ADMIN") ||
    hasRole(req.user, "HR") ||
    hasRole(req.user, "HR_ADMIN");
  if (!ok) return res.status(403).json({ error: "Admin access required" });
  next();
}
