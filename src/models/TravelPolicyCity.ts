// apps/backend/src/models/TravelPolicyCity.ts
//
// Per-workspace city master for the Travel Policy module (spec §9). Live, not
// versioned (decision D8): every change is written to TravelPolicyAudit, and
// Phase 3 evaluations will snapshot the city class they used. Seeded once per
// workspace from data/travelPolicyTemplate.ts TEMPLATE_CITIES.
//
// Only cities whose class differs from the default need a row: an Indian city
// with no row is OTHER, any other country is INTERNATIONAL
// (core.ts classifyDestination).
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";
import type { CityClass } from "../services/travelPolicy/core.js";

export interface ITravelPolicyCity extends Document {
  workspaceId: mongoose.Types.ObjectId;
  name: string;
  /** Set once when the row is created and never changed: what CITY-scoped rules store, so a rename keeps its overrides. */
  cityKey: string;
  nameKey: string; // core.ts normalizeKey(name): what a destination's city name is looked up by
  code: string;
  state: string;
  country: string; // ISO-2
  category: CityClass;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const TravelPolicyCitySchema = new Schema<ITravelPolicyCity>(
  {
    name: { type: String, required: true, trim: true },
    cityKey: { type: String, required: true, immutable: true },
    nameKey: { type: String, required: true },
    code: { type: String, default: "", trim: true },
    state: { type: String, default: "", trim: true },
    country: { type: String, default: "IN" },
    category: { type: String, enum: ["METRO", "TIER2", "OTHER", "INTERNATIONAL"], required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

TravelPolicyCitySchema.plugin(workspaceScopePlugin);
TravelPolicyCitySchema.index({ workspaceId: 1, country: 1, nameKey: 1 }, { unique: true });
TravelPolicyCitySchema.index({ workspaceId: 1, cityKey: 1 }, { unique: true, partialFilterExpression: { cityKey: { $type: "string" } } });

const TravelPolicyCity =
  (mongoose.models.TravelPolicyCity as mongoose.Model<ITravelPolicyCity>) ||
  mongoose.model<ITravelPolicyCity>("TravelPolicyCity", TravelPolicyCitySchema);

export default TravelPolicyCity;
