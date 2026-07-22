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
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import TravellerProfile, { MEAL_PREFERENCE_CODES } from "../models/TravellerProfile.js";
import CustomerMember from "../models/CustomerMember.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { mintTravellerProfileId } from "../utils/travelerId.js";
import { maskTailId } from "../utils/piiMask.js";
import { normalizeEmail, normalizeName, findMatchingTraveller, applyTravellerFields } from "../utils/travellerMatch.js";
import { parseCsv } from "../utils/csv.js";

const router = Router();
router.use(requireAuth, requireWorkspace);

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
      .select("travelerId firstName middleName lastName email mobile dob nationality passportNo createdBy linkedMemberId")
      .sort({ firstName: 1, lastName: 1 })
      .limit(100)
      .lean();

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
      canManage: ensureTravellerWriteAccess(uid, member, approverCanManage, d, "edit").ok,
      isClaimable: canClaimTraveller(actorEmail, member?._id, d),
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

    const travelerId = await issueTravelerId(workspaceId, customerId, linkedMemberId);

    const mealPreference = MEAL_PREFERENCE_CODES.includes(body.mealPreference)
      ? body.mealPreference
      : undefined;

    const traveller = await TravellerProfile.create({
      workspaceId,
      travelerId,
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

    res.status(201).json({ ok: true, traveller });
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
  "Passport Issue Date", "Mobile", "Email", "Frequent Flyer Airline", "Frequent Flyer Number",
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
): Promise<BulkRowOutcome[]> {
  const outcomes: BulkRowOutcome[] = [];

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
      if (ffAirline || ffNumber) doc.frequentFlyer = [{ airline: ffAirline || undefined, number: ffNumber || undefined }];
      await doc.save();
      outcomes.push({ rowNumber, firstName, lastName, email, action: "update", travelerId: doc.travelerId });
    } else {
      const travelerId = await mintTravellerProfileId(workspaceId, customerId);
      const created: any = await TravellerProfile.create({
        workspaceId,
        travelerId,
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
      outcomes.push({ rowNumber, firstName, lastName, email, action: "create", travelerId: created.travelerId });
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
    const results = await processBulkRows(workspaceId, customerId, uid, rawRows, false);

    const created = results.filter((r) => r.action === "create").length;
    const updated = results.filter((r) => r.action === "update").length;
    const skipped = results.filter((r) => r.action === "skip").length;

    res.json({ ok: true, totalRows: results.length, created, updated, skipped, results });
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
