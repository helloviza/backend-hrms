import type { Model, ProjectionType, Types, HydratedDocument } from "mongoose";

/**
 * scopedFindById — replaces bare `Model.findById(id)` calls with a
 * workspace-scoped lookup: `Model.findOne({ _id: id, workspaceId })`.
 *
 * This prevents cross-tenant data access via enumerable ObjectIds.
 */
export const scopedFindById = async <T>(
  model: Model<T>,
  id: string | Types.ObjectId,
  workspaceId: string | Types.ObjectId,
  projection?: ProjectionType<T>,
): Promise<HydratedDocument<T> | null> => {
  return model.findOne(
    { _id: id, workspaceId } as any,
    projection ?? null,
  );
};
