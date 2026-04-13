import { Schema, model, Types } from "mongoose";

const MessageSchema = new Schema(
  {
    conversationId: { type: Types.ObjectId, ref: "Conversation", required: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    senderId: { type: String, required: true },
    senderName: { type: String, required: true },
    senderAvatar: { type: String, default: "" },

    text: { type: String, required: true },

    readBy: [
      {
        userId: { type: String, required: true },
        readAt: { type: Date, required: true },
        _id: false,
      },
    ],

    edited: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

MessageSchema.index({ conversationId: 1, createdAt: -1 });
MessageSchema.index({ workspaceId: 1 });

export const Message = model("Message", MessageSchema);
export default Message;
