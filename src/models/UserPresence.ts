import { Schema, model } from "mongoose";

const UserPresenceSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ["ACTIVE", "IDLE", "OFFLINE"],
      default: "OFFLINE",
    },
    lastActivity: { type: Date, default: Date.now },
    idleDuration: { type: Number, default: 0 },
  },
  { timestamps: true }
);

UserPresenceSchema.index({ userId: 1 }, { unique: true });

export default model("UserPresence", UserPresenceSchema);
