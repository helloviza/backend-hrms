// apps/backend/src/models/HotelPhotoCache.ts
//
// The photo lookup's cache. WITHOUT THIS THE FEATURE IS UNSHIPPABLE: every
// hotel answer would spend one Places Text Search per property, per search, per
// user — a 12-row Dubai answer opened three times is 36 billed calls for three
// identical results.
//
// Keyed by HotelCode, which is TBO's stable identity for a property, so the
// cache is shared across users, workspaces and searches. That is deliberate and
// it is NOT a tenant leak: the row holds a Google Places photo reference for a
// public building. There is no traveller, booking, fare or workspace data here,
// so this model does NOT carry workspaceScopePlugin — unlike PlutoConversation,
// which is genuinely per-tenant.
//
// NEGATIVE RESULTS ARE CACHED TOO. A hotel Places has never heard of, or one
// whose only candidate failed the confidence gate, is the case that would
// otherwise re-hit the API forever: it never populates, so it never stops
// costing. `status: "none"` records "we looked, there is nothing usable" and
// expires sooner than a hit, so a newly-listed property is re-checked in a week.

import mongoose, { Schema, type Document } from "mongoose";

/** A resolved photo is stable — hotels do not re-shoot their listing weekly. */
export const PHOTO_TTL_DAYS = Number(process.env.HOTEL_PHOTO_TTL_DAYS) || 30;
/** A miss is re-checked sooner: the property may simply not be listed YET. */
export const PHOTO_MISS_TTL_DAYS = Number(process.env.HOTEL_PHOTO_MISS_TTL_DAYS) || 7;

export interface IHotelPhotoCache extends Document {
  hotelCode: string;
  status: "resolved" | "none";
  /** Places photo resource name ("places/X/photos/Y") — the proxy's input. */
  photoName: string | null;
  placeId: string | null;
  /** What Places actually matched, kept so a bad gate can be audited later. */
  matchedName: string | null;
  /** The gate's own numbers, for the same reason. */
  matchScore: number | null;
  matchDistanceM: number | null;
  /** Why a lookup produced nothing: too_far / name_mismatch / no_candidates … */
  reason: string;
  resolvedAt: Date;
  /** TTL anchor. Two lifetimes in one collection, so the date is precomputed. */
  expiresAt: Date;
}

const HotelPhotoCacheSchema = new Schema<IHotelPhotoCache>({
  hotelCode: { type: String, required: true, unique: true, index: true },
  status: { type: String, enum: ["resolved", "none"], required: true },
  photoName: { type: String, default: null },
  placeId: { type: String, default: null },
  matchedName: { type: String, default: null },
  matchScore: { type: Number, default: null },
  matchDistanceM: { type: Number, default: null },
  reason: { type: String, default: "" },
  resolvedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});

// expireAfterSeconds: 0 makes Mongo honour the per-document expiresAt, which is
// how one collection carries a 30-day hit TTL and a 7-day miss TTL.
HotelPhotoCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** The expiry a freshly-resolved row should carry. */
export function photoExpiryFor(status: "resolved" | "none", now = Date.now()): Date {
  const days = status === "resolved" ? PHOTO_TTL_DAYS : PHOTO_MISS_TTL_DAYS;
  return new Date(now + days * 24 * 60 * 60 * 1000);
}

const HotelPhotoCache =
  (mongoose.models.HotelPhotoCache as mongoose.Model<IHotelPhotoCache>) ||
  mongoose.model<IHotelPhotoCache>("HotelPhotoCache", HotelPhotoCacheSchema);

export default HotelPhotoCache;
