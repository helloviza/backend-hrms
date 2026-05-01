import mongoose, { Schema, model, type Document } from "mongoose";

export interface ITicketLead extends Document {
  email: string;
  name: string;
  phone?: string;
  company?: string;
  firstSeenAt: Date;
  lastTicketAt?: Date;
  ticketCount: number;
  status: "NEW" | "ENGAGED" | "CONVERTED" | "DORMANT";
  linkedCustomerId?: Schema.Types.ObjectId;
  notes?: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

const TicketLeadSchema = new Schema<ITicketLead>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, index: true },
    name: { type: String, default: "" },
    phone: String,
    company: String,
    firstSeenAt: { type: Date, default: Date.now },
    lastTicketAt: Date,
    ticketCount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["NEW", "ENGAGED", "CONVERTED", "DORMANT"],
      default: "NEW",
    },
    linkedCustomerId: { type: Schema.Types.ObjectId, ref: "Customer", index: true },
    notes: String,
    tags: [String],
  },
  { timestamps: true },
);

export default model<ITicketLead>("TicketLead", TicketLeadSchema);
