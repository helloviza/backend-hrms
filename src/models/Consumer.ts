// apps/backend/src/models/Consumer.ts
//
// The D2C (helloviza.ai) consumer identity — a SEPARATE collection from
// `users`, deliberately.
//
// WHY NOT `users`
// ---------------
// `users.email` carries a GLOBAL unique index (confirmed against the live
// cluster: infra/audit/helloviza-d2c-feasibility-2026-08-15.md §3.1). A
// consumer whose personal address happens to match a corporate user's could
// not be inserted at all, and the failure would surface as a raw duplicate-key
// error rather than a business decision. Keeping consumers in their own
// collection means the two namespaces are independent, and the Phase 1b
// "this email also exists in B2B" prompt becomes a deliberate read-only
// lookup instead of an insert that happens to fail.
//
// NO TENANT FIELDS
// ----------------
// There is no workspaceId/customerId/tenantId here, and this schema
// deliberately does NOT use workspaceScopePlugin — that plugin ADDS a
// required, indexed `workspaceId` to any schema it touches
// (plugins/workspaceScope.plugin.ts:33), which is exactly the coupling this
// phase exists to avoid. A consumer has no employer. Every consumer shares
// one synthetic workspace (services/consumerWorkspace.ts) purely so
// downstream tenant-shaped code has something to read; per-consumer
// isolation is ROW-LEVEL on this document's _id, never workspace-level.
import mongoose, { Schema, type Document, type Model } from "mongoose";

export const CONSUMER_STATUSES = ["ACTIVE", "DISABLED"] as const;
export type ConsumerStatus = (typeof CONSUMER_STATUSES)[number];

/**
 * HOW THIS ACCOUNT CAME INTO EXISTENCE. Recorded, not inferred.
 *
 * The alternative was to give a Google user a fabricated passwordHash so
 * the field could stay `required`. That is a lie written into the data:
 * every later reader — a support agent, a migration, a "can this person
 * reset their password?" branch — would see a credential that does not
 * exist and cannot ever be used. An optional hash plus an explicit
 * provider says the true thing instead, and says it in one field a query
 * can filter on.
 */
export const CONSUMER_AUTH_PROVIDERS = ["password", "google", "mobile"] as const;
export type ConsumerAuthProvider = (typeof CONSUMER_AUTH_PROVIDERS)[number];

export interface ConsumerDocument extends Document {
  email: string;
  /**
   * THE SIGNUP-CAPTURED IDENTITY HINT. Unverified, and not a login key.
   *
   * Normalised to bare ten digits on every write, so one shape is stored no
   * matter what a form sent. Nobody has proved they hold this number — it is
   * whatever was typed — which is exactly why `verifiedPhone` below is a
   * SEPARATE field and not a flag on this one. See it for the reasoning.
   */
  phone?: string;
  /**
   * THE VERIFIED, LOGIN-USABLE NUMBER. Unique across all consumers.
   *
   * Written in exactly one place — the OTP verify route, after MSG91
   * confirms the code — and absent until then. Bare ten digits, the same
   * shape `phone` holds, so a lookup never has to guess a format.
   */
  verifiedPhone?: string;
  /**
   * OPTIONAL, as of Google sign-in. Absent for every consumer whose
   * account was created by an identity provider rather than by choosing a
   * password. Anything that compares against it MUST check presence first
   * — bcrypt.compare(str, undefined) throws rather than returning false,
   * so an unguarded compare turns "this account has no password" into a
   * 500. routes/consumer.auth.ts's /login carries that guard.
   */
  passwordHash?: string;
  /** Which door created this account. See CONSUMER_AUTH_PROVIDERS. */
  authProvider: ConsumerAuthProvider;
  /**
   * Google's `sub` — the stable, immutable id for a Google account.
   *
   * Stored because EMAIL IS NOT A DURABLE KEY: a person can change the
   * address on their Google account, and matching on email alone would
   * then either fail to recognise them or, worse, attach them to somebody
   * else who since took the old address. `sub` never changes.
   */
  googleSub?: string;
  name: string;
  // Revocation counter. Every issued token embeds the value current at
  // issuance; middleware/requireConsumer.ts rejects any token whose embedded
  // value no longer matches. Bumping this invalidates every outstanding
  // access AND refresh token for this consumer at their next use — the
  // capability the B2B side does not have at all (no denylist, no
  // tokenVersion, no session store — see the tokenwall audit §5.3).
  tokenVersion: number;
  status: ConsumerStatus;
  /**
   * MARKETING CONSENT — a consent RECORD, not a notification preference.
   *
   * ⚠ THIS IS NOT ConsumerProfile.accountPrefs.notifyByEmail. That flag says
   * "send me transactional mail about my own application" and defaults TRUE
   * because a person who filed a visa case has asked to hear about it. This
   * block says "you may market to me", and it is the thing a regulator, or
   * the consumer themselves, asks us to prove. The two must never be read
   * for each other's question — which is why they live on different
   * collections rather than as two booleans in one bag.
   *
   * ── WHY IT IS ON Consumer AND NOT ConsumerProfile ─────────────────
   * ConsumerProfile is the encrypted collection, and encryption there is
   * absolute: any read that touches it must go through find/findOne so the
   * plugin's post-hooks can decrypt (models/ConsumerProfile.ts). Consent
   * STATUS is not identity data — it is a yes/no about a communication
   * channel — and the registry list has to sort, filter and count on it
   * across every consumer at once. Putting it behind the decryption
   * boundary would make "how many people opted in?" an unanswerable
   * question without decrypting the entire population.
   *
   * ── WHY EACH CHANNEL IS AN OBJECT AND NOT A BOOLEAN ───────────────
   * `optedIn: true` alone is an assertion with no evidence behind it. The
   * three fields beside it are what turn it into a record: WHEN (`at`),
   * WHERE (`source` — the surface that collected it), and WHAT THEY WERE
   * SHOWN (`version` — the consent-copy version, so a later change to the
   * wording cannot retroactively rewrite what somebody agreed to). A
   * boolean cannot answer "prove they consented", and that is the only
   * question this field will ever be asked.
   *
   * ── ABSENT MEANS NOT OPTED IN, AND THERE IS NO DEFAULT ────────────
   * No `default` anywhere in this block, on purpose. A default-true would
   * manufacture consent for every consumer who already exists and every one
   * created by a path that never showed them a checkbox; a default-false
   * would write a consent RECORD that nobody produced. Absent is the honest
   * third state, and every reader treats absent and false identically —
   * see consentView() in routes/admin.consumers.ts, the one place that
   * collapses them.
   */
  marketingConsent?: {
    email?: MarketingConsentEntry;
    whatsapp?: MarketingConsentEntry;
  };
  /**
   * WHERE THIS ACCOUNT WAS CREATED FROM — a one-shot snapshot taken at
   * registration, never updated afterwards.
   *
   * ── A SNAPSHOT, NOT A CURRENT LOCATION ────────────────────────────
   * The name says `registration` because that is the only thing this can
   * honestly claim. A consumer who signs up in Delhi and moves to Dubai
   * still carries `Delhi` here forever, and that is correct: the field
   * answers "where did this account come from", which is a marketing and
   * provenance question with a fixed answer. "Where are they now" is a
   * different question with a different lifetime, and models/
   * ActorLocation.ts already answers it — one row per actor, overwritten
   * on each request, expiring after 90 days. Do not teach this field to
   * track movement; that collection already does.
   *
   * ── PLAINTEXT, DELIBERATELY ───────────────────────────────────────
   * City/region/country are not identity data the way a passport number
   * is — they are coarse, shared by millions, and derived from an address
   * we did not store. The registry must group and filter on them across
   * the whole population ("consumers in India"), which is exactly the
   * aggregation the encrypted collection cannot do (models/
   * ConsumerProfile.ts). The IP itself is NOT stored here at all — that
   * is the identifying part, and location.service.ts hashes it.
   *
   * ── ABSENT IS A REAL AND EXPECTED STATE ───────────────────────────
   * No default, same rule as marketingConsent. Absent means the lookup
   * did not produce anything — a private IP, a cold-start timeout, or an
   * account created before this field existed. It must NEVER be inferred
   * to mean "unknown country" in a filter; the registry renders it as
   * "Unknown" and the country filter simply does not match it.
   */
  registrationLocation?: {
    /** Canonical city via the STRICT destinationLookup — null when unrecognised. */
    city: string | null;
    /** What the geo database said pre-canonicalisation, so a lookup-table gap stays measurable. */
    rawCity: string | null;
    region: string | null;
    /** ISO-3166-1 alpha-2, straight from the geo database. */
    country: string | null;
    source: string;
    /** 0..1 — see confidenceFromAccuracyRadius in location.service.ts. */
    confidence: number;
    accuracyRadiusKm: number | null;
    /** Machine-readable "why this answer" — distinguishes a timeout from a miss. */
    reason: string;
    capturedAt: Date;
  };
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * ONE CHANNEL'S CONSENT. See ConsumerDocument.marketingConsent below for why
 * this is a record rather than a boolean.
 *
 * `_id: false` — this is a singleton value object, not an addressable row;
 * nothing ever looks one up by id.
 */
export interface MarketingConsentEntry {
  optedIn: boolean;
  at?: Date;
  /** The surface that collected it, e.g. "signup". */
  source?: string;
  /** The consent-copy version they were shown, e.g. "2026-08-v1". */
  version?: string;
}

const MarketingConsentEntrySchema = new Schema(
  {
    /* No `default`. An entry only exists because something wrote one, and a
     * written entry always states its own value — see the interface note on
     * why absent is a real third state rather than a missing default. */
    optedIn: { type: Boolean, required: true },
    at: { type: Date },
    source: { type: String, trim: true },
    version: { type: String, trim: true },
  },
  { _id: false },
);

const ConsumerSchema = new Schema<ConsumerDocument>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    // INDEXED but deliberately NOT unique. The index exists for the Phase 1b
    // B2B-collision lookup, which needs to ask "does this mobile already
    // belong to a B2B user?" without a collection scan — `users` has no
    // phone index at all today (feasibility audit §3.1), so there is no
    // uniqueness guarantee on the other side to mirror. Optional because a
    // consumer can sign up with email alone.
    phone: { type: String, trim: true, index: true },
    /* ── THE UNIQUE, VERIFIED LOGIN KEY ────────────────────────────────
     * SEPARATE FROM `phone` ABOVE, AND THE SEPARATION IS THE WHOLE POINT.
     *
     * `phone` is what somebody typed into a signup form. This is a number
     * MSG91 has confirmed they can receive an SMS at. Those are different
     * facts with different trust levels, and collapsing them into one
     * unique field creates a specific, nasty failure:
     *
     *   A types 98765-43210 at signup — a typo, or somebody else's number,
     *   never verified. It takes the unique slot. B, who actually HOLDS
     *   98765-43210, then tries to verify it and is refused, because a
     *   stranger's typo is squatting on their real number. The unverified
     *   claim beats the proven one.
     *
     * With two fields that cannot happen: unverified claims live on `phone`,
     * where duplicates are harmless, and only proven numbers reach this
     * index. The constraint then means exactly one thing — "one account per
     * verified number" — which is what an OTP login needs to resolve a
     * number to a single account.
     *
     * ── sparse, NOT merely unique ─────────────────────────────────────
     * Almost every consumer has no verified number (all 3 in production
     * today, and every account created by Google or email signup). Without
     * `sparse` they would all collide on the missing value and the index
     * could not build at all. Sparse omits documents that lack the field.
     *
     * ⚠ THE EMPTY STRING IS NOT A MISSING VALUE. `sparse` skips ABSENT
     * fields; `""` is present, so two rows storing `""` would collide and
     * the second write would fail with a duplicate-key error. Every writer
     * must therefore store a valid ten-digit string or NOTHING AT ALL —
     * never the empty string normaliseIndiaMobile() returns on rejection.
     * The writers enforce that; this note is why they bother. */
    verifiedPhone: { type: String, trim: true, unique: true, sparse: true },
    // select:false so an incidental .find() can never return it; the login
    // path re-selects it explicitly.
    //
    // NO LONGER REQUIRED — a Google-created consumer has no password at
    // all. See the interface note above for the one rule that comes with
    // that: never bcrypt-compare against it without checking presence.
    passwordHash: { type: String, select: false },
    // Defaults to "password", so every row written before Google sign-in
    // existed reads correctly without a backfill: those accounts were all
    // created by the email signup path, which is exactly what the default
    // claims.
    authProvider: {
      type: String,
      enum: CONSUMER_AUTH_PROVIDERS,
      default: "password",
      index: true,
    },
    // Sparse, so the many consumers with no Google link are simply absent
    // from the index rather than piling up under a null key.
    //
    // Deliberately NOT unique yet. A sparse-unique index here would be the
    // stronger guarantee — one Google account should map to one consumer
    // — and is worth adding, but it is a schema constraint on a live
    // collection and belongs in its own reviewed change rather than
    // riding along with the feature that first writes the field.
    googleSub: { type: String, index: true, sparse: true },
    name: { type: String, required: true, trim: true },
    tokenVersion: { type: Number, required: true, default: 0 },
    status: { type: String, enum: CONSUMER_STATUSES, default: "ACTIVE", index: true },

    /* Deliberately no `default: () => ({})`. An empty object here would put
     * a marketingConsent key on every consumer row that has never been
     * asked, and "the field is present but empty" is a state the registry
     * would then have to distinguish from "opted out" — a distinction with
     * no meaning. Absent is the state; see the interface note. */
    marketingConsent: {
      type: new Schema(
        {
          email: { type: MarketingConsentEntrySchema },
          whatsapp: { type: MarketingConsentEntrySchema },
        },
        { _id: false },
      ),
    },

    /* No default, for the same reason marketingConsent has none: an empty
     * object would put the key on every row that was never located, and
     * "present but blank" is a state with no meaning here. See the
     * interface note — absent IS the answer. */
    registrationLocation: {
      type: new Schema(
        {
          city: { type: String, default: null },
          rawCity: { type: String, default: null },
          region: { type: String, default: null },
          // Uppercased on write: the geo database emits ISO alpha-2 already,
          // but the registry's country filter compares exactly, and one
          // lowercase row would silently drop out of its own segment.
          country: { type: String, default: null, uppercase: true, trim: true },
          source: { type: String, required: true },
          confidence: { type: Number, default: 0 },
          accuracyRadiusKm: { type: Number, default: null },
          reason: { type: String, default: "" },
          capturedAt: { type: Date, required: true },
        },
        { _id: false },
      ),
    },
  },
  { timestamps: true },
);

/**
 * THE REGISTRY'S DEFAULT SORT — newest first.
 *
 * `timestamps: true` creates createdAt but indexes nothing. The admin
 * registry (routes/admin.consumers.ts) sorts every page on it, and an
 * unindexed sort is a full collection scan plus an in-memory sort that
 * mongo aborts outright once the result set passes 32MB. Three consumers
 * today; this is the index that has to already exist the day there are
 * three hundred thousand.
 */
ConsumerSchema.index({ createdAt: -1 });

/**
 * The registry's country segment — "every consumer who registered from IN".
 * Sparse, because absent is the common state (see registrationLocation's own
 * note) and there is no reason for the many unlocated rows to pile up under
 * one null key.
 */
ConsumerSchema.index({ "registrationLocation.country": 1 }, { sparse: true });

const Consumer: Model<ConsumerDocument> =
  mongoose.models.Consumer || mongoose.model<ConsumerDocument>("Consumer", ConsumerSchema);

export default Consumer;
