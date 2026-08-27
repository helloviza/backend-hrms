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
export const CONSUMER_AUTH_PROVIDERS = ["password", "google"] as const;
export type ConsumerAuthProvider = (typeof CONSUMER_AUTH_PROVIDERS)[number];

export interface ConsumerDocument extends Document {
  email: string;
  phone?: string;
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
  createdAt?: Date;
  updatedAt?: Date;
}

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
  },
  { timestamps: true },
);

const Consumer: Model<ConsumerDocument> =
  mongoose.models.Consumer || mongoose.model<ConsumerDocument>("Consumer", ConsumerSchema);

export default Consumer;
