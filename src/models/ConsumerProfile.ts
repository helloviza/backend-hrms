// apps/backend/src/models/ConsumerProfile.ts
//
// The D2C consumer's travel profile — everything the 7-tab "My Profile"
// surface holds, as ONE document keyed to one Consumer.
//
// ══════════════════════════════════════════════════════════════════════
// ⚠ PII: THIS COLLECTION IS THE MOST SENSITIVE ONE IN THE CODEBASE.
//
// Passport numbers, dates of birth, home addresses and family members'
// passport numbers all live here, IN CLEAN TEXT, deliberately and
// temporarily. Every such field carries a
//
//     // PII: encrypt-at-rest before prod
//
// marker on its own line. Encrypting them is a separate hardening pass;
// the markers exist so that pass cannot miss a field. Grep for the marker
// to enumerate the work:
//
//     grep -rn "PII: encrypt-at-rest before prod" apps/backend/src
//
// DO NOT add a new field holding identity data without a marker.
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
    // PII: encrypt-at-rest before prod
    line1: { type: String, trim: true },
    // PII: encrypt-at-rest before prod
    line2: { type: String, trim: true },
    // PII: encrypt-at-rest before prod
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    // PII: encrypt-at-rest before prod
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
    // PII: encrypt-at-rest before prod
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

    // PII: encrypt-at-rest before prod
    // Scans live in the shared locker (models/ConsumerDocument.ts); these are
    // references, so the Apply page reuses the same file rather than asking
    // for a second upload of the same page.
    frontDocumentId: { type: Schema.Types.ObjectId, ref: "ConsumerDocument" },
    // PII: encrypt-at-rest before prod
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
    // PII: encrypt-at-rest before prod
    dateOfBirth: { type: Date },
    // PII: encrypt-at-rest before prod
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
    // PII: encrypt-at-rest before prod
    dateOfBirth: { type: Date },
    gender: { type: String, enum: GENDERS },
    placeOfBirthCity: { type: String, trim: true },
    placeOfBirthCountry: { type: String, trim: true },
    nationality: { type: String, trim: true },
    maritalStatus: { type: String, enum: MARITAL_STATUSES },
    countryOfResidence: { type: String, trim: true },
    // The ACCOUNT avatar. Explicitly not the visa photograph, which has
    // biometric composition rules this one does not meet — keeping them
    // separate stops someone submitting a selfie to an embassy.
    photoDocumentId: { type: Schema.Types.ObjectId, ref: "ConsumerDocument" },
  },
  { _id: false },
);

const ContactSchema = new Schema(
  {
    // PII: encrypt-at-rest before prod
    mobile: { type: String, trim: true },
    // OTP wiring is a later task. The flag is modelled now so the UI can show
    // a real state rather than a decorative badge, and so nothing has to
    // migrate when verification lands.
    mobileVerified: { type: Boolean, default: false },
    mobileVerifiedAt: { type: Date },

    // Mirrored from the login identity at read time. Consumer.email is the
    // source of truth; this exists so the tab has something to render when
    // the consumer has not touched the tab at all.
    // PII: encrypt-at-rest before prod
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

const ConsumerProfile: Model<ConsumerProfileDocument> =
  mongoose.models.ConsumerProfile ||
  mongoose.model<ConsumerProfileDocument>("ConsumerProfile", ConsumerProfileSchema);

export default ConsumerProfile;
