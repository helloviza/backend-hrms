import { Schema, model } from "mongoose";
const PipelineSchema = new Schema(
  {
    entity: { type: String, enum: ["VENDOR", "BUSINESS"], required: true },
    name: String,
    stage: {
      type: String,
      enum: ["NEW", "SHORTLISTED", "APPROVED", "REJECTED"],
      default: "NEW",
    },
    notes: String,
    ownerId: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);
export default model("Pipeline", PipelineSchema);
