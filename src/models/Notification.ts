import mongoose, { Schema, Document } from 'mongoose'

export const NOTIFICATION_TYPES = [
  'TASK_DUE_SOON',
  'TASK_DUE_NOW',
  'TASK_OVERDUE',
  'TASK_ASSIGNED',
  'TASK_COMPLETED_BY_OTHER',
  'TICKET_ASSIGNED',
] as const

export type NotificationType = typeof NOTIFICATION_TYPES[number]

export interface INotification extends Document {
  workspaceId: string
  userId: mongoose.Types.ObjectId
  type: NotificationType
  title: string
  body: string
  linkUrl: string
  relatedType?: 'TASK' | 'TICKET'
  relatedId?: mongoose.Types.ObjectId
  read: boolean
  readAt?: Date
  createdAt: Date
}

const notificationSchema = new Schema<INotification>(
  {
    workspaceId: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    linkUrl: { type: String, required: true },
    relatedType: { type: String, enum: ['TASK', 'TICKET'] },
    relatedId: { type: Schema.Types.ObjectId },
    read: { type: Boolean, default: false },
    readAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

notificationSchema.index({ workspaceId: 1, userId: 1, read: 1 })
notificationSchema.index({ workspaceId: 1, userId: 1, createdAt: -1 })

export default mongoose.model<INotification>('Notification', notificationSchema)
