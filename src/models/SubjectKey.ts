// apps/backend/src/models/SubjectKey.ts
//
// One master-wrapped data key (DEK) per erasure SUBJECT. This collection is
// the crypto-shredding mechanism: destroying the row's wrappedDek makes
// every field encrypted under it permanently unreadable, everywhere it is
// stored, in one write — without visiting a single one of those documents.
//
// ── WHY ITS OWN COLLECTION, NOT A FIELD ON THE OWNING DOCUMENT ────────
// The obvious alternative — keep the wrapped DEK on the row whose fields it
// protects — fails on the case that matters most. A traveller's PII is not
// confined to one row: VisaDocument.extractedFields holds their MRZ data on
// N document rows across M applications, and those rows are owned by an
// APPLICATION, not by the traveller. Embedding would put N copies of the
// same subject's DEK in the database, so crypto-shredding would mean finding
// and destroying all N — and ONE missed copy is not a partial erasure, it is
// no erasure at all, because a single surviving wrapped DEK decrypts
// everything.
//
// A single row per subject makes the shred atomic and provable: one
// updateOne, and the count of remaining live keys for that subject is zero
// by construction (the unique index below).
//
// Lookup cost is the trade: one indexed findOne per subject per request
// instead of a field already in hand. security/subjectKeys.ts caches
// resolved DEKs in-process with a short TTL, which makes a request that
// touches many rows of one subject pay for exactly one lookup.
//
// ── WHAT A SUBJECT IS ─────────────────────────────────────────────────
// The subject is whoever the erasure right belongs to — matching the entry
// points in scripts/erase-traveller-profile.ts and (Stage 2) the consumer
// side:
//
//   CONSUMER          — Consumer._id. The D2C account holder. Owns
//                       ConsumerProfile (personal, contact, passports,
//                       coTravellers) and ConsumerDocument.
//   TRAVELLER_PROFILE — TravellerProfile._id. The B2B/concierge applicant.
//                       Owns their own VisaDocument.extractedFields, reached
//                       through VisaApplication.travellerProfileId — which
//                       is exactly the path erase-traveller-profile.ts
//                       already cascades along.
//
// A co-traveller stored inside a ConsumerProfile is NOT its own subject:
// they have no account, no login and no way to exercise an erasure right
// independently (models/ConsumerProfile.ts says so explicitly). Their fields
// encrypt under the owning CONSUMER's key, and erasing that consumer erases
// them too — which is the correct outcome, not an oversight.
//
// ── ONE ROW PER SUBJECT, FOREVER ──────────────────────────────────────
// The unique index is on {subjectType, subjectId} with no epoch and no
// second live row. A destroyed key is TOMBSTONED, never deleted: wrappedDek
// is unset, destroyedAt/destroyedBy/destroyReason are stamped, and the row
// stays as proof the shred happened. getOrCreateSubjectDek() refuses to
// mint a replacement for a tombstoned subject — a fresh key on an erased
// subject id would mean two crypto epochs sharing one identity, with the
// pre-erasure ciphertext still sitting there unreadable and undistinguished.
// This is not a trap for future writes: subject ids are ObjectIds and are
// never reused, so a re-registered person is a new _id and therefore a new
// row.
//
// ── AND WHAT THIS DOES NOT DO ─────────────────────────────────────────
// Crypto-shredding kills the subject's data in every backup taken AFTER the
// destroy. A backup taken BEFORE it still contains the live wrapped DEK
// alongside the ciphertext, so restoring that snapshot wholesale restores
// readability. Making the claim unconditional requires this collection to
// have its own retention (a shorter backup window than the data
// collections, or none) — an infrastructure decision, recorded here as an
// open item rather than assumed by the code.
import mongoose, { Schema, type Document, type Model } from "mongoose";

export const PII_SUBJECT_TYPES = ["CONSUMER", "TRAVELLER_PROFILE"] as const;
export type PiiSubjectType = (typeof PII_SUBJECT_TYPES)[number];

export interface SubjectKeyDocument extends Document {
  subjectType: PiiSubjectType;
  subjectId: mongoose.Types.ObjectId;

  // The DEK, encrypted under the master key, in the standard envelope from
  // security/fieldCrypto.ts. NULL means destroyed — see the header. There is
  // no state in which this holds an unwrapped key.
  wrappedDek: string | null;

  // Envelope version the wrap was written with, denormalised so a rotation
  // can find rows to re-wrap without parsing every wrappedDek string.
  encVersion: number;

  // Set together, never independently — the same convention as
  // VisaApplication's travellerProfileId/travellerErasedAt pair.
  destroyedAt: Date | null;
  destroyedByEmail: string | null;
  destroyReason: string | null;

  createdAt?: Date;
  updatedAt?: Date;
}

const SubjectKeySchema = new Schema<SubjectKeyDocument>(
  {
    subjectType: { type: String, enum: PII_SUBJECT_TYPES, required: true },
    subjectId: { type: Schema.Types.ObjectId, required: true },

    wrappedDek: { type: String, default: null },
    encVersion: { type: Number, required: true },

    destroyedAt: { type: Date, default: null },
    destroyedByEmail: { type: String, default: null, trim: true, lowercase: true },
    destroyReason: { type: String, default: null, trim: true },
  },
  { timestamps: true },
);

// THE invariant: at most one key row per subject, enforced by the database
// rather than by every call site remembering to upsert. Also the lookup
// index — every read of an encrypted field goes through exactly this query.
SubjectKeySchema.index({ subjectType: 1, subjectId: 1 }, { unique: true });

// Operational: "which subjects have been shredded, and when" without a
// collection scan — the query an erasure audit asks.
SubjectKeySchema.index({ destroyedAt: -1 });

const SubjectKey: Model<SubjectKeyDocument> =
  mongoose.models.SubjectKey || mongoose.model<SubjectKeyDocument>("SubjectKey", SubjectKeySchema);

export default SubjectKey;
