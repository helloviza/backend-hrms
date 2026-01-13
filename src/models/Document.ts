import { Schema, model } from "mongoose";
const DocumentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor" },
    key: String,
    name: String,
    contentType: String,
  },
  { timestamps: true },
);
export default model("Document", DocumentSchema);
