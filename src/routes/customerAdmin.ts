import { Router } from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import requireAuth from "../middleware/auth.js";
import User from "../models/User.js";
import { scopedFindById } from "../middleware/scopedFindById.js";
import CustomerWhitelistDomain from "../models/CustomerWhitelistDomain.js";
import CustomerWhitelistEmail from "../models/CustomerWhitelistEmail.js";
import MasterData from "../models/MasterData.js";
import { requireCustomer, requireHrmsAdmin, resolveCustomerWorkspaceId, assertWorkspaceEmailAllowed } from "../middleware/customerApprovalGuard.js";

const r = Router();

const toId = (v: any) => (mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(v) : null);

function normalizeEmail(e: string) { return String(e || "").trim().toLowerCase(); }
function getEmailDomain(email: string) {
  const m = normalizeEmail(email).match(/@([a-z0-9.-]+\.[a-z]{2,})$/i);
  return m ? m[1] : null;
}

/**
 * Workspace resolver:
 * - Customer: derive from token/user
 * - Admin: allow explicit workspaceId
 */
async function getWorkspaceId(req: any): Promise<string> {
  const role = String(req.user?.role || "").toUpperCase();
  const isAdmin =
    (req.user?.roles || []).includes("ADMIN") ||
    (req.user?.roles || []).includes("SUPERADMIN") ||
    role === "ADMIN" || role === "SUPERADMIN";

  if (isAdmin && req.query.workspaceId && mongoose.isValidObjectId(req.query.workspaceId)) {
    return String(req.query.workspaceId);
  }

  const wid = await resolveCustomerWorkspaceId(req.user);
  if (!wid) throw new Error("Workspace not found for this user");
  return wid;
}

/* -------------------- WHITELIST DOMAINS -------------------- */
r.get("/whitelist/domains", requireAuth, requireCustomer, async (req: any, res, next) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    const rows = await CustomerWhitelistDomain.find({ workspaceId }).sort({ createdAt: -1 }).lean();
    res.json({ rows });
  } catch (e) { next(e); }
});

r.post("/whitelist/domains", requireAuth, requireCustomer, async (req: any, res, next) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    const domain = String(req.body?.domain || "").trim().toLowerCase();
    if (!domain) return res.status(400).json({ error: "domain required" });

    const doc = await CustomerWhitelistDomain.create({
      workspaceId,
      domain,
      createdBy: req.user?.sub || req.user?.id,
    });
    res.json({ ok: true, doc });
  } catch (e: any) {
    if (e?.code === 11000) return res.status(409).json({ error: "Domain already exists" });
    next(e);
  }
});

r.delete("/whitelist/domains/:id", requireAuth, requireCustomer, async (req: any, res, next) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    await CustomerWhitelistDomain.deleteOne({ _id: req.params.id, workspaceId });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* -------------------- WHITELIST EMAILS (exceptions) -------------------- */
r.get("/whitelist/emails", requireAuth, requireCustomer, async (req: any, res, next) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    const rows = await CustomerWhitelistEmail.find({ workspaceId }).sort({ createdAt: -1 }).lean();
    res.json({ rows });
  } catch (e) { next(e); }
});

r.post("/whitelist/emails", requireAuth, requireCustomer, async (req: any, res, next) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    const email = normalizeEmail(req.body?.email || "");
    if (!email) return res.status(400).json({ error: "email required" });

    const doc = await CustomerWhitelistEmail.create({
      workspaceId,
      email,
      createdBy: req.user?.sub || req.user?.id,
    });
    res.json({ ok: true, doc });
  } catch (e: any) {
    if (e?.code === 11000) return res.status(409).json({ error: "Email already exists" });
    next(e);
  }
});

r.delete("/whitelist/emails/:id", requireAuth, requireCustomer, async (req: any, res, next) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    await CustomerWhitelistEmail.deleteOne({ _id: req.params.id, workspaceId });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* -------------------- SET APPROVER (L2) --------------------
   Stored inside MasterData.payload.approverUserId for workspace.
*/
r.get("/settings", requireAuth, requireCustomer, async (req: any, res, next) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    const ws = await MasterData.findOne({ _id: workspaceId, type: "Business" }).lean();
    const approverUserId = ws?.payload?.approverUserId || null;
    res.json({ workspaceId, approverUserId });
  } catch (e) { next(e); }
});

r.put("/settings/approver", requireAuth, requireCustomer, async (req: any, res, next) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    const approverUserId = String(req.body?.approverUserId || "").trim();
    if (!mongoose.isValidObjectId(approverUserId)) {
      return res.status(400).json({ error: "approverUserId required" });
    }

    // ensure approver belongs to same workspace
    const u: any = await scopedFindById(User, approverUserId, workspaceId);
    if (!u) return res.status(404).json({ error: "Approver user not found" });
    if (String(u.customerWorkspaceId || "") !== String(workspaceId)) {
      return res.status(400).json({ error: "Approver must belong to the same workspace" });
    }

    await MasterData.updateOne(
      { _id: workspaceId, type: "Business" },
      { $set: { "payload.approverUserId": approverUserId } }
    );

    res.json({ ok: true, workspaceId, approverUserId });
  } catch (e) { next(e); }
});

/* -------------------- CREATE SUB CUSTOMER USERS (L1/L2) --------------------
   Body: { name, email, level: "L1"|"L2" }
*/
r.post("/users", requireAuth, requireCustomer, async (req: any, res, next) => {
  try {
    const workspaceId = await getWorkspaceId(req);

    const name = String(req.body?.name || "").trim();
    const email = normalizeEmail(req.body?.email || "");
    const level = String(req.body?.level || "L1").toUpperCase();

    if (!name || !email) return res.status(400).json({ error: "name & email required" });
    if (!["L1", "L2"].includes(level)) return res.status(400).json({ error: "level must be L1 or L2" });

    // enforce whitelist BEFORE creating user
    await assertWorkspaceEmailAllowed(workspaceId, email);

    // create temp password
    const tempPassword = Math.random().toString(36).slice(-10);
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    // roles
    const roles = ["CUSTOMER", level === "L2" ? "CUSTOMER_APPROVER" : "CUSTOMER_REQUESTER"];

    const existing = await User.findOne({ $or: [{ email }, { officialEmail: email }, { personalEmail: email }] });
    if (existing) return res.status(409).json({ error: "User already exists with this email" });

    const user: any = await User.create({
      email,
      officialEmail: email,
      personalEmail: email,
      firstName: name,
      lastName: "",
      roles,
      passwordHash,

      // IMPORTANT: workspace binding for sub-users
      customerWorkspaceId: toId(workspaceId),
    });

    res.json({
      ok: true,
      user: { _id: user._id, email: user.email, roles: user.roles, customerWorkspaceId: user.customerWorkspaceId },
      tempPassword,
    });
  } catch (e) { next(e); }
});

/* -------------------- PLATFORM ADMIN OVERRIDE -------------------- */
r.put("/admin/workspace-approver", requireAuth, requireHrmsAdmin, async (req: any, res, next) => {
  try {
    const workspaceId = String(req.body?.workspaceId || "").trim();
    const approverUserId = String(req.body?.approverUserId || "").trim();

    if (!mongoose.isValidObjectId(workspaceId) || !mongoose.isValidObjectId(approverUserId)) {
      return res.status(400).json({ error: "workspaceId & approverUserId required" });
    }

    await MasterData.updateOne(
      { _id: workspaceId, type: "Business" },
      { $set: { "payload.approverUserId": approverUserId } }
    );

    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
