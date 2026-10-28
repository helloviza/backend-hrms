// apps/backend/src/models/cstep/CstepCityCache.ts
import mongoose, { Schema, type Document } from "mongoose";

/**
 * CstepCityCache
 * --------------
 * Cities Google Places Autocomplete has suggested to a CSTEP city field
 * (services/cstepCitySearch.ts), kept so the next lookup for the same city
 * is a free database read. CSTEP-only: the shared TBO catalogue the SBT hotel
 * search reads (tbocities) is never written to.
 *
 * Global, not per workspace — a city name is public data, not tenant data.
 * One row per city (searchName + countryKey); `queries` lists the normalized
 * queries Google was asked that returned it, so a repeat of the same query
 * is answered from here without calling Google again.
 */
export interface ICstepCityCache extends Document {
  /** Google's structured mainText — the clean city name, e.g. "Manchester". */
  name: string;
  /** normalizeSearch(name), the prefix-searched field. */
  searchName: string;
  countryCode: string;
  countryName: string;
  /** Lowercased countryName — half of the dedupe key. */
  countryKey: string;
  placeId: string;
  queries: string[];
  createdAt: Date;
  updatedAt: Date;
}

const CstepCityCacheSchema = new Schema<ICstepCityCache>(
  {
    name: { type: String, required: true, trim: true },
    searchName: { type: String, required: true },
    countryCode: { type: String, default: "" },
    countryName: { type: String, default: "" },
    countryKey: { type: String, default: "" },
    placeId: { type: String, default: "" },
    queries: { type: [String], default: [] },
  },
  { timestamps: true, collection: "cstepcitycache" },
);

CstepCityCacheSchema.index({ searchName: 1, countryKey: 1 }, { unique: true });
CstepCityCacheSchema.index({ queries: 1 });

const CstepCityCache =
  (mongoose.models.CstepCityCache as mongoose.Model<ICstepCityCache>) ||
  mongoose.model<ICstepCityCache>("CstepCityCache", CstepCityCacheSchema);

export default CstepCityCache;
