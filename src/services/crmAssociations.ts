// apps/backend/src/services/crmAssociations.ts
//
// Thin service over models/CrmAssociation.ts — create / remove / listFor.
// Slice 1: schema + service only; NO route, NO consumer in Lead / Contact /
// Company / Opportunity. Consumers land in Slice 2.
//
// Every entry point checks CRM_V2_FOUNDATION and throws CrmV2DisabledError
// when the flag is off, so the collection cannot be written by accident while
// the foundation ships dark.
import mongoose from "mongoose";
import CrmAssociation, {
  CRM_ENTITY_TYPES,
  type CrmAssociationDoc,
  type CrmEntityRef,
  type CrmEntityType,
} from "../models/CrmAssociation.js";
import { CrmV2DisabledError, isCrmV2FoundationEnabled } from "../config/crmV2.js";

type AnyObj = Record<string, any>;

export interface CreateAssociationInput {
  from: CrmEntityRef | { type: CrmEntityType; id: string };
  to: CrmEntityRef | { type: CrmEntityType; id: string };
  /** Optional relationship label; normalised to upper-case. "" = unlabelled. */
  label?: string;
  createdBy?: mongoose.Types.ObjectId | string | null;
}

export interface ListForOptions {
  /** "from" = rows where the entity is the source; "to" = target; "both" (default). */
  direction?: "from" | "to" | "both";
  /** Restrict to a label (exact, after normalisation). */
  label?: string;
  /** Restrict to the other side's type. */
  otherType?: CrmEntityType;
}

function assertEnabled(feature: string): void {
  if (!isCrmV2FoundationEnabled()) throw new CrmV2DisabledError(feature);
}

function toObjectId(v: mongoose.Types.ObjectId | string, field: string): mongoose.Types.ObjectId {
  if (v instanceof mongoose.Types.ObjectId) return v;
  if (!mongoose.isValidObjectId(String(v))) {
    throw new Error(`crmAssociations: ${field} is not a valid ObjectId`);
  }
  return new mongoose.Types.ObjectId(String(v));
}

function assertType(t: string, field: string): asserts t is CrmEntityType {
  if (!(CRM_ENTITY_TYPES as readonly string[]).includes(t)) {
    throw new Error(`crmAssociations: ${field} must be one of ${CRM_ENTITY_TYPES.join(", ")}`);
  }
}

export function normalizeLabel(label: unknown): string {
  return String(label ?? "").trim().toUpperCase();
}

/**
 * Create (idempotently) one directed, labelled link. A repeated call with the
 * same (from, to, label) returns the existing row — the unique index makes a
 * concurrent double-create collapse the same way.
 */
export async function createAssociation(input: CreateAssociationInput): Promise<CrmAssociationDoc> {
  assertEnabled("createAssociation");
  assertType(input.from.type, "from.type");
  assertType(input.to.type, "to.type");
  const fromId = toObjectId(input.from.id, "from.id");
  const toId = toObjectId(input.to.id, "to.id");
  if (input.from.type === input.to.type && fromId.equals(toId)) {
    throw new Error("crmAssociations: an entity cannot be associated with itself");
  }
  const label = normalizeLabel(input.label);
  const createdBy =
    input.createdBy == null ? null : toObjectId(input.createdBy, "createdBy");

  const filter = { fromType: input.from.type, fromId, toType: input.to.type, toId, label };
  return CrmAssociation.findOneAndUpdate(
    filter,
    { $setOnInsert: { ...filter, createdBy, workspaceId: null } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

/**
 * Remove one link by id, or by its (from, to, label) triple. Returns the
 * number of rows removed (0 or 1).
 */
export async function removeAssociation(
  target: mongoose.Types.ObjectId | string | Omit<CreateAssociationInput, "createdBy">
): Promise<number> {
  assertEnabled("removeAssociation");
  if (typeof target === "string" || target instanceof mongoose.Types.ObjectId) {
    const res = await CrmAssociation.deleteOne({ _id: toObjectId(target, "_id") });
    return res.deletedCount ?? 0;
  }
  assertType(target.from.type, "from.type");
  assertType(target.to.type, "to.type");
  const res = await CrmAssociation.deleteOne({
    fromType: target.from.type,
    fromId: toObjectId(target.from.id, "from.id"),
    toType: target.to.type,
    toId: toObjectId(target.to.id, "to.id"),
    label: normalizeLabel(target.label),
  });
  return res.deletedCount ?? 0;
}

/**
 * Every link touching one entity, in either direction by default. Each row is
 * returned with an `other` convenience ref so callers need not work out which
 * side they are on.
 */
export async function listFor(
  entity: CrmEntityRef | { type: CrmEntityType; id: string },
  opts: ListForOptions = {}
): Promise<Array<CrmAssociationDoc & { other: CrmEntityRef }>> {
  assertEnabled("listFor");
  assertType(entity.type, "entity.type");
  const id = toObjectId(entity.id, "entity.id");
  const direction = opts.direction ?? "both";
  const labelFilter: AnyObj = opts.label != null ? { label: normalizeLabel(opts.label) } : {};

  const clauses: AnyObj[] = [];
  if (direction === "from" || direction === "both") {
    clauses.push({
      fromType: entity.type,
      fromId: id,
      ...(opts.otherType ? { toType: opts.otherType } : {}),
      ...labelFilter,
    });
  }
  if (direction === "to" || direction === "both") {
    clauses.push({
      toType: entity.type,
      toId: id,
      ...(opts.otherType ? { fromType: opts.otherType } : {}),
      ...labelFilter,
    });
  }

  const rows = (await CrmAssociation.find(clauses.length === 1 ? clauses[0] : { $or: clauses })
    .sort({ createdAt: 1 })
    .lean()) as any[];

  return rows.map((r) => {
    const isFrom = r.fromType === entity.type && String(r.fromId) === String(id);
    const other: CrmEntityRef = isFrom
      ? { type: r.toType, id: r.toId }
      : { type: r.fromType, id: r.fromId };
    return { ...r, other };
  });
}
