// apps/backend/src/models/Policy.ts
import { Schema, model } from "mongoose";

const PolicySchema = new Schema(
  {
    title: { type: String, required: true, trim: true },

    // For both URL and uploaded file we store a URL-ish string here.
    // For uploaded files this will be something like `/uploads/policies/1234-file.pdf`.
    url: { type: String, required: true, trim: true },

    category: { type: String, trim: true },
    tags: [{ type: String, trim: true }],

    // Distinguish between pure URL and uploaded FILE
    kind: {
      type: String,
      enum: ["URL", "FILE"],
      default: "URL",
    },

    // Extra metadata when kind === "FILE"
    fileName: { type: String, trim: true },
    mimeType: { type: String, trim: true },
    size: { type: Number },
    storagePath: { type: String, trim: true }, // usually same as `url` for FILE

    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  {
    timestamps: true,
  },
);

export default model("Policy", PolicySchema);
