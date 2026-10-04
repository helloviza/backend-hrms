// apps/backend/src/services/approvalInbox.ts
//
// The approver inbox's tabs and the requester line on each card.
//   inboxBucket       — which tab a request sits in for this approver:
//                       pending (their decision), clarification (waiting on
//                       the requester's reply), approved / declined (by them).
//   requesterProfiles — designation, department and cost centre from the
//                       requester's claimed traveller profile (My Profile),
//                       falling back to the User record. Only what is set:
//                       an absent field is left out, never "—" or an id.
import mongoose from "mongoose";
import TravellerProfile from "../models/TravellerProfile.js";
import Designation from "../models/Designation.js";
import Department from "../models/Department.js";
import User from "../models/User.js";

type AnyObj = Record<string, any>;

const str = (v: any) => String(v ?? "").trim();
const norm = (v: any) => str(v).toLowerCase();

export type InboxBucket = "pending" | "clarification" | "approved" | "declined";

/** Stages the approver can still act on (mirrors the inbox query). */
const DECIDABLE = new Set(["", "REQUEST_RAISED", "REQUEST_ON_HOLD"]);

export function inboxBucket(r: AnyObj, approverEmail: string): InboxBucket | null {
  const status = norm(r?.status);
  const stage = str(r?.stage).toUpperCase();
  if (r?.meta?.revoked) return null;
  if (status === "pending" && stage === "REQUEST_NEEDS_CLARIFICATION") return "clarification";
  if (status === "pending" && DECIDABLE.has(stage)) return "pending";
  const me = norm(approverEmail);
  if (!me || norm(r?.approvedByEmail) !== me) return null;
  if (status === "approved") return "approved";
  if (status === "declined") return "declined";
  return null;
}

export type RequesterProfile = { designation?: string; department?: string; costCentre?: string };

const oidOrNull = (v: any) => (mongoose.Types.ObjectId.isValid(str(v)) ? new mongoose.Types.ObjectId(str(v)) : null);

/**
 * Requester details keyed by frontlinerId, for rows in ONE workspace. A user
 * with two claimed profiles is ambiguous (as in resolveMyTravellerProfiles)
 * and gets only what the User record holds.
 */
export async function requesterProfiles(workspaceId: any, rows: AnyObj[]): Promise<Map<string, RequesterProfile>> {
  const out = new Map<string, RequesterProfile>();
  const ids = Array.from(new Set(rows.map((r) => str(r?.frontlinerId)).filter(Boolean)));
  const oids = ids.map(oidOrNull).filter(Boolean) as mongoose.Types.ObjectId[];
  if (!workspaceId || !oids.length) return out;

  const profiles: AnyObj[] = await TravellerProfile.find({ workspaceId, isActive: true, claimedBy: { $in: oids } })
    .select("claimedBy designationId departmentId costCenterId")
    .lean();
  const byUser = new Map<string, AnyObj[]>();
  for (const p of profiles) {
    const k = str(p.claimedBy);
    byUser.set(k, [...(byUser.get(k) || []), p]);
  }

  const one = (k: string) => {
    const list = byUser.get(k) || [];
    return list.length === 1 ? list[0] : null;
  };
  const desigIds = ids.map((k) => one(k)?.designationId).filter(Boolean);
  const deptIds = ids.map((k) => one(k)?.departmentId).filter(Boolean);
  const [desigs, depts, users] = await Promise.all([
    desigIds.length ? Designation.find({ _id: { $in: desigIds }, workspaceId }).select("name").lean() : [],
    deptIds.length ? Department.find({ _id: { $in: deptIds }, workspaceId }).select("name").lean() : [],
    User.find({ _id: { $in: oids } }).select("designation department").lean(),
  ]);
  const desigName = new Map((desigs as AnyObj[]).map((d) => [str(d._id), str(d.name)]));
  const deptName = new Map((depts as AnyObj[]).map((d) => [str(d._id), str(d.name)]));
  const userById = new Map((users as AnyObj[]).map((u) => [str(u._id), u]));

  for (const k of ids) {
    const p = one(k);
    const u = userById.get(k) || {};
    const prof: RequesterProfile = {};
    const designation = (p && desigName.get(str(p.designationId))) || str(u.designation);
    const department = (p && deptName.get(str(p.departmentId))) || str(u.department);
    const costCentre = p ? str(p.costCenterId) : "";
    if (designation) prof.designation = designation;
    if (department) prof.department = department;
    if (costCentre) prof.costCentre = costCentre;
    if (Object.keys(prof).length) out.set(k, prof);
  }
  return out;
}
