// apps/backend/src/services/cstepTravellerIds.ts
//
// CSTEP: Traveller ID = Employee ID.
//
// In a cstepEnabled workspace TravellerProfile.travelerId is NOT minted
// (<CODE>-NNN) — it is the employee number the company gives the person,
// entered by an admin, and mirrored into employeeId so the two never
// disagree. Every other workspace keeps minting exactly as before; nothing
// here runs for them.
//
//   - Entered ids are trimmed + uppercased (normalizeEmployeeId) and
//     checked up front (findTravelerIdHolder → 409). The unique index
//     {workspaceId, travelerId}, partial on a non-empty travelerId, is the
//     backstop — and is what lets any number of travellers sit with a BLANK
//     id (auto-captured passengers, awaiting an admin) without colliding.
//   - The employee id never goes anywhere near CustomerMember.travelerId:
//     that index is GLOBAL across every tenant, so one company's "E001"
//     would block every other company's. Nothing in this file writes
//     CustomerMember, and the CSTEP create path skips the "reuse the linked
//     member's id" branch entirely.
//   - Changing an id that is already set is NOT a routine edit: it goes
//     through the re-map (planTravelerIdRemap / applyTravelerIdRemap, run
//     by scripts/cstep-remap-traveller-ids.ts), which validates the whole
//     file, handles swaps through temporary values and only writes against
//     a reviewed plan. The bulk import and PUT can only fill a BLANK id.
//
// The index change itself (drop the old full unique index, create the
// partial one) is migrateTravelerIdIndex, run at deploy by
// migrations/2026-10-17-traveller-id-partial-index.ts.

import crypto from "node:crypto";
import mongoose from "mongoose";
import TravellerProfile from "../models/TravellerProfile.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { normalizeEmail } from "../utils/travellerMatch.js";
import { parseCsv } from "../utils/csv.js";

export const EMPLOYEE_ID_MAX_LENGTH = 40;
// The re-map parks each moving traveller on this value between its two
// phases. Never accepted as a real id.
const REMAP_TEMP_PREFIX = "__REMAP__";

/** "  e-0042 " → "E-0042". */
export function normalizeEmployeeId(raw: any): string {
  return String(raw ?? "").trim().toUpperCase();
}

/** Why an (already normalised) id can't be used, or null when it can. */
export function employeeIdProblem(id: string): string | null {
  if (!id) return "Employee ID is required";
  if (id.length > EMPLOYEE_ID_MAX_LENGTH) return `Employee ID must be at most ${EMPLOYEE_ID_MAX_LENGTH} characters`;
  if (id.startsWith(REMAP_TEMP_PREFIX)) return "Employee ID cannot start with __REMAP__";
  return null;
}

/** Read fresh from the workspace document — never from a cached req.workspace,
 * which a SUPERADMIN request doesn't carry. Absent workspace → false, so
 * anything without a CSTEP workspace behind it keeps today's behaviour. */
export async function isCstepWorkspace(workspaceId: any): Promise<boolean> {
  if (!workspaceId || !mongoose.isValidObjectId(workspaceId)) return false;
  const ws: any = await CustomerWorkspace.findById(workspaceId).select("config.features.cstepEnabled").lean();
  return ws?.config?.features?.cstepEnabled === true;
}

/** The traveller in this workspace already holding `travelerId`, if any. */
export async function findTravelerIdHolder(
  workspaceId: any,
  travelerId: string,
  excludeProfileId?: any,
): Promise<{ _id: any; firstName?: string; lastName?: string; travelerId: string } | null> {
  if (!travelerId) return null;
  const filter: any = { workspaceId, travelerId };
  if (excludeProfileId) filter._id = { $ne: excludeProfileId };
  return (await TravellerProfile.findOne(filter).select("_id firstName lastName travelerId").lean()) as any;
}

export function duplicateEmployeeIdMessage(id: string, holder: { firstName?: string; lastName?: string }): string {
  const name = [holder.firstName, holder.lastName].filter(Boolean).join(" ") || "another traveller";
  return `Employee ID ${id} is already used by ${name} in this workspace`;
}

/* ── Index migration ──────────────────────────────────────────────────── */

export const TRAVELER_ID_INDEX_NAME = "workspaceId_1_travelerId_1";
export const TRAVELER_ID_PARTIAL_FILTER = { travelerId: { $gt: "" } };

export interface IndexMigrationResult {
  state: "already-partial" | "migrated" | "would-migrate" | "created";
  before: any | null;
  after: any | null;
  blankIds: number;
}

/**
 * Replaces the full unique {workspaceId, travelerId} index with the partial
 * one (unique only when travelerId is a non-empty string). Idempotent: an
 * index that is already partial is left alone. Dropped then recreated under
 * the SAME name Mongoose derives from the schema, so autoIndex at boot sees
 * a matching index rather than a conflicting one. Uniqueness among
 * non-blank ids already holds (the old index enforced it on every value),
 * so the create cannot fail on existing data.
 */
export async function migrateTravelerIdIndex(dryRun: boolean): Promise<IndexMigrationResult> {
  const coll = TravellerProfile.collection;
  const indexes: any[] = await coll.indexes().catch(() => []);
  const before = indexes.find((i) => i.name === TRAVELER_ID_INDEX_NAME) || null;
  const blankIds = await coll.countDocuments({
    $or: [{ travelerId: "" }, { travelerId: null }, { travelerId: { $exists: false } }],
  });

  const isPartial = !!before?.unique && JSON.stringify(before?.partialFilterExpression) === JSON.stringify(TRAVELER_ID_PARTIAL_FILTER);
  if (isPartial) return { state: "already-partial", before, after: before, blankIds };
  if (dryRun) return { state: "would-migrate", before, after: null, blankIds };

  if (before) await coll.dropIndex(TRAVELER_ID_INDEX_NAME);
  await coll.createIndex(
    { workspaceId: 1, travelerId: 1 },
    { name: TRAVELER_ID_INDEX_NAME, unique: true, partialFilterExpression: TRAVELER_ID_PARTIAL_FILTER },
  );
  const after = (await coll.indexes()).find((i: any) => i.name === TRAVELER_ID_INDEX_NAME) || null;
  return { state: before ? "migrated" : "created", before, after, blankIds };
}

/* ── Re-map existing travellers ───────────────────────────────────────── */

export interface RemapRow {
  row: number; // spreadsheet row, header = 1
  email: string;
  currentId: string;
  employeeId: string;
}

export interface RemapChange {
  row: number;
  profileId: string;
  name: string;
  email: string;
  from: string; // travelerId now
  to: string; // travelerId (and employeeId) after
  employeeIdFrom: string;
  swap: boolean; // `to` is currently held by another traveller in this file
}

export interface RemapPlan {
  workspaceId: string;
  changes: RemapChange[];
  unchanged: { row: number; name: string; travelerId: string }[];
  errors: { row: number; message: string }[];
  planId: string;
}

const REMAP_HEADERS: Record<string, keyof Omit<RemapRow, "row">> = {
  email: "email",
  currentid: "currentId",
  travelerid: "currentId",
  travellerid: "currentId",
  employeeid: "employeeId",
};

/** CSV with an "Employee ID" column plus "Email" and/or "Current ID". */
export function parseRemapCsv(text: string): { rows: RemapRow[]; error?: string } {
  const { headers, rows } = parseCsv(text);
  const norm = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const fields = new Set(headers.map((h) => REMAP_HEADERS[norm(h)]).filter(Boolean));
  if (!fields.has("employeeId")) return { rows: [], error: 'The file needs an "Employee ID" column' };
  if (!fields.has("email") && !fields.has("currentId")) {
    return { rows: [], error: 'The file needs an "Email" or a "Current ID" column to identify each traveller' };
  }
  return {
    rows: rows.map((r, i) => {
      const out: RemapRow = { row: i + 2, email: "", currentId: "", employeeId: "" };
      for (const [h, v] of Object.entries(r)) {
        const f = REMAP_HEADERS[norm(h)];
        if (f) out[f] = String(v ?? "").trim();
      }
      return out;
    }),
  };
}

const personName = (t: any) => [t.firstName, t.lastName].filter(Boolean).join(" ") || String(t._id);

/**
 * Read-only. Resolves each row to one traveller, validates the whole file
 * (blank / bad ids, unknown or ambiguous travellers, a traveller listed
 * twice, an employee id used twice in the file, an id already held by a
 * traveller the file does not move) and returns every change it would
 * make. A plan with any error is never applied.
 *
 * A target held by another traveller who is ALSO in the file moving to a
 * new id is a swap/chain, not a conflict — the apply step parks every
 * mover on a temporary value first, so the order of rows never matters.
 */
export async function planTravelerIdRemap(workspaceId: any, rows: RemapRow[]): Promise<RemapPlan> {
  const errors: RemapPlan["errors"] = [];
  const travellers: any[] = await TravellerProfile.find({ workspaceId })
    .select("_id firstName lastName email travelerId employeeId")
    .lean();
  const byId = new Map<string, any>();
  const byEmail = new Map<string, any[]>();
  for (const t of travellers) {
    if (t.travelerId) byId.set(String(t.travelerId).toUpperCase(), t);
    const e = normalizeEmail(t.email);
    if (e) byEmail.set(e, [...(byEmail.get(e) || []), t]);
  }

  const resolved: { r: RemapRow; t: any; to: string }[] = [];
  const seenProfile = new Map<string, number>();
  const seenTarget = new Map<string, number>();

  for (const r of rows) {
    const to = normalizeEmployeeId(r.employeeId);
    const problem = employeeIdProblem(to);
    if (problem) {
      errors.push({ row: r.row, message: problem });
      continue;
    }

    const email = normalizeEmail(r.email);
    const currentId = normalizeEmployeeId(r.currentId);
    if (!email && !currentId) {
      errors.push({ row: r.row, message: "Row needs an Email or a Current ID" });
      continue;
    }
    let t: any = null;
    if (currentId) {
      t = byId.get(currentId) || null;
      if (!t) {
        errors.push({ row: r.row, message: `No traveller with current id ${currentId}` });
        continue;
      }
      if (email && normalizeEmail(t.email) !== email) {
        errors.push({ row: r.row, message: `Current id ${currentId} belongs to ${personName(t)}, not ${email}` });
        continue;
      }
    } else {
      const hits = byEmail.get(email) || [];
      if (hits.length !== 1) {
        errors.push({
          row: r.row,
          message: hits.length ? `${hits.length} travellers share ${email} — use the Current ID column instead` : `No traveller with email ${email}`,
        });
        continue;
      }
      t = hits[0];
    }

    const pid = String(t._id);
    if (seenProfile.has(pid)) {
      errors.push({ row: r.row, message: `${personName(t)} is already listed on row ${seenProfile.get(pid)}` });
      continue;
    }
    seenProfile.set(pid, r.row);
    if (seenTarget.has(to)) {
      errors.push({ row: r.row, message: `Employee ID ${to} is also given on row ${seenTarget.get(to)}` });
      continue;
    }
    seenTarget.set(to, r.row);
    resolved.push({ r, t, to });
  }

  // An id may only be taken if nobody keeps it: its holder must be moving
  // away in this same file.
  const moving = new Set(resolved.filter((x) => x.t.travelerId !== x.to).map((x) => String(x.t._id)));
  const changes: RemapChange[] = [];
  const unchanged: RemapPlan["unchanged"] = [];
  for (const { r, t, to } of resolved) {
    const from = String(t.travelerId || "");
    const holder = byId.get(to);
    const heldByOther = !!holder && String(holder._id) !== String(t._id);
    if (heldByOther && !moving.has(String(holder._id))) {
      errors.push({ row: r.row, message: `Employee ID ${to} is held by ${personName(holder)}, who is not moved by this file` });
      continue;
    }
    if (from === to && (t.employeeId || "") === to) {
      unchanged.push({ row: r.row, name: personName(t), travelerId: to });
      continue;
    }
    changes.push({
      row: r.row,
      profileId: String(t._id),
      name: personName(t),
      email: normalizeEmail(t.email),
      from,
      to,
      employeeIdFrom: String(t.employeeId || ""),
      swap: heldByOther,
    });
  }

  const planId = crypto
    .createHash("sha256")
    .update(JSON.stringify([String(workspaceId), changes.map((c) => [c.profileId, c.from, c.to, c.employeeIdFrom])]))
    .digest("hex")
    .slice(0, 12);
  return { workspaceId: String(workspaceId), changes, unchanged, errors, planId };
}

/**
 * Applies a plan in ONE transaction, in two phases: every traveller whose
 * travelerId changes is first parked on a unique temporary value, then all
 * of them take their new id (and employeeId). That is what makes A→B while
 * B→A (or longer chains) pass the unique index. Each write is conditional
 * on the value the plan read, so a traveller edited since the plan aborts
 * the whole thing rather than being overwritten.
 */
export async function applyTravelerIdRemap(plan: RemapPlan): Promise<{ changed: number }> {
  if (plan.errors.length) throw new Error(`Plan has ${plan.errors.length} error(s) — nothing applied`);
  const ws = new mongoose.Types.ObjectId(plan.workspaceId);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const c of plan.changes) {
        if (c.from === c.to) continue;
        const r = await TravellerProfile.updateOne(
          { _id: c.profileId, workspaceId: ws, travelerId: c.from || { $in: ["", null] } },
          { $set: { travelerId: `${REMAP_TEMP_PREFIX}${c.profileId}` } },
          { session },
        );
        if (r.matchedCount !== 1) throw new Error(`${c.name} changed since the plan was made (row ${c.row}) — nothing applied`);
      }
      for (const c of plan.changes) {
        const current = c.from === c.to ? c.from : `${REMAP_TEMP_PREFIX}${c.profileId}`;
        const r = await TravellerProfile.updateOne(
          { _id: c.profileId, workspaceId: ws, travelerId: current },
          { $set: { travelerId: c.to, employeeId: c.to } },
          { session },
        );
        if (r.matchedCount !== 1) throw new Error(`${c.name} changed since the plan was made (row ${c.row}) — nothing applied`);
      }
    });
  } finally {
    await session.endSession();
  }
  return { changed: plan.changes.length };
}
