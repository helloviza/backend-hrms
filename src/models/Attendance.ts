import { Schema, model } from "mongoose";
const AttendanceSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  punches: [
    {
      ts: Date,
      type: { type: String, enum: ["IN", "OUT"] },
      geo: { lat: Number, lng: Number },
    },
  ],
  odRequests: [
    {
      reason: String,
      from: Date,
      to: Date,
      status: {
        type: String,
        enum: ["PENDING", "APPROVED", "REJECTED"],
        default: "PENDING",
      },
    },
  ],
});
AttendanceSchema.index({ userId: 1, date: 1 }, { unique: true });
export default model("Attendance", AttendanceSchema);
