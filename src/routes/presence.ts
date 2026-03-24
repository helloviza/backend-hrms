import { Router } from "express";
import requireAuth from "../middleware/auth.js";
import requireRoles from "../middleware/roles.js";
import UserPresence from "../models/UserPresence.js";
import Employee from "../models/Employee.js";

const r = Router();

r.use(requireAuth);

/** Fields that mark a user as vendor or customer (not staff) */
function isNonStaff(u: any): boolean {
  if (!u) return true;
  if (!u.name) return true; // ghost account

  const at = String(u.accountType || "").toLowerCase();
  const ut = String(u.userType || "").toLowerCase();
  if (at === "vendor" || at === "customer") return true;
  if (ut === "vendor" || ut === "customer") return true;

  if (u.vendorId || u.vendor_id) return true;
  if (u.businessId || u.customerId || u.clientId || u.companyId) return true;

  return false;
}

r.get("/team", requireRoles("MANAGER", "ADMIN", "SUPERADMIN"), async (_req, res, next) => {
  try {
    const docs = await UserPresence.find()
      .populate(
        "userId",
        "name email avatarKey department designation accountType userType vendorId vendor_id businessId customerId clientId companyId"
      )
      .lean();

    const now = Date.now();

    // Filter to staff-only, exclude ghosts/vendors/customers
    const staffDocs = docs.filter((doc: any) => !isNonStaff(doc.userId));

    // Collect user IDs for Employee lookup
    const userIds = staffDocs.map((d: any) => d.userId?._id ?? d.userId);
    const employees = await Employee.find({ ownerId: { $in: userIds } })
      .select("ownerId department designation")
      .lean();

    const empMap = new Map<string, any>();
    for (const emp of employees) {
      if (emp.ownerId) empMap.set(String(emp.ownerId), emp);
    }

    const result = staffDocs.map((doc: any) => {
      const lastMs = new Date(doc.lastActivity).getTime();
      const diffSec = (now - lastMs) / 1000;

      let status: "ACTIVE" | "IDLE" | "OFFLINE";
      if (diffSec < 60) {
        status = "ACTIVE";
      } else if (diffSec < 180) {
        status = "IDLE";
      } else {
        status = "OFFLINE";
      }

      const uid = String(doc.userId?._id ?? doc.userId);
      const emp = empMap.get(uid);

      return {
        userId: doc.userId?._id ?? doc.userId,
        name: doc.userId?.name ?? "Unknown",
        email: doc.userId?.email ?? "",
        avatarKey: doc.userId?.avatarKey || null,
        department: doc.userId?.department || emp?.department || null,
        designation: doc.userId?.designation || emp?.designation || null,
        status,
        lastActivity: doc.lastActivity,
        idleDuration: doc.idleDuration,
      };
    });

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

export default r;
