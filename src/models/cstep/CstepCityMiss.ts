// apps/backend/src/models/cstep/CstepCityMiss.ts
import mongoose, { Schema, type Document } from "mongoose";

/**
 * CstepCityMiss
 * -------------
 * The negative half of the CSTEP city cache (services/cstepCitySearch.ts):
 * queries Google Places Autocomplete answered successfully with zero
 * predictions, so the same query skips Google next time. Only a genuine empty
 * answer lands here — an error, timeout, missing key or unreadable reply is
 * not "no such city" and stays re-tryable.
 *
 * Keyed on the exact normalized query, so typing further ("agar" →
 * "agartala") still asks Google. Rows expire (Mongo TTL on expiresAt), so a
 * city Google learns later eventually resolves. A separate collection, not a
 * flag on cstepcitycache, so the TTL can never touch a real cached city.
 */
export const CSTEP_CITY_MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ICstepCityMiss extends Document {
  /** normalizeSearch(q) — the exact query Google answered empty. */
  query: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CstepCityMissSchema = new Schema<ICstepCityMiss>(
  {
    query: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "cstepcitymisses" },
);

CstepCityMissSchema.index({ query: 1 }, { unique: true });
CstepCityMissSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const CstepCityMiss =
  (mongoose.models.CstepCityMiss as mongoose.Model<ICstepCityMiss>) ||
  mongoose.model<ICstepCityMiss>("CstepCityMiss", CstepCityMissSchema);

export default CstepCityMiss;
