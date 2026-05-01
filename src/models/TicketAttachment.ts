import mongoose, { Schema, model, type Document } from "mongoose";

export interface ITicketAttachment extends Document {
  ticketId: Schema.Types.ObjectId;
  messageId: Schema.Types.ObjectId;
  fileName: string;
  mimeType: string;
  size: number;
  s3Key: string;
  s3Bucket: string;
  checksum: string;
  createdAt: Date;
}

const TicketAttachmentSchema = new Schema<ITicketAttachment>(
  {
    ticketId: { type: Schema.Types.ObjectId, ref: "Ticket", required: true, index: true },
    messageId: { type: Schema.Types.ObjectId, ref: "TicketMessage", required: true, index: true },
    fileName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    s3Key: { type: String, required: true },
    s3Bucket: { type: String, required: true },
    checksum: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export default model<ITicketAttachment>("TicketAttachment", TicketAttachmentSchema);
