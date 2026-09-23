// apps/backend/src/services/trainingReport.ts
//
// The org-wide Learning Hub progress report: every active HOUSE staff member ×
// every LIVE module, one status per cell. Read-only over TrainingProgress (the
// collection Piece 1 writes) and the PATHS registry (services/trainingModules).
//
// The report starts from the PEOPLE, not from the progress rows: a person with
// no row for a module is "not_started" — they are exactly who the report is
// for, so they must appear rather than drop out of a join.
//
// Rows = the People & Culture roster, not "every login in HOUSE": active
// Employee rows in the HOUSE workspace (activeEmployeeFilter — the filter
// GET /api/employees and the org chart use) → Employee.ownerId → a User that
// is also active (activeUserFilter; progress keys by User._id). Anyone whose
// employment status is Resigned/Terminated is left out even while the flags
// still say active. A User with no Employee row — onboarding stubs that never
// joined, test/seed logins, customer workspace leaders mis-scoped to HOUSE —
// is not an employee and never appears (their emails must not reach this
// report or its export).
// Department = User.department — on the same User._id the progress is keyed
// by — normalised; blank → "Unassigned". Casing is taken from the workspace's
// Department list when the text matches one, so "tech & product" and
// "Tech & Product" land in one bucket.
import mongoose from "mongoose";
import User from "../models/User.js";
import TrainingProgress from "../models/TrainingProgress.js";
import Department from "../models/Department.js";
import Employee from "../models/Employee.js";
import { activeEmployeeFilter, activeUserFilter, isTerminalEmploymentStatus } from "../utils/userActiveStatus.js";
import { liveTrainingModules, type TrainingModule } from "./trainingModules.js";

// HOUSE (Plumtrips internal) workspace — per-file literal, the repo convention
// (see middleware/requireHouse.ts). Training is HOUSE-only.
export const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";
export const UNASSIGNED = "Unassigned";

export type CellStatus = "not_started" | "in_progress" | "completed";

export interface ReportCell {
  status: CellStatus;
  pct: number;
  slide: number | null; // furthest slide reached, 1-based
  total: number;
  lastActivity: string | null;
  completedAt: string | null;
}

export interface ReportRow {
  userId: string;
  name: string;
  email: string;
  department: string;
  cells: Record<string, ReportCell>;
}

export interface ModuleCount {
  completed: number;
  inProgress: number;
  notStarted: number;
  total: number;
  completionRate: number; // % of people in the slice who completed, 1 dp
}

export interface TrainingReport {
  generatedAt: string;
  modules: Array<Pick<TrainingModule, "id" | "title" | "total">>;
  /** Every department bucket across ALL staff (filter options), with head count. */
  departments: Array<{ name: string; count: number }>;
  /** The department filter that was applied ([] = everyone). */
  filter: { departments: string[] };
  rows: ReportRow[];
  counts: Record<string, ModuleCount>;
}

const squash = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ");

/** Canonical bucket name for a department value. Pure; exported for tests. */
export function normalizeDepartment(raw: unknown, canonical: Map<string, string> = new Map()): string {
  const v = squash(raw);
  if (!v) return UNASSIGNED;
  return canonical.get(v.toLowerCase()) ?? v;
}

/** Same % the hub shows (learning-hub.html PT.pct): completed = 100, else ≤ 99. */
export function cellFor(row: any | null, mod: Pick<TrainingModule, "total">): ReportCell {
  const total = Number(row?.total) > 0 ? Number(row.total) : mod.total;
  if (!row) return { status: "not_started", pct: 0, slide: null, total, lastActivity: null, completedAt: null };
  const completed = row.completed === true;
  const reached = Math.max(0, Number(row.maxSlide) || 0) + 1;
  const pct = completed ? 100 : total > 0 ? Math.min(99, Math.round((reached / total) * 100)) : 0;
  const iso = (d: any) => (d ? new Date(d).toISOString() : null);
  return {
    status: completed ? "completed" : "in_progress",
    pct,
    slide: reached,
    total,
    lastActivity: iso(row.updatedAt) ?? iso(row.syncedAt),
    completedAt: completed ? iso(row.completedAt) : null,
  };
}

function displayName(u: any): string {
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return squash(u.name) || full || String(u.email || "—");
}

/**
 * The real HOUSE employees, as Users. Employee.employmentStatus is not in the
 * Employee schema (strictQuery would silently drop a filter on it), so the
 * terminal check runs here on the loaded rows — on both the Employee row and
 * the User, the same two places GET /api/employees reads it from.
 */
async function houseEmployeeUsers(house: mongoose.Types.ObjectId): Promise<any[]> {
  const employees = (await Employee.find({ workspaceId: house, ...activeEmployeeFilter() })
    .select("ownerId employmentStatus")
    .lean()) as any[];
  const ownerIds = [
    ...new Set(
      employees
        .filter((e) => e.ownerId && !isTerminalEmploymentStatus(e.employmentStatus))
        .map((e) => String(e.ownerId)),
    ),
  ].map((id) => new mongoose.Types.ObjectId(id));
  if (!ownerIds.length) return [];
  const users = (await User.find({ _id: { $in: ownerIds }, workspaceId: house, ...activeUserFilter() })
    .select("_id name firstName lastName email department employmentStatus")
    .lean()) as any[];
  return users.filter((u) => !isTerminalEmploymentStatus(u.employmentStatus));
}

export async function buildTrainingReport(opts: { departments?: string[]; hubFile?: string } = {}): Promise<TrainingReport> {
  const modules = (opts.hubFile ? liveTrainingModules(opts.hubFile) : liveTrainingModules()).map(({ id, title, total }) => ({ id, title, total }));
  const house = new mongoose.Types.ObjectId(HOUSE_WORKSPACE_ID);

  const [users, deptDocs] = await Promise.all([
    houseEmployeeUsers(house),
    Department.find({ workspaceId: house }).select("name").lean(),
  ]);
  const canonical = new Map<string, string>((deptDocs as any[]).map((d) => [squash(d.name).toLowerCase(), squash(d.name)]));

  const people = (users as any[]).map((u) => ({
    userId: String(u._id),
    name: displayName(u),
    email: String(u.email || ""),
    department: normalizeDepartment(u.department, canonical),
  }));

  const deptCount = new Map<string, number>();
  for (const p of people) deptCount.set(p.department, (deptCount.get(p.department) || 0) + 1);
  const departments = [...deptCount.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (a.name === UNASSIGNED ? 1 : b.name === UNASSIGNED ? -1 : a.name.localeCompare(b.name)));

  const wanted = new Set((opts.departments ?? []).map((d) => squash(d)).filter(Boolean));
  const slice = wanted.size ? people.filter((p) => wanted.has(p.department)) : people;

  const progress = slice.length && modules.length
    ? ((await TrainingProgress.find({
        userId: { $in: slice.map((p) => new mongoose.Types.ObjectId(p.userId)) },
        module: { $in: modules.map((m) => m.id) },
      }).lean()) as any[])
    : [];
  const byKey = new Map(progress.map((r) => [`${String(r.userId)}:${r.module}`, r]));

  const counts: Record<string, ModuleCount> = {};
  for (const m of modules) counts[m.id] = { completed: 0, inProgress: 0, notStarted: 0, total: slice.length, completionRate: 0 };

  const rows: ReportRow[] = slice
    .map((p) => {
      const cells: Record<string, ReportCell> = {};
      for (const m of modules) {
        const cell = cellFor(byKey.get(`${p.userId}:${m.id}`) ?? null, m);
        cells[m.id] = cell;
        const c = counts[m.id];
        if (cell.status === "completed") c.completed++;
        else if (cell.status === "in_progress") c.inProgress++;
        else c.notStarted++;
      }
      return { ...p, cells };
    })
    .sort((a, b) => a.department.localeCompare(b.department) || a.name.localeCompare(b.name));

  for (const c of Object.values(counts)) c.completionRate = c.total ? Math.round((c.completed / c.total) * 1000) / 10 : 0;

  return {
    generatedAt: new Date().toISOString(),
    modules,
    departments,
    filter: { departments: [...wanted] },
    rows,
    counts,
  };
}
