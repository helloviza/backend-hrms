import { Schema, model } from "mongoose";
const HolidaySchema = new Schema(
  {
    date: { type: String, required: true },
    name: { type: String, required: true },
    type: { type: String, default: "GENERAL" },
    region: { type: String, default: "All locations / Company-wide" },
    description: { type: String, default: "" },
  },
  { timestamps: true },
);
export default model("Holiday", HolidaySchema);
