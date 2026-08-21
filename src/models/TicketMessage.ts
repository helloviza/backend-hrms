import mongoose, { Schema, model, type Document } from "mongoose";

export interface ITicketMessage extends Document {
  ticketId: Schema.Types.ObjectId;
  direction: "INBOUND" | "OUTBOUND";
  // PORTAL: an agent reply delivered by being READABLE, not by being sent —
  // the consumer reads it on /account/support. It is neither EMAIL (nothing
  // leaves the building, and it carries no Gmail ids) nor SYSTEM (which this
  // console writes for three internal things: agent notes, status audit and
  // assignment audit). Writing EMAIL with the Gmail fields left blank would
  // have made the transport a lie to save an enum value.
  channel: "EMAIL" | "SYSTEM" | "PORTAL";
  fromEmail: string;
  toEmail: string[];
  ccEmail: string[];
  bccEmail: string[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  gmailMessageId?: string;
  rfcMessageId?: string;
  gmailThreadId?: string;
  inReplyTo?: string;
  attachmentRefs: Schema.Types.ObjectId[];
  sentBy?: Schema.Types.ObjectId;
  sentAt?: Date;
  deliveryStatus: "PENDING" | "SENT" | "FAILED" | "BOUNCED";
  /**
   * May the consumer read this message?
   *
   * An ALLOWLIST, and the direction matters: the consumer query filters
   * `visibleToConsumer: true`, so anything that does not say yes is
   * invisible. Every message written before this field existed, and every
   * message written by the three writers that do not set it (internal
   * notes, status audit, assignment audit), fails that filter — as a
   * missing field, not as a stored false. No backfill, and no migration:
   * nothing reads this expecting a value to be present.
   *
   * `channel` is NOT a proxy for this and never was — see the note on it
   * above.
   */
  visibleToConsumer: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const TicketMessageSchema = new Schema<ITicketMessage>(
  {
    ticketId: { type: Schema.Types.ObjectId, ref: "Ticket", required: true, index: true },
    direction: { type: String, enum: ["INBOUND", "OUTBOUND"], required: true },
    channel: { type: String, enum: ["EMAIL", "SYSTEM", "PORTAL"], default: "EMAIL" },
    fromEmail: { type: String, default: "" },
    toEmail: [String],
    ccEmail: [String],
    bccEmail: [String],
    subject: { type: String, default: "" },
    bodyHtml: { type: String, default: "" },
    bodyText: { type: String, default: "" },
    gmailMessageId: { type: String, unique: true, sparse: true },
    rfcMessageId: { type: String, index: true, sparse: true },
    gmailThreadId: String,
    inReplyTo: String,
    attachmentRefs: [{ type: Schema.Types.ObjectId, ref: "TicketAttachment" }],
    sentBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    sentAt: Date,
    deliveryStatus: {
      type: String,
      enum: ["PENDING", "SENT", "FAILED", "BOUNCED"],
      default: "PENDING",
    },
    visibleToConsumer: { type: Boolean, default: false },
  },
  { timestamps: true },
);

TicketMessageSchema.index({ ticketId: 1, sentAt: 1 });

export default model<ITicketMessage>("TicketMessage", TicketMessageSchema);
