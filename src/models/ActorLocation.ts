// apps/backend/src/models/ActorLocation.ts
//
// WHERE AN ACTOR CURRENTLY APPEARS TO BE — one row per actor, overwritten in
// place, never appended to.
//
// ITS OWN COLLECTION, DELIBERATELY NOT A FIELD ON User / Customer / Vendor.
// Three reasons, in order of how much they'd hurt:
//
//   1. TTL. Inferred location is a derived, decaying signal — it is only
//      honest for as long as it is fresh. A TTL index expires it on its own;
//      a field on User would need a sweeper nobody would remember to write,
//      and stale geo silently becomes "wrong geo presented as fact".
//   2. DELETABILITY. Under DPDP / GDPR this is the row you drop on an
//      erasure request or a "stop inferring my location" toggle. Dropping a
//      row is a one-liner; surgically nulling three fields across three
//      identity models is how partial deletions happen.
//   3. THREE ACTOR TYPES, ONE SHAPE. Employees, customers and vendors live
//      in different collections but the question and the answer are
//      identical. (actorId, actorType) keeps one code path instead of three.
//
// NO RAW IP IS EVER STORED. `ipHash` is a SALTED HMAC computed by
// location.service.ts. An unsalted hash of an IPv4 address is not
// pseudonymisation — the whole 2^32 space rainbow-tables in seconds — so the
// salt is what makes this field lawful to keep at all. When the salt is
// absent the service writes null rather than a weaker hash.
//
// NOT workspaceScopePlugin: that plugin declares workspaceId as
// `required: true`, and internal staff / HOUSE-tenant actors legitimately
// have no CustomerWorkspace. workspaceId is declared nullable below and
// carried in the unique key so the same human acting inside two workspaces
// is two rows, not a race between them.

import mongoose, { Schema, type Document, type Types } from "mongoose";

/** Which identity collection `actorId` points into. */
export type ActorType = "EMPLOYEE" | "CUSTOMER" | "VENDOR";

/** How the location was arrived at. Mirrors LocationSource in location.service.ts. */
export type ActorLocationSource = "ip" | "private-ip" | "unresolved" | "unavailable-non-http";

/**
 * How long a resolved location stays meaningful. 90 days is a deliberate
 * middle: long enough that a quarterly analytics question still has data,
 * short enough that nothing here outlives its own accuracy.
 */
export const ACTOR_LOCATION_TTL_DAYS = Number(process.env.ACTOR_LOCATION_TTL_DAYS) || 90;

export interface IActorLocation extends Document {
  actorId: Types.ObjectId;
  actorType: ActorType;
  /** null for internal staff / HOUSE-tenant actors with no CustomerWorkspace. */
  workspaceId: Types.ObjectId | null;

  /** Canonical city via the STRICT destinationLookup — null when unrecognised. */
  city: string | null;
  /**
   * What the geo database actually said, before canonicalisation.
   *
   * This is the field that makes the lookup gap MEASURABLE. destinationLookup
   * is a small, India-travel-shaped table, so plenty of genuine cities
   * ("Thane", "Warsaw") canonicalise to null. Without rawCity that shows up
   * as "we couldn't resolve them", which is false and would send someone
   * debugging the geo database instead of extending the table.
   */
  rawCity: string | null;
  /** Subdivision / state, verbatim from the geo database. */
  region: string | null;
  /** ISO-3166-1 alpha-2, verbatim from the geo database (NOT via the lookup). */
  country: string | null;

  source: ActorLocationSource;
  /** 0..1, derived from the geo database's accuracy radius. See location.service.ts. */
  confidence: number;
  /** The raw radius in km that `confidence` came from — kept so a threshold can be re-cut later. */
  accuracyRadiusKm: number | null;

  /** SALTED HMAC-SHA256 of the client IP. NEVER the IP itself. Null when no salt is configured. */
  ipHash: string | null;

  resolvedAt: Date;
  /** TTL anchor — see ACTOR_LOCATION_TTL_DAYS. */
  expiresAt: Date;
}

const ActorLocationSchema = new Schema<IActorLocation>(
  {
    actorId: { type: Schema.Types.ObjectId, required: true, index: true },
    actorType: { type: String, enum: ["EMPLOYEE", "CUSTOMER", "VENDOR"], required: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", default: null, index: true },

    city: { type: String, default: null },
    rawCity: { type: String, default: null },
    region: { type: String, default: null },
    country: { type: String, default: null },

    source: {
      type: String,
      enum: ["ip", "private-ip", "unresolved", "unavailable-non-http"],
      required: true,
    },
    confidence: { type: Number, default: 0 },
    accuracyRadiusKm: { type: Number, default: null },

    ipHash: { type: String, default: null },

    resolvedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { collection: "actorlocations" },
);

// ONE ROW PER ACTOR PER WORKSPACE. The unique key is what makes
// upsertCurrentLocation an overwrite rather than an append — without it two
// concurrent requests from the same user would each insert, and the
// collection would quietly become a location history nobody consented to.
//
// workspaceId: null participates in the key as a value (Mongo indexes null),
// so a staff actor with no workspace also gets exactly one row.
ActorLocationSchema.index({ actorId: 1, actorType: 1, workspaceId: 1 }, { unique: true });

// expireAfterSeconds: 0 makes Mongo honour the per-document expiresAt.
ActorLocationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** The expiry a freshly-resolved row should carry. */
export function actorLocationExpiryFor(now = Date.now()): Date {
  return new Date(now + ACTOR_LOCATION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** Identity half of a row — who we resolved, as opposed to what we resolved. */
export interface ActorIdentity {
  actorId: Types.ObjectId | string;
  actorType: ActorType;
  workspaceId: Types.ObjectId | string | null;
}

/** Location half of a row. Structurally the ResolvedLocation from location.service.ts. */
export interface ActorLocationFacts {
  city: string | null;
  rawCity: string | null;
  region: string | null;
  country: string | null;
  source: ActorLocationSource;
  confidence: number;
  accuracyRadiusKm: number | null;
}

function toObjectId(v: Types.ObjectId | string | null): Types.ObjectId | null {
  if (!v) return null;
  if (typeof v !== "string") return v;
  return mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(v) : null;
}

/**
 * Overwrite this actor's current location. Upsert on the unique key, so the
 * collection holds a CURRENT position and not a movement history.
 *
 * Returns false rather than throwing on any write failure: recording where
 * someone appears to be is an observability nicety, and it must never be the
 * reason a booking, an expense or a login fails.
 */
export async function upsertCurrentLocation(
  actor: ActorIdentity,
  facts: ActorLocationFacts,
  ipHash: string | null,
): Promise<boolean> {
  const actorId = toObjectId(actor.actorId);
  if (!actorId) return false;

  try {
    await ActorLocation.updateOne(
      {
        actorId,
        actorType: actor.actorType,
        workspaceId: toObjectId(actor.workspaceId),
      },
      {
        $set: {
          city: facts.city,
          rawCity: facts.rawCity,
          region: facts.region,
          country: facts.country,
          source: facts.source,
          confidence: facts.confidence,
          accuracyRadiusKm: facts.accuracyRadiusKm,
          ipHash,
          resolvedAt: new Date(),
          expiresAt: actorLocationExpiryFor(),
        },
      },
      { upsert: true },
    );
    return true;
  } catch (e: any) {
    console.error("[actorLocation] upsert failed", e?.message);
    return false;
  }
}

const ActorLocation =
  (mongoose.models.ActorLocation as mongoose.Model<IActorLocation>) ||
  mongoose.model<IActorLocation>("ActorLocation", ActorLocationSchema);

export default ActorLocation;
