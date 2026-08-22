// apps/backend/src/models/SavedCountry.ts
//
// A consumer's bookmarked destination. One row per (consumer, country).
//
// ══════════════════════════════════════════════════════════════════════
// NOT PII, AND DELIBERATELY NOT ENCRYPTED.
// ══════════════════════════════════════════════════════════════════════
// models/ConsumerProfile.ts encrypts passport numbers, dates of birth and
// addresses because they identify a person. A bookmark is a PREFERENCE:
// "this reader is interested in Thailand". It is still private — the
// routes are own-scoped exactly like every other consumer collection —
// but it is not identity data, so it carries no `PII: encrypted at rest`
// marker and no fieldEncryptionPlugin.
//
// The distinction is worth stating rather than assuming, because the
// encryption plugin's own header warns that `distinct()` and `aggregate()`
// bypass decryption. Keeping this collection plaintext means the saved
// list can be queried and counted with ordinary Mongo without that trap.
//
// ── WHY iso2 AND NOT A REFERENCE ─────────────────────────────────────
// There is no Country COLLECTION to reference. The catalogue is static
// config (config/visaCountrySeed.ts), read in-process, so a bookmark
// stores the same key the map, the country route and the apply route all
// use — an uppercase ISO-3166-1 alpha-2 code. Anything else would need a
// translation layer between four surfaces that already agree.
//
// A saved code that later leaves the seed simply stops enriching; the
// route drops it from the response rather than rendering a blank card.
// See routes/consumer.saved.ts.
//
// ── ONE ROW, TWO WAYS IN ─────────────────────────────────────────────
// `source` records HOW a country got saved — by hand, or by starting an
// application for it. Both write to THIS collection, and the unique index
// below is what makes that safe: saving Thailand by hand and then
// starting an application for it is one row, not two, and the second
// write is a no-op rather than a duplicate-key error the caller has to
// interpret.
//
// It is kept because the two are genuinely different signals later — a
// deliberate bookmark is interest, an application-triggered save is
// intent — and recovering that distinction after the fact is impossible.
import mongoose, { Schema, type Document, type Model } from "mongoose";

/** How a country came to be saved. */
export const SAVED_COUNTRY_SOURCES = ["manual", "get-started"] as const;
export type SavedCountrySource = (typeof SAVED_COUNTRY_SOURCES)[number];

export interface SavedCountryDocument extends Document {
  consumerId: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  iso2: string;
  source: SavedCountrySource;
  createdAt?: Date;
  updatedAt?: Date;
}

const SavedCountrySchema = new Schema<SavedCountryDocument>(
  {
    // THE ISOLATION KEY. Every query in routes/consumer.saved.ts includes
    // it, taken from req.consumer.id and never from the request body —
    // the same rule ConsumerProfile states at length.
    consumerId: {
      type: Schema.Types.ObjectId,
      ref: "Consumer",
      required: true,
      index: true,
    },
    // The synthetic D2C tenant — a STAMP for downstream tenant-shaped
    // code, NOT an isolation boundary: every consumer carries the same
    // value (services/consumerWorkspace.ts).
    workspaceId: { type: Schema.Types.ObjectId, required: true, index: true },

    /**
     * Uppercase ISO-3166-1 alpha-2.
     *
     * `uppercase: true` normalises on write so the unique index below
     * cannot be defeated by case — without it "th" and "TH" are two rows
     * for one country, and the idempotent POST stops being idempotent.
     */
    iso2: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
    },

    source: {
      type: String,
      enum: SAVED_COUNTRY_SOURCES,
      required: true,
      default: "manual",
    },
  },
  { timestamps: true },
);

/**
 * ONE SAVE PER COUNTRY PER CONSUMER — enforced by the database.
 *
 * The route's idempotency is built ON this index rather than on a
 * read-then-write check: two rapid clicks on a heart are two concurrent
 * requests, and "find, see nothing, insert" would let both through. The
 * index makes the second insert fail with E11000, which the route treats
 * as success — because it is: the row the caller wanted exists.
 */
SavedCountrySchema.index({ consumerId: 1, iso2: 1 }, { unique: true });

/** The list is read newest-first, per consumer. */
SavedCountrySchema.index({ consumerId: 1, createdAt: -1 });

const SavedCountry: Model<SavedCountryDocument> =
  mongoose.models.SavedCountry ||
  mongoose.model<SavedCountryDocument>("SavedCountry", SavedCountrySchema);

export default SavedCountry;
