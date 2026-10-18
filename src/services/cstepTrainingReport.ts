// apps/backend/src/services/cstepTrainingReport.ts
//
// CSTEP Team Training — every active user of ONE workspace × every LIVE deck,
// one status per cell. The tenant-scoped twin of services/trainingReport.ts
// (HOUSE): read-only over CstepTrainingProgress and the CSTEP PATHS registry
// (services/cstepTrainingModules.ts), and the same cell rule (cellFor), so
// the % here is the % the learner's hub shows.
//
// Starts from the PEOPLE, not the progress rows: a user with no row for a
// deck is "not_started" — exactly who the report is for.
//
// Rows = active Users of the workspace (activeUserFilter), the same set the
// old Team Training view and CSTEP's own pickers use. Each carries its CSTEP
// role tags — Admin by role, Approver / Official / Finance by the traveller
// mappings, Requester by a claimed or email-matched traveller profile — which
// stand in for the HOUSE report's departments as the filter.
import mongoose from "mongoose";
import User from "../models/User.js";
import TravellerProfile from "../models/TravellerProfile.js";
import CstepTrainingProgress from "../models/cstep/CstepTrainingProgress.js";
import { activeUserFilter } from "../utils/userActiveStatus.js";
import { cellFor, type CellStatus, type ModuleCount, type ReportCell } from "./trainingReport.js";
import { liveCstepTrainingModules } from "./cstepTrainingModules.js";
import type { TrainingModule } from "./trainingModules.js";

export type { CellStatus };

export const CSTEP_ROLE_TAGS = ["ADMIN", "APPROVER", "OFFICIAL", "FINANCE", "REQUESTER"] as const;
export type CstepRoleTag = (typeof CSTEP_ROLE_TAGS)[number];
export const NO_ROLE = "NONE";

export interface CstepReportRow {
  userId: string;
  name: string;
  email: string;
  roles: CstepRoleTag[];
  cells: Record<string, ReportCell>;
}

export interface CstepTrainingReport {
  generatedAt: string;
  modules: Array<Pick<TrainingModule, "id" | "title" | "total">>;
  /** Every role tag across ALL workspace users (filter options), with head count; NONE = no CSTEP role. */
  roles: Array<{ name: string; count: number }>;
  /** The role filter that was applied ([] = everyone). */
  filter: { roles: string[] };
  rows: CstepReportRow[];
  counts: Record<string, ModuleCount>;
}

/** CSTEP Admin by the user document's own roles — the same role set as
 * utils/cstepAccess.isCstepAdmin, which reads req.user. Pure; exported for tests. */
export function userIsCstepAdmin(u: any): boolean {
  const roles = (u?.roles || []).map((r: string) => String(r).toUpperCase().replace(/[\s_-]/g, ""));
  return ["SUPERADMIN", "ADMIN", "HR", "WORKSPACELEADER"].some((r) => roles.includes(r));
}

const squash = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ");

function displayName(u: any): string {
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return squash(u.name) || full || String(u.email || "—");
}

export async function buildCstepTrainingReport(
  workspaceId: mongoose.Types.ObjectId,
  opts: { roles?: string[]; hubFile?: string } = {},
): Promise<CstepTrainingReport> {
  const modules = (opts.hubFile ? liveCstepTrainingModules(opts.hubFile) : liveCstepTrainingModules()).map(({ id, title, total }) => ({ id, title, total }));

  const [users, profiles] = await Promise.all([
    User.find({ workspaceId, ...activeUserFilter() }).select("_id name firstName lastName email roles").lean(),
    TravellerProfile.find({ workspaceId, isActive: { $ne: false } })
      .select("email claimedBy tourApproverId officialUserId financeUserId")
      .lean(),
  ]);

  const ids = (f: string) => new Set((profiles as any[]).map((p) => p[f]).filter(Boolean).map(String));
  const approvers = ids("tourApproverId");
  const officials = ids("officialUserId");
  const finance = ids("financeUserId");
  const claimed = ids("claimedBy");
  const profileEmails = new Set((profiles as any[]).map((p) => String(p.email || "").trim().toLowerCase()).filter(Boolean));

  const people = (users as any[]).map((u) => {
    const id = String(u._id);
    const roles: CstepRoleTag[] = [];
    if (userIsCstepAdmin(u)) roles.push("ADMIN");
    if (approvers.has(id)) roles.push("APPROVER");
    if (officials.has(id)) roles.push("OFFICIAL");
    if (finance.has(id)) roles.push("FINANCE");
    if (claimed.has(id) || profileEmails.has(String(u.email || "").trim().toLowerCase())) roles.push("REQUESTER");
    return { userId: id, name: displayName(u), email: String(u.email || ""), roles };
  });

  const roleCount = new Map<string, number>();
  for (const p of people) for (const r of p.roles.length ? p.roles : [NO_ROLE]) roleCount.set(r, (roleCount.get(r) || 0) + 1);
  const order = [...CSTEP_ROLE_TAGS, NO_ROLE] as string[];
  const roles = [...roleCount.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

  const wanted = new Set((opts.roles ?? []).map((r) => squash(r).toUpperCase()).filter(Boolean));
  const slice = wanted.size
    ? people.filter((p) => (p.roles.length ? p.roles : [NO_ROLE]).some((r) => wanted.has(r)))
    : people;

  const progress = slice.length && modules.length
    ? ((await CstepTrainingProgress.find({
        workspaceId,
        userId: { $in: slice.map((p) => new mongoose.Types.ObjectId(p.userId)) },
        module: { $in: modules.map((m) => m.id) },
      }).lean()) as any[])
    : [];
  const byKey = new Map(progress.map((r) => [`${String(r.userId)}:${r.module}`, r]));

  const counts: Record<string, ModuleCount> = {};
  for (const m of modules) counts[m.id] = { completed: 0, inProgress: 0, notStarted: 0, total: slice.length, completionRate: 0 };

  const rows: CstepReportRow[] = slice
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
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const c of Object.values(counts)) c.completionRate = c.total ? Math.round((c.completed / c.total) * 1000) / 10 : 0;

  return {
    generatedAt: new Date().toISOString(),
    modules,
    roles,
    filter: { roles: [...wanted] },
    rows,
    counts,
  };
}
