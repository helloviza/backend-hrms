// apps/backend/src/models/ConsumerErasureRequest.ts
//
// THE ERASURE REQUEST, AND THE RECORD OF WHAT IT DID — decisions D6 + D7.
//
// One row per request. It is BOTH the workflow object (a consumer asked; an
// ops reviewer looked; a Super Admin executed) and the permanent audit
// record of the execution. Those are not two collections because they are
// not two facts: "this person asked to be erased on the 3rd and it was done
// on the 5th by X" is one story, and splitting it would let the halves
// disagree.
//
// ══════════════════════════════════════════════════════════════════════
// D6 — WHY THE AUDIT RECORD IS PSEUDONYMISED, AND WHAT THAT MEANS HERE
// ══════════════════════════════════════════════════════════════════════
// An erasure log that stores the erased person's name and email is not an
// audit trail, it is a copy of the thing that was erased — the exact
// orphaned-PII problem the erasure was raised to solve, now sitting in the
// one collection nothing is ever allowed to delete.
//
// So this row holds identifying data ONLY while it is still needed to do
// the job, and the cascade's last act is to take it away:
//
//   requested / under_review / approved
//       subjectEmail + subjectName are POPULATED. A reviewer has to know
//       who they are approving the erasure of; asking them to approve an
//       opaque id would make the review theatre.
//
//   executed
//       subjectEmail and subjectName are NULLED by the same run that
//       performed the erasure (markExecuted() below — it is not a separate
//       step anyone can forget). What survives is:
//         - subjectPseudonym: HMAC-SHA256(salt, lowercased email), the
//           stable, non-reversible handle. Answers "has this person asked
//           before / been erased already?" without holding the address.
//         - consumerId: now a dangling ObjectId that resolves to nothing.
//           Pseudonymous by construction once the Consumer row is gone, and
//           kept because it is the ONLY thing that can correlate this row
//           with a redacted ManualBooking's metadata.consumerId if a
//           regulator ever asks "which invoice belonged to this request".
//         - the manifest: counts, collection names, invoice NUMBERS and
//           amounts. No name, no email, no address, no document.
//
//   rejected
//       Also nulled. A refused request has no reason to keep the address it
//       arrived with.
//
// The pseudonym is computed at CREATION, not at execution, so duplicate
// detection works while a request is still pending.
//
// ══════════════════════════════════════════════════════════════════════
// D7 — WHO DOES WHAT
// ══════════════════════════════════════════════════════════════════════
// The state machine below encodes it; the routes enforce it.
//   raise    -> the consumer themselves (routes/consumer.erasure.ts), or an
//               ops agent logging a request that arrived by another channel.
//   review   -> any holder of visaApplication:READ — the same gate the
//               consumer registry uses, because it is the same population
//               viewed for the same purpose.
//   approve  -> SUPERADMIN.
//   execute  -> SUPERADMIN, and only from `approved`.
// The split between approve and execute is deliberate even though both are
// SUPERADMIN: approving is a decision, executing is an irreversible act, and
// collapsing them removes the moment where someone can read the retention
// summary and stop.
import mongoose, { Schema, type Document, type Model } from "mongoose";
import crypto from "node:crypto";
import { erasurePseudonymSalt } from "../config/erasurePolicy.js";

export const CONSUMER_ERASURE_STATES = [
  "requested",
  "under_review",
  "approved",
  "executed",
  "rejected",
] as const;
export type ConsumerErasureState = (typeof CONSUMER_ERASURE_STATES)[number];

/**
 * THE ONLY LEGAL MOVES. Everything not listed is refused by
 * assertTransitionAllowed() below.
 *
 * `executed` and `rejected` are TERMINAL — no onward moves, deliberately,
 * not an empty array by accident. An executed request cannot be reopened
 * because the subject it refers to no longer exists; a rejected one is
 * closed and the consumer raises a new request rather than having an old
 * refusal quietly flipped.
 *
 * `approved -> under_review` exists so a reviewer who approved and then had
 * second thoughts can pull it back BEFORE anything runs. There is no path
 * out of `executed`, which is the point.
 */
export const CONSUMER_ERASURE_TRANSITIONS: Record<ConsumerErasureState, ConsumerErasureState[]> = {
  requested: ["under_review", "rejected"],
  under_review: ["approved", "rejected"],
  approved: ["executed", "under_review", "rejected"],
  executed: [],
  rejected: [],
};

export class ConsumerErasureTransitionError extends Error {
  constructor(from: ConsumerErasureState, to: ConsumerErasureState) {
    super(
      `Illegal erasure request transition ${from} -> ${to}. Allowed from ${from}: ` +
        `${CONSUMER_ERASURE_TRANSITIONS[from].join(", ") || "(none — terminal state)"}.`,
    );
    this.name = "ConsumerErasureTransitionError";
  }
}

export function assertTransitionAllowed(from: ConsumerErasureState, to: ConsumerErasureState): void {
  if (!CONSUMER_ERASURE_TRANSITIONS[from]?.includes(to)) {
    throw new ConsumerErasureTransitionError(from, to);
  }
}

/**
 * How the request reached us. Recorded because the evidentiary weight
 * differs: a request raised through the consumer's own authenticated
 * session is self-proving, whereas one an agent logged from an email needs
 * that email kept elsewhere.
 */
export const CONSUMER_ERASURE_ORIGINS = ["consumer_account", "ops_logged"] as const;
export type ConsumerErasureOrigin = (typeof CONSUMER_ERASURE_ORIGINS)[number];

export interface ConsumerErasureRequestDocument extends Document {
  consumerId: mongoose.Types.ObjectId;
  subjectPseudonym: string;
  subjectEmail: string | null;
  subjectName: string | null;

  state: ConsumerErasureState;
  origin: ConsumerErasureOrigin;

  requestedAt: Date;
  requestedByConsumerId: mongoose.Types.ObjectId | null;
  requestedByUserId: mongoose.Types.ObjectId | null;
  requestedByEmail: string | null;
  requestReason: string | null;

  reviewedAt: Date | null;
  reviewedByUserId: mongoose.Types.ObjectId | null;
  reviewedByEmail: string | null;
  reviewNote: string | null;

  decidedAt: Date | null;
  decidedByUserId: mongoose.Types.ObjectId | null;
  decidedByEmail: string | null;
  decisionNote: string | null;

  executedAt: Date | null;
  executedByUserId: mongoose.Types.ObjectId | null;
  executedByEmail: string | null;

  /** The dry-run plan captured at review time — what the reviewer actually saw. */
  reviewManifest: Record<string, unknown> | null;
  /** The real run's manifest. Written once, by markExecuted(). */
  manifest: Record<string, unknown> | null;

  createdAt?: Date;
  updatedAt?: Date;
}

const ConsumerErasureRequestSchema = new Schema<ConsumerErasureRequestDocument>(
  {
    // NOT unique on its own: a rejected request must not block a later,
    // better-founded one for the same person. Uniqueness that DOES matter —
    // "no two LIVE requests for one consumer" — is the partial index below.
    // No `index: true` here: the partial-unique index below already covers
    // every live-request lookup, and the {consumerId, requestedAt} compound
    // covers the history read. Declaring both would have created a second,
    // identical {consumerId:1} index — the exact thing Mongoose warns about
    // at boot.
    consumerId: { type: Schema.Types.ObjectId, ref: "Consumer", required: true },
    subjectPseudonym: { type: String, required: true, index: true },
    // Nullable BY DESIGN — see the D6 block in this file's header. Populated
    // while pending, nulled on execute/reject.
    subjectEmail: { type: String, default: null, lowercase: true, trim: true },
    subjectName: { type: String, default: null, trim: true },

    state: {
      type: String,
      enum: CONSUMER_ERASURE_STATES,
      default: "requested",
      required: true,
      index: true,
    },
    origin: { type: String, enum: CONSUMER_ERASURE_ORIGINS, required: true },

    requestedAt: { type: Date, required: true, default: Date.now },
    requestedByConsumerId: { type: Schema.Types.ObjectId, ref: "Consumer", default: null },
    requestedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    requestedByEmail: { type: String, default: null, lowercase: true, trim: true },
    requestReason: { type: String, default: null, trim: true },

    reviewedAt: { type: Date, default: null },
    reviewedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reviewedByEmail: { type: String, default: null, lowercase: true, trim: true },
    reviewNote: { type: String, default: null, trim: true },

    decidedAt: { type: Date, default: null },
    decidedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decidedByEmail: { type: String, default: null, lowercase: true, trim: true },
    decisionNote: { type: String, default: null, trim: true },

    executedAt: { type: Date, default: null },
    executedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    executedByEmail: { type: String, default: null, lowercase: true, trim: true },

    // Mixed rather than a fixed sub-schema, for the same reason
    // VisaErasureLog.counts is: the cascade's collection set will grow, and a
    // future collection must not need a migration of this model just to be
    // counted. The SHAPE is owned and typed by
    // scripts/lib/consumerErasureCascade.ts (ConsumerErasureManifest); this
    // model only stores it.
    reviewManifest: { type: Schema.Types.Mixed, default: null },
    manifest: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

/**
 * ONE LIVE REQUEST PER CONSUMER. The partial filter is what makes this
 * workable: terminal rows (executed/rejected) are excluded, so a person can
 * be refused and ask again, and the history of both attempts survives. A
 * plain unique index on consumerId would have made the second request
 * impossible; no index at all would let a double-click create two rows and
 * a reviewer approve one while a colleague rejects the other.
 */
ConsumerErasureRequestSchema.index(
  { consumerId: 1 },
  {
    unique: true,
    partialFilterExpression: { state: { $in: ["requested", "under_review", "approved"] } },
  },
);
// Every request ever raised for one person, newest first — the history
// read behind "has this consumer asked before?".
ConsumerErasureRequestSchema.index({ consumerId: 1, requestedAt: -1 });
ConsumerErasureRequestSchema.index({ state: 1, requestedAt: -1 });
ConsumerErasureRequestSchema.index({ requestedAt: -1 });

const ConsumerErasureRequest: Model<ConsumerErasureRequestDocument> =
  mongoose.models.ConsumerErasureRequest ||
  mongoose.model<ConsumerErasureRequestDocument>(
    "ConsumerErasureRequest",
    ConsumerErasureRequestSchema,
  );

export default ConsumerErasureRequest;

/* ─────────────────────────────────────────────────────────────────────
 * THE PSEUDONYM
 * ───────────────────────────────────────────────────────────────────── */

/**
 * HMAC-SHA256 over the lowercased, trimmed email, keyed on the deployment
 * salt, rendered as 32 hex chars (128 bits — collision-free at any
 * plausible population, half the string to store and read).
 *
 * HMAC, not a bare hash: an email address is drawn from a guessable space,
 * so an unkeyed SHA-256 of one is reversible by anybody holding a list of
 * addresses. The key is what makes this a pseudonym rather than an
 * obfuscation.
 *
 * The "hv:" prefix keeps a value in a log or a support ticket
 * self-describing, so nobody mistakes it for a hash of something else.
 */
export function consumerPseudonym(email: string): string {
  const normalised = String(email || "").trim().toLowerCase();
  const digest = crypto
    .createHmac("sha256", erasurePseudonymSalt())
    .update(`consumer:${normalised}`)
    .digest("hex")
    .slice(0, 32);
  return `hv:${digest}`;
}

/* ─────────────────────────────────────────────────────────────────────
 * THE SANCTIONED WRITERS. Nothing outside this file sets `state`.
 *
 * Each one re-reads and re-checks rather than trusting the caller's copy:
 * the console and the CLI can both drive this, and a stale document held by
 * one of them must not be able to walk the machine backwards.
 * ───────────────────────────────────────────────────────────────────── */

export interface RaiseConsumerErasureInput {
  consumerId: mongoose.Types.ObjectId | string;
  subjectEmail: string;
  subjectName: string;
  origin: ConsumerErasureOrigin;
  requestedByConsumerId?: mongoose.Types.ObjectId | string | null;
  requestedByUserId?: mongoose.Types.ObjectId | string | null;
  requestedByEmail?: string | null;
  requestReason?: string | null;
}

export class ConsumerErasureAlreadyOpenError extends Error {
  constructor(
    public readonly existingId: string,
    public readonly state: ConsumerErasureState,
  ) {
    super(`An erasure request for this consumer is already open (${state}).`);
    this.name = "ConsumerErasureAlreadyOpenError";
  }
}

/**
 * Raise a request. NEVER deletes anything — that is the whole point of the
 * two-step design (D4): the entry point creates a row in `requested` and
 * stops. Erasure happens only when a Super Admin later executes it.
 */
export async function raiseConsumerErasureRequest(
  input: RaiseConsumerErasureInput,
): Promise<ConsumerErasureRequestDocument> {
  const consumerId = new mongoose.Types.ObjectId(String(input.consumerId));

  const open = await ConsumerErasureRequest.findOne({
    consumerId,
    state: { $in: ["requested", "under_review", "approved"] },
  })
    .select("_id state")
    .lean();
  if (open) {
    throw new ConsumerErasureAlreadyOpenError(String((open as any)._id), (open as any).state);
  }

  try {
    const [doc] = await ConsumerErasureRequest.create([
      {
        consumerId,
        subjectPseudonym: consumerPseudonym(input.subjectEmail),
        subjectEmail: input.subjectEmail,
        subjectName: input.subjectName,
        state: "requested",
        origin: input.origin,
        requestedAt: new Date(),
        requestedByConsumerId: input.requestedByConsumerId ?? null,
        requestedByUserId: input.requestedByUserId ?? null,
        requestedByEmail: input.requestedByEmail ?? null,
        requestReason: input.requestReason ?? null,
      },
    ]);
    return doc;
  } catch (err: any) {
    // The partial unique index catching a race the findOne above lost.
    // Re-read and report it as the same refusal, not as a 500.
    if (err?.code === 11000) {
      const raced = await ConsumerErasureRequest.findOne({
        consumerId,
        state: { $in: ["requested", "under_review", "approved"] },
      })
        .select("_id state")
        .lean();
      throw new ConsumerErasureAlreadyOpenError(
        String((raced as any)?._id ?? ""),
        ((raced as any)?.state as ConsumerErasureState) ?? "requested",
      );
    }
    throw err;
  }
}

/**
 * D6, APPLIED AT EVERY TERMINAL STATE. Called by markExecuted() and
 * markRejected() — the two places a request stops moving and becomes a
 * permanent row nothing will ever delete.
 *
 * FOUR fields go, and the fourth is the one that is easy to miss:
 *
 *   subjectEmail, subjectName   the obvious pair.
 *   requestReason               free text the SUBJECT typed. Unenumerable
 *                               by construction — "my other address is
 *                               x@y.com, please remove that too" is a
 *                               perfectly ordinary thing to write in it —
 *                               so it is wiped wholesale rather than
 *                               inspected, the same rule this codebase
 *                               already applies to VisaActivityLog.detail
 *                               and ManualBooking.notes. The ops-authored
 *                               decisionNote survives and carries the
 *                               audit: what we decided, and why.
 *   requestedByEmail            ONLY when origin is "consumer_account", in
 *                               which case it is the subject's own address
 *                               under a different field name — and it is
 *                               exactly the field a scrub written from the
 *                               obvious pair alone leaves behind. For an
 *                               "ops_logged" request it identifies the
 *                               AGENT who logged it, not the subject, and
 *                               removing it would delete the audit trail
 *                               instead of the PII.
 *
 * Caught by the "the audit record does not keep the erased PII" test, which
 * serialises the whole row and asserts the address does not appear anywhere
 * in it — rather than asserting field by field, which is how requestedByEmail
 * survived the first version of this.
 */
function scrubSubjectIdentifiers(doc: ConsumerErasureRequestDocument): void {
  doc.subjectEmail = null;
  doc.subjectName = null;
  doc.requestReason = null;
  if (doc.origin === "consumer_account") {
    doc.requestedByEmail = null;
  }
}

export interface ErasureActor {
  userId: mongoose.Types.ObjectId | string;
  email: string;
}

/** requested -> under_review. Stores the dry-run plan the reviewer saw. */
export async function markUnderReview(
  requestId: mongoose.Types.ObjectId | string,
  actor: ErasureActor,
  reviewManifest: Record<string, unknown> | null,
  note?: string | null,
): Promise<ConsumerErasureRequestDocument> {
  const doc = await loadForTransition(requestId, "under_review");
  doc.state = "under_review";
  doc.reviewedAt = new Date();
  doc.reviewedByUserId = new mongoose.Types.ObjectId(String(actor.userId));
  doc.reviewedByEmail = actor.email;
  doc.reviewNote = note ?? null;
  doc.reviewManifest = reviewManifest;
  await doc.save();
  return doc;
}

/** under_review|approved -> approved. SUPERADMIN, enforced at the route. */
export async function markApproved(
  requestId: mongoose.Types.ObjectId | string,
  actor: ErasureActor,
  note?: string | null,
): Promise<ConsumerErasureRequestDocument> {
  const doc = await loadForTransition(requestId, "approved");
  doc.state = "approved";
  doc.decidedAt = new Date();
  doc.decidedByUserId = new mongoose.Types.ObjectId(String(actor.userId));
  doc.decidedByEmail = actor.email;
  doc.decisionNote = note ?? null;
  await doc.save();
  return doc;
}

/** -> rejected. Terminal, and the subject's contact details go with it. */
export async function markRejected(
  requestId: mongoose.Types.ObjectId | string,
  actor: ErasureActor,
  note: string,
): Promise<ConsumerErasureRequestDocument> {
  const doc = await loadForTransition(requestId, "rejected");
  doc.state = "rejected";
  doc.decidedAt = new Date();
  doc.decidedByUserId = new mongoose.Types.ObjectId(String(actor.userId));
  doc.decidedByEmail = actor.email;
  doc.decisionNote = note;
  // D6 — a refused request keeps no address either. The pseudonym is enough
  // to recognise the same person if they ask again.
  scrubSubjectIdentifiers(doc);
  await doc.save();
  return doc;
}

/**
 * approved -> executed. THE PSEUDONYMISATION HAPPENS HERE, in the same save
 * as the manifest, so there is no window in which a row says "executed"
 * while still holding the erased person's email — and no separate cleanup
 * step for anyone to forget.
 */
export async function markExecuted(
  requestId: mongoose.Types.ObjectId | string,
  actor: ErasureActor,
  manifest: Record<string, unknown>,
): Promise<ConsumerErasureRequestDocument> {
  const doc = await loadForTransition(requestId, "executed");
  doc.state = "executed";
  doc.executedAt = new Date();
  doc.executedByUserId = new mongoose.Types.ObjectId(String(actor.userId));
  doc.executedByEmail = actor.email;
  doc.manifest = manifest;
  scrubSubjectIdentifiers(doc);
  // The review snapshot named them too — a dry-run plan lists the invoice
  // recipient. It has served its purpose (the reviewer saw it) and must not
  // outlive the execution.
  doc.reviewManifest = null;
  await doc.save();
  return doc;
}

async function loadForTransition(
  requestId: mongoose.Types.ObjectId | string,
  to: ConsumerErasureState,
): Promise<ConsumerErasureRequestDocument> {
  const doc = await ConsumerErasureRequest.findById(requestId);
  if (!doc) throw new Error(`No ConsumerErasureRequest found with id ${String(requestId)}`);
  assertTransitionAllowed(doc.state, to);
  return doc;
}
