import mongoose, { Schema, model, type Document } from "mongoose";

export interface ITicketMessage extends Document {
  ticketId: Schema.Types.ObjectId;
  direction: "INBOUND" | "OUTBOUND";
  channel: "EMAIL" | "SYSTEM";
  fromEmail: string;
  toEmail: string[];
  ccEmail: string[];
  bccEmail: string[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  gmailMessageId?: string;
  gmailThreadId?: string;
  inReplyTo?: string;
  attachmentRefs: Schema.Types.ObjectId[];
  sentBy?: Schema.Types.ObjectId;
  sentAt?: Date;
  deliveryStatus: "PENDING" | "SENT" | "FAILED" | "BOUNCED";
  createdAt: Date;
  updatedAt: Date;
}

const TicketMessageSchema = new Schema<ITicketMessage>(
  {
    ticketId: { type: Schema.Types.ObjectId, ref: "Ticket", required: true, index: true },
    direction: { type: String, enum: ["INBOUND", "OUTBOUND"], required: true },
    channel: { type: String, enum: ["EMAIL", "SYSTEM"], default: "EMAIL" },
    fromEmail: { type: String, default: "" },
    toEmail: [String],
    ccEmail: [String],
    bccEmail: [String],
    subject: { type: String, default: "" },
    bodyHtml: { type: String, default: "" },
    bodyText: { type: String, default: "" },
    gmailMessageId: { type: String, unique: true, sparse: true },
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
  },
  { timestamps: true },
);

TicketMessageSchema.index({ ticketId: 1, sentAt: 1 });

export default model<ITicketMessage>("TicketMessage", TicketMessageSchema);
