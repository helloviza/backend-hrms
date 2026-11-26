// apps/backend/src/scripts/statusneo-approval-setup.ts
//
// S7 / D10 — StatusNeo's org data for the approval workflow, then its config.
// The workspace itself, its users and its traveller profiles are created by
// Imran through the normal onboarding screens; this script only:
//   1. creates missing departments and sets each department's HEAD
//      (Department.managerId);
//   2. links each employee's traveller profile to their login
//      (TravellerProfile.claimedBy) and sets its department and REPORTING
//      MANAGER (TravellerProfile.departmentId / reportingManagerId);
//   3. publishes the approval-workflow config (scripts/approval-workflow-publish.ts).
//
// People are matched by EMPLOYEE ID, then EMAIL — never by name:
//   login   User.employeeCode, else User.email, among this workspace's users
//   profile TravellerProfile.employeeId, else TravellerProfile.email, in this workspace
// A row that matches nobody, or more than one, is a problem; with any problem
// --apply refuses (unless --allow-partial). A profile already claimed by a
// different login is never re-linked.
//
// Dry run by default. Idempotent: a second --apply writes nothing.
// Refuses: no --expect-db / wrong db, a demo workspace (isDemo or "demo" in
// its name — StatusNeo Demo is never touched), a workspace not on Flow 3.
//
//   npx tsx src/scripts/statusneo-approval-setup.ts \
//     --workspace=<CustomerWorkspace _id> --expect-db=<db> --actor="<your name>" \
//     --departments=<departments.xlsx|csv> --people=<people.xlsx|csv> \
//     [--config=src/scripts/data/statusneo-approval-workflow.json] \
//     [--travel-admins=a@statusneo.com,b@statusneo.com] [--reply-to=travel@statusneo.com] \
//     [--apply] [--allow-partial]
//
// Sheets (first sheet of the file; header names are case- and space-insensitive):
//   departments: Department | Head Employee ID | Head Email
//   people:      Employee ID | Email | Department | Reporting Manager Employee ID | Reporting Manager Email
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import XLSX from "xlsx";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import Department from "../models/Department.js";
import TravellerProfile from "../models/TravellerProfile.js";
import User from "../models/User.js";
import WorkspaceMembership from "../models/WorkspaceMembership.js";
import { appendWorkflowAudit } from "../services/approvalWorkflow/store.js";
import { runWorkflowPublish } from "./approval-workflow-publish.js";

type AnyObj = Record<string, any>;
const str = (v: any) => String(v ?? "").trim();
const low = (v: any) => str(v).toLowerCase();
const rx = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

export const DEFAULT_CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "statusneo-approval-workflow.json");

export type DeptRow = { department: string; headEmployeeId: string; headEmail: string };
export type PersonRow = { employeeId: string; email: string; department: string; managerEmployeeId: string; managerEmail: string };

/** First sheet of an .xlsx / .csv as rows keyed by normalised header ("Head Email" → "heademail"). */
export function readSheet(file: string): AnyObj[] {
  const wb = XLSX.read(fs.readFileSync(file), { type: "buffer", raw: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: AnyObj[] = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase().replace(/[^a-z]/g, ""), str(v)])));
}
const pick = (r: AnyObj, ...keys: string[]) => str(keys.map((k) => r[k]).find((v) => str(v)));
export const toDeptRows = (rows: AnyObj[]): DeptRow[] =>
  rows
    .map((r) => ({ department: pick(r, "department", "departmentname"), headEmployeeId: pick(r, "heademployeeid", "heademployeecode", "headempid"), headEmail: low(pick(r, "heademail")) }))
    .filter((r) => r.department);
export const toPersonRows = (rows: AnyObj[]): PersonRow[] =>
  rows
    .map((r) => ({
      employeeId: pick(r, "employeeid", "employeecode", "empid"),
      email: low(pick(r, "email", "emailid", "workemail")),
      department: pick(r, "department", "departmentname"),
      managerEmployeeId: pick(r, "reportingmanageremployeeid", "manageremployeeid", "rmemployeeid"),
      managerEmail: low(pick(r, "reportingmanageremail", "manageremail", "rmemail")),
    }))
    .filter((r) => r.employeeId || r.email);

export type SetupOpts = {
  workspaceId: string;
  expectDb?: string;
  actor: string;
  departments: DeptRow[];
  people: PersonRow[];
  config: AnyObj;
  travelAdmins?: string[];
  replyTo?: string;
  apply?: boolean;
  allowPartial?: boolean;
  log?: (s: string) => void;
};

export type SetupReport = {
  problems: string[];
  departmentsCreated: string[];
  headsSet: string[];
  profilesLinked: string[];
  departmentsSet: string[];
  managersSet: string[];
  written: boolean;
  publish: string;
};

export async function runStatusNeoSetup(opts: SetupOpts): Promise<SetupReport> {
  const log = opts.log || ((s: string) => console.log(s));
  const db = mongoose.connection.name;
  if (!opts.expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (opts.expectDb !== db) throw new Error(`REFUSING: --expect-db="${opts.expectDb}" but connected db is "${db}".`);
  if (!str(opts.actor)) throw new Error('REFUSING: --actor="<your name>" is required (it is written to the audit).');
  if (!mongoose.Types.ObjectId.isValid(str(opts.workspaceId))) throw new Error("REFUSING: --workspace must be a CustomerWorkspace _id.");
  const ws: any = await CustomerWorkspace.findOne({ _id: opts.workspaceId }).lean();
  if (!ws) throw new Error(`REFUSING: no workspace ${opts.workspaceId} in "${db}".`);
  const wsName = str(ws.companyName || ws.name);
  if (ws.isDemo || /demo/i.test(wsName)) throw new Error(`REFUSING: "${wsName}" is a demo workspace. This script never touches a demo (StatusNeo Demo stays as it is).`);
  if (ws?.config?.travelFlow !== "APPROVAL_DIRECT") throw new Error(`REFUSING: "${wsName}" is on ${ws?.config?.travelFlow || "(no flow)"}; StatusNeo's workflow is for Flow 3 (APPROVAL_DIRECT).`);
  const wsId = ws._id as mongoose.Types.ObjectId;
  log(`Workspace: ${wsName} (${String(wsId)}) — Flow 3`);

  const problems: string[] = [];
  const report: SetupReport = { problems, departmentsCreated: [], headsSet: [], profilesLinked: [], departmentsSet: [], managersSet: [], written: false, publish: "" };

  /* ── who is in this workspace ── */
  const memberIds = (await WorkspaceMembership.find({ workspaceId: wsId, status: "ACTIVE" }).select("userId").lean()).map((m: any) => String(m.userId));
  const users: AnyObj[] = await User.find({ $or: [{ workspaceId: wsId }, { _id: { $in: memberIds } }] })
    .select("email employeeCode firstName lastName name status")
    .lean();
  const profiles: AnyObj[] = await TravellerProfile.find({ workspaceId: wsId, isActive: true })
    .select("employeeId email firstName lastName claimedBy departmentId reportingManagerId")
    .lean();

  const one = <T>(list: T[], what: string, label: string): T | null => {
    if (list.length === 1) return list[0];
    if (list.length > 1) problems.push(`${label}: ${list.length} ${what} match — fix the data, nothing is guessed`);
    return null;
  };
  /** Employee ID first, then email — never by name. */
  function userFor(employeeId: string, email: string, label: string): AnyObj | null {
    if (employeeId) {
      const byId = users.filter((u) => low(u.employeeCode) === low(employeeId));
      if (byId.length) return one(byId, "logins", label);
      const viaProfile = profiles.filter((p) => low(p.employeeId) === low(employeeId) && str(p.email));
      if (viaProfile.length === 1) {
        const byProfileEmail = users.filter((u) => low(u.email) === low(viaProfile[0].email));
        if (byProfileEmail.length) return one(byProfileEmail, "logins", label);
      }
    }
    if (email) {
      const byEmail = users.filter((u) => low(u.email) === email);
      if (byEmail.length) return one(byEmail, "logins", label);
    }
    problems.push(`${label}: no login with ${[employeeId && `employee ID ${employeeId}`, email && `email ${email}`].filter(Boolean).join(" or ")}`);
    return null;
  }
  function profileFor(employeeId: string, email: string, label: string): AnyObj | null {
    if (employeeId) {
      const byId = profiles.filter((p) => low(p.employeeId) === low(employeeId));
      if (byId.length) return one(byId, "traveller profiles", label);
    }
    if (email) {
      const byEmail = profiles.filter((p) => low(p.email) === email);
      if (byEmail.length) return one(byEmail, "traveller profiles", label);
    }
    problems.push(`${label}: no traveller profile with ${[employeeId && `employee ID ${employeeId}`, email && `email ${email}`].filter(Boolean).join(" or ")}`);
    return null;
  }
  const userLabel = (u: AnyObj) => `${str([u.firstName, u.lastName].filter(Boolean).join(" ")) || str(u.name) || u.email} <${u.email}>`;
  const inactive = (u: AnyObj | null) => !!u && str(u.status).toUpperCase() === "INACTIVE";

  /* ── departments and heads ── */
  const existingDepts: AnyObj[] = await Department.find({ workspaceId: wsId }).select("name managerId isActive").lean();
  const deptByName = new Map<string, AnyObj>(existingDepts.map((d) => [low(d.name), d]));
  type DeptPlan = { name: string; create: boolean; id?: any; headId?: string; headLabel?: string };
  const deptPlans = new Map<string, DeptPlan>();
  const seenDept = new Set<string>();
  for (const row of opts.departments) {
    const key = low(row.department);
    if (seenDept.has(key)) {
      problems.push(`departments: "${row.department}" is listed twice`);
      continue;
    }
    seenDept.add(key);
    const existing = deptByName.get(key);
    const plan: DeptPlan = { name: existing ? existing.name : row.department, create: !existing, id: existing?._id };
    if (existing && existing.isActive === false) problems.push(`department "${existing.name}" exists but is inactive — reactivate it in the app first`);
    if (row.headEmployeeId || row.headEmail) {
      const head = userFor(row.headEmployeeId, row.headEmail, `head of "${row.department}"`);
      if (head && inactive(head)) problems.push(`head of "${row.department}": ${userLabel(head)} is inactive`);
      if (head) {
        plan.headLabel = userLabel(head);
        if (!existing || String(existing.managerId || "") !== String(head._id)) plan.headId = String(head._id);
      }
    }
    deptPlans.set(key, plan);
  }

  /* ── people: link, department, reporting manager ── */
  type ProfilePlan = { profileId: any; label: string; set: AnyObj };
  const profilePlans: ProfilePlan[] = [];
  const seenPerson = new Set<string>();
  for (const row of opts.people) {
    const label = row.employeeId ? `employee ${row.employeeId}` : row.email;
    const pkey = low(row.employeeId) || row.email;
    if (seenPerson.has(pkey)) {
      problems.push(`people: ${label} is listed twice`);
      continue;
    }
    seenPerson.add(pkey);
    const login = userFor(row.employeeId, row.email, label);
    const prof = profileFor(row.employeeId, row.email, label);
    if (!login || !prof) continue;
    const set: AnyObj = {};
    if (prof.claimedBy && String(prof.claimedBy) !== String(login._id)) {
      problems.push(`${label}: the traveller profile is already linked to another login — not re-linked`);
      continue;
    }
    if (!prof.claimedBy) Object.assign(set, { claimedBy: login._id, claimedAt: new Date() });
    // The login must not already be linked to a DIFFERENT profile (the engine needs exactly one).
    const otherClaim = profiles.find((p) => String(p.claimedBy || "") === String(login._id) && String(p._id) !== String(prof._id));
    if (otherClaim) {
      problems.push(`${label}: ${userLabel(login)} is already linked to another traveller profile`);
      continue;
    }
    if (row.department) {
      const plan = deptPlans.get(low(row.department));
      const existing = deptByName.get(low(row.department));
      if (!plan && !existing) {
        problems.push(`${label}: department "${row.department}" is not in the departments sheet`);
        continue;
      }
      const deptId = plan?.id || existing?._id || null; // null = created on --apply
      if (!deptId || String(prof.departmentId || "") !== String(deptId)) set.departmentId = deptId || `__new__:${low(row.department)}`;
    }
    if (row.managerEmployeeId || row.managerEmail) {
      const mgr = userFor(row.managerEmployeeId, row.managerEmail, `reporting manager of ${label}`);
      if (!mgr) continue;
      if (String(mgr._id) === String(login._id)) {
        problems.push(`${label}: is listed as their own reporting manager`);
        continue;
      }
      if (inactive(mgr)) problems.push(`reporting manager of ${label}: ${userLabel(mgr)} is inactive`);
      if (String(prof.reportingManagerId || "") !== String(mgr._id)) set.reportingManagerId = mgr._id;
    }
    if (Object.keys(set).length) profilePlans.push({ profileId: prof._id, label: `${label} (${userLabel(login)})`, set });
  }

  /* ── the plan ── */
  for (const p of deptPlans.values()) {
    if (p.create) report.departmentsCreated.push(p.name);
    if (p.headId) report.headsSet.push(`${p.name} → ${p.headLabel}`);
  }
  for (const p of profilePlans) {
    if (p.set.claimedBy) report.profilesLinked.push(p.label);
    if (p.set.departmentId) report.departmentsSet.push(p.label);
    if (p.set.reportingManagerId) report.managersSet.push(p.label);
  }
  log(`Departments to create: ${report.departmentsCreated.length}${report.departmentsCreated.length ? ` (${report.departmentsCreated.join(", ")})` : ""}`);
  log(`Department heads to set: ${report.headsSet.length}${report.headsSet.map((h) => `\n  ${h}`).join("")}`);
  log(`Traveller profiles to link to their login: ${report.profilesLinked.length}`);
  log(`Profile departments to set: ${report.departmentsSet.length}`);
  log(`Reporting managers to set: ${report.managersSet.length}`);
  if (problems.length) log(`PROBLEMS (${problems.length}):${problems.map((p) => `\n  - ${p}`).join("")}`);

  // The config, with StatusNeo's own addresses when given.
  const config = JSON.parse(JSON.stringify(opts.config));
  config.email = config.email || {};
  if (opts.travelAdmins?.length) config.email.travelAdminEmails = opts.travelAdmins.map(low);
  if (opts.replyTo) config.email.sender = { ...(config.email.sender || {}), replyTo: low(opts.replyTo) };

  const changes = report.departmentsCreated.length + report.headsSet.length + profilePlans.length;
  if (!opts.apply) {
    const pub = await runWorkflowPublish({ workspaceId: String(wsId), config, actor: opts.actor, summary: "StatusNeo approval workflow (D1–D10)", expectDb: opts.expectDb, apply: false, log });
    report.publish = pub.outcome;
    log("Dry run — nothing written. Re-run with --apply.");
    return report;
  }
  if (problems.length && !opts.allowPartial) {
    throw new Error(`REFUSING --apply: ${problems.length} problem(s) above. Fix the sheet or the data, or pass --allow-partial to write only the rows that matched.`);
  }

  /* ── write (only what differs) ── */
  const actor = { id: "", name: str(opts.actor), email: "", kind: "SCRIPT" as const, roles: ["SCRIPT"] };
  for (const [key, p] of deptPlans) {
    if (p.create) {
      const created: any = await Department.create({ workspaceId: wsId, name: p.name, isActive: true, ...(p.headId ? { managerId: p.headId } : {}) });
      p.id = created._id;
      deptByName.set(key, created.toObject());
    } else if (p.headId) {
      await Department.updateOne({ _id: p.id, workspaceId: wsId }, { $set: { managerId: new mongoose.Types.ObjectId(p.headId) } });
    }
  }
  for (const p of profilePlans) {
    const set = { ...p.set };
    if (typeof set.departmentId === "string" && set.departmentId.startsWith("__new__:")) {
      set.departmentId = deptPlans.get(set.departmentId.slice(8))?.id || deptByName.get(set.departmentId.slice(8))?._id;
    }
    // Never overwrite a claim made meanwhile by someone else.
    const filter: AnyObj = { _id: p.profileId, workspaceId: wsId };
    if (set.claimedBy) filter.$or = [{ claimedBy: null }, { claimedBy: { $exists: false } }, { claimedBy: set.claimedBy }];
    await TravellerProfile.updateOne(filter, { $set: set });
  }
  if (changes) {
    await appendWorkflowAudit({
      workspaceId: wsId,
      action: "ORG_DATA_SET",
      summary: `StatusNeo setup: ${report.departmentsCreated.length} departments created, ${report.headsSet.length} heads, ${report.profilesLinked.length} links, ${report.departmentsSet.length} departments, ${report.managersSet.length} reporting managers`,
      changes: [
        { field: "departmentsCreated", from: null, to: report.departmentsCreated },
        { field: "headsSet", from: null, to: report.headsSet },
        { field: "profilesLinked", from: null, to: report.profilesLinked },
        { field: "departmentsSet", from: null, to: report.departmentsSet },
        { field: "managersSet", from: null, to: report.managersSet },
      ],
      reason: problems.length ? `--allow-partial with ${problems.length} problem(s)` : "",
      actor,
    });
  }
  report.written = changes > 0;
  log(changes ? `Wrote ${changes} change(s).` : "Org data already up to date — nothing written.");
  const pub = await runWorkflowPublish({ workspaceId: String(wsId), config, actor: opts.actor, summary: "StatusNeo approval workflow (D1–D10)", expectDb: opts.expectDb, apply: true, log });
  report.publish = pub.outcome;
  return report;
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  console.log(`Target: ${uri.replace(/^mongodb(\+srv)?:\/\/([^@/]*@)?/, "").split(/[/?]/)[0]}`);
  const depts = arg("departments");
  const people = arg("people");
  if (!depts || !people) throw new Error("--departments=<file> and --people=<file> are required");
  await mongoose.connect(uri);
  try {
    console.log(`Database: ${mongoose.connection.name}`);
    await runStatusNeoSetup({
      workspaceId: str(arg("workspace")),
      expectDb: arg("expect-db"),
      actor: str(arg("actor")),
      departments: toDeptRows(readSheet(depts)),
      people: toPersonRows(readSheet(people)),
      config: JSON.parse(fs.readFileSync(arg("config") || DEFAULT_CONFIG, "utf8")),
      travelAdmins: (arg("travel-admins") || "").split(",").map(str).filter(Boolean),
      replyTo: arg("reply-to"),
      apply: process.argv.includes("--apply"),
      allowPartial: process.argv.includes("--allow-partial"),
    });
  } finally {
    await mongoose.disconnect();
  }
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/statusneo-approval-setup.ts");
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
