import { Schema, model } from "mongoose";

const MeetingSchema = new Schema({
  roomId: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  createdAt: { type: Date, default: Date.now },
});

export default model("Meeting", MeetingSchema);
