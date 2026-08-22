// apps/backend/src/models/ConsumerProfile.ts
//
// The D2C consumer's travel profile — everything the 7-tab "My Profile"
// surface holds, as ONE document keyed to one Consumer.
//
// ══════════════════════════════════════════════════════════════════════
// ⚠ PII: THIS COLLECTION IS THE MOST SENSITIVE ONE IN THE CODEBASE.
//
// Passport numbers, dates of birth, home addresses and family members'
// passport numbers all live here. They are now ENCRYPTED AT REST — see the
// ENCRYPTED_PII_FIELDS block at the bottom of this file, which is the
// authoritative list, and plugins/fieldEncryption.plugin.ts for the
// mechanism. Every such field still carries a
//
//     // PII: encrypted at rest
//
// marker on its own line, so the set stays greppable:
//
//     grep -rn "PII: encrypted at rest" apps/backend/src
//
// DO NOT add a new field holding identity data without BOTH a marker and an
// entry in ENCRYPTED_PII_FIELDS. A marker alone encrypts nothing.
//
// ── DUAL READ: ROWS WRITTEN BEFORE THIS ARE STILL PLAINTEXT ───────────
// Nothing has been backfilled. A row written before encryption was switched
// on reads back exactly as it always did (the plugin passes a non-envelope
// value through untouched) and converts to ciphertext on its NEXT save. A
// bulk conversion is a separate, gated step — until it runs, this
// collection is deliberately MIXED, and that is a supported state, not a
// half-finished migration.
//
// ── WHAT IS DELIBERATELY *NOT* ENCRYPTED ──────────────────────────────
// passports[].frontDocumentId / backDocumentId. They were marked PII in the
// original audit, but they are ObjectId REFERENCES to ConsumerDocument
// rows, not identity data — the located row holds the passport scan, and
// that row is what an erasure destroys. Encrypting a reference would break
// `ref` population and the arrayFilters $unset in
// routes/consumer.profile.ts, and protect nothing that isn't already
// protected. Recorded here so the next reader does not "fix" the omission.
//
// personal.photoStorageKey / photoDriver / photoMimeType / photoUpdatedAt.
// Same reasoning one step further: a storage LOCATOR for the account
// avatar, not identity data. The bytes are covered by SSE-S3 at rest, and
// encrypting the key would break the read-back path that serves them.
// ══════════════════════════════════════════════════════════════════════
//
// ── ISOLATION: ROW-LEVEL ON consumerId ────────────────────────────────
// `consumerId` is the boundary, and it is unique. Every query in
// routes/consumer.profile.ts takes it from req.consumer.id — never from a
// route param, a body field or a query string. workspaceId is a STAMP, not
// a boundary: every consumer shares HELLOVIZA_D2C_WORKSPACE_ID, so filtering
// on it alone would return everyone's profile (services/consumerWorkspace.ts).
//
// ── WHY NOT workspaceScopePlugin ──────────────────────────────────────
// Same reason models/Consumer.ts refuses it: the plugin ADDS a required,
// indexed workspaceId and a query shape built around tenant isolation, which
// is precisely the wrong boundary here. workspaceId below is a plain stamped
// field so downstream tenant-shaped code has something to read.
//
// ── WHY DOCUMENTS ARE NOT IN THIS FILE ────────────────────────────────
// The document locker is its OWN collection (models/ConsumerDocument.ts) so
// the future Apply page can reference the same rows. Passport scans are not
// stored inline here either — a passport holds ConsumerDocument ids. One
// store, reused, never copied.
import mongoose, { Schema, type Document, type Model } from "mongoose";
import { fieldEncryptionPlugin } from "../plugins/fieldEncryption.plugin.js";

/* ── Enums ──────────────────────────────────────────────────────────── */

export const PASSPORT_TYPES = ["ORDINARY", "DIPLOMATIC", "OFFICIAL"] as const;
export type PassportType = (typeof PASSPORT_TYPES)[number];

export const GENDERS = ["MALE", "FEMALE", "OTHER", "PREFER_NOT_TO_SAY"] as const;
export const MARITAL_STATUSES = ["SINGLE", "MARRIED", "DIVORCED", "WIDOWED", "OTHER"] as const;

export const EMPLOYMENT_TYPES = [
  "SALARIED",
  "SELF_EMPLOYED",
  "BUSINESS_OWNER",
  "STUDENT",
  "RETIRED",
  "HOMEMAKER",
  "UNEMPLOYED",
  "OTHER",
] as const;

export const CABIN_CLASSES = ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"] as const;
export const SEAT_PREFERENCES = ["WINDOW", "AISLE", "MIDDLE", "NO_PREFERENCE"] as const;

/* ── Sub-schemas ────────────────────────────────────────────────────── */

/**
 * A postal address. Used twice (current + permanent).
 *
 * `_id: false` throughout this file's embedded objects that are SINGLETONS;
 * the ARRAYS keep their _id because the API addresses their rows by it.
 */
const AddressSchema = new Schema(
  {
    // PII: encrypted at rest
    line1: { type: String, trim: true },
    // PII: encrypted at rest
    line2: { type: String, trim: true },
    // PII: encrypted at rest
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    // PII: encrypted at rest
    postalCode: { type: String, trim: true },
    country: { type: String, trim: true },
  },
  { _id: false },
);

/**
 * One passport. A consumer may hold several (dual nationality, a renewed
 * book kept for its valid visas), so this is an array with exactly one
 * `isPrimary` — enforced in the route layer, which is the only place that
 * can see all of them at once.
 */
const PassportSchema = new Schema(
  {
    // PII: encrypted at rest
    // The single highest-value field in this collection.
    number: { type: String, trim: true, uppercase: true },
    type: { type: String, enum: PASSPORT_TYPES, default: "ORDINARY" },
    issuingCountry: { type: String, trim: true },
    issueDate: { type: Date },
    // Drives the &lt;6-months expiry warning. Not validated as "future" — an
    // expired passport is a real thing a consumer may still have on file,
    // and refusing to store it would just mean they store nothing.
    expiryDate: { type: Date },
    placeOfIssue: { type: String, trim: true },

    // NOT encrypted — a reference, not identity data. See the file header's
    // "WHAT IS DELIBERATELY *NOT* ENCRYPTED" note.
    // Scans live in the shared locker (models/ConsumerDocument.ts); these are
    // references, so the Apply page reuses the same file rather than asking
    // for a second upload of the same page.
    frontDocumentId: { type: Schema.Types.ObjectId, ref: "ConsumerDocument" },
    // NOT encrypted — see frontDocumentId above.
    backDocumentId: { type: Schema.Types.ObjectId, ref: "ConsumerDocument" },

    isPrimary: { type: Boolean, default: false },
  },
  { timestamps: true },
);

/** One prior trip. Free-form on purpose — this is recall, not a record. */
const TravelHistorySchema = new Schema(
  {
    country: { type: String, trim: true },
    visaType: { type: String, trim: true },
    travelDate: { type: Date },
    notes: { type: String, trim: true },
  },
  { timestamps: true },
);

/**
 * A co-traveller (family member or frequent companion).
 *
 * Deliberately NOT a Consumer row: these people have no login, no session
 * and no account. Making them accounts would mean creating identities for
 * people who never asked for one — including children.
 */
const CoTravellerSchema = new Schema(
  {
    fullName: { type: String, trim: true },
    relationship: { type: String, trim: true },
    // PII: encrypted at rest
    // Mixed, not Date — TRAP 2 in plugins/fieldEncryption.plugin.ts: this
    // path has to hold either a real Date (a legacy row, never rewritten)
    // or a ciphertext string. The plugin owns the Date<->ISO conversion
    // Mongoose no longer does, so readers still get a Date object.
    dateOfBirth: { type: Schema.Types.Mixed },
    // PII: encrypted at rest
    passportNumber: { type: String, trim: true, uppercase: true },
    passportExpiryDate: { type: Date },
    nationality: { type: String, trim: true },
  },
  { timestamps: true },
);

/* ── Tab sections ───────────────────────────────────────────────────── */

const PersonalSchema = new Schema(
  {
    // The three name parts are separate because a visa form asks for them
    // separately and "must match your passport" is only checkable per part.
    firstName: { type: String, trim: true },
    middleName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    // PII: encrypted at rest
    // Mixed, not Date — see the CoTraveller dateOfBirth comment above and
    // TRAP 2 in plugins/fieldEncryption.plugin.ts. Nothing queries or does
    // date math on this field; services/consumerProfileCompletion.ts only
    // checks it for presence, and the <6-month expiry warning reads
    // passports[].expiryDate, which is NOT encrypted and stays a Date.
    dateOfBirth: { type: Schema.Types.Mixed },
    gender: { type: String, enum: GENDERS },
    placeOfBirthCity: { type: String, trim: true },
    placeOfBirthCountry: { type: String, trim: true },
    nationality: { type: String, trim: true },
    maritalStatus: { type: String, enum: MARITAL_STATUSES },
    countryOfResidence: { type: String, trim: true },
    /**
     * ⚠ UNUSED, AND THE AVATAR DELIBERATELY DOES NOT LIVE HERE.
     *
     * This was modelled as a forward hook before the upload existed and
     * nothing has ever written it. When the upload was built it did NOT
     * take this path, because a ConsumerDocument row is a LOCKER row: it
     * is counted by services/consumerProfileCompletion.ts and its docCode
     * is read by services/consumerVisaReadiness.ts. Storing an avatar as
     * one would mean uploading a selfie moved a consumer's completion bar
     * and could satisfy the PHOTO readiness item — an account avatar
     * silently reporting that the visa photograph requirement is met.
     *
     * The avatar is therefore a plain pointer on this section
     * (photoStorageKey below), owned by nothing but the profile.
     * Left in place rather than dropped so an existing row carrying one
     * is not orphaned by a schema removal; delete it once a migration
     * confirms the field is empty everywhere.
     */
    photoDocumentId: { type: Schema.Types.ObjectId, ref: "ConsumerDocument" },

    /* ── The ACCOUNT avatar ─────────────────────────────────────────
     *
     * Explicitly not the visa photograph, which has biometric
     * composition rules a selfie does not meet — keeping them separate
     * is what stops someone submitting one to an embassy. The UI says so
     * on the tile ("Account photo only"), and the storage split above is
     * what makes that sentence true rather than decorative.
     *
     * NOT ENCRYPTED, and not in ENCRYPTED_PII_FIELDS — the same
     * reasoning the file header gives for passports[].frontDocumentId:
     * these are LOCATORS, not identity data. The bytes they point at are
     * covered by S3 SSE-S3 at rest (utils/s3Upload.ts). Encrypting a
     * storage key would protect nothing and break the read-back path.
     *
     * ── WHY FOUR FIELDS AND NOT ONE ──────────────────────────────────
     * `openConsumerDocument()` needs BOTH the driver and the key: the
     * same key means an S3 object in production and a path under
     * .devdata/ in development, and a row written under one driver must
     * still be readable when the other is active. models/
     * ConsumerDocument.ts stores exactly this pair for exactly this
     * reason. mimeType is stored so the bytes route can set a real
     * Content-Type instead of guessing from the extension, and
     * photoUpdatedAt is what lets the client bust the <img> cache when a
     * consumer replaces their photo — without it the browser keeps
     * showing the old avatar at an unchanged URL.
     */
    photoStorageKey: { type: String, trim: true },
    photoDriver: { type: String, trim: true },
    photoMimeType: { type: String, trim: true },
    photoUpdatedAt: { type: Date },
  },
  { _id: false },
);

const ContactSchema = new Schema(
  {
    // PII: encrypted at rest
    mobile: { type: String, trim: true },
    // OTP wiring is a later task. The flag is modelled now so the UI can show
    // a real state rather than a decorative badge, and so nothing has to
    // migrate when verification lands.
    mobileVerified: { type: Boolean, default: false },
    mobileVerifiedAt: { type: Date },

    // Mirrored from the login identity at read time. Consumer.email is the
    // source of truth; this exists so the tab has something to render when
    // the consumer has not touched the tab at all.
    // PII: encrypted at rest
    alternateEmail: { type: String, trim: true, lowercase: true },

    currentAddress: { type: AddressSchema, default: () => ({}) },
    permanentSameAsCurrent: { type: Boolean, default: false },
    permanentAddress: { type: AddressSchema, default: () => ({}) },
  },
  { _id: false },
);

const TravelProfileSchema = new Schema(
  {
    occupation: { type: String, trim: true },
    employer: { type: String, trim: true },
    designation: { type: String, trim: true },
    employmentType: { type: String, enum: EMPLOYMENT_TYPES },
    workExperienceYears: { type: Number, min: 0, max: 80 },

    travelHistory: { type: [TravelHistorySchema], default: () => [] },

    // ── PRIOR REFUSALS: BOOLEAN ONLY, BY DESIGN ──────────────────────
    // Yes/No and nothing else. No country, no date, no reason, no free
    // text. A refusal narrative is exactly the kind of detail that damages
    // an applicant when it is stored half-remembered and then surfaced into
    // a form years later. The flag is enough to route the case to a human.
    hasPriorVisaRefusal: { type: Boolean, default: null },
  },
  { _id: false },
);

/**
 * Travel preferences.
 *
 * ⚠ THIS BLOCK IS A FORWARD HOOK, NOT A LIVE FEATURE.
 * Nothing books flights or hotels for a D2C consumer today. These fields
 * exist so the profile is already the place preferences live when flight and
 * hotel booking arrive, rather than a second profile appearing beside this
 * one. The UI labels the block as such — it must not imply that setting a
 * meal preference here affects anything yet.
 */
const TravelPreferencesSchema = new Schema(
  {
    cabinClass: { type: String, enum: CABIN_CLASSES },
    seatPreference: { type: String, enum: SEAT_PREFERENCES },
    mealPreference: { type: String, trim: true },
    frequentFlyerNumbers: {
      type: [
        new Schema(
          { airline: { type: String, trim: true }, number: { type: String, trim: true } },
          { _id: false },
        ),
      ],
      default: () => [],
    },
  },
  { _id: false },
);

const AccountPrefsSchema = new Schema(
  {
    // Mirrors what the account was created with. Today always PASSWORD;
    // GOOGLE / MICROSOFT arrive with real OAuth.
    loginMethod: { type: String, trim: true, default: "PASSWORD" },
    // UI-only today — see routes/consumer.profile.ts, which marks the
    // endpoints that are stubs.
    twoStepEnabled: { type: Boolean, default: false },
    notifyByEmail: { type: Boolean, default: true },
    notifyByWhatsapp: { type: Boolean, default: false },
    notifyProductUpdates: { type: Boolean, default: false },
  },
  { _id: false },
);

/* ── The document ───────────────────────────────────────────────────── */

export interface ConsumerProfileDocument extends Document {
  consumerId: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  personal: any;
  // `any`, not `any[]`: mongoose's SchemaDefinitionProperty cannot reconcile
  // an embedded-Schema array with a plain `any[]` field type, and the useful
  // runtime type here is DocumentArray anyway — it is what gives these the
  // `.id()` lookup the routes rely on for OWN-scoped sub-document access.
  passports: any;
  contact: any;
  travel: any;
  travelPreferences: any;
  coTravellers: any;
  accountPrefs: any;
  createdAt?: Date;
  updatedAt?: Date;
}

const ConsumerProfileSchema = new Schema<ConsumerProfileDocument>(
  {
    // THE ISOLATION KEY. Unique: one profile per consumer, enforced by the
    // database rather than by every call site remembering to upsert.
    consumerId: {
      type: Schema.Types.ObjectId,
      ref: "Consumer",
      required: true,
      unique: true,
      index: true,
    },
    // The synthetic D2C tenant — a STAMP for downstream tenant-shaped code.
    // NOT an isolation boundary: every consumer carries the same value.
    workspaceId: { type: Schema.Types.ObjectId, required: true, index: true },

    personal: { type: PersonalSchema, default: () => ({}) },
    passports: { type: [PassportSchema], default: () => [] },
    contact: { type: ContactSchema, default: () => ({}) },
    travel: { type: TravelProfileSchema, default: () => ({}) },
    travelPreferences: { type: TravelPreferencesSchema, default: () => ({}) },
    coTravellers: { type: [CoTravellerSchema], default: () => [] },
    accountPrefs: { type: AccountPrefsSchema, default: () => ({}) },
  },
  { timestamps: true },
);

/* ── Encryption at rest ─────────────────────────────────────────────── */

/**
 * THE authoritative list of encrypted paths on this collection — 14 of
 * them, from the 12 `PII: encrypted at rest` markers above (AddressSchema is
 * reused for current + permanent, so its 4 markers are 8 paths).
 *
 * Exported so tests and any future backfill script enumerate the same set
 * this schema actually encrypts, rather than a second copy that can drift.
 *
 * `$` means "every element of this array" (plugins/fieldEncryption.plugin.ts).
 * `type: "date"` paths are declared Schema.Types.Mixed above — see TRAP 2.
 */
export const ENCRYPTED_PII_FIELDS = [
  { path: "personal.dateOfBirth", type: "date" as const },

  { path: "contact.mobile" },
  { path: "contact.alternateEmail" },
  { path: "contact.currentAddress.line1" },
  { path: "contact.currentAddress.line2" },
  { path: "contact.currentAddress.city" },
  { path: "contact.currentAddress.postalCode" },
  { path: "contact.permanentAddress.line1" },
  { path: "contact.permanentAddress.line2" },
  { path: "contact.permanentAddress.city" },
  { path: "contact.permanentAddress.postalCode" },

  { path: "passports.$.number" },

  { path: "coTravellers.$.dateOfBirth", type: "date" as const },
  { path: "coTravellers.$.passportNumber" },
];

/**
 * The subject is the CONSUMER — the same `consumerId` that is already this
 * collection's isolation boundary, so encryption and row-level access
 * control key on exactly the same identity, and there is no second notion
 * of "whose data is this" to keep in sync.
 *
 * A co-traveller stored in `coTravellers[]` is NOT a separate subject:
 * they have no login and no independent erasure right (see this file's own
 * note on why they are not Consumer rows). Their passport number and date
 * of birth encrypt under the owning consumer's key, so erasing the consumer
 * erases them too — which is the intended outcome.
 */
ConsumerProfileSchema.plugin(fieldEncryptionPlugin, {
  fields: ENCRYPTED_PII_FIELDS,
  subject: (doc: any) =>
    doc?.consumerId ? { subjectType: "CONSUMER", subjectId: doc.consumerId } : null,
});

const ConsumerProfile: Model<ConsumerProfileDocument> =
  mongoose.models.ConsumerProfile ||
  mongoose.model<ConsumerProfileDocument>("ConsumerProfile", ConsumerProfileSchema);

export default ConsumerProfile;
