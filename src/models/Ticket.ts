import mongoose, { Schema, model, type Document } from "mongoose";
import Counter from "./Counter.js";

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
  sourceChannel: "EMAIL";
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
    sourceChannel: { type: String, enum: ["EMAIL"], default: "EMAIL" },
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
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const dateCode = `${yy}${mm}${dd}`;

    const counter = await Counter.findByIdAndUpdate(
      `ticket:${dateCode}`,
      { $inc: { seq: 1 } },
      { new: true, upsert: true },
    );

    this.ticketRef = `PT-BR-${dateCode}-${String(counter!.seq).padStart(3, "0")}`;
    next();
  } catch (err) {
    next(err as Error);
  }
});

export default model<ITicket>("Ticket", TicketSchema);
