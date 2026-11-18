// apps/backend/src/models/UserPreference.ts
//
// Per-user UI preferences, stored server-side so they follow the user across
// devices (Phase B additions, 2026-11-18 — first consumer: Travel Spend's
// show/hide cards). One row per (user, key). Kept OFF the User document,
// which travels with every login/refresh payload.
//
// Keys are a closed list (PREFERENCE_KEYS) with a validator each, so the
// collection can never become a free-form blob store.
import { Schema, model, type Document, type Types } from "mongoose";

export type TravelSpendCardsPref = { hidden: string[]; v: 1 };

export const PREFERENCE_KEYS: Record<string, (value: unknown) => unknown | null> = {
  /** Cards the user hid on the Travel Spend dashboard. Unknown ids are kept (harmless) so a
   *  card added later stays visible by default — only ids listed here are hidden. */
  "travelSpend.cards": (value) => {
    const hidden = (value as any)?.hidden;
    if (!Array.isArray(hidden) || hidden.length > 50) return null;
    const ids = hidden.map((h) => String(h ?? "").trim()).filter((h) => /^[a-zA-Z0-9_.-]{1,40}$/.test(h));
    if (ids.length !== hidden.length) return null;
    return { hidden: [...new Set(ids)], v: 1 } satisfies TravelSpendCardsPref;
  },
};

export interface UserPreferenceDoc extends Document {
  userId: Types.ObjectId;
  key: string;
  value: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const UserPreferenceSchema = new Schema<UserPreferenceDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    key: { type: String, required: true, trim: true },
    value: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true, collection: "userpreferences" },
);

UserPreferenceSchema.index({ userId: 1, key: 1 }, { unique: true });

export const UserPreference = model<UserPreferenceDoc>("UserPreference", UserPreferenceSchema);
export default UserPreference;
