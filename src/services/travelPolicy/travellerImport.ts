// apps/backend/src/services/travelPolicy/travellerImport.ts
//
// Traveller import on Traveller Mapping (CSV / XLSX): employee ID, name,
// email, department, designation, band.
//
//   • Matches by employee ID, then email. NEVER by name.
//   • Two steps: planImport (dry run, writes nothing) then applyImport, which
//     re-reads the same file against live data and refuses to run if the plan
//     is no longer the one the person reviewed (planId).
//   • Creates missing departments and designations, only for rows that apply.
//   • One audit entry with every field that changed.
//
// What it deliberately does NOT do:
//   • create a login or send an invitation (the Travellers import does that);
//   • change the name of an existing traveller: that is the name on their
//     tickets and passport, and an HR sheet spells it differently;
//   • change an employee ID or email that is already set: both identify the
//     person, so a different value means the wrong person or a typo;
//   • touch User.bandNumber (expense limits) — see TravellerProfile.bandNumber.
// A blank cell never clears what is stored.
import crypto from "node:crypto";
import mongoose from "mongoose";
import CustomerWorkspace from "../../models/CustomerWorkspace.js";
import Department from "../../models/Department.js";
import Designation from "../../models/Designation.js";
import TravellerProfile from "../../models/TravellerProfile.js";
import User from "../../models/User.js";
import type { PolicyActor } from "../../models/TravelPolicyVersion.js";
import { employeeIdProblem, isCstepWorkspace, normalizeEmployeeId } from "../cstepTravellerIds.js";
import { mintTravellerProfileId } from "../../utils/travelerId.js";
import { normalizeEmail } from "../../utils/travellerMatch.js";
import { cellToString, normalizeHeader } from "../../utils/sheetImport.js";
import logger from "../../utils/logger.js";
import { TravelPolicyError, appendAudit } from "../travelPolicy.service.js";
import { nameKey } from "./designations.js";

type Oid = mongoose.Types.ObjectId;

export const IMPORT_MAX_ROWS = 1000;
export const IMPORT_COLUMNS = ["Employee ID", "Name", "Email", "Department", "Designation", "Band"];

const HEADERS: Record<string, keyof ImportCells> = {
  employeeid: "employeeId",
  empid: "employeeId",
  employeecode: "employeeId",
  employeenumber: "employeeId",
  name: "name",
  fullname: "name",
  employeename: "name",
  email: "email",
  emailid: "email",
  emailaddress: "email",
  department: "department",
  designation: "designation",
  band: "band",
};

interface ImportCells {
  employeeId: string;
  name: string;
  email: string;
  department: string;
  designation: string;
  band: string;
}

export interface ImportRow {
  rowNumber: number; // spreadsheet row, header = 1
  action: "CREATE" | "UPDATE" | "UNCHANGED" | "ERROR";
  cells: ImportCells;
  travellerProfileId: string | null;
  matchedBy: "EMPLOYEE_ID" | "EMAIL" | null;
  travellerName: string;
  errors: string[];
  warnings: string[];
  changes: { field: string; from: string | null; to: string }[];
}

export interface ImportPlan {
  planId: string;
  rows: ImportRow[];
  counts: { create: number; update: number; unchanged: number; error: number };
  newDepartments: string[];
  newDesignations: string[];
  reactivated: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const squash = (v: string) => v.trim().replace(/\s+/g, " ");

/** "5", "L5", "l 5", "Band 5", "Band L5" → 5. Blank → null. Anything else → an error. */
export function parseBand(raw: string): { value: number | null; error?: string } {
  const t = raw.trim();
  if (!t) return { value: null };
  const m = /^(?:band\s*)?l?\s*(\d{1,2})(?:\.0+)?$/i.exec(t);
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 10) return { value: null, error: `Band "${t}" is not a band from L1 to L10` };
  return { value: n };
}

/** First word → first name, last word → last name, the rest in between. */
export function splitName(raw: string): { firstName: string; middleName: string; lastName: string } | null {
  const parts = squash(raw).split(" ").filter(Boolean);
  if (parts.length < 2) return null;
  return { firstName: parts[0], middleName: parts.slice(1, -1).join(" "), lastName: parts[parts.length - 1] };
}

function readCells(raw: Record<string, any>): ImportCells {
  const out: ImportCells = { employeeId: "", name: "", email: "", department: "", designation: "", band: "" };
  for (const [h, v] of Object.entries(raw || {})) {
    const f = HEADERS[normalizeHeader(h)];
    if (f && !out[f]) out[f] = squash(cellToString(v));
  }
  return out;
}

interface OrgList {
  byKey: Map<string, { _id: any; name: string; isActive: boolean } | "AMBIGUOUS">;
}
async function orgList(model: any, workspaceId: Oid): Promise<OrgList> {
  const rows: any[] = await model.find({ workspaceId }).select("name isActive").lean();
  const byKey: OrgList["byKey"] = new Map();
  for (const r of rows) {
    const k = nameKey(r.name);
    if (!k) continue;
    const mine = { _id: r._id, name: r.name, isActive: r.isActive !== false };
    const prev = byKey.get(k);
    if (!prev) byKey.set(k, mine);
    else if (prev !== "AMBIGUOUS") {
      // "Sales" and "sales" can both exist. One active and one not is not a question; two active ones are.
      if (prev.isActive && mine.isActive) byKey.set(k, "AMBIGUOUS");
      else if (mine.isActive) byKey.set(k, mine);
    }
  }
  return { byKey };
}

const fullName = (t: any) => [t.firstName, t.middleName, t.lastName].filter(Boolean).join(" ");
const bandText = (n: number | null | undefined) => (n == null ? null : `L${n}`);

/** The dry run: what every row would do, and why a row cannot. Writes nothing. */
export async function planImport(workspaceId: Oid, rawRows: Record<string, any>[]): Promise<ImportPlan> {
  const headers = new Set(Object.keys(rawRows[0] ?? {}).map((h) => HEADERS[normalizeHeader(h)]).filter(Boolean));
  if (!headers.has("employeeId") && !headers.has("email")) {
    throw new TravelPolicyError(400, `The file needs an "Employee ID" or an "Email" column. Columns: ${IMPORT_COLUMNS.join(", ")}`);
  }
  const cstep = await isCstepWorkspace(workspaceId);
  const [profiles, departments, designations] = await Promise.all([
    TravellerProfile.find({ workspaceId })
      .select("firstName middleName lastName email employeeId travelerId departmentId designationId bandNumber claimedBy isActive")
      .lean() as Promise<any[]>,
    orgList(Department, workspaceId),
    orgList(Designation, workspaceId),
  ]);
  const userIds = profiles.map((p) => p.claimedBy).filter(Boolean);
  const users: any[] = userIds.length ? await User.find({ _id: { $in: userIds } }).select("bandNumber").lean() : [];
  const loginBand = new Map(users.map((u) => [String(u._id), u.bandNumber ?? null]));
  const nameById = (list: OrgList) => {
    const m = new Map<string, string>();
    for (const v of list.byKey.values()) if (v !== "AMBIGUOUS") m.set(String(v._id), v.name);
    return m;
  };
  const deptName = nameById(departments);
  const desigName = nameById(designations);

  // The company's own number first; the id this system issued (shown in the same column) second.
  const byEmployeeId = new Map<string, any[]>();
  const push = (m: Map<string, any[]>, k: string, p: any) => {
    if (!k) return;
    const list = m.get(k) ?? [];
    if (!list.includes(p)) list.push(p);
    m.set(k, list);
  };
  for (const p of profiles) push(byEmployeeId, normalizeEmployeeId(p.employeeId), p);
  for (const p of profiles) {
    const k = normalizeEmployeeId(p.travelerId);
    if (k && !byEmployeeId.has(k)) push(byEmployeeId, k, p);
  }
  const byEmail = new Map<string, any[]>();
  for (const p of profiles) push(byEmail, normalizeEmail(p.email), p);

  // One spelling per name: what is stored, else the first one in this file.
  const spelling = new Map<string, string>();
  const canonical = (kind: string, list: OrgList, value: string): string => {
    if (!value) return "";
    const k = nameKey(value);
    const hit = list.byKey.get(k);
    if (hit && hit !== "AMBIGUOUS") return hit.name;
    if (!spelling.has(`${kind}|${k}`)) spelling.set(`${kind}|${k}`, value);
    return spelling.get(`${kind}|${k}`)!;
  };

  const seenId = new Map<string, number>();
  const seenEmail = new Map<string, number>();
  const seenProfile = new Map<string, number>();
  const rows: ImportRow[] = rawRows.map((raw, i) => {
    const rowNumber = i + 2;
    const cells = readCells(raw);
    const errors: string[] = [];
    const warnings: string[] = [];
    const changes: ImportRow["changes"] = [];
    cells.department = canonical("dept", departments, cells.department);
    cells.designation = canonical("desig", designations, cells.designation);
    const employeeId = normalizeEmployeeId(cells.employeeId);
    const email = normalizeEmail(cells.email);

    if (!employeeId && !email) errors.push("Needs an employee ID or an email");
    if (cells.email && !EMAIL_RE.test(email)) errors.push(`"${cells.email}" is not an email address`);
    if (employeeId) {
      const bad = employeeIdProblem(employeeId);
      if (bad) errors.push(bad);
      if (seenId.has(employeeId)) errors.push(`Employee ID ${employeeId} is also on row ${seenId.get(employeeId)}`);
      else seenId.set(employeeId, rowNumber);
    }
    if (email) {
      if (seenEmail.has(email)) errors.push(`${email} is also on row ${seenEmail.get(email)}`);
      else seenEmail.set(email, rowNumber);
    }
    const band = parseBand(cells.band);
    if (band.error) errors.push(band.error);
    for (const [label, value, list] of [["Department", cells.department, departments], ["Designation", cells.designation, designations]] as const) {
      if (value.length > 80) errors.push(`${label} can be at most 80 characters`);
      if (value && list.byKey.get(nameKey(value)) === "AMBIGUOUS") errors.push(`${label} "${value}" matches more than one in this workspace. Rename one first`);
    }

    // Match: employee ID, then email. Never name.
    // Someone re-added after being deactivated leaves the old profile behind:
    // the active one is the person; deactivated ones only count when alone.
    const live = (list: any[]) => (list.some((x) => x.isActive !== false) ? list.filter((x) => x.isActive !== false) : list);
    const idHits = employeeId ? live(byEmployeeId.get(employeeId) ?? []) : [];
    const mailHits = email ? live(byEmail.get(email) ?? []) : [];
    let p: any = null;
    let matchedBy: ImportRow["matchedBy"] = null;
    if (idHits.length > 1) errors.push(`${idHits.length} travellers have employee ID ${employeeId}. Fix that on Travellers first`);
    else if (idHits.length === 1) {
      p = idHits[0];
      matchedBy = "EMPLOYEE_ID";
      if (mailHits.some((m) => String(m._id) !== String(p._id))) {
        errors.push(`Employee ID ${employeeId} is ${fullName(p)}, but ${email} belongs to ${fullName(mailHits.find((m) => String(m._id) !== String(p._id)))}`);
      } else if (email && p.email && normalizeEmail(p.email) !== email) {
        errors.push(`${fullName(p)} has a different email on record (${p.email}). An import cannot change it`);
      }
    } else if (mailHits.length > 1) errors.push(`${mailHits.length} travellers have the email ${email}. Use the employee ID instead`);
    else if (mailHits.length === 1) {
      p = mailHits[0];
      matchedBy = "EMAIL";
      const own = normalizeEmployeeId(p.employeeId);
      if (employeeId && own && own !== employeeId) errors.push(`${fullName(p)} already has employee ID ${p.employeeId}. An import cannot change it`);
    }

    if (p) {
      const pid = String(p._id);
      if (seenProfile.has(pid)) errors.push(`${fullName(p)} is already on row ${seenProfile.get(pid)}`);
      else seenProfile.set(pid, rowNumber);
      if (p.isActive === false) errors.push(`${fullName(p)} is deactivated. Activate them on Travellers first`);
      if (cells.name && nameKey(cells.name) !== nameKey(fullName(p)) && nameKey(cells.name) !== nameKey(`${p.firstName} ${p.lastName}`)) {
        warnings.push(`Name stays "${fullName(p)}" (the file says "${cells.name}")`);
      }
      if (employeeId && matchedBy === "EMAIL" && !normalizeEmployeeId(p.employeeId)) {
        if (cstep && p.travelerId && normalizeEmployeeId(p.travelerId) !== employeeId) errors.push(`${fullName(p)} already has employee ID ${p.travelerId}. An import cannot change it`);
        else changes.push({ field: "Employee ID", from: null, to: employeeId });
      }
      if (email && !p.email) changes.push({ field: "Email", from: null, to: email });
      const dept = p.departmentId ? deptName.get(String(p.departmentId)) ?? "" : "";
      if (cells.department && nameKey(cells.department) !== nameKey(dept)) changes.push({ field: "Department", from: dept || null, to: cells.department });
      const desig = p.designationId ? desigName.get(String(p.designationId)) ?? "" : "";
      if (cells.designation && nameKey(cells.designation) !== nameKey(desig)) changes.push({ field: "Designation", from: desig || null, to: cells.designation });
      if (band.value != null && band.value !== (p.bandNumber ?? null)) changes.push({ field: "Band", from: bandText(p.bandNumber), to: bandText(band.value)! });
      const own = p.claimedBy ? loginBand.get(String(p.claimedBy)) : null;
      if (band.value != null && own != null && own !== band.value) warnings.push(`Their login has band L${own}. Travel Policy will use L${band.value}; expense limits stay on L${own}`);
    } else if (!errors.length) {
      if (cstep && !employeeId) errors.push("A new traveller needs an employee ID");
      if (!cells.name) errors.push("A new traveller needs a name");
      else if (!splitName(cells.name)) errors.push(`"${cells.name}": a new traveller needs a first and a last name`);
      for (const [field, value] of [["Employee ID", employeeId], ["Name", cells.name], ["Email", email], ["Department", cells.department], ["Designation", cells.designation], ["Band", bandText(band.value) ?? ""]] as const) {
        if (value) changes.push({ field, from: null, to: value });
      }
    }

    return {
      rowNumber,
      action: errors.length ? "ERROR" : !p ? "CREATE" : changes.length ? "UPDATE" : "UNCHANGED",
      cells,
      travellerProfileId: p ? String(p._id) : null,
      matchedBy,
      travellerName: p ? fullName(p) : cells.name,
      errors,
      warnings,
      changes: errors.length ? [] : changes,
    };
  });

  const wanted = (field: "Department" | "Designation", list: OrgList) => {
    const fresh = new Map<string, string>();
    const back: string[] = [];
    for (const r of rows) {
      const c = r.changes.find((x) => x.field === field);
      if (!c) continue;
      const hit = list.byKey.get(nameKey(c.to));
      if (!hit) {
        if (!fresh.has(nameKey(c.to))) fresh.set(nameKey(c.to), c.to);
      } else if (hit !== "AMBIGUOUS" && !hit.isActive && !back.includes(`${field} "${hit.name}"`)) back.push(`${field} "${hit.name}"`);
    }
    return { fresh: [...fresh.values()], back };
  };
  const d = wanted("Department", departments);
  const g = wanted("Designation", designations);
  const n = (a: ImportRow["action"]) => rows.filter((r) => r.action === a).length;
  const planId = crypto
    .createHash("sha256")
    .update(JSON.stringify([String(workspaceId), rows.map((r) => [r.rowNumber, r.action, r.travellerProfileId, r.changes]), d.fresh, g.fresh]))
    .digest("hex")
    .slice(0, 16);
  return {
    planId,
    rows,
    counts: { create: n("CREATE"), update: n("UPDATE"), unchanged: n("UNCHANGED"), error: n("ERROR") },
    newDepartments: d.fresh,
    newDesignations: g.fresh,
    reactivated: [...d.back, ...g.back],
  };
}

/** Find (any case), reactivate or create. Returns the id and whether it had to be created. */
async function ensureOrg(model: any, workspaceId: Oid, name: string, createdBy: Oid | undefined): Promise<{ id: Oid; created: boolean }> {
  const find = async () => {
    const rows: any[] = await model.find({ workspaceId }).select("name isActive").lean();
    const hits = rows.filter((r) => nameKey(r.name) === nameKey(name));
    return hits.find((r) => r.isActive !== false) ?? hits[0] ?? null;
  };
  const hit = await find();
  if (hit) {
    if (hit.isActive === false) await model.updateOne({ _id: hit._id, workspaceId }, { $set: { isActive: true } });
    return { id: hit._id, created: false };
  }
  try {
    const doc = await model.create({ workspaceId, name, isActive: true, createdBy });
    return { id: doc._id, created: true };
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
    const again = await find(); // someone added it between the look-up and the insert
    if (!again) throw err;
    return { id: again._id, created: false };
  }
}

export async function applyImport(workspaceId: Oid, actor: PolicyActor, rawRows: Record<string, any>[], opts: { planId?: string; fileName?: string; reason?: string }) {
  const plan = await planImport(workspaceId, rawRows);
  if (!opts.planId || plan.planId !== opts.planId) {
    throw new TravelPolicyError(409, "Travellers changed since this preview. Check the new preview and apply again.", plan, "IMPORT_PLAN_CHANGED");
  }
  const todo = plan.rows.filter((r) => r.action === "CREATE" || r.action === "UPDATE");
  if (!todo.length) throw new TravelPolicyError(400, "Nothing to import: no row would create or change a traveller");
  if (!mongoose.isValidObjectId(actor.id)) throw new TravelPolicyError(400, "Your account could not be identified. Sign in again.");
  const uid = new mongoose.Types.ObjectId(actor.id);
  const cstep = await isCstepWorkspace(workspaceId);
  const ws: any = await CustomerWorkspace.findById(workspaceId).select("customerId").lean();

  const orgIds = new Map<string, Oid>();
  const org = async (kind: "Department" | "Designation", name: string) => {
    const key = `${kind}|${nameKey(name)}`;
    const known = orgIds.get(key);
    if (known) return known;
    const r = await ensureOrg(kind === "Department" ? Department : Designation, workspaceId, name, uid);
    orgIds.set(key, r.id);
    if (r.created) {
      await appendAudit({
        workspaceId,
        action: kind === "Department" ? "DEPARTMENT_CREATED" : "DESIGNATION_CREATED",
        entity: "ORG",
        entityId: String(r.id),
        categories: [kind === "Department" ? "DEPARTMENT" : "DESIGNATION"],
        summary: `${kind} "${name}" added by the traveller import`,
        changes: [{ category: kind === "Department" ? "DEPARTMENT" : "DESIGNATION", field: name, from: null, to: "Active" }],
        reason: opts.reason,
        actor,
      });
    }
    return r.id;
  };

  const audit: { category: string; field: string; from: unknown; to: unknown }[] = [];
  const failed: { rowNumber: number; error: string }[] = [];
  let created = 0;
  let updated = 0;
  for (const r of todo) {
    const to = (field: string) => r.changes.find((c) => c.field === field)?.to;
    try {
      const set: any = { updatedBy: uid };
      if (to("Department")) set.departmentId = await org("Department", to("Department")!);
      if (to("Designation")) set.designationId = await org("Designation", to("Designation")!);
      if (to("Band")) set.bandNumber = parseBand(to("Band")!).value;
      if (to("Email")) set.email = to("Email");
      if (to("Employee ID")) set.employeeId = to("Employee ID");
      if (r.action === "UPDATE") {
        // CSTEP: the employee ID IS the traveller ID (services/cstepTravellerIds.ts).
        if (cstep && set.employeeId) set.travelerId = set.employeeId;
        const res = await TravellerProfile.updateOne({ _id: r.travellerProfileId, workspaceId, isActive: true }, { $set: set });
        if (res.matchedCount !== 1) throw new Error("The traveller was changed by someone else");
        updated++;
        for (const c of r.changes) audit.push({ category: "TRAVELLER", field: `${r.travellerName} · ${c.field}`, from: c.from, to: c.to });
      } else {
        const name = splitName(r.cells.name)!;
        const make = async () =>
          TravellerProfile.create({
            workspaceId,
            ...name,
            middleName: name.middleName || undefined,
            ...set,
            travelerId: cstep ? set.employeeId : await mintTravellerProfileId(workspaceId, ws?.customerId),
            createdBy: uid,
            source: "BULK_IMPORT",
          });
        try {
          await make();
        } catch (err: any) {
          if (err?.code !== 11000 || cstep) throw err;
          await make(); // someone else took the minted number: take the next
        }
        created++;
        audit.push({ category: "TRAVELLER", field: r.travellerName, from: null, to: r.changes.map((c) => `${c.field}: ${c.to}`).join(" · ") });
      }
    } catch (err: any) {
      logger.warn("[travelPolicy] traveller import row failed", { row: r.rowNumber, message: err?.message });
      failed.push({ rowNumber: r.rowNumber, error: err?.code === 11000 ? "That employee ID was just taken" : "Could not be saved. Try this row again" });
    }
  }
  const skipped = plan.counts.error;
  if (created || updated) {
    await appendAudit({
      workspaceId,
      action: "TRAVELLERS_IMPORTED",
      entity: "TRAVELLER",
      categories: ["TRAVELLER", "MAPPING"],
      summary:
        `Travellers imported${opts.fileName ? ` from ${opts.fileName.slice(0, 120)}` : ""}: ${created} created, ${updated} updated` +
        (skipped ? `, ${skipped} row${skipped === 1 ? "" : "s"} skipped with errors` : "") +
        (failed.length ? `, ${failed.length} failed` : ""),
      changes: audit,
      reason: opts.reason,
      actor,
    });
  }
  return { created, updated, unchanged: plan.counts.unchanged, skipped, failed };
}
