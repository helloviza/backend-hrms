// apps/backend/src/utils/reportingTree.ts
//
// "Who is in my team?" — the caller plus everyone who reports to them,
// directly or through reportees, walking User.managerId (the User-space
// reporting key; Employee.managerId is a different id space, see the note on
// User.managerId).
//
// Used for permission scope TEAM (Manual Bookings list / export / single
// booking / Team Summary — utils/bookingAccess.ts).
//
// SAFE BY CONSTRUCTION:
//  - cycle guard: every id is visited once, so A→B→A terminates;
//  - depth limit: at most `maxDepth` levels BELOW the root (default 5);
//  - one query per level (an $in over the whole frontier), never per user.

import mongoose from "mongoose";
import User from "../models/User.js";

export const REPORTING_TREE_MAX_DEPTH = 5;

/** The root's id first, then every reportee down to `maxDepth` levels. */
export async function reportingTreeUserIds(
  rootId: string,
  maxDepth: number = REPORTING_TREE_MAX_DEPTH,
): Promise<string[]> {
  const root = String(rootId || "");
  if (!mongoose.Types.ObjectId.isValid(root)) return root ? [root] : [];

  const seen = new Set<string>([root]);
  let frontier: string[] = [root];
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const rows: any[] = await User.find({
      managerId: { $in: frontier.map((id) => new mongoose.Types.ObjectId(id)) },
    })
      .select("_id")
      .lean();
    const next: string[] = [];
    for (const r of rows) {
      const id = String(r._id);
      if (seen.has(id)) continue; // cycle (or a diamond) — never revisit
      seen.add(id);
      next.push(id);
    }
    frontier = next;
  }
  return [...seen];
}
