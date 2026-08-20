import mongoose, { Schema, model, type Document } from "mongoose";

/**
 * Where an attachment's bytes physically live.
 *
 * ── WHY THIS COLUMN EXISTS ───────────────────────────────────────────
 * Until D2C support, every attachment arrived through Gmail ingestion and
 * went straight to S3, so the storage location could be assumed and the
 * schema simply hard-required s3Key + s3Bucket.
 *
 * Consumer uploads are the first attachments created from a browser, and
 * local development has NO working S3: the credentials in
 * .env.development are placeholders (a PutObject there fails
 * InvalidAccessKeyId), and the S3_ENDPOINT line that points at a MinIO on
 * :9000 is inert because neither S3 client passes an `endpoint`. So an
 * upload path that can only speak S3 is an upload path nobody can
 * exercise or verify before it reaches production.
 *
 * This mirrors the fix models/ConsumerDocument.ts already made for the
 * same problem: record WHICH store holds the bytes, so the download route
 * can serve either. Production is still S3, unconditionally — see
 * services/ticketAttachmentStorage.ts, where the local driver refuses to
 * run under NODE_ENV=production.
 */
export type TicketAttachmentDriver = "s3" | "local-disk";

export interface ITicketAttachment extends Document {
  ticketId: Schema.Types.ObjectId;
  messageId: Schema.Types.ObjectId;
  fileName: string;
  mimeType: string;
  size: number;
  driver: TicketAttachmentDriver;
  /** Driver-agnostic locator. For s3 rows this equals s3Key. */
  storageKey: string;
  s3Key?: string;
  s3Bucket?: string;
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

    // DEFAULT "s3" IS WHAT KEEPS EXISTING ROWS BYTE-IDENTICAL. Every
    // attachment written before this column existed is an S3 object, and
    // Mongoose reports the default for a field absent from the document —
    // so the four production rows read back as driver "s3" with the
    // s3Key/s3Bucket they already have, and the download route takes the
    // same branch it always took.
    driver: { type: String, enum: ["s3", "local-disk"], default: "s3" },
    storageKey: { type: String, default: "" },

    // No longer unconditionally required: a local-disk row has no bucket.
    // Still required for s3 rows, which is every row Gmail ingestion
    // writes and every row production writes at all.
    s3Key: {
      type: String,
      required: function (this: ITicketAttachment) {
        return this.driver !== "local-disk";
      },
    },
    s3Bucket: {
      type: String,
      required: function (this: ITicketAttachment) {
        return this.driver !== "local-disk";
      },
    },
    checksum: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

/**
 * Back-fills storageKey from s3Key for callers that only set the latter.
 *
 * services/ticketAttachments.ts (the Gmail path) writes s3Key and knows
 * nothing about storageKey, and it is deliberately left that way so the
 * B2B path stays byte-identical. This hook is what lets a reader use
 * storageKey uniformly regardless of which writer produced the row.
 */
TicketAttachmentSchema.pre("validate", function (next) {
  const self = this as unknown as ITicketAttachment;
  if (!self.storageKey && self.s3Key) self.storageKey = self.s3Key;
  next();
});

export default model<ITicketAttachment>("TicketAttachment", TicketAttachmentSchema);
