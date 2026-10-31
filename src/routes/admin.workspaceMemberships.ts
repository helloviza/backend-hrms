// apps/backend/src/routes/admin.workspaceMemberships.ts
//
// Company switcher Phase 4 — Plumtrips staff add an EXISTING login to another
// customer company (docs/audits/multi-workspace-login-audit.md §4, §6, §8.5).
//
//   GET   /api/admin/workspace-memberships?workspaceId=|customerId=
//         second-company members of that company (not the people whose User
//         document already describes it — they are managed as today)
//   POST  /api/admin/workspace-memberships {email, workspaceId|customerId, memberRole, roles?, flags?}
//         one ACTIVE CUSTOMER membership + the company's CustomerMember row
//         (an existing row is reused). The password is never touched: the
//         email says "sign in with your existing password" and carries no
//         reset link (§6).
//   PATCH /api/admin/workspace-memberships/:id {status: ACTIVE|SUSPENDED|REMOVED}
//         suspend / remove bumps tokenVersion, so that company's open
//         sessions end (refresh at once, open access tokens within the 60s
//         membership cache).
//
// Mounted behind requireAuth + requireWorkspace + requireHouse; ADMIN /
// SUPERADMIN only. 404 FEATURE_DISABLED unless MULTI_WORKSPACE_LOGIN=true.
import { Router } from "express";
import mongoose from "mongoose";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import CustomerMember from "../models/CustomerMember.js";
import Customer from "../models/Customer.js";
import WorkspaceMembership, { MEMBER_ROLES, type MembershipMemberRole } from "../models/WorkspaceMembership.js";
import { clearMembershipCache } from "../middleware/requireWorkspace.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import { findUserByLoginEmail } from "../utils/loginEmailLookup.js";
import { isLoginDisabled } from "../utils/loginDisabled.js";
import { isUserActive } from "../utils/userActiveStatus.js";
import { generateTravelerId } from "../utils/travelerId.js";
import { publicAppUrl } from "../utils/publicAppUrl.js";
import { sendMail } from "../utils/mailer.js";
import { authLogger } from "../utils/logger.js";
import { isOwnCompany } from "../services/activeMembership.js";
import { multiWorkspaceLoginEnabled, switchIneligibleReason } from "../services/workspaceSwitch.service.js";

const router = Router();

const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";
const CUSTOMER_ROLES = ["CUSTOMER", "WORKSPACE_LEADER", "APPROVER", "REQUESTER"];

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function actorId(req: any): string {
  return str(req.user?._id ?? req.user?.id ?? req.user?.sub);
}

router.use((req: any, res, next) => {
  if (!multiWorkspaceLoginEnabled()) return res.status(404).json({ error: "Not found", code: "FEATURE_DISABLED" });
  const roles = (Array.isArray(req.user?.roles) ? req.user.roles : []).map((r: unknown) => str(r).toUpperCase());
  if (!isSuperAdmin(req) && !roles.includes("ADMIN")) return res.status(403).json({ error: "Admin access required" });
  next();
});

/** The customer company named by workspaceId or customerId, or a refusal. */
async function targetWorkspace(q: any): Promise<{ ws: any } | { status: number; code: string; error: string }> {
  const wsId = str(q?.workspaceId);
  const custId = str(q?.customerId);
  let ws: any = null;
  if (wsId && mongoose.isValidObjectId(wsId)) ws = await CustomerWorkspace.findById(wsId).select("_id customerId companyName name status").lean();
  else if (custId) ws = await CustomerWorkspace.findOne({ customerId: custId }).select("_id customerId companyName name status").lean();
  else return { status: 400, code: "WORKSPACE_REQUIRED", error: "workspaceId or customerId is required" };
  if (!ws || !str(ws.customerId)) return { status: 404, code: "WORKSPACE_NOT_FOUND", error: "No customer company with that id" };
  if (str(ws._id) === HOUSE_WORKSPACE_ID) return { status: 400, code: "HOUSE_WORKSPACE", error: "Plumtrips staff cannot be added this way" };
  return { ws };
}

function companyName(ws: any): string {
  return str(ws.companyName) || str(ws.name) || "your company";
}

function rolesFor(memberRole: MembershipMemberRole, requested: unknown): string[] | null {
  const out: string[] = [];
  if (requested !== undefined) {
    if (!Array.isArray(requested)) return null;
    for (const r of requested) {
      const v = str(r).toUpperCase();
      if (!CUSTOMER_ROLES.includes(v)) return null;
      if (!out.includes(v)) out.push(v);
    }
  }
  if (memberRole === "REQUESTER" && !out.length) out.push("CUSTOMER");
  if (memberRole !== "REQUESTER" && !out.includes(memberRole)) out.push(memberRole);
  return out;
}

function flagsFor(raw: unknown): Record<string, unknown> | null {
  const f: any = raw && typeof raw === "object" ? raw : {};
  const out: Record<string, unknown> = {
    sbtEnabled: false,
    sbtBookingType: "both",
    sbtRole: null,
    bandNumber: null,
    canRaiseRequest: true,
    canViewBilling: false,
    canManageUsers: false,
  };
  for (const k of ["sbtEnabled", "canRaiseRequest", "canViewBilling", "canManageUsers"]) {
    if (f[k] === undefined) continue;
    if (typeof f[k] !== "boolean") return null;
    out[k] = f[k];
  }
  if (f.sbtBookingType !== undefined) {
    if (!["flight", "hotel", "both"].includes(f.sbtBookingType)) return null;
    out.sbtBookingType = f.sbtBookingType;
  }
  if (f.sbtRole !== undefined) {
    if (![null, "L1", "L2", "BOTH"].includes(f.sbtRole)) return null;
    out.sbtRole = f.sbtRole;
  }
  if (f.bandNumber !== undefined) {
    if (f.bandNumber !== null && !(Number.isInteger(f.bandNumber) && f.bandNumber >= 1 && f.bandNumber <= 10)) return null;
    out.bandNumber = f.bandNumber;
  }
  return out;
}

/** The company's roster row for this person: reuse it if present, else create it. */
async function upsertCustomerMember(ws: any, user: any, memberRole: MembershipMemberRole, actor: string) {
  const customerId = str(ws.customerId);
  const email = str(user.email).toLowerCase();
  const rx = new RegExp(`^${escapeRegExp(email)}$`, "i");
  const name = str(user.name) || [str(user.firstName), str(user.lastName)].filter(Boolean).join(" ");

  const existing: any = await CustomerMember.findOne({ customerId, email: rx }).select("_id name").lean();
  if (existing) {
    const $set: any = { role: memberRole, isActive: true };
    if (!str(existing.name) && name) $set.name = name;
    await CustomerMember.updateOne({ _id: existing._id }, { $set });
    return existing._id;
  }

  const customer: any = mongoose.isValidObjectId(customerId)
    ? await Customer.findById(customerId).select("legalName name companyName").lean()
    : null;
  const travelerId = await generateTravelerId(customerId, customer?.legalName || customer?.name || customer?.companyName || companyName(ws));
  const doc: any = { customerId, email, role: memberRole, isActive: true, createdBy: `admin.workspace-memberships:${actor}`, invitedAt: new Date() };
  if (name) doc.name = name;
  try {
    return (await CustomerMember.create({ ...doc, travelerId }))._id;
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
    // A concurrent insert of the same person, or a travelerId collision.
    const again: any = await CustomerMember.findOne({ customerId, email: rx }).select("_id").lean();
    if (again) return again._id;
    return (await CustomerMember.create(doc))._id;
  }
}

async function sendAddedEmail(user: any, ws: any) {
  const company = companyName(ws);
  const first = str(user.firstName) || str(user.name).split(" ")[0] || "";
  const link = `${publicAppUrl()}/login`;
  await sendMail({
    to: str(user.email).toLowerCase(),
    subject: `You've been added to ${company} on Plumbox`,
    kind: "CONFIRMATIONS",
    html: `
      <p>Hi${first ? ` ${esc(first)}` : ""},</p>
      <p>You've been added to <strong>${esc(company)}</strong> on Plumbox.</p>
      <p>Sign in with your existing email and password. When you sign in you can choose which company to work in, and switch between them from the top bar at any time.</p>
      <p><a href="${esc(link)}">Sign in to Plumbox</a></p>
      <p>Your password has not changed. If you weren't expecting this, contact your Plumtrips account manager.</p>
      <p>— Plumtrips</p>
    `,
  });
}

function view(m: any, u: any) {
  return {
    id: str(m._id),
    userId: str(m.userId),
    email: str(u?.email),
    name: str(u?.name) || [str(u?.firstName), str(u?.lastName)].filter(Boolean).join(" "),
    workspaceId: str(m.workspaceId),
    memberRole: m.memberRole ?? null,
    roles: m.roles || [],
    flags: m.flags || {},
    status: m.status,
    createdAt: m.createdAt ?? null,
    removedAt: m.removedAt ?? null,
  };
}

/* GET — second-company members of one company. */
router.get("/", async (req: any, res, next) => {
  try {
    const t = await targetWorkspace(req.query);
    if (!("ws" in t)) return res.status(t.status).json({ error: t.error, code: t.code });
    const ms: any[] = await WorkspaceMembership.find({ workspaceId: t.ws._id, isDefault: { $ne: true } }).sort({ createdAt: -1 }).lean();
    const users: any[] = ms.length
      ? await User.find({ _id: { $in: ms.map((m) => m.userId) } }).select("_id email name firstName lastName customerId").lean()
      : [];
    const byId = new Map(users.map((u) => [str(u._id), u]));
    const members = ms
      .filter((m) => byId.has(str(m.userId)) && !isOwnCompany(m, byId.get(str(m.userId))))
      .map((m) => view(m, byId.get(str(m.userId))));
    res.json({ workspaceId: str(t.ws._id), companyName: companyName(t.ws), members });
  } catch (err) {
    next(err);
  }
});

/* POST — add an existing login to this company. */
router.post("/", async (req: any, res, next) => {
  try {
    const body = req.body || {};
    const email = str(body.email).toLowerCase();
    if (!email) return res.status(400).json({ error: "email is required", code: "EMAIL_REQUIRED" });

    const memberRole = str(body.memberRole).toUpperCase() as MembershipMemberRole;
    if (!(MEMBER_ROLES as readonly string[]).includes(memberRole)) {
      return res.status(400).json({ error: `memberRole must be one of ${MEMBER_ROLES.join(", ")}`, code: "BAD_MEMBER_ROLE" });
    }
    const roles = rolesFor(memberRole, body.roles);
    if (!roles) return res.status(400).json({ error: `roles may only contain ${CUSTOMER_ROLES.join(", ")}`, code: "BAD_ROLES" });
    const flags = flagsFor(body.flags);
    if (!flags) return res.status(400).json({ error: "flags contain an invalid value", code: "BAD_FLAGS" });

    const t = await targetWorkspace(body);
    if (!("ws" in t)) return res.status(t.status).json({ error: t.error, code: t.code });
    const ws = t.ws;
    if (ws.status !== "ACTIVE") return res.status(409).json({ error: "That company is not active", code: "WORKSPACE_INACTIVE" });

    // An existing login only — this route never creates users or passwords.
    const { user, ambiguous } = await findUserByLoginEmail(email, { context: "admin.workspace-memberships" });
    if (ambiguous) return res.status(409).json({ error: "More than one account uses that email", code: "AMBIGUOUS_EMAIL" });
    if (!user || isLoginDisabled(user)) {
      return res.status(404).json({ error: "No existing Plumbox login with that email. Invite them as a new user instead.", code: "USER_NOT_FOUND" });
    }
    if (!isUserActive(user)) return res.status(409).json({ error: "That login is deactivated", code: "USER_INACTIVE" });
    const why = switchIneligibleReason(user);
    if (why) return res.status(409).json({ error: `This login cannot join a second company (${why})`, code: "USER_NOT_ELIGIBLE" });
    if (!str((user as any).customerId)) {
      // Login would otherwise adopt the new company as their only one.
      return res.status(409).json({ error: "This login has no home company yet. Ask them to sign in once first.", code: "NO_HOME_COMPANY" });
    }
    if (str((user as any).customerId) === str(ws.customerId)) {
      return res.status(409).json({ error: "This person already belongs to that company", code: "OWN_COMPANY" });
    }

    const existing: any = await WorkspaceMembership.findOne({ userId: user._id, workspaceId: ws._id }).lean();
    if (existing?.isDefault) return res.status(409).json({ error: "This person already belongs to that company", code: "OWN_COMPANY" });
    if (existing?.status === "ACTIVE") return res.status(409).json({ error: "Already a member of that company", code: "ALREADY_MEMBER" });

    const actor = actorId(req);
    const customerMemberId = await upsertCustomerMember(ws, user, memberRole, actor);

    let m: any;
    let reactivated = false;
    if (existing) {
      // SUSPENDED / REMOVED → back to ACTIVE; tokenVersion was bumped when it ended.
      m = await WorkspaceMembership.findByIdAndUpdate(
        existing._id,
        { $set: { status: "ACTIVE", roles, memberRole, flags, customerMemberId, customerId: str(ws.customerId), removedAt: null, removedBy: null } },
        { new: true },
      ).lean();
      reactivated = true;
    } else {
      try {
        m = (
          await WorkspaceMembership.create({
            userId: user._id,
            workspaceId: ws._id,
            customerId: str(ws.customerId),
            kind: "CUSTOMER",
            roles,
            memberRole,
            customerMemberId,
            flags,
            status: "ACTIVE",
            isDefault: false,
            tokenVersion: 0,
            invitedBy: mongoose.isValidObjectId(actor) ? actor : null,
          })
        ).toObject();
      } catch (err: any) {
        if (err?.code === 11000) return res.status(409).json({ error: "Already a member of that company", code: "ALREADY_MEMBER" });
        throw err;
      }
    }
    clearMembershipCache(str(m._id));

    let emailed = true;
    try {
      await sendAddedEmail(user, ws);
    } catch (err: any) {
      emailed = false;
      authLogger.error("Added-to-company email failed", { userId: str(user._id), workspaceId: str(ws._id), error: err?.message });
    }

    authLogger.info("Membership added", { actorId: actor, userId: str(user._id), workspaceId: str(ws._id), memberRole, reactivated });
    res.status(reactivated ? 200 : 201).json({ ok: true, reactivated, emailed, membership: view(m, user) });
  } catch (err) {
    next(err);
  }
});

/* PATCH /:id — suspend, remove or reactivate a second-company membership. */
router.patch("/:id", async (req: any, res, next) => {
  try {
    const id = str(req.params.id);
    const status = str(req.body?.status).toUpperCase();
    if (!["ACTIVE", "SUSPENDED", "REMOVED"].includes(status)) {
      return res.status(400).json({ error: "status must be ACTIVE, SUSPENDED or REMOVED", code: "BAD_STATUS" });
    }
    const m: any = mongoose.isValidObjectId(id) ? await WorkspaceMembership.findById(id).lean() : null;
    if (!m) return res.status(404).json({ error: "Membership not found", code: "NOT_FOUND" });
    const user: any = await User.findById(m.userId).select("_id email name firstName lastName customerId").lean();
    // The home company is managed through the person's User record, as today.
    if (m.isDefault || !user || isOwnCompany(m, user)) {
      return res.status(409).json({ error: "That is this person's home company; manage it from their user record", code: "HOME_MEMBERSHIP" });
    }
    if (m.status === status) return res.json({ ok: true, unchanged: true, membership: view(m, user) });

    const actor = actorId(req);
    const update: any =
      status === "ACTIVE"
        ? { $set: { status, removedAt: null, removedBy: null } }
        : {
            $set: {
              status,
              ...(status === "REMOVED"
                ? { removedAt: new Date(), removedBy: mongoose.isValidObjectId(actor) ? actor : null }
                : {}),
            },
            // Ends this company's open sessions (refresh + requireWorkspace check mver).
            $inc: { tokenVersion: 1 },
          };
    const updated: any = await WorkspaceMembership.findByIdAndUpdate(m._id, update, { new: true }).lean();
    clearMembershipCache(str(m._id));
    // The company's roster row follows (approvals stop routing to a suspended
    // member). Rows linked before customerMemberId existed: by company + email.
    const rosterFilter: any = m.customerMemberId
      ? { _id: m.customerMemberId }
      : str(m.customerId) && str(user.email)
        ? { customerId: str(m.customerId), email: new RegExp(`^${escapeRegExp(str(user.email))}$`, "i") }
        : null;
    if (rosterFilter) await CustomerMember.updateOne(rosterFilter, { $set: { isActive: status === "ACTIVE" } });

    authLogger.info("Membership status changed", { actorId: actor, membershipId: id, userId: str(m.userId), from: m.status, to: status });
    res.json({ ok: true, membership: view(updated, user) });
  } catch (err) {
    next(err);
  }
});

export default router;
