import { Schema, model } from "mongoose";

const SBTConfigSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, default: {} },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true },
);

export default model("SBTConfig", SBTConfigSchema);
