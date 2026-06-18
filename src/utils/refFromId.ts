// apps/backend/src/utils/refFromId.ts
//
// Shared short-ref generator. Derives a human-friendly reference from a Mongo
// _id with no counter / no extra DB round-trip — identical format for siblings
// like EXP-XXXXXX (expenses) and CLM-XXXXXX (claims — the user-facing term for
// the Report model; the prefix is passed by the caller).

import type mongoose from "mongoose";

export function refFromId(prefix: string, id: mongoose.Types.ObjectId | string): string {
  return `${prefix}-${String(id).slice(-6).toUpperCase()}`;
}
