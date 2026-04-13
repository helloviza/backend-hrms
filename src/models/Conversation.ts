import { Schema, model } from "mongoose";

const ConversationSchema = new Schema(
  {
    type: {
      type: String,
      enum: ["direct", "group", "announcement"],
      required: true,
    },
    workspaceId: { type: String, required: true, index: true },
    name: { type: String, trim: true, default: "" },
    participants: { type: [String], required: true, index: true },
    createdBy: { type: String, required: true },

    lastMessage: {
      text: { type: String, default: "" },
      senderId: { type: String, default: "" },
      senderName: { type: String, default: "" },
      sentAt: { type: Date },
    },

    // Map of userId → unread count
    unreadCounts: { type: Map, of: Number, default: new Map() },

    description: { type: String, trim: true },
    avatar: { type: String, trim: true },

    adminOnly: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

ConversationSchema.index({ workspaceId: 1, participants: 1 });

export const Conversation = model("Conversation", ConversationSchema);
export default Conversation;
