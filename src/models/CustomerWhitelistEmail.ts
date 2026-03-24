import mongoose, { Schema } from "mongoose";

const CustomerWhitelistEmailSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

CustomerWhitelistEmailSchema.index({ workspaceId: 1, email: 1 }, { unique: true });

export default (mongoose.models.CustomerWhitelistEmail ||
  mongoose.model("CustomerWhitelistEmail", CustomerWhitelistEmailSchema)) as mongoose.Model<any>;
