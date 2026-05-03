import mongoose from 'mongoose'
import Notification, { NotificationType } from '../models/Notification.js'

export async function notifyUser(
  userId: string | mongoose.Types.ObjectId,
  workspaceId: string,
  type: NotificationType,
  title: string,
  body: string,
  linkUrl: string,
  relatedType?: 'TASK' | 'TICKET',
  relatedId?: string | mongoose.Types.ObjectId,
): Promise<void> {
  if (!userId || !workspaceId) return
  try {
    await Notification.create({
      workspaceId,
      userId: new mongoose.Types.ObjectId(String(userId)),
      type,
      title,
      body,
      linkUrl,
      relatedType,
      relatedId: relatedId ? new mongoose.Types.ObjectId(String(relatedId)) : undefined,
      read: false,
    })
  } catch (e: any) {
    console.error('[NotificationDispatch] create failed', e?.message)
  }
}

export async function markRead(notificationId: string, userId: string) {
  return Notification.findOneAndUpdate(
    { _id: notificationId, userId: new mongoose.Types.ObjectId(userId) },
    { read: true, readAt: new Date() },
    { new: true }
  )
}

export async function markAllRead(userId: string, workspaceId: string) {
  return Notification.updateMany(
    { userId: new mongoose.Types.ObjectId(userId), workspaceId, read: false },
    { read: true, readAt: new Date() }
  )
}

export async function getUnreadCount(userId: string, workspaceId: string): Promise<number> {
  return Notification.countDocuments({
    userId: new mongoose.Types.ObjectId(userId),
    workspaceId,
    read: false,
  })
}

export async function listNotifications(
  userId: string,
  workspaceId: string,
  page = 1,
  limit = 20,
) {
  const skip = (page - 1) * limit
  return Notification.find({ userId: new mongoose.Types.ObjectId(userId), workspaceId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean()
}
