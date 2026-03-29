/**
 * workspaceScope plugin — auto-injects `workspaceId` filter into all
 * multi-tenant query methods so no route can accidentally leak data
 * across workspaces.
 *
 * Usage:
 *   import { workspaceScopePlugin } from '../plugins/workspaceScope.plugin.js';
 *   MySchema.plugin(workspaceScopePlugin);
 *
 * The plugin:
 *  1. Adds a `workspaceId` field (ObjectId, required, indexed) if absent.
 *  2. Hooks into find / findOne / findOneAndUpdate / findOneAndDelete /
 *     countDocuments / updateMany / deleteMany to auto-inject the
 *     workspaceId condition when it is available via `this.getQuery()`
 *     or `this.getOptions()._workspaceId`.
 *  3. Skips injection when the query already carries a workspaceId filter.
 */

import { Schema, Types } from "mongoose";

const SCOPED_METHODS = [
  "find",
  "findOne",
  "findOneAndUpdate",
  "findOneAndDelete",
  "countDocuments",
  "updateMany",
  "deleteMany",
] as const;

export const workspaceScopePlugin = (schema: Schema): void => {
  /* ── 1. Add workspaceId field if not already declared ─────────── */
  if (!schema.path("workspaceId")) {
    schema.add({
      workspaceId: {
        type: Schema.Types.ObjectId,
        ref: "CustomerWorkspace",
        required: true,
        index: true,
      },
    });
  }

  /* ── 2. Pre-query hooks — auto-inject workspaceId ─────────────── */
  for (const method of SCOPED_METHODS) {
    schema.pre(method, function (this: any) {
      // Already has workspaceId in the filter — skip
      const filter = this.getFilter?.() ?? this.getQuery?.() ?? {};
      if (filter.workspaceId != null) return;

      // Try to pick workspaceId from query options (set by middleware)
      const opts = this.getOptions?.() ?? {};
      const wsId = opts._workspaceId;

      if (wsId) {
        this.where("workspaceId").equals(
          typeof wsId === "string" ? new Types.ObjectId(wsId) : wsId,
        );
      }
    });
  }
};
