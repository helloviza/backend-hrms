import mongoose, { Schema, model, type Document } from "mongoose";
import Counter from "./Counter.js";
import { getCompanySettings } from "./CompanySettings.js";

export interface ITicket extends Document {
  ticketRef: string;
  subject: string;
  status: "NEW" | "IN_PROGRESS" | "WAITING_CLIENT" | "WAITING_SUPPLIER" | "CLOSED";
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  fromEmail: string;
  fromName: string;
  assignedTo?: Schema.Types.ObjectId;
  leadId?: Schema.Types.ObjectId;
  workspaceId?: Schema.Types.ObjectId;
  /** A D2C consumer's own support case. Null for every Gmail-ingested B2B
   *  ticket — ingestion never sets it. See services/consumerSupport.ts. */
  consumerId?: Schema.Types.ObjectId | null;
  sourceChannel: "EMAIL" | "WEB";
  gmailThreadId?: string;
  gmailHistoryId?: string;
  extractedFields?: {
    origin?: string | null;
    destination?: string | null;
    travelDate?: string | null;
    returnDate?: string | null;
    paxCount?: number | null;
    tripType?: string | null;
    requestType?: string | null;
    summary?: string | null;
    /**
     * Caller-owned idempotency key for a WEB case — the only field in this
     * bag that is NOT a Gemini extraction. Written solely by
     * services/consumerSupport.ts on behalf of the public enquiry door, and
     * queried by routes/public.visa.ts before it creates anything, so a
     * resubmitted enquiry files one ticket rather than one per attempt.
     */
    enquiryRef?: string | null;
  };
  firstResponseAt?: Date;
  closedAt?: Date;
  slaDueBy?: Date;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

const TicketSchema = new Schema<ITicket>(
  {
    ticketRef: { type: String, unique: true },
    subject: { type: String, required: true },
    status: {
      type: String,
      enum: ["NEW", "IN_PROGRESS", "WAITING_CLIENT", "WAITING_SUPPLIER", "CLOSED"],
      default: "NEW",
    },
    priority: {
      type: String,
      enum: ["LOW", "NORMAL", "HIGH", "URGENT"],
      default: "NORMAL",
    },
    fromEmail: { type: String, required: true, lowercase: true },
    fromName: { type: String, default: "" },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", default: null },
    leadId: { type: Schema.Types.ObjectId, ref: "TicketLead" },
    workspaceId: { type: Schema.Types.ObjectId, ref: "Customer", default: null },
    // A consumer support case has no employer and therefore no Customer
    // workspace — workspaceId stays null, which is already the common case
    // on B2B tickets whose sender matches no Customer.
    consumerId: { type: Schema.Types.ObjectId, ref: "Consumer", default: null, index: true },
    // "WEB" is a D2C consumer filing through /api/consumer/support/cases.
    // The default stays "EMAIL" so Gmail ingestion is untouched.
    sourceChannel: { type: String, enum: ["EMAIL", "WEB"], default: "EMAIL" },
    gmailThreadId: String,
    gmailHistoryId: String,
    extractedFields: { type: Schema.Types.Mixed },
    firstResponseAt: Date,
    closedAt: Date,
    slaDueBy: Date,
    tags: [String],
  },
  { timestamps: true },
);

TicketSchema.index({ fromEmail: 1, createdAt: -1 });
TicketSchema.index({ gmailThreadId: 1 });
TicketSchema.index({ status: 1, assignedTo: 1 });

TicketSchema.pre("save", async function (next) {
  if (!this.isNew || this.ticketRef) return next();
  try {
    const settings = await getCompanySettings();
    const prefix = settings?.ticketPrefix || "PT";
    const width = settings?.ticketSeqWidth || 3;
    const startNum = settings?.ticketStartNumber || 1;

    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const monthCode = `${yy}${mm}`;
    const counterKey = `ticket:${monthCode}`;

    const counter = await Counter.findByIdAndUpdate(
      counterKey,
      { $inc: { seq: 1 } },
      { new: true, upsert: true },
    );

    let seq = counter!.seq;

    // First ticket of a new month: bump seq up to startNum if below it
    if (seq < startNum) {
      const adjusted = await Counter.findByIdAndUpdate(
        counterKey,
        { $max: { seq: startNum } },
        { new: true },
      );
      seq = adjusted!.seq;
    }

    this.ticketRef = `${prefix}${monthCode}${String(seq).padStart(width, "0")}`;
    next();
  } catch (err) {
    next(err as Error);
  }
});

export default model<ITicket>("Ticket", TicketSchema);
