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

export interface ConsumerDocument extends Document {
  email: string;
  phone?: string;
  passwordHash: string;
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
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, required: true, trim: true },
    tokenVersion: { type: Number, required: true, default: 0 },
    status: { type: String, enum: CONSUMER_STATUSES, default: "ACTIVE", index: true },
  },
  { timestamps: true },
);

const Consumer: Model<ConsumerDocument> =
  mongoose.models.Consumer || mongoose.model<ConsumerDocument>("Consumer", ConsumerSchema);

export default Consumer;
