// apps/backend/src/services/consumerSupport.ts
//
// The D2C consumer's way into the SHARED B2B ticket inbox.
//
// This is the second thing that ever creates a Ticket — services/
// ticketIngestion.ts (Gmail) is the first, and stays the only one for the
// B2B path. The point of integrating rather than siloing is that ops keep
// ONE queue: a consumer case lands in /admin/tickets next to an emailed
// one, with a real PT ref, and needs no ops-side branching to be worked.
//
// Two invariants this file exists to hold:
//
//   1. fromEmail comes from the SERVER-SIDE consumer record, never from the
//      request body. A caller who could name their own fromEmail could file
//      a case as somebody else and — because the admin console threads and
//      replies by that address — could make ops send a stranger's case
//      details to an address of the caller's choosing. Same integrity rule
//      as a payment amount: the client proposes nothing that matters.
//
//   2. Ticket.create(), never insertMany or an upsert. ticketRef is minted
//      by a pre("save") hook on the model, and that hook fires ONLY on
//      .create()/.save(). Any other write path produces a ticket with an
//      undefined ticketRef against a unique index.
import mongoose from "mongoose";

import Ticket from "../models/Ticket.js";
import TicketMessage from "../models/TicketMessage.js";
import Consumer from "../models/Consumer.js";
import logger from "../utils/logger.js";

const supportLogger = logger.child({ module: "consumerSupport" });

/**
 * The subjects a consumer may pick, tailored to visa work. This is the
 * SERVER-SIDE allowlist — the frontend renders the same list in Stage B,
 * but this array is the one that decides. Free-text would land unbounded
 * strings in an ops queue and make "Something else" meaningless.
 */
export const CONSUMER_SUPPORT_SUBJECTS = [
  "Visa application help",
  "Document query",
  "Visa refused or rejected",
  "Processing time or status",
  "Payment or refund",
  "Appointment or biometrics",
  "Request a callback",
  "Something else",
] as const;

export type ConsumerSupportSubject = (typeof CONSUMER_SUPPORT_SUBJECTS)[number];

/** The one subject that also carries a phone number. */
export const CALLBACK_SUBJECT: ConsumerSupportSubject = "Request a callback";

/** Tag ops can filter on to spot a callback request in the queue. */
export const CALLBACK_TAG = "callback";

/** Tag marking every ticket this file creates, so ops can see the channel. */
export const CONSUMER_SUPPORT_TAG = "d2c-support";

/**
 * Tag on a case filed for an UNVERIFIED email address — an anonymous lead
 * that owns no account here (see the `lead` input below).
 *
 * It is on the ticket rather than only in the body because it changes how
 * an agent should treat the thread: nobody has proved they hold that
 * address, so it must not be used to disclose anything the sender did not
 * themselves supply. A tag is the one place the console shows that before
 * the agent starts typing.
 */
export const UNVERIFIED_LEAD_TAG = "unverified-lead";

export function isAllowedSubject(value: unknown): value is ConsumerSupportSubject {
  return (
    typeof value === "string" &&
    (CONSUMER_SUPPORT_SUBJECTS as readonly string[]).includes(value)
  );
}

/**
 * The consumer-facing status vocabulary.
 *
 * The raw enum is an OPS artefact and never reaches a consumer: "WAITING_
 * SUPPLIER" would tell a customer that their visa is stuck at a third party
 * we have not named, which is both alarming and none of their business —
 * it maps to the same "In progress" as IN_PROGRESS on purpose.
 */
export const CONSUMER_STATUS_LABELS: Record<string, string> = {
  NEW: "Received",
  IN_PROGRESS: "In progress",
  WAITING_CLIENT: "Action needed from you",
  WAITING_SUPPLIER: "In progress",
  CLOSED: "Resolved",
};

export function consumerStatusLabel(status: string | undefined | null): string {
  return CONSUMER_STATUS_LABELS[String(status)] ?? "In progress";
}

/**
 * Escape a consumer's free text before it goes into bodyHtml.
 *
 * The admin console renders message bodies as HTML (it has to — an ingested
 * email IS html). A consumer's message is NOT html, so anything they type
 * that looks like a tag must arrive at an agent's screen as the characters
 * they typed rather than as markup.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface CreateConsumerSupportCaseInput {
  /**
   * The account this case belongs to. EXACTLY ONE of `consumerId` and
   * `lead` must be given — see the identity fork in the function body.
   */
  consumerId?: string | mongoose.Types.ObjectId | null;
  /**
   * AN ANONYMOUS LEAD — a caller who has no account and is not being given
   * one. Added for the public Visa Profile Score gate (routes/
   * public.visaScore.ts), which captures an email mid-assessment.
   *
   * ── HOW THIS SITS WITH INVARIANT 1 AT THE TOP OF THIS FILE ──────────
   * That invariant says fromEmail is read from the server-side consumer
   * record and never taken from a request body. It still holds wherever
   * there IS a record: `consumerId` is the only way to file against an
   * account, and the read below is unchanged. What it protected against was
   * a caller naming somebody ELSE's account as the sender — impossible
   * here, because this branch is chosen only after the caller's route has
   * confirmed the address matches no consumer at all. A ticket on this
   * branch is attached to no account, grants no access to one, and is
   * tagged UNVERIFIED_LEAD_TAG so an agent knows the address is a claim
   * rather than an identity.
   *
   * The alternative — mint a passwordless Consumer just so this function
   * had an id to read — would have written a real identity, into the
   * consumer registry and the DPDP erasure surface, for someone who only
   * typed an email into a calculator. That is a heavier act than the one
   * being requested.
   */
  lead?: { email: string; name?: string } | null;
  subject: ConsumerSupportSubject;
  message: string;
  /** Only meaningful for the callback subject; folded into the body. */
  callbackPhone?: string | null;
  /**
   * An IDEMPOTENCY KEY owned by the caller, landing on
   * `extractedFields.enquiryRef`.
   *
   * Optional and defaulted-absent, so both pre-existing callers
   * (routes/consumer.support.ts's two POSTs) write exactly the document they
   * always did — the same additive shape `channel` uses in
   * services/travelIntake.create.ts, and for the same reason.
   *
   * It exists for the PUBLIC enquiry door (routes/public.visa.ts), which is
   * reachable by an anonymous caller who can retry: that route looks a case
   * up by this ref BEFORE creating anything, so a resubmitted enquiry files
   * one ticket rather than one per attempt. The ManualBooking path it
   * replaced deduped on `metadata.intakeRef` and this preserves the
   * property.
   *
   * ── WHY extractedFields AND NOT tags ─────────────────────────────────
   * `tags` is an ops FILING VOCABULARY that the console renders and lets
   * agents filter on; a submission UUID in there is visible clutter with no
   * meaning to a human. extractedFields is already the model's bag for
   * machine-written per-ticket data, and consumer.support.ts's projection
   * allowlist never sends it to a consumer.
   */
  enquiryRef?: string | null;
  /**
   * Extra ops FILING TAGS, appended to the ones this service always sets.
   *
   * Unlike enquiryRef these are meant to be seen: a channel that wants its
   * own queue filter (the score gate's "visa-score-lead") says so here
   * rather than by inventing a subject outside CONSUMER_SUPPORT_SUBJECTS,
   * which is a closed allowlist for a reason. Deduped, so a caller cannot
   * double a tag this function already applied.
   */
  extraTags?: readonly string[];
}

export interface CreateConsumerSupportCaseResult {
  ticket: InstanceType<typeof Ticket>;
  message: InstanceType<typeof TicketMessage>;
}

/**
 * File a consumer support case. Creates the Ticket and its first INBOUND
 * message — the same two-document shape ticketIngestion.ts writes for an
 * email, so the admin console reads one without knowing which made it.
 *
 * "Request a callback" is NOT a separate mechanism: it is this path with a
 * fixed subject, the phone number in the body, and a tag. A second pipeline
 * for callbacks would be a second thing to monitor and a second thing to
 * forget.
 */
export async function createConsumerSupportCase(
  input: CreateConsumerSupportCaseInput,
): Promise<CreateConsumerSupportCaseResult> {
  /* ── THE IDENTITY FORK ──────────────────────────────────────────────
   * Exactly one of the two, checked rather than assumed: passing both
   * would leave the sender ambiguous and passing neither would produce a
   * ticket with no fromEmail, which is a thread no agent can answer. */
  const hasConsumer = Boolean(input.consumerId);
  const hasLead = Boolean(input.lead);
  if (hasConsumer === hasLead) {
    throw new Error("createConsumerSupportCase requires exactly one of consumerId or lead");
  }

  let consumerObjectId: mongoose.Types.ObjectId | null = null;
  let fromEmail: string;
  let fromName: string;

  if (hasConsumer) {
    consumerObjectId = new mongoose.Types.ObjectId(String(input.consumerId));

    // THE INTEGRITY READ. The identity on the ticket is whatever the database
    // says this consumer is, resolved here and not accepted from the caller.
    const consumer = await Consumer.findById(consumerObjectId)
      .select("_id email name")
      .lean();

    if (!consumer) {
      throw new Error("Consumer not found");
    }

    fromEmail = String((consumer as any).email || "").toLowerCase();
    fromName = String((consumer as any).name || "");

    if (!fromEmail) {
      // Not reachable through the router (requireConsumer loaded this same
      // record), but a ticket with no fromEmail is unrepliable, so refuse it
      // rather than create one an agent cannot answer.
      throw new Error("Consumer has no email address");
    }
  } else {
    fromEmail = String(input.lead?.email || "").trim().toLowerCase();
    fromName = String(input.lead?.name || "").trim();

    /* The same shape check every door applies before it accepts an address.
     * It is not verification — nothing here proves the person holds it —
     * but an unrepliable string must never become a ticket. */
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) {
      throw new Error("Lead email address is not valid");
    }
  }

  const trimmedMessage = input.message.trim();
  const phone = input.callbackPhone?.trim() || "";

  const tags = [CONSUMER_SUPPORT_TAG];
  if (input.subject === CALLBACK_SUBJECT) tags.push(CALLBACK_TAG);
  if (!hasConsumer) tags.push(UNVERIFIED_LEAD_TAG);
  for (const t of input.extraTags ?? []) {
    const tag = String(t).trim();
    if (tag && !tags.includes(tag)) tags.push(tag);
  }

  const enquiryRef = input.enquiryRef?.trim() || "";

  // .create() — the ticketRef pre-save hook depends on it.
  const ticket = await Ticket.create({
    subject: input.subject,
    fromEmail,
    fromName,
    sourceChannel: "WEB",
    consumerId: consumerObjectId,
    // workspaceId is deliberately left to its null default: a consumer has
    // no Customer. leadId is left absent for the same reason — TicketLead
    // is the B2B lead-resolution artefact and a consumer is not a lead.
    tags,
    // Spread, so a caller that passes nothing writes NO extractedFields key
    // at all rather than an empty object — the same rule the Consumer
    // signup path applies to its own optional blocks.
    ...(enquiryRef ? { extractedFields: { enquiryRef } } : {}),
  });

  // The phone rides in the body rather than in a new column, so an agent
  // reading the thread sees it without the model growing a field that only
  // one subject would ever populate.
  const bodyLines = phone
    ? [trimmedMessage, "", `Callback number: ${phone}`]
    : [trimmedMessage];
  const bodyText = bodyLines.join("\n");
  const bodyHtml = bodyLines
    .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<p></p>"))
    .join("");

  // INBOUND, matching how ingestion writes the customer's first message.
  // channel is "EMAIL" because TicketMessage.channel enumerates only
  // EMAIL|SYSTEM, and "SYSTEM" is the bucket the console uses for internal
  // notes and audit entries — putting a customer's own words there would
  // file them as an internal note. Widening that enum is a separate change
  // with its own blast radius across the console's rendering.
  const message = await TicketMessage.create({
    ticketId: ticket._id,
    direction: "INBOUND",
    channel: "EMAIL",
    fromEmail,
    toEmail: [],
    subject: input.subject,
    bodyHtml,
    bodyText,
    sentAt: new Date(),
    deliveryStatus: "SENT",
  });

  supportLogger.info("[ConsumerSupport] Created web case", {
    ticketRef: ticket.ticketRef,
    ticketId: String(ticket._id),
    consumerId: consumerObjectId ? String(consumerObjectId) : null,
    subject: input.subject,
  });

  return { ticket, message };
}
