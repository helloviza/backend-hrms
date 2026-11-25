// apps/backend/src/services/travelPolicy/designations.ts
//
// Designations manager of the Travel Policy module: list / add / rename /
// deactivate, per workspace. Same Designation collection the traveller form
// and the HRMS master data use; this is another door to it, behind the
// module's own write gate (leader, tenant admin, or staff with the grant).
//
// Everything that points at a designation points by id (TravellerProfile,
// tiers), so a rename never breaks a mapping. Deactivating keeps existing
// travellers and tiers as they are: it only stops the name being offered.
import mongoose from "mongoose";
import Designation from "../../models/Designation.js";
import TravellerProfile from "../../models/TravellerProfile.js";
import TravelPolicyVersion, { type PolicyActor } from "../../models/TravelPolicyVersion.js";
import { TravelPolicyError, appendAudit } from "../travelPolicy.service.js";

type Oid = mongoose.Types.ObjectId;
const NAME_MAX = 80;

/** Names are compared without case and with runs of spaces collapsed. */
export const nameKey = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const cleanName = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ");
const oidOrNull = (id: string) => (mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : null);

export async function listDesignations(workspaceId: Oid) {
  const [rows, counts, versions] = await Promise.all([
    Designation.find({ workspaceId }).select("name level isActive").sort({ name: 1 }).lean(),
    TravellerProfile.aggregate([
      { $match: { workspaceId, isActive: true, designationId: { $ne: null } } },
      { $group: { _id: "$designationId", n: { $sum: 1 } } },
    ]),
    TravelPolicyVersion.find({ workspaceId, status: { $in: ["DRAFT", "PUBLISHED"] } }).select("status versionNumber effectiveFrom effectiveTo tiers").lean(),
  ]);
  const n = new Map((counts as any[]).map((c) => [String(c._id), c.n as number]));
  // Newest first, the draft ahead of everything: the tier shown is the one that applies next.
  const ordered = (versions as any[]).sort((a, b) => (a.status === "DRAFT" ? -1 : b.status === "DRAFT" ? 1 : (b.versionNumber ?? 0) - (a.versionNumber ?? 0)));
  const tierOf = (id: string) => {
    for (const v of ordered) {
      const t = (v.tiers || []).find((x: any) => x.active && (x.designationIds || []).includes(id));
      if (t) return t.name as string;
    }
    return "";
  };
  return (rows as any[]).map((d) => ({
    _id: String(d._id),
    name: d.name,
    level: d.level ?? null,
    isActive: d.isActive !== false,
    travellers: n.get(String(d._id)) ?? 0,
    tier: tierOf(String(d._id)),
  }));
}

async function clash(workspaceId: Oid, name: string, exceptId?: string) {
  const rows: any[] = await Designation.find({ workspaceId }).select("name isActive").lean();
  return rows.find((r) => nameKey(r.name) === nameKey(name) && String(r._id) !== String(exceptId ?? ""));
}

function requireName(raw: unknown): string {
  const name = cleanName(raw);
  if (!name) throw new TravelPolicyError(400, "Give the designation a name");
  if (name.length > NAME_MAX) throw new TravelPolicyError(400, `A designation name can be at most ${NAME_MAX} characters`);
  return name;
}

export async function createDesignation(workspaceId: Oid, actor: PolicyActor, body: any) {
  const name = requireName(body?.name);
  const same = await clash(workspaceId, name);
  if (same) {
    throw new TravelPolicyError(409, same.isActive === false ? `"${same.name}" already exists but is inactive. Activate it instead` : `"${same.name}" already exists`);
  }
  try {
    const doc: any = await Designation.create({ workspaceId, name, isActive: true, createdBy: oidOrNull(actor.id) ?? undefined });
    await appendAudit({
      workspaceId,
      action: "DESIGNATION_CREATED",
      entity: "ORG",
      entityId: String(doc._id),
      categories: ["DESIGNATION"],
      summary: `Designation "${name}" added`,
      changes: [{ category: "DESIGNATION", field: name, from: null, to: "Active" }],
      actor,
    });
    return { _id: String(doc._id), name, level: null, isActive: true, travellers: 0, tier: "" };
  } catch (err: any) {
    if (err?.code === 11000) throw new TravelPolicyError(409, `"${name}" already exists`);
    throw err;
  }
}

export async function updateDesignation(workspaceId: Oid, actor: PolicyActor, id: string, body: any) {
  const _id = oidOrNull(id);
  const before: any = _id ? await Designation.findOne({ _id, workspaceId }).lean() : null;
  if (!before) throw new TravelPolicyError(404, "Designation not found");
  const set: any = {};
  if (body?.name !== undefined) {
    set.name = requireName(body.name);
    const same = await clash(workspaceId, set.name, id);
    if (same) throw new TravelPolicyError(409, `"${same.name}" already exists`);
  }
  if (body?.isActive !== undefined) set.isActive = body.isActive === true;
  const words = (v: boolean | undefined) => (v === false ? "Inactive" : "Active");
  const changes = [
    set.name !== undefined && set.name !== before.name && { category: "DESIGNATION", field: `${before.name} · name`, from: before.name, to: set.name },
    set.isActive !== undefined && words(set.isActive) !== words(before.isActive) && { category: "DESIGNATION", field: `${before.name} · status`, from: words(before.isActive), to: words(set.isActive) },
  ].filter(Boolean) as { category: string; field: string; from: unknown; to: unknown }[];
  if (!changes.length) return { changed: false };
  try {
    await Designation.updateOne({ _id: before._id, workspaceId }, { $set: set });
  } catch (err: any) {
    if (err?.code === 11000) throw new TravelPolicyError(409, `"${set.name}" already exists`);
    throw err;
  }
  const renamed = changes.some((c) => c.field.endsWith("· name"));
  await appendAudit({
    workspaceId,
    action: "DESIGNATION_UPDATED",
    entity: "ORG",
    entityId: String(before._id),
    categories: ["DESIGNATION"],
    summary: renamed
      ? `Designation "${before.name}" renamed to "${set.name}"`
      : `Designation "${before.name}" ${set.isActive ? "activated" : "deactivated"}`,
    changes,
    reason: body?.reason,
    actor,
  });
  return { changed: true };
}

