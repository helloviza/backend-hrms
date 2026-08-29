// apps/backend/src/scripts/lib/consumerErasureCascade.ts
//
// CONSUMER ERASURE — the executor. Stage 4.
//
// Given ONE consumerId, this erases that person from helloviza.ai. It is
// the D2C sibling of scripts/lib/visaErasureCascade.ts and borrows that
// file's whole shape — allow-list, plan-then-apply, dry-run by default,
// verified SUPERADMIN actor, shred last, an append-only record of the run —
// ADDITIVELY. Nothing over there is edited, moved or generalised: the two
// cascades start from different roots, touch overlapping-but-different
// collection sets, and answer to different retention arguments, and a
// premature merge of the two would have to carry every difference as a
// branch anyway.
//
// ══════════════════════════════════════════════════════════════════════
// THE THREE MOTIONS
// ══════════════════════════════════════════════════════════════════════
// Erasure here is not one verb. Three different things happen to three
// different classes of row, and conflating them is how you either
// under-erase (leave a name in a notes string) or over-erase (delete a tax
// invoice and put a hole in a statutory number series).
//
//   (b) REDACT   the rows we are REQUIRED TO KEEP: ManualBooking, its
//                TravelBooking mirror, Invoice, CreditNote. The fiscal
//                fields stay exactly as they are — invoice number, date,
//                amounts, the CGST/SGST/IGST split, GSTIN, the Razorpay
//                ids. Everything that identifies the person comes off.
//                NEVER a delete: the invoice series must stay gapless.
//
//   (a) DELETE   the rows that are pure PII with no retention claim on
//                them at all: the profile, the documents, the saved
//                corridors, the leads, the location, the support cases, the
//                visa case itself, and the Consumer row.
//
//   (c) SHRED    the subject's data key, LAST. Whatever ciphertext this
//                cascade could not reach — a stray copy, a row a future
//                code path forgets about — becomes unreadable rather than
//                merely deleted-where-we-looked.
//
// ── WHY REDACT RUNS BEFORE DELETE, THOUGH SHRED IS STILL LAST ────────
// The ordering constraint that actually binds is "the key dies last", and
// it is obeyed. Within the other two, redact goes first, and that is a
// deliberate choice rather than the order the motions are numbered in.
//
// Every motion has to FIND its targets. Redaction finds the invoice by
// walking consumer -> application -> ManualBooking -> Invoice. Deletion
// destroys exactly that walk. If deletion ran first and the process then
// died — a crash, a network blip, an operator's Ctrl-C — a re-run would be
// planning against a graph that no longer exists, and the invoice with the
// consumer's name still on it would be the one thing left pointing at a
// person we had just spent a cascade erasing.
//
// Redact-first inverts that: the worst interruption leaves a redacted
// invoice and a still-present profile, which is a re-runnable state and a
// visibly incomplete one. (Re-discovery is doubly safe because
// ManualBooking.metadata.consumerId survives redaction — see
// planManualBookings below for why that string is deliberately kept.)
//
// ══════════════════════════════════════════════════════════════════════
// THE DATA MAP — the confirmed set, and what happens to each
// ══════════════════════════════════════════════════════════════════════
//   Consumer                 delete   the account row
//   ConsumerProfile          delete   + avatar bytes; also the shred subject
//   ConsumerDocument         delete   + stored bytes (s3 or local-disk)
//   SavedCountry             delete   saved corridors
//   VisaD2CLead              delete   funnel rows
//   ActorLocation            delete   scoped actorType:"CONSUMER"
//   Ticket                   delete   D5 — see the block on tickets below
//   TicketMessage            delete   D5
//   TicketAttachment         delete   D5 + stored bytes
//   VisaRequest              delete   the consumer's own D2C cases
//   VisaApplication          delete   ditto
//   VisaDocument             delete   + S3 objects
//   VisaActivityLog          redact   detail wiped, row kept (audit)
//   ManualBooking            redact   passengers + notes; pricing kept
//   TravelBooking            redact   travellerName/Email on the mirror
//   Invoice                  redact   + stored PDF deleted; NEVER deleted
//   CreditNote               redact   ditto
//   SubjectKey               shred    last
//
// ══════════════════════════════════════════════════════════════════════
// D5 — TICKETS ARE DELETED, NOT REDACTED
// ══════════════════════════════════════════════════════════════════════
// A consumer support case is correspondence, and correspondence is the
// worst possible redaction target: TicketMessage.bodyText/bodyHtml is free
// text a person typed, so there is no enumerable set of fields to strip and
// no way to PROVE a redaction was complete. This is the same judgement
// VisaActivityLog's own erasure path already makes about `detail` — the
// difference is that an activity ROW is an audit fact worth keeping once
// its detail is gone, whereas a support ticket with its messages emptied is
// not a record of anything.
//
// Nothing pulls the other way: ticketRef comes from a monthly counter
// (models/Ticket.ts), not a statutory series, and no retention rule reaches
// a helpdesk thread. Only tickets carrying THIS consumerId are touched —
// every Gmail-ingested B2B ticket has consumerId null by construction and
// is unreachable from here.
//
// ══════════════════════════════════════════════════════════════════════
// D1 — THE ONE SWITCH
// ══════════════════════════════════════════════════════════════════════
// The recipient name on Invoice/CreditNote is governed by
// config/erasurePolicy.ts's shouldRedactInvoiceName(). Default false =
// keep it. Read that file for why the default is what it is. The name on
// ManualBooking/TravelBooking is NOT governed by it and always goes.
//
// ══════════════════════════════════════════════════════════════════════
// DRY RUN IS THE DEFAULT
// ══════════════════════════════════════════════════════════════════════
// planConsumerErasure() reads and writes nothing. executeConsumerErasure()
// is the only function here that writes, it takes an explicit
// {apply: true, confirmed: true} pair, and it refuses both halves
// separately so a caller cannot get there by passing one truthy object.
import mongoose from "mongoose";
import * as readline from "node:readline/promises";
import { stdin as rlInput, stdout as rlOutput } from "node:process";
import { env } from "../../config/env.js";

import Consumer from "../../models/Consumer.js";
import ConsumerProfile from "../../models/ConsumerProfile.js";
import ConsumerDocument from "../../models/ConsumerDocument.js";
import SavedCountry from "../../models/SavedCountry.js";
import VisaD2CLead from "../../models/VisaD2CLead.js";
import ActorLocation from "../../models/ActorLocation.js";
import Ticket from "../../models/Ticket.js";
import TicketMessage from "../../models/TicketMessage.js";
import TicketAttachment from "../../models/TicketAttachment.js";
import VisaRequest from "../../models/VisaRequest.js";
import VisaApplication from "../../models/VisaApplication.js";
import VisaDocument from "../../models/VisaDocument.js";
import VisaActivityLog, { redactVisaActivityForApplications } from "../../models/VisaActivityLog.js";
import ManualBooking from "../../models/ManualBooking.js";
import TravelBooking from "../../models/TravelBooking.js";
import Invoice from "../../models/Invoice.js";
import CreditNote from "../../models/CreditNote.js";
import User from "../../models/User.js";

import { deleteObject } from "../../utils/s3Upload.js";
import { deleteConsumerDocumentBytes } from "../../services/consumerDocumentStorage.js";
import { deleteLocalTicketAttachment } from "../../services/ticketAttachmentStorage.js";
import { destroySubjectDek } from "../../security/subjectKeys.js";
import { shouldRedactInvoiceName, ERASED_NAME_PLACEHOLDER } from "../../config/erasurePolicy.js";
import { consumerPseudonym } from "../../models/ConsumerErasureRequest.js";

/* ─────────────────────────────────────────────────────────────────────
 * GUARD 1 — the allow-list.
 *
 * TWO checks, because this cascade has two callers with opposite model
 * environments and one check cannot serve both:
 *
 *   assertModelScope()  — the STRICT registry sweep, exactly as
 *       visaErasureCascade.ts does it. Valid ONLY in a standalone script,
 *       where the set of registered models is the set this file imported.
 *       Useless inside the API server, where every model in the codebase is
 *       registered by server.ts before any request arrives.
 *
 *   assertAllowed()     — the per-write check, called at the top of every
 *       function below that writes. Works in BOTH environments and is the
 *       one with actual teeth: a future edit that reaches for a collection
 *       nobody signed off on fails on its first call, in a test, not in
 *       production against a customer's data.
 * ───────────────────────────────────────────────────────────────────── */
export const CONSUMER_ERASURE_ALLOWED_MODELS = [
  "Consumer",
  "ConsumerProfile",
  "ConsumerDocument",
  "SavedCountry",
  "VisaD2CLead",
  "ActorLocation",
  "Ticket",
  "TicketMessage",
  "TicketAttachment",
  "VisaRequest",
  "VisaApplication",
  "VisaDocument",
  "VisaActivityLog",
  "ManualBooking",
  "TravelBooking",
  "Invoice",
  "CreditNote",
  "SubjectKey",
  "ConsumerErasureRequest",
  // Read-only here — resolveSuperAdminActor() verifies the actor. Listed
  // because the allow-list is "may be touched", and a model this file
  // imports at all belongs on it.
  "User",
  // ── REGISTERED TRANSITIVELY, NEVER WRITTEN BY THIS FILE ──────────
  // Listed because assertModelScope() sweeps mongoose.modelNames(), which
  // sees every model the import graph pulls in, not just the ones named
  // above. Verified by import, not by guess: Counter/CompanySettings arrive
  // with Invoice and CreditNote (their number series), CustomerWorkspace
  // with ManualBooking (its TravelBooking mirror resolves the tenant), and
  // VisaRule with VisaApplication. Omitting any one of them made
  // assertModelScope() abort erase-consumer.ts on every run.
  //
  // The per-write assertAllowed() is what actually keeps them untouched:
  // nothing in this file calls it with these names, so nothing can write to
  // them without that being an obvious, deliberate edit here first.
  "Counter",
  "CompanySettings",
  "CustomerWorkspace",
  "VisaRule",
] as const;

export class ModelNotAllowedError extends Error {
  constructor(modelName: string) {
    super(
      `Refusing to write to "${modelName}": the consumer erasure cascade may only touch ` +
        `${CONSUMER_ERASURE_ALLOWED_MODELS.join(", ")}.`,
    );
    this.name = "ModelNotAllowedError";
  }
}

/** The per-write check. Cheap, and correct in both the CLI and the server. */
export function assertAllowed(modelName: string): void {
  if (!(CONSUMER_ERASURE_ALLOWED_MODELS as readonly string[]).includes(modelName)) {
    throw new ModelNotAllowedError(modelName);
  }
}

/**
 * The strict sweep — SCRIPT ONLY. Calling this from inside the API server
 * would abort the process, which is why the console path (routes/
 * admin.consumerErasure.ts) does not call it and says so.
 */
export function assertModelScope(): void {
  const registered = mongoose.modelNames();
  const unexpected = registered.filter(
    (name) => !(CONSUMER_ERASURE_ALLOWED_MODELS as readonly string[]).includes(name),
  );
  if (unexpected.length > 0) {
    console.error(
      `Refusing to run: this script may only touch ${CONSUMER_ERASURE_ALLOWED_MODELS.join(", ")}, but ` +
        `additional model(s) are registered: ${unexpected.join(", ")}.`,
    );
    process.exit(1);
  }
}

export function targetInfo(): { host: string; db: string } {
  const url = new URL(env.MONGO_URI);
  return { host: url.hostname, db: url.pathname.replace(/^\//, "") || "(default)" };
}

/* ─────────────────────────────────────────────────────────────────────
 * GUARD 2 — typed confirmation, same shape as visaErasureCascade.ts.
 * ───────────────────────────────────────────────────────────────────── */
export async function confirmDatabaseName(expectedDb: string): Promise<void> {
  if (process.argv.includes("--yes")) {
    console.log("--yes passed — skipping interactive confirmation.");
    return;
  }
  const rl = readline.createInterface({ input: rlInput, output: rlOutput });
  try {
    const answer = await rl.question(`Type the database name ("${expectedDb}") to proceed: `);
    if (answer.trim() !== expectedDb) {
      console.error("Aborted: input did not match the database name.");
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * GUARD 3 — actor verification. Duplicated from visaErasureCascade.ts
 * rather than imported, and that is the point of the duplication: importing
 * that module would register TravellerProfile, CstepTravelRequest and
 * CstepClaim, none of which are on THIS cascade's allow-list, and
 * assertModelScope() above would then refuse to run every time.
 * ───────────────────────────────────────────────────────────────────── */
export class ActorNotSuperAdminError extends Error {}

export async function resolveSuperAdminActor(
  actorEmail: string,
): Promise<{ _id: mongoose.Types.ObjectId; email: string }> {
  const email = (actorEmail || "").trim().toLowerCase();
  if (!email) throw new ActorNotSuperAdminError("--actor-email is required");

  const user = await User.findOne({ email }).select("_id email roles").lean();
  if (!user) throw new ActorNotSuperAdminError(`No user found with email "${email}"`);

  const roles: string[] = Array.isArray((user as any).roles) ? (user as any).roles : [];
  if (!roles.includes("SUPERADMIN")) {
    throw new ActorNotSuperAdminError(
      `User "${email}" is not SUPERADMIN (roles: ${roles.join(", ") || "none"})`,
    );
  }

  return { _id: (user as any)._id, email: (user as any).email };
}

/* ═════════════════════════════════════════════════════════════════════
 * THE PLAN
 *
 * Pure discovery. Every id the execution will need is resolved HERE, in
 * one pass, before anything is written — which is what lets the delete
 * motion run after the redact motion without having to re-walk a graph the
 * redaction has already changed.
 * ═════════════════════════════════════════════════════════════════════ */

export interface StoredObjectRef {
  driver: "s3" | "local-disk";
  storageKey: string;
  /** What it belongs to, for the plan's readout. */
  origin: string;
}

/** A fiscal row the reviewer is being told will SURVIVE. No PII in here. */
export interface RetainedInvoice {
  invoiceId: string;
  invoiceNo: string;
  invoiceDate: string | null;
  grandTotal: number;
  status: string;
  /** True when the recipient name stays — i.e. the D1 flag is off. */
  nameKept: boolean;
}

export interface RetainedBooking {
  manualBookingId: string;
  bookingRef: string;
  grandTotal: number;
}

export interface ConsumerErasurePlan {
  consumerId: string;
  /** Present only while the Consumer row still exists — used for the pseudonym. */
  subjectEmail: string | null;
  subjectName: string | null;
  subjectPseudonym: string | null;

  /* (a) delete */
  consumerExists: boolean;
  consumerProfileIds: string[];
  consumerDocumentIds: string[];
  savedCountryIds: string[];
  visaD2CLeadIds: string[];
  actorLocationIds: string[];
  ticketIds: string[];
  ticketMessageIds: string[];
  ticketAttachmentIds: string[];
  visaRequestIds: string[];
  visaApplicationIds: string[];
  visaDocumentIds: string[];

  /* (b) redact */
  manualBookingIds: string[];
  travelBookingIds: string[];
  invoiceIds: string[];
  creditNoteIds: string[];
  visaActivityLogCount: number;

  /* storage */
  storageObjects: StoredObjectRef[];

  /* what the reviewer must SEE before approving */
  retainedInvoices: RetainedInvoice[];
  retainedCreditNotes: RetainedInvoice[];
  retainedBookings: RetainedBooking[];

  /* things flagged, not erased */
  residuals: string[];
}

function ids(rows: any[]): string[] {
  return rows.map((r) => String(r._id));
}

export async function planConsumerErasure(
  consumerId: mongoose.Types.ObjectId | string,
): Promise<ConsumerErasurePlan> {
  const oid = new mongoose.Types.ObjectId(String(consumerId));
  const asString = String(consumerId);
  const residuals: string[] = [];

  /* ── The subject ────────────────────────────────────────────────── */
  const consumer: any = await Consumer.findById(oid).select("email name").lean();
  if (!consumer) {
    // NOT an error. A re-run after a successful erasure lands here, and the
    // right answer is a plan whose delete motion is empty and whose redact
    // motion still finds the fiscal rows via metadata.consumerId. That is
    // what makes this whole cascade re-runnable.
    residuals.push(
      "Consumer row not found — either already erased or a bad id. The fiscal rows below are still discoverable via ManualBooking.metadata.consumerId.",
    );
  }

  /* ── The visa case graph ────────────────────────────────────────── */
  const [applications, requests] = await Promise.all([
    VisaApplication.find({ consumerId: oid }).select("_id travellerProfileId").lean(),
    VisaRequest.find({ consumerId: oid }).select("_id").lean(),
  ]);
  const visaApplicationIds = ids(applications as any[]);
  const visaRequestIds = ids(requests as any[]);

  // A D2C application normally has no TravellerProfile (VisaDocument's
  // subject resolver falls through to CONSUMER — see that model). If one
  // DOES, its documents are encrypted under the TRAVELLER_PROFILE subject,
  // which this cascade deliberately does not shred: a traveller profile can
  // be shared across B2B cases belonging to other people. The document ROWS
  // are still deleted; only the key survives, and it is flagged rather than
  // silently left behind.
  const foreignSubjects = (applications as any[]).filter((a) => a.travellerProfileId);
  if (foreignSubjects.length > 0) {
    residuals.push(
      `${foreignSubjects.length} of this consumer's application(s) carry a travellerProfileId, so their VisaDocument ciphertext is keyed to a TRAVELLER_PROFILE subject. Those document rows are deleted, but that subject's key is NOT shredded here (it may be shared with other people's cases). Erase the traveller profile separately with scripts/erase-traveller-profile.ts if that is also intended.`,
    );
  }

  const visaDocuments =
    visaApplicationIds.length > 0
      ? await VisaDocument.find({ applicationId: { $in: visaApplicationIds } })
          .select("_id s3Key")
          .lean()
      : [];

  const visaActivityLogCount =
    visaApplicationIds.length > 0 || visaRequestIds.length > 0
      ? await VisaActivityLog.countDocuments({
          redactedAt: null,
          $or: [
            ...(visaApplicationIds.length > 0
              ? [{ applicationId: { $in: visaApplicationIds } }]
              : []),
            ...(visaRequestIds.length > 0 ? [{ requestId: { $in: visaRequestIds } }] : []),
          ],
        })
      : 0;

  /* ── Plaintext PII collections ──────────────────────────────────── */
  const [profiles, documents, savedCountries, leads, locations, tickets] = await Promise.all([
    ConsumerProfile.find({ consumerId: oid })
      // .lean() SKIPS the field-encryption plugin's post-hook, which is
      // exactly what is wanted: the plan must not decrypt anything. It only
      // needs the id and the avatar's storage locator, and neither is an
      // encrypted path.
      .select("_id personal.photoStorageKey personal.photoDriver")
      .lean(),
    ConsumerDocument.find({ consumerId: oid }).select("_id driver storageKey").lean(),
    SavedCountry.find({ consumerId: oid }).select("_id").lean(),
    VisaD2CLead.find({ consumerId: oid }).select("_id").lean(),
    ActorLocation.find({ actorId: oid, actorType: "CONSUMER" }).select("_id").lean(),
    Ticket.find({ consumerId: oid }).select("_id").lean(),
  ]);

  const ticketIds = ids(tickets as any[]);
  const [ticketMessages, ticketAttachments] =
    ticketIds.length > 0
      ? await Promise.all([
          TicketMessage.find({ ticketId: { $in: ticketIds } }).select("_id").lean(),
          TicketAttachment.find({ ticketId: { $in: ticketIds } })
            .select("_id driver storageKey s3Key")
            .lean(),
        ])
      : [[], []];

  /* ── The fiscal rows — found TWO ways, unioned ──────────────────── */
  // metadata.consumerId is the durable handle (a plain string written by
  // services/d2cInvoicing.ts, which survives redaction on purpose so a
  // half-finished run can be re-planned). metadata.visaApplicationId is the
  // handle visaBillingSync.ts/d2cInvoicing.ts share. Either alone would
  // miss rows: the first misses a booking minted before that key existed,
  // the second misses a booking whose application has already been deleted
  // by an interrupted run.
  const bookingFilters: any[] = [{ "metadata.consumerId": asString }];
  if (visaApplicationIds.length > 0) {
    bookingFilters.push({ "metadata.visaApplicationId": { $in: visaApplicationIds } });
  }
  const manualBookings = await ManualBooking.find({ $or: bookingFilters })
    .select("_id bookingRef invoiceId pricing")
    .lean();
  const manualBookingIds = ids(manualBookings as any[]);
  const manualBookingObjectIds = manualBookingIds.map((s) => new mongoose.Types.ObjectId(s));

  const travelBookings =
    manualBookingIds.length > 0
      ? await TravelBooking.find({
          reference: { $in: manualBookingObjectIds },
          referenceModel: "ManualBooking",
        })
          .select("_id")
          .lean()
      : [];

  // Same union logic for invoices: bookingIds is the real link, and
  // VisaApplication.d2cInvoiceId is the back-reference the Payments page
  // uses. A booking whose invoiceId was set but which never made it into
  // Invoice.bookingIds is exactly the stranded case d2cInvoicing.ts's
  // recovery path describes.
  const invoiceIdCandidates = new Set<string>();
  for (const b of manualBookings as any[]) if (b.invoiceId) invoiceIdCandidates.add(String(b.invoiceId));
  for (const a of applications as any[]) if (a.d2cInvoiceId) invoiceIdCandidates.add(String(a.d2cInvoiceId));

  const invoiceFilters: any[] = [];
  if (manualBookingObjectIds.length > 0) invoiceFilters.push({ bookingIds: { $in: manualBookingObjectIds } });
  if (invoiceIdCandidates.size > 0) {
    invoiceFilters.push({ _id: { $in: [...invoiceIdCandidates].map((s) => new mongoose.Types.ObjectId(s)) } });
  }
  const invoices =
    invoiceFilters.length > 0
      ? await Invoice.find({ $or: invoiceFilters })
          .select("_id invoiceNo invoiceDate grandTotal status pdfUrl")
          .lean()
      : [];
  const invoiceIds = ids(invoices as any[]);

  const creditNotes =
    invoiceIds.length > 0
      ? await CreditNote.find({ originalInvoiceId: { $in: invoiceIds } })
          .select("_id creditNoteNo creditNoteDate grandTotal")
          .lean()
      : [];

  /* ── Storage objects ────────────────────────────────────────────── */
  const storageObjects: StoredObjectRef[] = [];
  for (const d of documents as any[]) {
    if (d.storageKey) {
      storageObjects.push({ driver: d.driver, storageKey: d.storageKey, origin: "ConsumerDocument" });
    }
  }
  for (const p of profiles as any[]) {
    const key = p?.personal?.photoStorageKey;
    const driver = p?.personal?.photoDriver;
    // The avatar has no ConsumerDocument row of its own (routes/
    // consumer.profile.ts writes it straight to storage), so deleting the
    // document rows would leave the person's face in the bucket.
    if (key && driver) {
      storageObjects.push({ driver, storageKey: key, origin: "ConsumerProfile avatar" });
    }
  }
  for (const a of ticketAttachments as any[]) {
    const key = a.storageKey || a.s3Key;
    if (key) {
      storageObjects.push({ driver: a.driver || "s3", storageKey: key, origin: "TicketAttachment" });
    }
  }
  for (const d of visaDocuments as any[]) {
    if (d.s3Key) storageObjects.push({ driver: "s3", storageKey: d.s3Key, origin: "VisaDocument" });
  }
  // The rendered invoice PDF. A stored copy of an invoice is a frozen
  // snapshot of the PII we are about to strip out of the database, and it
  // is served from S3 by key. Deleting it is safe precisely because nothing
  // reads it as the source of truth — routes/invoices.ts re-renders every
  // PDF in-process from current DB state (see its bulk-pdf note), so the
  // next download produces a REDACTED document rather than a 404.
  for (const inv of invoices as any[]) {
    storageObjects.push({
      driver: "s3",
      storageKey: `invoices/${inv.invoiceNo}.pdf`,
      origin: `Invoice ${inv.invoiceNo} (rendered PDF — re-rendered on demand)`,
    });
  }

  const redactName = shouldRedactInvoiceName();

  return {
    consumerId: asString,
    subjectEmail: consumer?.email ?? null,
    subjectName: consumer?.name ?? null,
    subjectPseudonym: consumer?.email ? consumerPseudonym(consumer.email) : null,

    consumerExists: Boolean(consumer),
    consumerProfileIds: ids(profiles as any[]),
    consumerDocumentIds: ids(documents as any[]),
    savedCountryIds: ids(savedCountries as any[]),
    visaD2CLeadIds: ids(leads as any[]),
    actorLocationIds: ids(locations as any[]),
    ticketIds,
    ticketMessageIds: ids(ticketMessages as any[]),
    ticketAttachmentIds: ids(ticketAttachments as any[]),
    visaRequestIds,
    visaApplicationIds,
    visaDocumentIds: ids(visaDocuments as any[]),

    manualBookingIds,
    travelBookingIds: ids(travelBookings as any[]),
    invoiceIds,
    creditNoteIds: ids(creditNotes as any[]),
    visaActivityLogCount,

    storageObjects,

    retainedInvoices: (invoices as any[]).map((i) => ({
      invoiceId: String(i._id),
      invoiceNo: i.invoiceNo,
      invoiceDate: i.invoiceDate ? new Date(i.invoiceDate).toISOString() : null,
      grandTotal: Number(i.grandTotal ?? 0),
      status: String(i.status ?? ""),
      nameKept: !redactName,
    })),
    retainedCreditNotes: (creditNotes as any[]).map((c) => ({
      invoiceId: String(c._id),
      invoiceNo: c.creditNoteNo,
      invoiceDate: c.creditNoteDate ? new Date(c.creditNoteDate).toISOString() : null,
      grandTotal: Number(c.grandTotal ?? 0),
      status: "CREDIT_NOTE",
      nameKept: !redactName,
    })),
    retainedBookings: (manualBookings as any[]).map((b) => ({
      manualBookingId: String(b._id),
      bookingRef: b.bookingRef,
      grandTotal: Number(b.pricing?.grandTotal ?? b.pricing?.quotedPrice ?? 0),
    })),

    residuals,
  };
}

/* ═════════════════════════════════════════════════════════════════════
 * THE MANIFEST — the audit/undo record, and the dry-run report.
 *
 * ONE type for both, so what a reviewer approved and what actually ran are
 * literally the same shape and can be diffed. `dryRun` is the only field
 * that says which one you are holding.
 *
 * D6 CONTRACT: nothing in here identifies the subject. Counts, collection
 * names, invoice NUMBERS, amounts, storage keys (which contain a
 * consumerId, never a name) — and the pseudonym. No name, no email, no
 * address, no document contents.
 * ═════════════════════════════════════════════════════════════════════ */

export interface MotionEntry {
  collection: string;
  count: number;
}

export interface ConsumerErasureManifest {
  version: 1;
  consumerId: string;
  subjectPseudonym: string | null;
  dryRun: boolean;
  at: string;
  actorEmail: string;
  reason: string;
  /** The D1 flag AS IT WAS at run time — the run's own record of the policy it applied. */
  redactInvoiceName: boolean;
  motions: {
    redact: MotionEntry[];
    delete: MotionEntry[];
    shred: Array<{ subjectType: string; subjectId: string; outcome: string }>;
  };
  storage: {
    deleted: string[];
    failed: Array<{ key: string; error: string }>;
  };
  retained: {
    invoices: RetainedInvoice[];
    creditNotes: RetainedInvoice[];
    bookings: RetainedBooking[];
  };
  residuals: string[];
}

/** The dry-run manifest: what WOULD happen, written by nothing. */
export function planToManifest(
  plan: ConsumerErasurePlan,
  meta: { actorEmail: string; reason: string },
): ConsumerErasureManifest {
  return {
    version: 1,
    consumerId: plan.consumerId,
    subjectPseudonym: plan.subjectPseudonym,
    dryRun: true,
    at: new Date().toISOString(),
    actorEmail: meta.actorEmail,
    reason: meta.reason,
    redactInvoiceName: shouldRedactInvoiceName(),
    motions: {
      redact: [
        { collection: "ManualBooking", count: plan.manualBookingIds.length },
        { collection: "TravelBooking", count: plan.travelBookingIds.length },
        { collection: "Invoice", count: plan.invoiceIds.length },
        { collection: "CreditNote", count: plan.creditNoteIds.length },
        { collection: "VisaActivityLog", count: plan.visaActivityLogCount },
      ],
      delete: [
        { collection: "ConsumerProfile", count: plan.consumerProfileIds.length },
        { collection: "ConsumerDocument", count: plan.consumerDocumentIds.length },
        { collection: "SavedCountry", count: plan.savedCountryIds.length },
        { collection: "VisaD2CLead", count: plan.visaD2CLeadIds.length },
        { collection: "ActorLocation", count: plan.actorLocationIds.length },
        { collection: "TicketAttachment", count: plan.ticketAttachmentIds.length },
        { collection: "TicketMessage", count: plan.ticketMessageIds.length },
        { collection: "Ticket", count: plan.ticketIds.length },
        { collection: "VisaDocument", count: plan.visaDocumentIds.length },
        { collection: "VisaApplication", count: plan.visaApplicationIds.length },
        { collection: "VisaRequest", count: plan.visaRequestIds.length },
        { collection: "Consumer", count: plan.consumerExists ? 1 : 0 },
      ],
      shred: [
        {
          subjectType: "CONSUMER",
          subjectId: plan.consumerId,
          outcome: "would destroy the subject data key (last)",
        },
      ],
    },
    storage: { deleted: plan.storageObjects.map((s) => s.storageKey), failed: [] },
    retained: {
      invoices: plan.retainedInvoices,
      creditNotes: plan.retainedCreditNotes,
      bookings: plan.retainedBookings,
    },
    residuals: plan.residuals,
  };
}

/* ═════════════════════════════════════════════════════════════════════
 * MOTION (b) — REDACT THE RETAINED FINANCIAL ROWS
 * ═════════════════════════════════════════════════════════════════════ */

/**
 * The name the B2B cascade's redactManualBookings() deliberately LEAVES,
 * and which this one takes. The two are not in conflict — they are erasing
 * different things. Over there the subject is a traveller on a CORPORATE
 * customer's invoice, and the name on that invoice line is the customer's
 * business record of who they sent where. Here the subject IS the payer:
 * the booking exists only because this consumer bought a visa, its single
 * passenger IS them, and there is no third party whose record it also is.
 *
 * ALSO takes `notes`, which the B2B version does not reach at all, and
 * which is the concrete gap the D2C flow opened:
 * services/d2cInvoicing.ts writes `Helloviza D2C visa — {consumerName}` —
 * a name in a free-text field that no passenger-level redaction touches.
 *
 * The replacement is a WHOLESALE overwrite, not a surgical excision of the
 * name from the string. Free text is unenumerable, exactly the property
 * that makes redactVisaActivityForApplications() wipe `detail` rather than
 * pick through it, and a regex that assumed the current notes format would
 * silently pass through any note written in a different one. The reference
 * number the note carried is not lost: it lives on `sourceBookingRef` and
 * `metadata.visaRequestReferenceNumber`, neither of which is PII.
 */
export const REDACTED_NOTES = "[PII erased on request — see ConsumerErasureRequest]";

export interface RedactBookingsResult {
  manualBookingsRedacted: number;
  travelBookingsRedacted: number;
}

export async function redactManualBookingsForConsumer(
  manualBookingIds: string[],
): Promise<RedactBookingsResult> {
  assertAllowed("ManualBooking");
  assertAllowed("TravelBooking");
  if (manualBookingIds.length === 0) return { manualBookingsRedacted: 0, travelBookingsRedacted: 0 };

  /* NO .select() HERE, AND THAT IS LOAD-BEARING.
   *
   * Projecting to the fields being edited looks tidy and is a data-loss
   * bug: `pricing` hydrates from its schema defaults when it is not
   * selected, ManualBooking's pre("save") hook then recomputes the whole
   * block from those zeroes, and save() writes ₹0 over a real invoice
   * total. The post("save") mirror sync reads the same zeroed pricing and
   * pushes ₹0 onto the TravelBooking as well.
   *
   * That is the exact failure this cascade exists to prevent — an erasure
   * is never allowed to alter a financial figure — so the whole document is
   * loaded and round-tripped. Caught by the "redacts the booking and its
   * mirror without touching pricing" test, which asserts the amounts are
   * unchanged rather than only asserting the name is gone. */
  const bookings = await ManualBooking.find({
    _id: { $in: manualBookingIds },
    piiRedactedAt: { $exists: false },
  });

  let manualBookingsRedacted = 0;
  for (const booking of bookings as any[]) {
    booking.passengers = (booking.passengers || []).map((p: any) => ({
      ...(p.toObject ? p.toObject() : p),
      // `name` is required on the sub-schema, so it takes the visible
      // tombstone rather than undefined — a required field set to undefined
      // fails validation and would abort the whole erasure on a save().
      name: ERASED_NAME_PLACEHOLDER,
      email: undefined,
      phone: undefined,
      passportNo: undefined,
    }));
    booking.notes = REDACTED_NOTES;
    booking.piiRedactedAt = new Date();
    // save(), NOT updateOne: the post("save") hook re-syncs the
    // TravelBooking mirror from these very fields, so the mirror's
    // travellerName/travellerEmail follow automatically. The explicit
    // mirror pass below is still run — see its own comment.
    await booking.save();
    manualBookingsRedacted++;
  }

  /* THE MIRROR, WRITTEN EXPLICITLY.
   *
   * ManualBookingSchema.post("save") already syncs it — and swallows any
   * failure into a console.warn (see that hook). A best-effort hook is fine
   * for a booking edit; it is not fine for the step that removes a person's
   * name. This pass is idempotent with the hook's own result and turns a
   * silent mirror failure into a thrown error. It is also what covers a
   * mirror whose source booking was ALREADY redacted by an earlier,
   * interrupted run (and is therefore skipped by the loop above). */
  const objectIds = manualBookingIds.map((s) => new mongoose.Types.ObjectId(s));
  const mirrorResult = await TravelBooking.updateMany(
    { reference: { $in: objectIds }, referenceModel: "ManualBooking" },
    { $set: { travellerName: ERASED_NAME_PLACEHOLDER, travellerEmail: "" } },
  );

  return {
    manualBookingsRedacted,
    travelBookingsRedacted: mirrorResult.matchedCount ?? 0,
  };
}

/**
 * The fields that come off a fiscal document, and the ones that stay.
 *
 * KEPT, unconditionally — this is the whole reason the document survives:
 *   invoiceNo / creditNoteNo, invoiceDate, subtotal, totalGST, grandTotal,
 *   supplyType, cgst/sgst/utgst/igst, issuerDetails (that is US, not them),
 *   clientDetails.gstin, clientDetails.state/country, placeOfSupply,
 *   clientState, lineItems' descriptions and amounts, status, paidAt,
 *   the Razorpay id in `notes`, bookingIds, editHistory.
 *
 * REMOVED:
 *   clientDetails.email, .billingAddress, .addressLine1, .addressLine2,
 *   .pincode  — contact and street-level location, no GST role.
 *   pdfUrl    — a presigned link to the un-redacted rendering.
 *
 * KEPT-OR-REMOVED BY D1 (config/erasurePolicy.ts):
 *   clientDetails.companyName, clientDetails.contactPerson,
 *   lineItems[].passengerNames
 *
 * ── WHY passengerNames MOVES WITH THE RECIPIENT NAME ─────────────────
 * On a D2C receipt they are the SAME STRING — d2cInvoicing.ts sets the
 * bill-to from the consumer's name, and the booking's single passenger is
 * that same person. Governing them with two switches would admit an invoice
 * addressed to "[erased on request]" whose line item still reads "Rahul
 * Sharma", which erases nothing and looks like a bug. One decision, one
 * flag.
 *
 * ── WHY city IS KEPT WHILE pincode IS NOT ────────────────────────────
 * City feeds place-of-supply reasoning alongside state, and a city on its
 * own identifies nobody. A pincode plus a name is close to an address.
 */
function redactFiscalClientDetails(details: any, redactName: boolean): any {
  const next = { ...(details ?? {}) };
  next.email = undefined;
  next.billingAddress = undefined;
  next.addressLine1 = undefined;
  next.addressLine2 = undefined;
  next.pincode = undefined;
  if (redactName) {
    next.companyName = ERASED_NAME_PLACEHOLDER;
    next.contactPerson = ERASED_NAME_PLACEHOLDER;
  }
  return next;
}

export interface RedactInvoicesResult {
  invoicesRedacted: number;
  creditNotesRedacted: number;
  /** The flag's value at the moment of the run — recorded, not re-read later. */
  redactedName: boolean;
}

export async function redactInvoicesForConsumer(
  invoiceIds: string[],
  creditNoteIds: string[],
  actorUserId: mongoose.Types.ObjectId | string | null,
): Promise<RedactInvoicesResult> {
  assertAllowed("Invoice");
  assertAllowed("CreditNote");
  const redactName = shouldRedactInvoiceName();

  let invoicesRedacted = 0;
  if (invoiceIds.length > 0) {
    const rows = await Invoice.find({ _id: { $in: invoiceIds }, piiRedactedAt: { $exists: false } });
    for (const inv of rows as any[]) {
      inv.clientDetails = redactFiscalClientDetails(inv.clientDetails, redactName);
      if (redactName) {
        inv.lineItems = (inv.lineItems || []).map((li: any) => ({
          ...(li.toObject ? li.toObject() : li),
          passengerNames: (li.passengerNames || []).map(() => ERASED_NAME_PLACEHOLDER),
        }));
      }
      inv.pdfUrl = undefined;
      inv.piiRedactedAt = new Date();
      /* The model's own audit convention, with ONE deliberate departure:
       * oldValues is left EMPTY. Every other writer of editHistory records
       * what the field used to be — which here would copy the erased
       * person's name and email into the invoice's own history and undo the
       * redaction in the same save. The fields changed are recorded; their
       * former contents are not. */
      inv.editHistory = [
        ...(inv.editHistory || []),
        {
          editedAt: new Date(),
          editedBy: actorUserId ?? undefined,
          fieldsChanged: redactName
            ? ["clientDetails", "lineItems.passengerNames", "pdfUrl"]
            : ["clientDetails", "pdfUrl"],
          oldValues: {},
          newValues: { piiRedactedAt: inv.piiRedactedAt, redactInvoiceName: redactName },
        },
      ];
      await inv.save();
      invoicesRedacted++;
    }
  }

  let creditNotesRedacted = 0;
  if (creditNoteIds.length > 0) {
    const rows = await CreditNote.find({
      _id: { $in: creditNoteIds },
      piiRedactedAt: { $exists: false },
    });
    for (const cn of rows as any[]) {
      cn.clientDetails = redactFiscalClientDetails(cn.clientDetails, redactName);
      if (redactName) {
        cn.lineItems = (cn.lineItems || []).map((li: any) => ({
          ...(li.toObject ? li.toObject() : li),
          passengerNames: (li.passengerNames || []).map(() => ERASED_NAME_PLACEHOLDER),
        }));
      }
      // reasonNote is the agent's free text on why the credit was raised and
      // routinely names the customer; reasonText is a catalogue value and
      // stays. Same unenumerable-free-text rule as ManualBooking.notes.
      cn.reasonNote = undefined;
      cn.pdfUrl = undefined;
      cn.piiRedactedAt = new Date();
      await cn.save();
      creditNotesRedacted++;
    }
  }

  return { invoicesRedacted, creditNotesRedacted, redactedName: redactName };
}

/* ═════════════════════════════════════════════════════════════════════
 * MOTION (a) — DELETE THE PLAINTEXT PII ROWS
 * ═════════════════════════════════════════════════════════════════════ */

export interface StorageDeleteResult {
  deleted: string[];
  failed: Array<{ key: string; error: string }>;
}

/**
 * Bytes go BEFORE rows, for the reason visaErasureCascade.ts's
 * deleteDocumentsAndS3() gives: the failure mode worth engineering against
 * is a deleted row whose passport scan is still in the bucket, now
 * unreferenced and undiscoverable by anything that lists by owner.
 *
 * UNLIKE the B2B version, a failure here does NOT abort the run. That is a
 * considered difference, not a relaxation. Over there the object set is one
 * homogeneous group of visa documents and an abort loses nothing. Here it
 * spans four unrelated stores plus a rendered invoice PDF that may never
 * have been generated at all — a `NoSuchKey` on `invoices/PT-123.pdf`
 * because nobody ever downloaded that invoice is the COMMON case, and
 * aborting a person's erasure over it would mean the erasure never
 * completes. Every failure is collected, returned, and lands in the
 * manifest as a named residual the operator must chase.
 */
export async function deleteStorageObjects(objects: StoredObjectRef[]): Promise<StorageDeleteResult> {
  const deleted: string[] = [];
  const failed: Array<{ key: string; error: string }> = [];

  for (const obj of objects) {
    try {
      if (obj.driver === "local-disk") {
        // Ticket attachments and consumer documents keep their local bytes
        // under different roots; each store deletes its own.
        if (obj.origin === "TicketAttachment") {
          await deleteLocalTicketAttachment(obj.storageKey);
        } else {
          await deleteConsumerDocumentBytes({ driver: "local-disk", storageKey: obj.storageKey });
        }
      } else {
        await deleteObject(obj.storageKey);
      }
      deleted.push(obj.storageKey);
    } catch (err: any) {
      failed.push({ key: obj.storageKey, error: err?.message || String(err) });
    }
  }

  return { deleted, failed };
}

export interface DeleteRowsResult {
  counts: Record<string, number>;
}

/**
 * The delete motion. Order within it runs CHILDREN BEFORE PARENTS —
 * attachments before messages before tickets, documents before applications
 * before requests — so that an interruption leaves orphans pointing UP at a
 * row that still exists, never a parent pointing down at rows that are
 * gone. An orphan with a live parent is findable and re-runnable; the
 * reverse is not.
 */
export async function deleteConsumerRows(plan: ConsumerErasurePlan): Promise<DeleteRowsResult> {
  for (const m of [
    "TicketAttachment",
    "TicketMessage",
    "Ticket",
    "VisaDocument",
    "VisaApplication",
    "VisaRequest",
    "ConsumerDocument",
    "SavedCountry",
    "VisaD2CLead",
    "ActorLocation",
    "ConsumerProfile",
    "Consumer",
  ]) {
    assertAllowed(m);
  }

  const counts: Record<string, number> = {};
  const del = async (name: string, fn: () => Promise<{ deletedCount?: number }>) => {
    const r = await fn();
    counts[name] = r.deletedCount ?? 0;
  };

  await del("TicketAttachment", () =>
    plan.ticketAttachmentIds.length
      ? TicketAttachment.deleteMany({ _id: { $in: plan.ticketAttachmentIds } })
      : Promise.resolve({ deletedCount: 0 }),
  );
  await del("TicketMessage", () =>
    plan.ticketMessageIds.length
      ? TicketMessage.deleteMany({ _id: { $in: plan.ticketMessageIds } })
      : Promise.resolve({ deletedCount: 0 }),
  );
  await del("Ticket", () =>
    plan.ticketIds.length
      ? Ticket.deleteMany({ _id: { $in: plan.ticketIds } })
      : Promise.resolve({ deletedCount: 0 }),
  );
  await del("VisaDocument", () =>
    plan.visaDocumentIds.length
      ? VisaDocument.deleteMany({ _id: { $in: plan.visaDocumentIds } })
      : Promise.resolve({ deletedCount: 0 }),
  );
  await del("VisaApplication", () =>
    plan.visaApplicationIds.length
      ? VisaApplication.deleteMany({ _id: { $in: plan.visaApplicationIds } })
      : Promise.resolve({ deletedCount: 0 }),
  );
  await del("VisaRequest", () =>
    plan.visaRequestIds.length
      ? VisaRequest.deleteMany({ _id: { $in: plan.visaRequestIds } })
      : Promise.resolve({ deletedCount: 0 }),
  );
  await del("ConsumerDocument", () =>
    plan.consumerDocumentIds.length
      ? ConsumerDocument.deleteMany({ _id: { $in: plan.consumerDocumentIds } })
      : Promise.resolve({ deletedCount: 0 }),
  );
  await del("SavedCountry", () =>
    plan.savedCountryIds.length
      ? SavedCountry.deleteMany({ _id: { $in: plan.savedCountryIds } })
      : Promise.resolve({ deletedCount: 0 }),
  );
  await del("VisaD2CLead", () =>
    plan.visaD2CLeadIds.length
      ? VisaD2CLead.deleteMany({ _id: { $in: plan.visaD2CLeadIds } })
      : Promise.resolve({ deletedCount: 0 }),
  );
  await del("ActorLocation", () =>
    plan.actorLocationIds.length
      ? ActorLocation.deleteMany({ _id: { $in: plan.actorLocationIds } })
      : Promise.resolve({ deletedCount: 0 }),
  );
  await del("ConsumerProfile", () =>
    plan.consumerProfileIds.length
      ? ConsumerProfile.deleteMany({ _id: { $in: plan.consumerProfileIds } })
      : Promise.resolve({ deletedCount: 0 }),
  );
  await del("Consumer", () =>
    plan.consumerExists
      ? Consumer.deleteOne({ _id: new mongoose.Types.ObjectId(plan.consumerId) })
      : Promise.resolve({ deletedCount: 0 }),
  );

  return { counts };
}

/* ═════════════════════════════════════════════════════════════════════
 * MOTION (c) — CRYPTO-SHRED. THE KEY DIES LAST.
 * ═════════════════════════════════════════════════════════════════════
 *
 * ConsumerProfile's 14 encrypted paths and (for a D2C case)
 * VisaDocument.extractedFields are both keyed on the SAME subject —
 * {CONSUMER, consumerId} — so one destroySubjectDek() covers both. See
 * models/VisaDocument.ts's subject resolver: it falls through to the
 * consumer precisely when there is no traveller profile, which is every
 * ordinary D2C case.
 *
 * WHY LAST, concretely: the plan reads ConsumerProfile and VisaDocument
 * rows. Shredding first would leave the field-encryption plugin unable to
 * decrypt them, and a later step that needed a real value would either
 * throw or silently read a null. Shredding last means every step ran
 * against live data and the key's destruction is the final, unrecoverable
 * act — the one thing that cannot be half-done.
 *
 * Idempotent: a re-run reports alreadyDestroyed rather than failing.
 */
export interface ShredResult {
  destroyed: boolean;
  hadNoKey: boolean;
  alreadyDestroyed: boolean;
  outcome: string;
}

export async function shredConsumerKey(
  consumerId: mongoose.Types.ObjectId | string,
  actorEmail: string,
  reason: string,
): Promise<ShredResult> {
  assertAllowed("SubjectKey");
  const result = await destroySubjectDek("CONSUMER", consumerId, { actorEmail, reason });
  const outcome = result.destroyed
    ? "destroyed"
    : result.alreadyDestroyed
      ? "already destroyed by an earlier run"
      : "no key existed — this subject never encrypted anything";
  return { ...result, outcome };
}

/* ═════════════════════════════════════════════════════════════════════
 * THE INVARIANTS — checked after every real run.
 *
 * Detection only. There is no multi-collection transaction here, so these
 * cannot roll an erasure back; they exist to make a failure IMPOSSIBLE TO
 * MISS. They THROW rather than process.exit() (unlike the B2B cascade's
 * assertNoDanglingVisaDocuments) because this code also runs inside the API
 * server, where killing the process would take every other request with it.
 * ═════════════════════════════════════════════════════════════════════ */

export class ErasureInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErasureInvariantError";
  }
}

/**
 * THE ONE THAT MATTERS MOST: no invoice was deleted, and the series has no
 * hole in it.
 *
 * It re-reads every invoice the plan said would be RETAINED and asserts each
 * is still there. A cascade that "worked" but took an invoice with it is
 * the single worst outcome available to this code — worse than failing to
 * erase, because the erasure can be re-run and a gapless statutory series
 * cannot be un-gapped.
 */
export async function assertInvoicesSurvived(plan: ConsumerErasurePlan): Promise<void> {
  if (plan.invoiceIds.length === 0) return;
  const survivors = await Invoice.find({ _id: { $in: plan.invoiceIds } }).select("_id invoiceNo").lean();
  if (survivors.length !== plan.invoiceIds.length) {
    const found = new Set(survivors.map((s: any) => String(s._id)));
    const missing = plan.invoiceIds.filter((id) => !found.has(id));
    throw new ErasureInvariantError(
      `INVARIANT VIOLATED: ${missing.length} invoice(s) that this erasure promised to RETAIN no longer exist ` +
        `(${missing.join(", ")}). A tax invoice must never be deleted by an erasure — the number series has to stay gapless.`,
    );
  }
}

/**
 * No ManualBooking or Invoice this run touched still carries a readable
 * contact detail. Cheap, and it catches the class of bug where a field was
 * added to a schema and nobody added it to redactFiscalClientDetails().
 */
export async function assertFinancialPiiStripped(plan: ConsumerErasurePlan): Promise<void> {
  if (plan.manualBookingIds.length > 0) {
    const leaky = await ManualBooking.find({
      _id: { $in: plan.manualBookingIds },
      $or: [
        { "passengers.email": { $exists: true, $nin: [null, ""] } },
        { "passengers.phone": { $exists: true, $nin: [null, ""] } },
        { "passengers.passportNo": { $exists: true, $nin: [null, ""] } },
      ],
    })
      .select("_id bookingRef")
      .lean();
    if (leaky.length > 0) {
      throw new ErasureInvariantError(
        `INVARIANT VIOLATED: ${leaky.length} ManualBooking(s) still carry passenger contact details after redaction: ` +
          leaky.map((b: any) => b.bookingRef).join(", "),
      );
    }
  }

  if (plan.invoiceIds.length > 0) {
    const leaky = await Invoice.find({
      _id: { $in: plan.invoiceIds },
      "clientDetails.email": { $exists: true, $nin: [null, ""] },
    })
      .select("_id invoiceNo")
      .lean();
    if (leaky.length > 0) {
      throw new ErasureInvariantError(
        `INVARIANT VIOLATED: ${leaky.length} Invoice(s) still carry a recipient email after redaction: ` +
          leaky.map((i: any) => i.invoiceNo).join(", "),
      );
    }
  }
}

/* ═════════════════════════════════════════════════════════════════════
 * THE EXECUTOR
 * ═════════════════════════════════════════════════════════════════════ */

export interface ExecuteOptions {
  /** Must be literally true. Without it nothing is written. */
  apply: boolean;
  /**
   * The SECOND gate — the caller's assertion that a human confirmed. Two
   * separate booleans rather than one, so no caller reaches a real erasure
   * by spreading a partially-built options object.
   */
  confirmed: boolean;
  actorEmail: string;
  actorUserId?: mongoose.Types.ObjectId | string | null;
  reason: string;
}

export class ErasureNotConfirmedError extends Error {}

/**
 * Runs the three motions in order: redact -> delete -> shred. Returns the
 * manifest of what it actually did.
 *
 * Callers pass a PLAN, not a consumerId, so the ids that were reviewed are
 * the ids that are acted on. A console flow that plans, shows a reviewer,
 * waits, and then executes cannot silently widen its blast radius between
 * the two — anything created in the gap is simply not in the plan, and the
 * cascade is re-runnable for it.
 */
export async function executeConsumerErasure(
  plan: ConsumerErasurePlan,
  opts: ExecuteOptions,
): Promise<ConsumerErasureManifest> {
  if (opts.apply !== true) {
    throw new ErasureNotConfirmedError("Refusing to write: executeConsumerErasure requires apply === true.");
  }
  if (opts.confirmed !== true) {
    throw new ErasureNotConfirmedError(
      "Refusing to write: executeConsumerErasure requires confirmed === true (the human confirmation gate).",
    );
  }
  if (!opts.reason || !opts.reason.trim()) {
    throw new ErasureNotConfirmedError("Refusing to write: a reason is required and is recorded on the manifest.");
  }

  const redactInvoiceName = shouldRedactInvoiceName();

  /* ── (b) REDACT — first, while the graph that finds these rows is
   *      still intact. See the header for why this precedes the delete. ── */
  const bookings = await redactManualBookingsForConsumer(plan.manualBookingIds);
  const fiscal = await redactInvoicesForConsumer(
    plan.invoiceIds,
    plan.creditNoteIds,
    opts.actorUserId ?? null,
  );
  const activityRowsRedacted =
    plan.visaApplicationIds.length > 0
      ? await redactVisaActivityForApplications(plan.visaApplicationIds)
      : 0;

  /* ── (a) DELETE — bytes, then rows, children before parents. ─────── */
  const storage = await deleteStorageObjects(plan.storageObjects);
  const { counts: deleteCounts } = await deleteConsumerRows(plan);

  /* ── (c) SHRED — last. ──────────────────────────────────────────── */
  const shred = await shredConsumerKey(plan.consumerId, opts.actorEmail, opts.reason);

  /* ── Invariants ─────────────────────────────────────────────────── */
  await assertInvoicesSurvived(plan);
  await assertFinancialPiiStripped(plan);

  const residuals = [...plan.residuals];
  if (storage.failed.length > 0) {
    residuals.push(
      `${storage.failed.length} stored object(s) could not be deleted and are still in the bucket — chase each by key: ` +
        storage.failed.map((f) => `${f.key} (${f.error})`).join("; "),
    );
  }
  if (!redactInvoiceName && plan.invoiceIds.length > 0) {
    residuals.push(
      `ERASURE_REDACT_INVOICE_NAME is OFF (the default), so the recipient name REMAINS on ${plan.invoiceIds.length} retained tax invoice(s) under the statutory-retention reading. Every other identifying field on them was stripped. Flip the flag and re-run this consumer to remove the name once counsel rules.`,
    );
  }

  return {
    version: 1,
    consumerId: plan.consumerId,
    subjectPseudonym: plan.subjectPseudonym,
    dryRun: false,
    at: new Date().toISOString(),
    actorEmail: opts.actorEmail,
    reason: opts.reason,
    redactInvoiceName,
    motions: {
      redact: [
        { collection: "ManualBooking", count: bookings.manualBookingsRedacted },
        { collection: "TravelBooking", count: bookings.travelBookingsRedacted },
        { collection: "Invoice", count: fiscal.invoicesRedacted },
        { collection: "CreditNote", count: fiscal.creditNotesRedacted },
        { collection: "VisaActivityLog", count: activityRowsRedacted },
      ],
      delete: Object.entries(deleteCounts).map(([collection, count]) => ({ collection, count })),
      shred: [{ subjectType: "CONSUMER", subjectId: plan.consumerId, outcome: shred.outcome }],
    },
    storage: { deleted: storage.deleted, failed: storage.failed },
    retained: {
      invoices: plan.retainedInvoices,
      creditNotes: plan.retainedCreditNotes,
      bookings: plan.retainedBookings,
    },
    residuals,
  };
}

/* ═════════════════════════════════════════════════════════════════════
 * RENDERING — one readout, used by the CLI and by the console's review
 * screen, so a reviewer and an operator are looking at the same words.
 * ═════════════════════════════════════════════════════════════════════ */

export function renderManifest(m: ConsumerErasureManifest): string {
  const lines: string[] = [];
  const rule = "──────────────────────────────────────────────────────";
  lines.push(rule);
  lines.push(m.dryRun ? "DRY RUN — nothing was written." : "APPLIED — this run wrote to the database.");
  lines.push(`Consumer:          ${m.consumerId}`);
  lines.push(`Subject pseudonym: ${m.subjectPseudonym ?? "(unknown — consumer row absent)"}`);
  lines.push(`Actor:             ${m.actorEmail}`);
  lines.push(`Reason:            ${m.reason}`);
  lines.push(`D1 invoice name:   ${m.redactInvoiceName ? "REDACTED" : "KEPT (default)"}`);
  lines.push(rule);

  lines.push("MOTION (b) — REDACT (rows kept, PII stripped):");
  for (const e of m.motions.redact) lines.push(`  ${e.collection.padEnd(20)} ${e.count}`);
  lines.push("MOTION (a) — DELETE (rows removed):");
  for (const e of m.motions.delete) lines.push(`  ${e.collection.padEnd(20)} ${e.count}`);
  lines.push("MOTION (c) — CRYPTO-SHRED (last):");
  for (const e of m.motions.shred) lines.push(`  ${e.subjectType}/${e.subjectId} — ${e.outcome}`);

  lines.push(rule);
  lines.push(`Stored objects ${m.dryRun ? "to delete" : "deleted"}: ${m.storage.deleted.length}`);
  for (const k of m.storage.deleted) lines.push(`  - ${k}`);
  for (const f of m.storage.failed) lines.push(`  ! FAILED ${f.key} — ${f.error}`);

  lines.push(rule);
  lines.push("RETAINED — these SURVIVE the erasure, with PII stripped:");
  if (m.retained.invoices.length === 0 && m.retained.creditNotes.length === 0) {
    lines.push("  (no tax invoice for this consumer)");
  }
  for (const i of m.retained.invoices) {
    lines.push(
      `  Invoice ${i.invoiceNo} — ${i.invoiceDate?.slice(0, 10) ?? "?"} — ₹${i.grandTotal} — ${i.status} — recipient name ${i.nameKept ? "KEPT" : "REDACTED"}`,
    );
  }
  for (const c of m.retained.creditNotes) {
    lines.push(`  CreditNote ${c.invoiceNo} — ${c.invoiceDate?.slice(0, 10) ?? "?"} — ₹${c.grandTotal}`);
  }
  for (const b of m.retained.bookings) lines.push(`  ManualBooking ${b.bookingRef} — ₹${b.grandTotal}`);

  if (m.residuals.length > 0) {
    lines.push(rule);
    lines.push("RESIDUALS — flagged, NOT erased by this run:");
    for (const r of m.residuals) lines.push(`  ! ${r}`);
  }
  lines.push(rule);
  return lines.join("\n");
}
