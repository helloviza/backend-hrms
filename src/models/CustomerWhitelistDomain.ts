import mongoose, { Schema } from "mongoose";

const CustomerWhitelistDomainSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, index: true }, // MasterData(Business)._id
    domain: { type: String, required: true, lowercase: true, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

CustomerWhitelistDomainSchema.index({ workspaceId: 1, domain: 1 }, { unique: true });

export default (mongoose.models.CustomerWhitelistDomain ||
  mongoose.model("CustomerWhitelistDomain", CustomerWhitelistDomainSchema)) as mongoose.Model<any>;
