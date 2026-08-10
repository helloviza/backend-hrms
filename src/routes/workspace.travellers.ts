// apps/backend/src/routes/workspace.travellers.ts
//
// Traveller Profiles — Phase 1 (schema already in models/TravellerProfile.ts).
// CRUD + search, ownership bound in the Mongo filter (never a URL param),
// field-allowlisted list/search response (mirrors myBookings.ts's $project
// pattern — see docs/audits/traveller-profiles-scoping.md §4.3).
//
// Read-vs-write RBAC split (docs/prd/traveller-profiles.md §2):
//   - any active workspace member can search/select and view full detail of
//     ANY workspace traveller (booking a colleague's saved traveller needs
//     the real passport/DOB to populate the passenger form);
//   - WRITE (create/edit/delete) is gated: WORKSPACE_LEADER always,
//     APPROVER via the canApproverManageTravellers workspace flag (default
//     ON), REQUESTER only on records they created or are linked to.
// Self-linking (§1 of the design doc) happens ONLY via the explicit
// POST /:id/claim action — never inferred silently from an email match.
import { Router } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import TravellerProfile, { MEAL_PREFERENCE_CODES } from "../models/TravellerProfile.js";
import CustomerMember from "../models/CustomerMember.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import Department from "../models/Department.js";
import { mintTravellerProfileId } from "../utils/travelerId.js";
import { maskTailId } from "../utils/piiMask.js";
import { normalizeEmail, normalizeName, findMatchingTraveller, applyTravellerFields } from "../utils/travellerMatch.js";
// Self-service identity (2026-08-10). The nine-condition guard is SHARED with
// GET /api/visa/travellers/me/candidates — the tier that offers the button and
// the action behind it must never disagree.
// See infra/design/visa-self-service-identity-2026-08-10.md.
import { evaluateNameUniqueSelfConfirm } from "../services/travellerIdentity.service.js";
import { UserPermission, hasAccess } from "../models/UserPermission.js";
import logger from "../utils/logger.js";
import { parseCsv } from "../utils/csv.js";
import { autoCaptureTravellersFromBooking } from "../services/travellerAutoCapture.js";
import User from "../models/User.js";
import { isCstepAdmin } from "../utils/cstepAccess.js";
// Login auto-provisioning (CSTEP traveller-add addition) — reuses the exact
// same account-creation machinery the "add customer user" flow already
// uses, rather than a parallel auth path. See ensureCstepTravellerLogin below.
import { ensureAuthUserForCustomer, trySendInviteEmailSafe } from "./customerUsers.js";

const router = Router();
router.use(requireAuth, requireWorkspace);

/**
 * Structured audit trail for the two routes that CREATE an identity link
 * (self-confirm, link-member) — a LOG LINE, deliberately not a collection.
 * There is no reviewer, no queue and no retention requirement attached to
 * these events; a collection would be a schema to migrate and a table nobody
 * reads. VisaActivityLog is not reused either: it is keyed to a requestId and
 * describes a visa case's history, and a claim happens before any case exists.
 */
const identityLogger = logger.child({ module: "traveller-identity" });

/* ── Helpers ─────────────────────────────────────────────────────── */

function normStr(v: any): string {
  return String(v ?? "").trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function actorUserId(req: any): string {
  return String(req.user?._id ?? req.user?.id ?? req.user?.sub ?? "");
}

type TravellerRole = "WORKSPACE_LEADER" | "APPROVER" | "REQUESTER";

function normalizeRole(v: any): TravellerRole | "" {
  const r = String(v || "").toUpperCase();
  return r === "WORKSPACE_LEADER" || r === "APPROVER" || r === "REQUESTER" ? r : "";
}

async function getActorMember(customerId: string, email: string) {
  return CustomerMember.findOne({ customerId, email: normalizeEmail(email) }).lean().exec();
}

async function getApproverCanManage(workspaceId: any): Promise<boolean> {
  const ws: any = await CustomerWorkspace.findById(workspaceId).select("canApproverManageTravellers").lean();
  return ws?.canApproverManageTravellers !== false; // default ON
}

type WriteAction = "create" | "edit" | "delete" | "bulk";

export function ensureTravellerWriteAccess(
  userId: string,
  member: any | null, // null = SUPERADMIN bypass path, already verified by the caller
  approverCanManage: boolean,
  traveller: any | null,
  action: WriteAction,
): { ok: true } | { ok: false; status: number; error: string } {
  if (!member) return { ok: true }; // SUPERADMIN

  const role = normalizeRole(member.role);
  if (!role) return { ok: false, status: 403, error: "Not a member of this workspace" };

  // Bulk import is stricter than a single Add — bulk-importing OTHER
  // people's records isn't something a REQUESTER should be able to do,
  // even though they can add a single traveller of their own.
  if (action === "bulk") {
    if (role === "WORKSPACE_LEADER") return { ok: true };
    if (role === "APPROVER") {
      return approverCanManage
        ? { ok: true }
        : { ok: false, status: 403, error: "Approvers cannot manage travellers in this workspace" };
    }
    return { ok: false, status: 403, error: "Only workspace leaders and approvers can bulk-import travellers" };
  }

  if (action === "create") return { ok: true };

  if (!traveller) return { ok: false, status: 404, error: "Traveller not found" };

  if (role === "WORKSPACE_LEADER") return { ok: true };

  if (role === "APPROVER") {
    if (!approverCanManage) {
      return { ok: false, status: 403, error: "Approvers cannot manage travellers in this workspace" };
    }
    return { ok: true };
  }

  // REQUESTER — only records they created, or are the linked subject of
  // (linked only ever via the explicit claim action, never inferred).
  const isOwner = String(traveller.createdBy) === userId;
  const isSubject = traveller.linkedMemberId && String(traveller.linkedMemberId) === String(member._id);
  if (isOwner || isSubject) return { ok: true };

  return { ok: false, status: 403, error: "You can only edit travellers you created or are linked to" };
}

/**
 * Advisory-only display flag ("should the UI offer a claim CTA") — the
 * claim route re-derives its own decision independently and never trusts
 * this. A profile already linked to ANYONE (self or another member) has
 * nothing left to claim, so this returns false either way; the route's own
 * check separately distinguishes "linked to you" (no-op) from "linked to
 * someone else" (409) since only the route needs that distinction.
 */
function canClaimTraveller(actorEmail: string, memberId: any, traveller: any): boolean {
  if (!memberId) return false;
  if (traveller.linkedMemberId) return false;
  const travellerEmail = normalizeEmail(traveller.email);
  const mine = normalizeEmail(actorEmail);
  return !!travellerEmail && travellerEmail === mine;
}

async function requireActiveMember(req: any, res: any): Promise<{ member: any | null } | null> {
  if (isSuperAdmin(req)) return { member: null };

  const customerId = req.workspace?.customerId;
  const member = await getActorMember(String(customerId), req.user?.email);
  if (!member || member.isActive === false) {
    res.status(403).json({ error: "Not a member of this workspace" });
    return null;
  }
  return { member };
}

/**
 * requireWorkspace's SUPERADMIN bypass only attaches req.workspaceObjectId
 * when an explicit workspaceId is present in body/query/params/header or the
 * JWT — a SUPERADMIN session with none of those (e.g. hitting this router
 * from a page that never sends one, like the SBT passenger typeahead) sails
 * through requireActiveMember (which no-ops for SUPERADMIN) with
 * req.workspaceObjectId left undefined. Every query below scopes by
 * workspaceId, and an undefined value there doesn't broaden the search —
 * it makes every route silently behave as "no travellers" instead of
 * failing loudly. Call this right after the access gate on every handler
 * that touches TravellerProfile so that failure mode is a clear 400
 * instead of a quiet empty result indistinguishable from "no matches".
 */
function requireWorkspaceContext(req: any, res: any): boolean {
  if (req.workspaceObjectId) return true;
  res.status(400).json({
    error: "No workspace context. SUPERADMIN: pass workspaceId in body, query, or x-workspace-id header.",
  });
  return false;
}

/**
 * Reuses the linked CustomerMember's existing travelerId when one is being
 * assigned at create time, so the same person doesn't end up with two IDs
 * across CustomerMember and TravellerProfile. Otherwise mints a new one
 * scoped to this collection's own per-workspace counter.
 */
async function issueTravelerId(workspaceId: any, customerId: any, linkedMemberId?: string): Promise<string> {
  if (linkedMemberId) {
    const linked: any = await CustomerMember.findOne({ _id: linkedMemberId, customerId })
      .select("travelerId")
      .lean();
    if (linked?.travelerId) return linked.travelerId;
  }
  return mintTravellerProfileId(workspaceId, customerId);
}

function applyFrequentFlyer(input: any): { airline?: string; number?: string }[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((f: any) => ({ airline: normStr(f?.airline), number: normStr(f?.number) }))
    .filter((f) => f.airline || f.number);
}

/**
 * CSTEP traveller login auto-provisioning (additive). When a traveller with
 * an email is added (single Add Traveller or Bulk Import), ensures they
 * have a real login in this workspace so they can immediately file for
 * themselves and be selected in the Approver/Official user/Finance user
 * dropdowns (which read straight from User.find({workspaceId}) — see
 * GET /tour-approver-candidates).
 *
 * Reuses customerUsers.ts's existing account-creation flow exactly —
 * ensureAuthUserForCustomer (idempotent: scoped-then-global lookup by
 * email, adopts an existing User rather than duplicating, issues a random
 * temp password only when actually creating) and trySendInviteEmailSafe
 * (the same best-effort invite email that flow already sends) — no new
 * auth path, no new credential mechanism.
 *
 * Also upserts a matching CustomerMember role record — same pairing
 * customerUsers.ts's own add-member routes always do — but ONLY on first
 * insert ($setOnInsert), and only defaults to REQUESTER (the lowest-
 * privilege customer role): being saved as a CSTEP traveller is not itself
 * an Approver/WorkspaceLeader grant, and an existing member's role/status
 * must never be silently touched just because they were also added here.
 *
 * Returns the linked User's id (for the caller to set claimedBy), or null
 * with a human-readable note when no login could be created/linked (no
 * email on the row, or the email already belongs to a different
 * workspace's account — customerUsers.ts's own cross-tenant safety refusal,
 * reused as-is).
 *
 * Exported so the one-time backfill migration (migrations/2026-07-26-
 * backfill-cstep-traveller-logins.ts) can reuse this exact same path for
 * travellers created before this auto-provisioning existed, instead of
 * hand-rolling a second account-creation flow. `sendInvite` (default true,
 * so the single Add Traveller / Bulk Import call sites above are byte-for-
 * byte unchanged) lets the migration opt OUT of the invite email — a
 * one-time backfill over potentially many already-active people should not
 * re-invite them; they already have a workspace login, which is the point.
 */
export async function ensureCstepTravellerLogin(params: {
  email: string;
  name?: string;
  customerId: string;
  workspaceId: any;
  inviterEmail?: string;
  sendInvite?: boolean;
}): Promise<{ userId: string | null; created: boolean; note?: string }> {
  const email = normalizeEmail(params.email);
  if (!email) return { userId: null, created: false, note: "No email — login not created" };

  await CustomerMember.findOneAndUpdate(
    { customerId: params.customerId, email },
    {
      $setOnInsert: {
        customerId: params.customerId,
        email,
        name: params.name || undefined,
        role: "REQUESTER",
        isActive: true,
      },
    },
    { upsert: true },
  ).exec();

  const { user, created, conflict } = await ensureAuthUserForCustomer({
    email,
    name: params.name,
    customerId: params.customerId,
    workspaceId: params.workspaceId,
    memberRole: "REQUESTER",
    passwordPlain: null,
    managerUser: null,
  });

  if (conflict || !user) {
    return { userId: null, created: false, note: "This email already has a login in a different workspace — not linked" };
  }

  if (created && params.sendInvite !== false) {
    // Best-effort, same mechanism the existing "add customer user" flow
    // already uses — never blocks/fails the traveller add. Only sent for a
    // genuinely NEW login; an already-existing account (the idempotent
    // "just link them" case) is not re-invited. The backfill migration
    // passes sendInvite: false — see this function's doc comment.
    await trySendInviteEmailSafe({
      to: email,
      customerId: params.customerId,
      inviterEmail: params.inviterEmail || "",
      inviteeName: params.name,
    }).catch(() => undefined);
  }

  return { userId: String(user._id), created };
}

const EDITABLE_STRING_FIELDS = [
  "title", "firstName", "middleName", "lastName", "gender", "dob", "nationality",
  "passportNo", "passportExpiry", "passportIssueCountry", "passportIssueDate", "mobile",
] as const;

/* ── GET / — search / list (allowlisted, masked passport) ──────────── */

router.get("/", async (req: any, res: any) => {
  try {
    const gate = await requireActiveMember(req, res);
    if (!gate) return;
    if (!requireWorkspaceContext(req, res)) return;
    const { member } = gate;

    const workspaceId = req.workspaceObjectId;
    const search = normStr(req.query.search);

    const filter: any = { workspaceId, isActive: true };
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      filter.$or = [{ firstName: re }, { lastName: re }, { email: re }];
    }

    const role = normalizeRole(member?.role);
    const approverCanManage = role === "APPROVER" ? await getApproverCanManage(workspaceId) : true;
    const uid = actorUserId(req);
    const actorEmail = req.user?.email;

    // Allowlisted projection — never a bare passengers/traveller-shaped
    // select; leaf fields only. passportNo/createdBy/linkedMemberId are
    // selected server-side purely to compute passportMasked/canManage/
    // isClaimable, then stripped before the response row is built — the
    // caller sees only the derived booleans, never the raw ownership ids.
    const docs = await TravellerProfile.find(filter)
      .select("travelerId firstName middleName lastName email mobile dob nationality passportNo createdBy linkedMemberId departmentId tourApproverId officialUserId financeUserId")
      .sort({ firstName: 1, lastName: 1 })
      .limit(100)
      .lean();

    // Department names for whatever this page happens to show. Looked up by
    // id AND workspaceId — a stale departmentId pointing outside this
    // workspace resolves to no name rather than leaking another tenant's.
    const deptIds = [...new Set((docs as any[]).map((d) => d.departmentId).filter(Boolean).map(String))];
    const deptNameById = new Map<string, string>();
    if (deptIds.length) {
      const depts = await Department.find({ _id: { $in: deptIds }, workspaceId }).select("_id name").lean();
      for (const d of depts as any[]) deptNameById.set(String(d._id), d.name);
    }

    const travellers = (docs as any[]).map((d) => ({
      _id: d._id,
      travelerId: d.travelerId,
      firstName: d.firstName,
      middleName: d.middleName,
      lastName: d.lastName,
      email: d.email,
      mobile: d.mobile,
      dob: d.dob,
      nationality: d.nationality,
      passportMasked: maskTailId(d.passportNo),
      departmentId: d.departmentId ? String(d.departmentId) : null,
      departmentName: d.departmentId ? deptNameById.get(String(d.departmentId)) ?? null : null,
      canManage: ensureTravellerWriteAccess(uid, member, approverCanManage, d, "edit").ok,
      isClaimable: canClaimTraveller(actorEmail, member?._id, d),
      // CSTEP Phase 5 (+ three-person mapping addition) — not sensitive (org
      // routing facts, not PII); the controls to CHANGE these stay
      // isCstepAdmin-gated on the dedicated PATCH /:id/tour-approver route
      // regardless of who can see this.
      tourApproverId: d.tourApproverId ? String(d.tourApproverId) : null,
      officialUserId: d.officialUserId ? String(d.officialUserId) : null,
      financeUserId: d.financeUserId ? String(d.financeUserId) : null,
    }));

    const capabilities = {
      canCreate: ensureTravellerWriteAccess(uid, member, approverCanManage, null, "create").ok,
      canBulkImport: ensureTravellerWriteAccess(uid, member, approverCanManage, null, "bulk").ok,
    };

    res.json({ ok: true, travellers, capabilities });
  } catch (err: any) {
    console.error("[workspace.travellers GET list]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /tour-approver-candidates — CSTEP Admin only: lightweight list of
 * workspace users. Originally just the Tour Approver picker (CSTEP Phase 5);
 * the three-person-mapping addition reuses this SAME list for all three
 * mapping columns (Approver/Official user/Finance user) — any workspace
 * user is a valid candidate for any slot, so one candidate list suffices.
 * Registered ahead of GET /:id — same HTTP method and single path segment,
 * so it must come first or Express would match "tour-approver-candidates"
 * as an :id. */

router.get("/tour-approver-candidates", async (req: any, res: any) => {
  try {
    if (!isCstepAdmin(req)) {
      return res.status(403).json({ error: "Only a CSTEP Admin can view Tour Approver candidates" });
    }
    if (!requireWorkspaceContext(req, res)) return;

    const users = await User.find({ workspaceId: req.workspaceObjectId })
      .select("firstName lastName name email")
      .sort({ firstName: 1, lastName: 1 })
      .lean();

    const candidates = (users as any[]).map((u) => ({
      _id: u._id,
      name: u.name || [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || "Unnamed",
      email: u.email,
    }));

    res.json({ ok: true, candidates });
  } catch (err: any) {
    console.error("[workspace.travellers GET tour-approver-candidates]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Department resolution ────────────────────────────────────────────
 *
 * TENANT SAFETY, stated once and used by every write path below (create,
 * edit, bulk import): a department is only ever looked up with BOTH the id
 * (or name) AND this request's own workspaceId in the same filter. There
 * is no code path that resolves a name globally and checks the workspace
 * afterwards — the check IS the query, so a caller cannot pass another
 * tenant's Department._id and have it stick.
 *
 * Department is scoped by workspaceId -> CustomerWorkspace, exactly like
 * TravellerProfile, so req.workspaceObjectId is the correct key for both
 * with no translation.
 * ─────────────────────────────────────────────────────────────────────── */

/** null = explicitly cleared; undefined = not supplied; string = error. */
async function resolveDepartmentId(
  workspaceId: any,
  raw: any,
): Promise<{ value?: mongoose.Types.ObjectId | null; error?: string }> {
  if (raw === undefined) return {};
  // "" / null both mean "no department", which is a valid state.
  if (raw === null || String(raw).trim() === "") return { value: null };

  const id = String(raw).trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return { error: "departmentId is not a valid id" };
  }
  const dept = await Department.findOne({ _id: id, workspaceId, isActive: true })
    .select("_id")
    .lean();
  if (!dept) {
    // Same message whether the department belongs to another workspace, is
    // inactive, or does not exist — a caller probing ids must not be able
    // to tell another tenant's real id from a made-up one.
    return { error: "Unknown department for this workspace" };
  }
  return { value: (dept as any)._id };
}

/**
 * Bulk import's name -> id resolution. Case-insensitive EXACT match (never
 * a prefix or fuzzy match — "Sales" must not silently land in "Sales
 * Development"), anchored and regex-escaped, scoped to this workspace.
 *
 * Returns the whole map up front so an import of 500 rows runs ONE query
 * rather than one per row, and so an unknown name is detectable before any
 * row is written.
 */
async function loadDepartmentsByLowerName(workspaceId: any): Promise<Map<string, any>> {
  const rows = await Department.find({ workspaceId, isActive: true })
    .select("_id name")
    .lean();
  const byName = new Map<string, any>();
  for (const d of rows as any[]) {
    const key = String(d.name || "").trim().toLowerCase();
    if (!key) continue;
    // The unique index is on the EXACT name, so "Sales" and "sales" can
    // both exist in one workspace even though none do today. If that ever
    // happens the name is genuinely ambiguous and the import must say so
    // rather than pick one — marked here, reported per row below.
    if (byName.has(key)) byName.set(key, { ambiguous: true, name: d.name });
    else byName.set(key, d);
  }
  return byName;
}

/* ── GET /departments — the dropdown's option list ─────────────────────
 *
 * MUST stay above GET /:id or Express matches "departments" as an :id.
 *
 * Why not reuse GET /master-data/departments: that route is gated on
 * isHrAdmin (ADMIN/SUPERADMIN/HR/HR_ADMIN/MANAGER), so the very people who
 * fill this form — a customer WORKSPACE_LEADER or REQUESTER — get a 403
 * from it. It also computes a User-headcount aggregate this dropdown has
 * no use for. This is the same collection, read at the access level the
 * traveller form actually runs at, projected to the two fields a <select>
 * needs. Read-only: nothing here can create a department.
 * ─────────────────────────────────────────────────────────────────────── */

router.get("/departments", async (req: any, res: any) => {
  try {
    const gate = await requireActiveMember(req, res);
    if (!gate) return;
    if (!requireWorkspaceContext(req, res)) return;

    const departments = await Department.find({
      workspaceId: req.workspaceObjectId,
      isActive: true,
    })
      .select("_id name")
      .sort({ name: 1 })
      .lean();

    res.json({
      ok: true,
      departments: (departments as any[]).map((d) => ({ id: String(d._id), name: d.name })),
      // Drives the inline "+ Add department" control. Advisory only — every
      // write route below re-derives the same decision independently and
      // never trusts this, matching how canCreate/canManage already work on
      // the traveller list.
      capabilities: { canManageDepartments: isWorkspaceLeaderActor(req, gate.member) },
    });
  } catch (err: any) {
    console.error("[workspace.travellers GET departments]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Department MANAGEMENT (2026-08-09) ───────────────────────────────
 *
 * GATE SPLIT, and it is not the same gate as the picker above:
 *
 *   PICK an existing department — anyone who can add a traveller. Per
 *     ensureTravellerWriteAccess, `action: "create"` returns ok
 *     UNCONDITIONALLY for any active member, so that is WORKSPACE_LEADER,
 *     APPROVER *and* REQUESTER. (canApproverManageTravellers gates an
 *     APPROVER's edit/delete/bulk, never create.) Hence GET /departments
 *     stays on requireActiveMember alone.
 *   CREATE / RENAME / DEACTIVATE / DELETE — WORKSPACE_LEADER only, via the
 *     isOrgScope dual-check. A REQUESTER or APPROVER who can happily pick
 *     a department gets a 403 from every route below.
 *
 * Every query carries workspaceId in the same filter as the id — the check
 * IS the query, so no route here can read or mutate another tenant's
 * Department row. There is no findById-then-compare anywhere.
 * ─────────────────────────────────────────────────────────────────────── */

/**
 * The same dual-check routes/visa.ts's resolveVisaRequestsFilter uses to
 * grant ORG scope:
 *
 *     rolesNorm.includes("WORKSPACELEADER") || memberRole === "WORKSPACE_LEADER"
 *
 * Both halves are load-bearing — accounts exist with a CustomerMember row
 * at WORKSPACE_LEADER but no matching roles[] entry, and the promote flow
 * writes roles[] before a member row is guaranteed. Kept identical so a
 * leader who sees the org-wide roster is exactly the leader who can edit
 * the departments it groups by.
 *
 * member === null is the SUPERADMIN path requireActiveMember already
 * verified — same bypass ensureTravellerWriteAccess grants it.
 */
function isWorkspaceLeaderActor(req: any, member: any | null): boolean {
  if (!member) return true; // SUPERADMIN
  const roles: any[] = Array.isArray(req.user?.roles) ? req.user.roles : [];
  const hasRole = roles.some(
    (r) => String(r).toUpperCase().replace(/[^A-Z]/g, "") === "WORKSPACELEADER",
  );
  if (hasRole) return true;
  return normalizeRole(member.role) === "WORKSPACE_LEADER";
}

/** Gate + workspace context for every department WRITE route. */
async function requireDepartmentManager(
  req: any,
  res: any,
): Promise<{ workspaceId: any } | null> {
  const gate = await requireActiveMember(req, res);
  if (!gate) return null;
  if (!requireWorkspaceContext(req, res)) return null;
  if (!isWorkspaceLeaderActor(req, gate.member)) {
    res.status(403).json({ error: "Only a workspace leader can manage departments" });
    return null;
  }
  return { workspaceId: req.workspaceObjectId };
}

/**
 * Case-insensitive name lookup within ONE workspace.
 *
 * Stricter than the database: the unique index is { workspaceId, name } on
 * the EXACT name, so "Sales" and "sales" can legally coexist. Deduping
 * case-insensitively at this layer is what stops a leader creating that
 * pair by accident. Because the index permits it, more than one row can
 * match — so this returns them ordered deterministically (exact-case
 * first, then active, then by name) rather than letting findOne pick an
 * arbitrary one.
 */
async function findDepartmentsByName(workspaceId: any, name: string, excludeId?: string) {
  const filter: any = {
    workspaceId,
    name: { $regex: `^${escapeRegex(name.trim())}$`, $options: "i" },
  };
  if (excludeId) filter._id = { $ne: excludeId };
  const rows = await Department.find(filter).select("_id name isActive").lean();
  return (rows as any[]).sort((a, b) => {
    const exactA = a.name === name.trim() ? 0 : 1;
    const exactB = b.name === name.trim() ? 0 : 1;
    if (exactA !== exactB) return exactA - exactB;
    const activeA = a.isActive === false ? 1 : 0;
    const activeB = b.isActive === false ? 1 : 0;
    if (activeA !== activeB) return activeA - activeB;
    return String(a.name).localeCompare(String(b.name));
  });
}

/**
 * How many travellers still point at this department.
 *
 * DELIBERATELY NOT filtered by isActive. A soft-deleted traveller
 * (isActive:false — there are such rows in production) still carries its
 * departmentId, so counting only active travellers would clear a hard
 * delete that leaves those references dangling. "Never orphan a reference"
 * means every reference, including the ones on rows the UI hides.
 */
function countTravellersInDepartment(workspaceId: any, departmentId: any): Promise<number> {
  return TravellerProfile.countDocuments({ workspaceId, departmentId });
}

/* ── GET /departments/manage — the Manage panel's list ─────────────────
 * Active AND inactive, each with its live traveller count so the panel can
 * show what a delete would block on before the leader clicks it.
 * Registered above /departments/:id — different verb, but kept adjacent so
 * the ordering rule stays obvious. */

router.get("/departments/manage", async (req: any, res: any) => {
  try {
    const gate = await requireDepartmentManager(req, res);
    if (!gate) return;
    const { workspaceId } = gate;

    const departments = await Department.find({ workspaceId })
      .select("_id name isActive")
      .sort({ name: 1 })
      .lean();

    // One grouped count for the whole panel rather than N countDocuments.
    const counts = await TravellerProfile.aggregate([
      { $match: { workspaceId, departmentId: { $ne: null } } },
      { $group: { _id: "$departmentId", n: { $sum: 1 } } },
    ]);
    const countById = new Map(counts.map((c: any) => [String(c._id), c.n]));

    res.json({
      ok: true,
      departments: (departments as any[]).map((d) => ({
        id: String(d._id),
        name: d.name,
        isActive: d.isActive !== false,
        travellerCount: countById.get(String(d._id)) || 0,
      })),
    });
  } catch (err: any) {
    console.error("[workspace.travellers GET departments/manage]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /departments — inline "+ Add department" ─────────────────────
 *
 * NON-DUPLICATING by construction, and reactivation is REQUIRED rather
 * than merely tidy: the unique index { workspaceId, name } has NO partial
 * filter excluding inactive rows, so inserting a second row carrying a
 * deactivated department's name throws E11000. "Create" for a name that
 * exists-but-inactive can therefore only ever mean "bring that one back".
 *
 * Three outcomes, all 200 — the control's job is to leave the leader with
 * the right department selected, not to argue about which verb happened:
 *   created:true                  a genuinely new row
 *   reactivated:true              an inactive row flipped back on
 *   created/reactivated both false  it already existed and is active; the
 *                                 existing row is returned so the UI
 *                                 selects it instead of making a twin
 * `note` carries the one-line explanation for the last two.
 *
 * This is the DELIBERATE, single, leader-initiated path. Bulk import still
 * rejects unknown names outright and never reaches here — a considered
 * click is controlled and deduped; a CSV typo is not.
 * ─────────────────────────────────────────────────────────────────────── */

router.post("/departments", async (req: any, res: any) => {
  try {
    const gate = await requireDepartmentManager(req, res);
    if (!gate) return;
    const { workspaceId } = gate;

    const name = normStr(req.body?.name);
    if (!name) return res.status(400).json({ error: "Department name is required" });
    if (name.length > 80) return res.status(400).json({ error: "Department name is too long (max 80 characters)" });

    const matches = await findDepartmentsByName(workspaceId, name);
    const active = matches.find((m) => m.isActive !== false);
    if (active) {
      return res.json({
        ok: true,
        created: false,
        reactivated: false,
        note: `“${active.name}” already exists — selected it for you.`,
        department: { id: String(active._id), name: active.name },
      });
    }

    const inactive = matches[0];
    if (inactive) {
      await Department.updateOne({ _id: inactive._id, workspaceId }, { $set: { isActive: true } });
      return res.json({
        ok: true,
        created: false,
        reactivated: true,
        note: `“${inactive.name}” existed but was deactivated — reactivated it.`,
        department: { id: String(inactive._id), name: inactive.name },
      });
    }

    const created: any = await Department.create({
      workspaceId,
      name,
      isActive: true,
      createdBy: actorUserId(req) || undefined,
    });
    res.status(201).json({
      ok: true,
      created: true,
      reactivated: false,
      department: { id: String(created._id), name: created.name },
    });
  } catch (err: any) {
    // The unique index is the last line of defence if two leaders add the
    // same name at once — the app-level dedupe above can race.
    if (err?.code === 11000) {
      return res.status(409).json({ error: "That department was just created by someone else. Refresh and pick it." });
    }
    console.error("[workspace.travellers POST departments]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── PATCH /departments/:id — rename and/or (de)activate ───────────────
 *
 * RENAME needs no data migration: travellers reference departmentId, never
 * the name, so every assigned traveller follows automatically. That is the
 * whole reason the reference was modelled as an id (see
 * TravellerProfile.departmentId's own note on the HRMS name-string
 * pattern this deliberately does not copy).
 *
 * DEACTIVATE removes it from the picker (GET /departments filters
 * isActive:true) while every assigned traveller KEEPS its reference —
 * nothing is unset, and reactivating restores the status quo exactly.
 * ─────────────────────────────────────────────────────────────────────── */

router.patch("/departments/:id", async (req: any, res: any) => {
  try {
    const gate = await requireDepartmentManager(req, res);
    if (!gate) return;
    const { workspaceId } = gate;

    const dept: any = await Department.findOne({ _id: req.params.id, workspaceId });
    if (!dept) return res.status(404).json({ error: "Department not found" });

    const body = req.body || {};

    if ("name" in body) {
      const name = normStr(body.name);
      if (!name) return res.status(400).json({ error: "Department name is required" });
      if (name.length > 80) return res.status(400).json({ error: "Department name is too long (max 80 characters)" });
      const clash = await findDepartmentsByName(workspaceId, name, String(dept._id));
      if (clash.length) {
        return res.status(409).json({
          error: `Another department is already called “${clash[0].name}”${
            clash[0].isActive === false ? " (deactivated)" : ""
          }.`,
        });
      }
      dept.name = name;
    }

    if ("isActive" in body) dept.isActive = body.isActive !== false;

    await dept.save();
    res.json({
      ok: true,
      department: { id: String(dept._id), name: dept.name, isActive: dept.isActive !== false },
    });
  } catch (err: any) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: "Another department already has that name." });
    }
    console.error("[workspace.travellers PATCH departments]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── DELETE /departments/:id — hard delete, guarded ────────────────────
 * Permitted ONLY at zero references. Anything else is a 400 naming the
 * count, because the alternative (delete anyway) leaves travellers
 * pointing at a row that no longer exists, which the roster then renders
 * as an un-named group. Deactivate is the answer for a department that is
 * finished but still has history. */

router.delete("/departments/:id", async (req: any, res: any) => {
  try {
    const gate = await requireDepartmentManager(req, res);
    if (!gate) return;
    const { workspaceId } = gate;

    const dept: any = await Department.findOne({ _id: req.params.id, workspaceId }).select("_id name").lean();
    if (!dept) return res.status(404).json({ error: "Department not found" });

    const travellerCount = await countTravellersInDepartment(workspaceId, dept._id);
    if (travellerCount > 0) {
      return res.status(400).json({
        error: `“${dept.name}” still has ${travellerCount} traveller${
          travellerCount === 1 ? "" : "s"
        } assigned — reassign ${travellerCount === 1 ? "that traveller" : `those ${travellerCount} travellers`} first, or deactivate it instead.`,
        travellerCount,
      });
    }

    await Department.deleteOne({ _id: dept._id, workspaceId });
    res.json({ ok: true, deleted: true, id: String(dept._id) });
  } catch (err: any) {
    console.error("[workspace.travellers DELETE departments]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /:id — full detail (unmasked; feeds edit form + booking autofill) */

router.get("/:id", async (req: any, res: any) => {
  try {
    const gate = await requireActiveMember(req, res);
    if (!gate) return;
    if (!requireWorkspaceContext(req, res)) return;
    const { member } = gate;

    const workspaceId = req.workspaceObjectId;
    const traveller: any = await TravellerProfile.findOne({ _id: req.params.id, workspaceId }).lean();
    if (!traveller) return res.status(404).json({ error: "Traveller not found" });

    const role = normalizeRole(member?.role);
    const approverCanManage = role === "APPROVER" ? await getApproverCanManage(workspaceId) : true;
    const uid = actorUserId(req);

    res.json({
      ok: true,
      traveller,
      canManage: ensureTravellerWriteAccess(uid, member, approverCanManage, traveller, "edit").ok,
      isClaimable: canClaimTraveller(req.user?.email, member?._id, traveller),
    });
  } catch (err: any) {
    console.error("[workspace.travellers GET one]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST / — create ────────────────────────────────────────────────── */

router.post("/", async (req: any, res: any) => {
  try {
    const gate = await requireActiveMember(req, res);
    if (!gate) return;
    if (!requireWorkspaceContext(req, res)) return;
    const { member } = gate;

    const uid = actorUserId(req);
    const writeGate = ensureTravellerWriteAccess(uid, member, true, null, "create");
    if (!writeGate.ok) return res.status((writeGate as any).status).json({ error: (writeGate as any).error });

    const body = req.body || {};
    const firstName = normStr(body.firstName);
    const lastName = normStr(body.lastName);
    if (!firstName || !lastName) {
      return res.status(400).json({ error: "firstName and lastName are required" });
    }

    const workspaceId = req.workspaceObjectId;
    const customerId = req.workspace?.customerId;
    const role = normalizeRole(member?.role);

    // Linking a NEW profile to a CustomerMember at creation is only allowed
    // when self-linking (always safe — you're identifying your own new
    // record) or when the actor is WORKSPACE_LEADER/APPROVER/SUPERADMIN
    // (standing to assert "this profile belongs to that member"). A
    // REQUESTER cannot unilaterally declare a profile is a DIFFERENT
    // member's — that bypasses the whole claim-based safety model.
    let linkedMemberId: string | undefined;
    if (body.linkedMemberId) {
      const requestedId = String(body.linkedMemberId);
      const isSelfLink = !!member && String(member._id) === requestedId;
      const canLinkOthers = !member || role === "WORKSPACE_LEADER" || role === "APPROVER";
      if (!isSelfLink && !canLinkOthers) {
        return res.status(403).json({ error: "Only a workspace leader or approver can link a profile to another member" });
      }
      linkedMemberId = requestedId;
    }

    // Resolved BEFORE the travelerId is minted: issueTravelerId consumes a
    // counter, so a department that turns out to be unknown must fail the
    // request before that side effect, not after it.
    const department = await resolveDepartmentId(workspaceId, body.departmentId);
    if (department.error) return res.status(400).json({ error: department.error });

    const travelerId = await issueTravelerId(workspaceId, customerId, linkedMemberId);

    const mealPreference = MEAL_PREFERENCE_CODES.includes(body.mealPreference)
      ? body.mealPreference
      : undefined;

    const traveller = await TravellerProfile.create({
      workspaceId,
      travelerId,
      departmentId: department.value ?? null,
      linkedMemberId: linkedMemberId || undefined,
      title: normStr(body.title) || undefined,
      firstName,
      middleName: normStr(body.middleName) || undefined,
      lastName,
      gender: normStr(body.gender) || undefined,
      dob: normStr(body.dob) || undefined,
      nationality: normStr(body.nationality) || undefined,
      mealPreference,
      passportNo: normStr(body.passportNo) || undefined,
      passportExpiry: normStr(body.passportExpiry) || undefined,
      passportIssueCountry: normStr(body.passportIssueCountry) || undefined,
      passportIssueDate: normStr(body.passportIssueDate) || undefined,
      mobile: normStr(body.mobile) || undefined,
      email: normalizeEmail(body.email) || undefined,
      frequentFlyer: applyFrequentFlyer(body.frequentFlyer),
      createdBy: uid,
      source: "MANUAL",
    });

    // Login auto-provisioning (additive) — a brand-new profile never has an
    // existing claimedBy, so linking here is always safe (no ambiguity
    // heuristic needed: this is the exact User just created/found for the
    // exact TravellerProfile just created, not an email search).
    let loginNote: string | undefined;
    if (traveller.email) {
      const login = await ensureCstepTravellerLogin({
        email: traveller.email,
        name: [traveller.firstName, traveller.lastName].filter(Boolean).join(" "),
        customerId,
        workspaceId,
        inviterEmail: req.user?.email,
      });
      if (login.userId) {
        traveller.claimedBy = login.userId as any;
        traveller.claimedAt = new Date();
        await traveller.save();
      } else {
        loginNote = login.note;
      }
    }

    res.status(201).json({ ok: true, traveller, ...(loginNote ? { loginNote } : {}) });
  } catch (err: any) {
    if (err?.code === 11000) return res.status(409).json({ error: "Traveler ID collision — please retry" });
    console.error("[workspace.travellers POST]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── PUT /:id — edit ─────────────────────────────────────────────────── */

router.put("/:id", async (req: any, res: any) => {
  try {
    const gate = await requireActiveMember(req, res);
    if (!gate) return;
    if (!requireWorkspaceContext(req, res)) return;
    const { member } = gate;

    const workspaceId = req.workspaceObjectId;
    const traveller: any = await TravellerProfile.findOne({ _id: req.params.id, workspaceId });
    if (!traveller) return res.status(404).json({ error: "Traveller not found" });

    const role = normalizeRole(member?.role);
    const approverCanManage = role === "APPROVER" ? await getApproverCanManage(workspaceId) : true;

    const uid = actorUserId(req);
    const writeGate = ensureTravellerWriteAccess(uid, member, approverCanManage, traveller, "edit");
    if (!writeGate.ok) return res.status((writeGate as any).status).json({ error: (writeGate as any).error });

    const body = req.body || {};
    for (const key of EDITABLE_STRING_FIELDS) {
      if (key in body) traveller[key] = normStr(body[key]) || undefined;
    }
    if ("email" in body) traveller.email = normalizeEmail(body.email) || undefined;
    // Only touched when the key is present, so a payload that never carries
    // departmentId (the "compact" /visa/apply preset) can never clear one.
    if ("departmentId" in body) {
      const department = await resolveDepartmentId(workspaceId, body.departmentId);
      if (department.error) return res.status(400).json({ error: department.error });
      traveller.departmentId = department.value ?? null;
    }
    if ("frequentFlyer" in body) traveller.frequentFlyer = applyFrequentFlyer(body.frequentFlyer);
    if ("mealPreference" in body) {
      traveller.mealPreference = MEAL_PREFERENCE_CODES.includes(body.mealPreference)
        ? body.mealPreference
        : undefined;
    }

    await traveller.save();
    res.json({ ok: true, traveller });
  } catch (err: any) {
    console.error("[workspace.travellers PUT]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── DELETE /:id — soft delete ───────────────────────────────────────── */

router.delete("/:id", async (req: any, res: any) => {
  try {
    const gate = await requireActiveMember(req, res);
    if (!gate) return;
    if (!requireWorkspaceContext(req, res)) return;
    const { member } = gate;

    const workspaceId = req.workspaceObjectId;
    const traveller: any = await TravellerProfile.findOne({ _id: req.params.id, workspaceId });
    if (!traveller) return res.status(404).json({ error: "Traveller not found" });

    const role = normalizeRole(member?.role);
    const approverCanManage = role === "APPROVER" ? await getApproverCanManage(workspaceId) : true;

    const uid = actorUserId(req);
    const writeGate = ensureTravellerWriteAccess(uid, member, approverCanManage, traveller, "delete");
    if (!writeGate.ok) return res.status((writeGate as any).status).json({ error: (writeGate as any).error });

    traveller.isActive = false;
    await traveller.save();

    res.json({ ok: true });
  } catch (err: any) {
    console.error("[workspace.travellers DELETE]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── PATCH /:id/tour-approver — CSTEP Admin only: set/clear this
 * traveller's three CSTEP mapping slots — tourApproverId (Approver),
 * officialUserId (Official user), financeUserId (Finance user). Started as
 * a single-field route (tourApproverId only); the three-person-mapping
 * addition widened its body contract to accept any subset of the three
 * keys in one save — a caller that only ever sends tourApproverId (the
 * original contract) behaves byte-for-byte as before. Deliberately its own,
 * CSTEP-specific gate (isCstepAdmin — SUPERADMIN/ADMIN/HR) rather than the
 * WORKSPACE_LEADER/APPROVER/REQUESTER write-RBAC (ensureTravellerWriteAccess)
 * that governs every other field on this model — these are CSTEP's own
 * routing concepts, separate from the general traveller-PII edit
 * permissions above. Any workspace user may go in any of the three slots —
 * no role restriction, same as the original Tour Approver rule. See
 * utils/cstepAccess.ts and routes/cstep.ts's CSTEP Phase 5 access-model
 * comment. ──────────────────────────────────────────────────────────── */

const CSTEP_MAPPING_SLOTS = ["tourApproverId", "officialUserId", "financeUserId"] as const;

/** Resolves one mapping slot's raw body value to either `undefined` (clear)
 * or a validated User ObjectId in this workspace — shared by all three
 * slots below so each gets identical validation. Flat (non-union) return
 * shape — `error` is simply unset on success — so callers can check `.ok`
 * without a discriminated-union narrow (this codebase runs with
 * strictNullChecks off). */
async function resolveCstepMappingSlot(
  raw: any,
  workspaceId: any,
): Promise<{ ok: boolean; value?: any; error?: string }> {
  if (raw === null || raw === "") return { ok: true, value: undefined };
  if (typeof raw !== "string") return { ok: false, error: "must be a string user id, or null to clear" };
  const user: any = await User.findOne({ _id: raw, workspaceId }).select("_id").lean();
  if (!user) return { ok: false, error: "does not resolve to a user in this workspace" };
  return { ok: true, value: user._id };
}

router.patch("/:id/tour-approver", async (req: any, res: any) => {
  try {
    if (!isCstepAdmin(req)) {
      return res.status(403).json({ error: "Only a CSTEP Admin can set the Approver/Official user/Finance user mapping" });
    }
    if (!requireWorkspaceContext(req, res)) return;

    const workspaceId = req.workspaceObjectId;
    const traveller: any = await TravellerProfile.findOne({ _id: req.params.id, workspaceId });
    if (!traveller) return res.status(404).json({ error: "Traveller not found" });

    const body = req.body || {};
    const providedSlots = CSTEP_MAPPING_SLOTS.filter((k) => k in body);
    if (providedSlots.length === 0) {
      return res.status(400).json({
        error: "Provide at least one of tourApproverId, officialUserId, financeUserId (pass null to clear it)",
      });
    }

    for (const slot of providedSlots) {
      const result = await resolveCstepMappingSlot(body[slot], workspaceId);
      if (!result.ok) return res.status(400).json({ error: `${slot} ${result.error}` });
      traveller[slot] = result.value;
    }

    await traveller.save();
    res.json({ ok: true, traveller: traveller.toObject() });
  } catch (err: any) {
    console.error("[workspace.travellers PATCH tour-approver]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /:id/claim — explicit "Is this you?" self-link ─────────────── */

router.post("/:id/claim", async (req: any, res: any) => {
  try {
    if (isSuperAdmin(req)) return res.status(400).json({ error: "Claim is a member self-service action" });

    const customerId = req.workspace?.customerId;
    const member: any = await getActorMember(String(customerId), req.user?.email);
    if (!member || member.isActive === false) {
      return res.status(403).json({ error: "Not a member of this workspace" });
    }

    const workspaceId = req.workspaceObjectId;
    const traveller: any = await TravellerProfile.findOne({ _id: req.params.id, workspaceId });
    if (!traveller) return res.status(404).json({ error: "Traveller not found" });

    if (traveller.linkedMemberId && String(traveller.linkedMemberId) !== String(member._id)) {
      return res.status(409).json({ error: "This profile is already linked to a different member" });
    }

    const travellerEmail = normalizeEmail(traveller.email);
    const actorEmail = normalizeEmail(req.user?.email);
    if (!travellerEmail || travellerEmail !== actorEmail) {
      return res.status(403).json({ error: "This profile's email doesn't match your account — cannot claim" });
    }

    traveller.linkedMemberId = member._id;
    traveller.claimedBy = actorUserId(req);
    traveller.claimedAt = new Date();
    await traveller.save();

    res.json({ ok: true, traveller });
  } catch (err: any) {
    console.error("[workspace.travellers CLAIM]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /:id/self-confirm — "Yes, that's me" for a BLANK-email profile ──
 *
 * The repair for the one case /claim cannot reach: a workspace leader created
 * the profile (roster entry or bulk import) and left the email blank, so
 * /claim's exact-email test can never pass and the employee has no route
 * forward at all — they can neither see nor edit a profile that is about them.
 *
 * NINE CONDITIONS, ALL of which must hold. Any single failure refuses. Five of
 * them (4-8) are data rules and live in services/travellerIdentity.service.ts,
 * shared with GET /visa/travellers/me/candidates so the tier that OFFERS this
 * button and the action behind it can never disagree. The four request-level
 * ones stay here, alongside every other gate in this router:
 *
 *   1. not SUPERADMIN            2. active member of this workspace
 *   3. session workspace only    9. explicit { confirm: true }
 *
 * Identity written is claimedBy (a User id) — the key routes/visa.ts actually
 * resolves on. linkedMemberId rides along for REQUESTER self-edit rights
 * (ensureTravellerWriteAccess), never as the identity key.
 *
 * See infra/design/visa-self-service-identity-2026-08-10.md.
 * ──────────────────────────────────────────────────────────────────────── */
router.post("/:id/self-confirm", async (req: any, res: any) => {
  try {
    // ── 1. Not SUPERADMIN. Same posture as /claim: this is a member
    // self-service action, and a SUPERADMIN has no member identity to
    // confirm AS.
    if (isSuperAdmin(req)) {
      return res.status(400).json({ error: "Self-confirm is a member self-service action" });
    }

    // ── 9. Explicit confirmation. Checked early and cheaply: this route
    // exists precisely BECAUSE the link is not inferrable, so it must never
    // fire off an incidental POST.
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: "confirm: true is required" });
    }

    // ── 2. Active member of this workspace.
    const customerId = req.workspace?.customerId;
    const member: any = await getActorMember(String(customerId), req.user?.email);
    if (!member || member.isActive === false) {
      return res.status(403).json({ error: "Not a member of this workspace" });
    }

    // ── 3. Session workspace context, fail loud (never a quiet empty read),
    // and the traveller resolved by {_id, workspaceId} — never by id alone.
    if (!requireWorkspaceContext(req, res)) return;
    const workspaceId = req.workspaceObjectId;

    const target: any = await TravellerProfile.findOne({ _id: req.params.id, workspaceId })
      .select("_id")
      .lean();
    if (!target) return res.status(404).json({ error: "Traveller not found" });

    // ── 4-8. The data guard: unclaimed on both keys, no contradicting email,
    // a non-blank member name, unambiguous across ALL active profiles
    // (claimed and unclaimed alike), and the server's OWN re-derived match
    // equal to the id supplied — the last of which is what stops :id being
    // walked as an enumeration oracle.
    const verdict = await evaluateNameUniqueSelfConfirm({
      workspaceId,
      callerEmail: req.user?.email,
      memberName: member.name,
      targetId: String(req.params.id),
    });

    if (!verdict.ok) {
      identityLogger.info("visa.identity.self_confirm.refused", {
        actorUserId: actorUserId(req),
        actorEmail: normalizeEmail(req.user?.email),
        workspaceId: String(workspaceId),
        travellerId: String(req.params.id),
        action: "self_confirm",
        outcome: "refused",
        code: verdict.code,
      });
      return res.status(verdict.status).json({ error: verdict.error, code: verdict.code });
    }

    // All nine hold — write the link. claimedBy is the identity;
    // linkedMemberId is the write-access key that rides along.
    const doc: any = await TravellerProfile.findOne({ _id: verdict.traveller._id, workspaceId });
    if (!doc) return res.status(404).json({ error: "Traveller not found" });
    doc.claimedBy = actorUserId(req);
    doc.claimedAt = new Date();
    doc.linkedMemberId = member._id;
    await doc.save();

    identityLogger.info("visa.identity.self_confirm.linked", {
      actorUserId: actorUserId(req),
      actorEmail: normalizeEmail(req.user?.email),
      workspaceId: String(workspaceId),
      travellerId: String(doc._id),
      action: "self_confirm",
      outcome: "linked",
      tier: "NAME_UNIQUE",
    });

    res.json({ ok: true, traveller: doc.toObject() });
  } catch (err: any) {
    console.error("[workspace.travellers SELF-CONFIRM]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── PATCH /:id/link-member — the admin link ──────────────────────────────
 *
 * The action the audit found missing entirely: no admin-side "link this
 * traveller to this member" existed anywhere, so recovering an unclaimed
 * profile required a leader to EDIT ITS EMAIL so the employee could then
 * claim it. This is also the fallback every self-confirm refusal points at
 * ("ask your workspace leader to link you").
 *
 * GATE: a workspace leader for this workspace, OR an ops user holding
 * visaApplication at WRITE/FULL. Deliberately NOT requireRoles("ADMIN") —
 * its ROLE_ALIASES expand ADMIN to include TENANT_ADMIN, a SaaS-HRMS
 * tenant's OWN admin, who would then be able to link travellers inside
 * another customer's workspace. Same reasoning admin.visa.roster.ts's header
 * already records for refusing that helper.
 *
 * Body: { memberId, reassign? }.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Ops-side half of the link-member gate: a live visaApplication grant at
 * WRITE or FULL. Mirrors admin.visa.ts's userCanBeAssignedVisaCases exactly
 * — never let someone link a traveller who could not open the visa console
 * that link is for.
 */
async function actorHasVisaOpsWriteGrant(req: any): Promise<boolean> {
  const userId = actorUserId(req);
  if (!userId) return false;
  const perm: any = await UserPermission.findOne({ userId: String(userId), status: "active" })
    .select("modules.visaApplication")
    .lean();
  const access = perm?.modules?.visaApplication?.access || "NONE";
  return hasAccess(access, "WRITE");
}

router.patch("/:id/link-member", async (req: any, res: any) => {
  try {
    // Membership first (SUPERADMIN passes with member === null), then the
    // narrower link gate.
    const gate = await requireActiveMember(req, res);
    if (!gate) return;
    if (!requireWorkspaceContext(req, res)) return;
    const workspaceId = req.workspaceObjectId;

    const isLeader = isWorkspaceLeaderActor(req, gate.member);
    if (!isLeader && !(await actorHasVisaOpsWriteGrant(req))) {
      return res.status(403).json({
        error: "Only a workspace leader or visa ops can link a traveller to a member",
      });
    }

    const memberId = normStr(req.body?.memberId);
    if (!memberId || !mongoose.isValidObjectId(memberId)) {
      return res.status(400).json({ error: "memberId is required" });
    }
    const reassign = req.body?.reassign === true;

    // SESSION-scoped, never body-scoped.
    const traveller: any = await TravellerProfile.findOne({ _id: req.params.id, workspaceId });
    if (!traveller) return res.status(404).json({ error: "Traveller not found" });

    // SAME-TENANT — the critical check on this route. memberId is
    // caller-supplied, so resolving it by _id alone would let a leader link
    // one of their own travellers to a member of a DIFFERENT customer.
    // customerId comes from the session workspace, never the body.
    const customerId = req.workspace?.customerId;
    const target: any = await CustomerMember.findOne({
      _id: memberId,
      customerId: String(customerId),
      isActive: true,
    })
      .select("_id email name")
      .lean();
    if (!target) return res.status(404).json({ error: "Member not found in this workspace" });

    // NO-LOGIN MEMBER -> REFUSE, never auto-provision. Identity here is a
    // User id; a member with no account has nothing to write into claimedBy.
    // Minting one inline (ensureAuthUserForCustomer is right there) would
    // create a credential nobody asked for, outside the invite flow that owns
    // account creation and its emails. The refusal names the fix instead.
    const targetUser: any = await User.findOne({ email: normalizeEmail(target.email) })
      .select("_id")
      .lean();
    if (!targetUser) {
      return res.status(409).json({
        error: "That member hasn't been invited yet — invite them first, then link.",
        code: "member_has_no_login",
      });
    }

    // Already linked to SOMEONE ELSE -> 409, overridable ONLY by an explicit
    // reassign. Re-pointing an identity link is a real operation, but it must
    // never be the accidental default.
    const claimedByOther =
      traveller.claimedBy && String(traveller.claimedBy) !== String(targetUser._id);
    const linkedToOther =
      traveller.linkedMemberId && String(traveller.linkedMemberId) !== String(target._id);
    if ((claimedByOther || linkedToOther) && !reassign) {
      return res.status(409).json({
        error: "This traveller is already linked to a different person. Pass reassign: true to move it.",
        code: "already_linked",
      });
    }

    const previousClaimedBy = traveller.claimedBy ? String(traveller.claimedBy) : null;

    traveller.claimedBy = targetUser._id;
    traveller.claimedAt = new Date();
    traveller.linkedMemberId = target._id;
    await traveller.save();

    identityLogger.info("visa.identity.link_member.linked", {
      actorUserId: actorUserId(req),
      actorEmail: normalizeEmail(req.user?.email),
      workspaceId: String(workspaceId),
      travellerId: String(traveller._id),
      action: "link_member",
      outcome: "linked",
      via: isLeader ? "workspace_leader" : "visa_ops_grant",
      targetMemberId: String(target._id),
      targetUserId: String(targetUser._id),
      reassigned: !!(claimedByOther || linkedToOther),
      previousClaimedBy,
    });

    res.json({ ok: true, traveller: traveller.toObject() });
  } catch (err: any) {
    console.error("[workspace.travellers LINK-MEMBER]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /auto-capture — passenger-step submit, not post-ticket ──────
 *
 * Fired by SBTPassengers.tsx when the user clicks Continue (Passengers ->
 * Seats), NOT after ticketing — the checkbox says "save for next time," not
 * "save if this booking completes," and the SBT session's ~13min TTL makes
 * re-entering lost passport details a worse failure mode than an occasional
 * stray profile from an abandoned booking (editable/deletable in
 * Travellers). Replaces the five post-ticket hooks that used to live in
 * sbt.flights.ts — this is the only capture entry point now.
 *
 * Same "system side effect, not a manage-travellers action" RBAC posture as
 * before: no requireRoles beyond the router-wide requireAuth/requireWorkspace
 * — any authenticated member can trigger capture for passengers on their own
 * in-progress booking.
 *
 * Fire-and-forget, same principle as the post-ticket hooks it replaces:
 * autoCaptureTravellersFromBooking is NOT awaited, so the write can never
 * delay the client's navigation to Seats. The frontend doesn't await this
 * endpoint's response either — see SBTPassengers.tsx.
 */
router.post("/auto-capture", (req: any, res: any) => {
  try {
    autoCaptureTravellersFromBooking({
      workspaceId: req.workspaceObjectId,
      customerId: req.workspace?.customerId,
      createdBy: actorUserId(req),
      passengers: req.body?.passengers,
    }).catch((err: any) => console.error("[auto-capture]", err?.message));
  } catch (err: any) {
    console.error("[auto-capture] failed synchronously", err?.message);
  }
  res.json({ accepted: true });
});

/* ── Bulk import — template / preview / commit / export ───────────────
 *
 * Real multer + ExcelJS triad (customerUsers.ts's version turned out to be
 * incomplete on inspection — its /bulk is CSV-only and it has no
 * template/download route at all; UserCreation.tsx's template buttons call
 * a route that doesn't exist). This one is genuinely complete: CSV via the
 * shared utils/csv.ts parser (same as customerUsers.ts's own CSV path),
 * XLSX via ExcelJS, template + export via ExcelJS.
 *
 * Two-step commit: preview (dryRun) never writes; commit re-parses the
 * SAME re-uploaded file and re-runs matching against LIVE data rather than
 * trusting the client's cached preview — correct even if the workspace's
 * traveller list changed between preview and commit.
 * ──────────────────────────────────────────────────────────────────── */

const bulkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const MAX_BULK_ROWS = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const TEMPLATE_COLUMNS = [
  "Title", "First Name", "Middle Name", "Last Name", "Gender", "Date of Birth",
  "Nationality", "Passport Number", "Passport Expiry", "Passport Issue Country",
  "Passport Issue Date", "Mobile", "Email", "Department",
  "Frequent Flyer Airline", "Frequent Flyer Number",
];

// Normalized header (lowercase, alphanumeric-only) -> internal field name.
// The template IS the contract — no fuzzy alias guessing beyond
// case/whitespace/punctuation tolerance.
const HEADER_FIELD_MAP: Record<string, string> = {
  title: "title",
  firstname: "firstName",
  middlename: "middleName",
  lastname: "lastName",
  gender: "gender",
  dateofbirth: "dob",
  nationality: "nationality",
  passportnumber: "passportNo",
  passportexpiry: "passportExpiry",
  passportissuecountry: "passportIssueCountry",
  passportissuedate: "passportIssueDate",
  mobile: "mobile",
  email: "email",
  // The CSV carries department NAMES, not ids — a spreadsheet author has
  // no way to know an ObjectId. Resolved to Department._id per row against
  // the importing workspace; an unmatched name REJECTS the row.
  department: "departmentName",
  frequentflyerairline: "ffAirline",
  frequentflyernumber: "ffNumber",
};

function normalizeHeader(h: string): string {
  return String(h || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function mapRowHeaders(raw: Record<string, any>): Record<string, any> {
  const mapped: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw || {})) {
    const field = HEADER_FIELD_MAP[normalizeHeader(key)];
    if (field) mapped[field] = value;
  }
  return mapped;
}

function cellToString(v: any): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return "";
  if (typeof v === "object") {
    if (Array.isArray((v as any).richText)) return (v as any).richText.map((t: any) => t.text).join("");
    if (typeof (v as any).text === "string") return (v as any).text;
    if ("result" in (v as any)) return String((v as any).result ?? "");
    return "";
  }
  return String(v).trim();
}

function normalizeDateField(raw: any, label: string): { value?: string; error?: string } {
  if (raw === undefined || raw === null || raw === "") return {};
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return { error: `Invalid ${label}` };
    const y = raw.getUTCFullYear();
    const m = String(raw.getUTCMonth() + 1).padStart(2, "0");
    const d = String(raw.getUTCDate()).padStart(2, "0");
    return { value: `${y}-${m}-${d}` };
  }
  const str = cellToString(raw);
  if (!str) return {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return { error: `${label} must be in YYYY-MM-DD format` };
  return { value: str };
}

function csvEscape(v: any): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function parseUploadedRows(file: any): Promise<Record<string, any>[]> {
  const name = String(file?.originalname || "").toLowerCase();
  const looksCsv = name.endsWith(".csv") || file?.mimetype === "text/csv";
  if (looksCsv) {
    const { rows } = parseCsv(file.buffer.toString("utf8"));
    return rows;
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell: any, colNumber: number) => {
    headers[colNumber - 1] = String(cell.value ?? "").trim();
  });

  const rows: Record<string, any>[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (row.cellCount === 0) continue;
    const obj: Record<string, any> = {};
    let hasValue = false;
    headers.forEach((h, idx) => {
      if (!h) return;
      const v = row.getCell(idx + 1).value;
      if (v !== null && v !== undefined && v !== "") hasValue = true;
      obj[h] = v;
    });
    if (hasValue) rows.push(obj);
  }
  return rows;
}

interface BulkRowOutcome {
  rowNumber: number;
  firstName: string;
  lastName: string;
  email?: string;
  action: "create" | "update" | "skip";
  reason?: string;
  travelerId?: string;
  // CSTEP login auto-provisioning (additive) — set only on commit
  // (dryRun=false); a row can succeed as create/update even when no login
  // could be created/linked (e.g. no email on the row), so this never
  // fails the row itself — see ensureCstepTravellerLogin's doc comment.
  loginCreated?: boolean;
  loginNote?: string;
}

/**
 * Shared by preview (dryRun=true, no writes) and commit (dryRun=false).
 * Tier 1 (email) or Tier 2 (name+DOB past the conflict guard) matches
 * UPDATE the existing profile — only fields the row actually provides,
 * a blank cell never clears existing data. Anything weaker creates a new
 * profile with source: "BULK_IMPORT". Every row gets exactly one outcome,
 * so a partial/failed batch is never silent.
 */
async function processBulkRows(
  workspaceId: any,
  customerId: any,
  uid: string,
  rawRows: Record<string, any>[],
  dryRun: boolean,
  actorEmail?: string,
): Promise<BulkRowOutcome[]> {
  const outcomes: BulkRowOutcome[] = [];

  // ONE query per file at most, scoped to the importing workspace, and none
  // at all for a file whose Department column is absent or entirely blank —
  // which is every file uploaded before this column existed. Every row's
  // department name is matched against THIS map and nothing else, so a name
  // can never resolve against another tenant's departments.
  let departmentsByLowerName: Map<string, any> | null = null;
  const loadDepartments = async () => {
    if (!departmentsByLowerName) departmentsByLowerName = await loadDepartmentsByLowerName(workspaceId);
    return departmentsByLowerName;
  };

  for (let i = 0; i < rawRows.length; i++) {
    const rowNumber = i + 2; // header is row 1
    const mapped = mapRowHeaders(rawRows[i]);

    const firstName = cellToString(mapped.firstName);
    const lastName = cellToString(mapped.lastName);
    if (!firstName || !lastName) {
      outcomes.push({ rowNumber, firstName, lastName, action: "skip", reason: "Missing required First Name or Last Name" });
      continue;
    }

    const email = cellToString(mapped.email).toLowerCase();
    if (email && !EMAIL_RE.test(email)) {
      outcomes.push({ rowNumber, firstName, lastName, email, action: "skip", reason: "Invalid email format" });
      continue;
    }

    const dob = normalizeDateField(mapped.dob, "Date of Birth");
    if (dob.error) { outcomes.push({ rowNumber, firstName, lastName, email, action: "skip", reason: dob.error }); continue; }
    const passportExpiry = normalizeDateField(mapped.passportExpiry, "Passport Expiry");
    if (passportExpiry.error) { outcomes.push({ rowNumber, firstName, lastName, email, action: "skip", reason: passportExpiry.error }); continue; }
    const passportIssueDate = normalizeDateField(mapped.passportIssueDate, "Passport Issue Date");
    if (passportIssueDate.error) { outcomes.push({ rowNumber, firstName, lastName, email, action: "skip", reason: passportIssueDate.error }); continue; }

    const nationality = cellToString(mapped.nationality);
    const passportIssueCountry = cellToString(mapped.passportIssueCountry);

    // DEPARTMENT — name -> Department._id, case-insensitive exact match
    // inside this workspace. Deliberately sits ABOVE the dryRun branch so
    // preview and commit reject identically: a name that fails here must
    // show up in the preview the user reads BEFORE committing, not for the
    // first time on commit.
    //
    // An unmatched name REJECTS the row. It does not auto-create the
    // department (that would let a typo mint a permanent org record), and
    // it does not import the traveller department-less (that silently
    // drops data the author explicitly supplied, and the row would look
    // like a success). The reason names the exact unmatched value so it
    // can be fixed in the sheet.
    const departmentName = cellToString(mapped.departmentName);
    let departmentId: any;
    if (departmentName) {
      const hit = (await loadDepartments()).get(departmentName.toLowerCase());
      if (!hit) {
        outcomes.push({
          rowNumber, firstName, lastName, email,
          action: "skip",
          reason: `Unknown department "${departmentName}" — it must already exist in this workspace. Add it under Master Data first, or correct the spelling.`,
        });
        continue;
      }
      if (hit.ambiguous) {
        outcomes.push({
          rowNumber, firstName, lastName, email,
          action: "skip",
          reason: `Department "${departmentName}" matches more than one department in this workspace — rename one so the names differ by more than case.`,
        });
        continue;
      }
      departmentId = hit._id;
    }

    const match = await findMatchingTraveller(workspaceId, {
      email, firstName, lastName, dob: dob.value, nationality, passportIssueCountry,
    });

    if (dryRun) {
      outcomes.push({
        rowNumber,
        firstName,
        lastName,
        email,
        action: match ? "update" : "create",
        travelerId: match?.profile?.travelerId,
        reason: match
          ? `Matches existing traveller ${match.profile.travelerId} by ${match.tier === 1 ? "email" : "name + date of birth"} — will update, not duplicate.`
          : undefined,
      });
      continue;
    }

    const title = cellToString(mapped.title);
    const middleName = cellToString(mapped.middleName);
    const gender = cellToString(mapped.gender);
    const passportNo = cellToString(mapped.passportNo);
    const mobile = cellToString(mapped.mobile);
    const ffAirline = cellToString(mapped.ffAirline);
    const ffNumber = cellToString(mapped.ffNumber);

    if (match) {
      const doc: any = match.profile;
      applyTravellerFields(doc, {
        title, firstName, middleName, lastName, gender,
        dob: dob.value, nationality,
        passportNo, passportExpiry: passportExpiry.value,
        passportIssueCountry, passportIssueDate: passportIssueDate.value,
        mobile, email,
      });
      // Same rule as every other bulk field: a blank cell never clears
      // existing data, so an unset Department column leaves the
      // traveller's current department alone.
      if (departmentId) doc.departmentId = departmentId;
      if (ffAirline || ffNumber) doc.frequentFlyer = [{ airline: ffAirline || undefined, number: ffNumber || undefined }];

      let loginCreated: boolean | undefined;
      let loginNote: string | undefined;
      // Never overwrite an existing claim — a matched (updated) profile may
      // already be linked to a different login via the explicit "Is this
      // you?" claim flow; only link if it's still unclaimed.
      if (email && !doc.claimedBy) {
        const fullName = [firstName, lastName].filter(Boolean).join(" ");
        const login = await ensureCstepTravellerLogin({ email, name: fullName, customerId, workspaceId, inviterEmail: actorEmail });
        if (login.userId) {
          doc.claimedBy = login.userId;
          doc.claimedAt = new Date();
          loginCreated = login.created;
        } else {
          loginNote = login.note;
        }
      } else if (!email) {
        loginNote = "No email — login not created";
      }

      await doc.save();
      outcomes.push({ rowNumber, firstName, lastName, email, action: "update", travelerId: doc.travelerId, loginCreated, loginNote });
    } else {
      const travelerId = await mintTravellerProfileId(workspaceId, customerId);
      const created: any = await TravellerProfile.create({
        workspaceId,
        travelerId,
        departmentId: departmentId || null,
        title: title || undefined,
        firstName,
        middleName: middleName || undefined,
        lastName,
        gender: gender || undefined,
        dob: dob.value || undefined,
        nationality: nationality || undefined,
        passportNo: passportNo || undefined,
        passportExpiry: passportExpiry.value || undefined,
        passportIssueCountry: passportIssueCountry || undefined,
        passportIssueDate: passportIssueDate.value || undefined,
        mobile: mobile || undefined,
        email: email || undefined,
        frequentFlyer: ffAirline || ffNumber ? [{ airline: ffAirline || undefined, number: ffNumber || undefined }] : [],
        createdBy: uid,
        source: "BULK_IMPORT",
      });

      let loginCreated: boolean | undefined;
      let loginNote: string | undefined;
      if (email) {
        const fullName = [firstName, lastName].filter(Boolean).join(" ");
        const login = await ensureCstepTravellerLogin({ email, name: fullName, customerId, workspaceId, inviterEmail: actorEmail });
        if (login.userId) {
          created.claimedBy = login.userId;
          created.claimedAt = new Date();
          await created.save();
          loginCreated = login.created;
        } else {
          loginNote = login.note;
        }
      } else {
        loginNote = "No email — login not created";
      }

      outcomes.push({ rowNumber, firstName, lastName, email, action: "create", travelerId: created.travelerId, loginCreated, loginNote });
    }
  }

  return outcomes;
}

async function requireBulkAccess(req: any, res: any): Promise<{ member: any | null } | null> {
  const gate = await requireActiveMember(req, res);
  if (!gate) return null;
  const { member } = gate;
  const role = normalizeRole(member?.role);
  const approverCanManage = role === "APPROVER" ? await getApproverCanManage(req.workspaceObjectId) : true;
  const bulkGate = ensureTravellerWriteAccess(actorUserId(req), member, approverCanManage, null, "bulk");
  if (!bulkGate.ok) {
    res.status((bulkGate as any).status).json({ error: (bulkGate as any).error });
    return null;
  }
  return { member };
}

/* ── GET /template/download ───────────────────────────────────────────── */

router.get("/template/download", async (req: any, res: any) => {
  try {
    const gate = await requireBulkAccess(req, res);
    if (!gate) return;

    const format = req.query.format === "xlsx" ? "xlsx" : "csv";
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="travellers-template.csv"');
      res.send(TEMPLATE_COLUMNS.map(csvEscape).join(",") + "\n");
      return;
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Travellers");
    sheet.columns = TEMPLATE_COLUMNS.map((h) => ({ header: h, width: 20 }));
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF00477F" } };
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="travellers-template.xlsx"');
    res.send(buffer);
  } catch (err: any) {
    console.error("[workspace.travellers TEMPLATE]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /bulk/preview — dry run, no writes ──────────────────────────── */

router.post("/bulk/preview", bulkUpload.single("file"), async (req: any, res: any) => {
  try {
    const gate = await requireBulkAccess(req, res);
    if (!gate) return;
    if (!requireWorkspaceContext(req, res)) return;

    if (!req.file?.buffer) return res.status(400).json({ error: "Missing file" });
    const rawRows = await parseUploadedRows(req.file);
    if (!rawRows.length) return res.status(400).json({ error: "File has no data rows" });
    if (rawRows.length > MAX_BULK_ROWS) {
      return res.status(400).json({ error: `File has ${rawRows.length} rows; the limit is ${MAX_BULK_ROWS} per import. Split into smaller files.` });
    }

    const workspaceId = req.workspaceObjectId;
    const customerId = req.workspace?.customerId;
    const uid = actorUserId(req);
    const results = await processBulkRows(workspaceId, customerId, uid, rawRows, true);

    res.json({ ok: true, totalRows: results.length, maxRows: MAX_BULK_ROWS, results });
  } catch (err: any) {
    console.error("[workspace.travellers BULK PREVIEW]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /bulk/commit — re-parses the re-uploaded file, writes for real */

router.post("/bulk/commit", bulkUpload.single("file"), async (req: any, res: any) => {
  try {
    const gate = await requireBulkAccess(req, res);
    if (!gate) return;
    if (!requireWorkspaceContext(req, res)) return;

    if (!req.file?.buffer) return res.status(400).json({ error: "Missing file" });
    const rawRows = await parseUploadedRows(req.file);
    if (!rawRows.length) return res.status(400).json({ error: "File has no data rows" });
    if (rawRows.length > MAX_BULK_ROWS) {
      return res.status(400).json({ error: `File has ${rawRows.length} rows; the limit is ${MAX_BULK_ROWS} per import. Split into smaller files.` });
    }

    const workspaceId = req.workspaceObjectId;
    const customerId = req.workspace?.customerId;
    const uid = actorUserId(req);
    const results = await processBulkRows(workspaceId, customerId, uid, rawRows, false, req.user?.email);

    const created = results.filter((r) => r.action === "create").length;
    const updated = results.filter((r) => r.action === "update").length;
    const skipped = results.filter((r) => r.action === "skip").length;
    const loginsCreated = results.filter((r) => r.loginCreated).length;

    res.json({ ok: true, totalRows: results.length, created, updated, skipped, loginsCreated, results });
  } catch (err: any) {
    console.error("[workspace.travellers BULK COMMIT]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /export/download — the workspace's own travellers, masked ───── */

router.get("/export/download", async (req: any, res: any) => {
  try {
    const gate = await requireActiveMember(req, res);
    if (!gate) return;
    if (!requireWorkspaceContext(req, res)) return;

    const workspaceId = req.workspaceObjectId;
    const docs = await TravellerProfile.find({ workspaceId, isActive: true })
      .select("travelerId title firstName middleName lastName gender dob nationality passportNo passportExpiry passportIssueCountry passportIssueDate mobile email frequentFlyer")
      .sort({ firstName: 1, lastName: 1 })
      .lean();

    const full = isSuperAdmin(req);
    const rows = (docs as any[]).map((d) => [
      d.travelerId || "",
      d.title || "",
      d.firstName || "",
      d.middleName || "",
      d.lastName || "",
      d.gender || "",
      d.dob || "",
      d.nationality || "",
      full ? d.passportNo || "" : maskTailId(d.passportNo) || "",
      d.passportExpiry || "",
      d.passportIssueCountry || "",
      d.passportIssueDate || "",
      d.mobile || "",
      d.email || "",
      d.frequentFlyer?.[0]?.airline || "",
      d.frequentFlyer?.[0]?.number || "",
    ]);

    const columns = [
      "Traveler ID", "Title", "First Name", "Middle Name", "Last Name", "Gender", "Date of Birth",
      "Nationality", "Passport", "Passport Expiry", "Passport Issue Country", "Passport Issue Date",
      "Mobile", "Email", "Frequent Flyer Airline", "Frequent Flyer Number",
    ];

    const format = req.query.format === "xlsx" ? "xlsx" : "csv";
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="travellers-export.csv"');
      const lines = [columns.map(csvEscape).join(","), ...rows.map((r) => r.map(csvEscape).join(","))];
      res.send(lines.join("\n") + "\n");
      return;
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Travellers");
    sheet.columns = columns.map((h) => ({ header: h, width: 18 }));
    rows.forEach((r) => sheet.addRow(r));
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF00477F" } };
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="travellers-export.xlsx"');
    res.send(buffer);
  } catch (err: any) {
    console.error("[workspace.travellers EXPORT]", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
