import cron from 'node-cron'
import Task from '../models/Task.js'
import User from '../models/User.js'
import { sendMail } from '../utils/mailer.js'
import { notifyUser } from '../services/notificationDispatch.js'
import logger from '../utils/logger.js'

const FRONTEND = process.env.FRONTEND_ORIGIN || 'https://hrms.plumtrips.com'

function fmtDate(d: Date) {
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function taskEmailHtml(opts: {
  assigneeName: string
  title: string
  priority: string
  dueDate: Date
  description?: string
  linkedRef?: string
  linkedType?: string
  taskId: string
  headingLine: string
}) {
  const {
    assigneeName, title, priority, dueDate, description, linkedRef, linkedType, taskId, headingLine,
  } = opts
  const link = `${FRONTEND}/admin/tasks?highlight=${taskId}`
  return `
<div style="font-family:DM Sans,sans-serif;max-width:600px;margin:auto;padding:32px;background:#fff;color:#1c1c1c;">
  <h2 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;font-weight:600;color:#1c1c1c;margin:0 0 16px;">
    ${headingLine}
  </h2>
  <p style="margin:0 0 12px;">Hi ${assigneeName},</p>
  <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px;width:120px;">Task</td>
      <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-weight:600;">${title}</td>
    </tr>
    ${linkedRef ? `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Linked to</td>
      <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;">${linkedRef}${linkedType ? ` (${linkedType})` : ''}</td>
    </tr>` : ''}
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Priority</td>
      <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;">${priority}</td>
    </tr>
    <tr>
      <td style="padding:8px 0;color:#6b7280;font-size:14px;">Due</td>
      <td style="padding:8px 0;color:#d97706;font-weight:600;">${fmtDate(dueDate)} IST</td>
    </tr>
  </table>
  ${description ? `<p style="font-size:14px;color:#374151;margin:0 0 20px;white-space:pre-wrap;">${description}</p>` : ''}
  <a href="${link}"
     style="display:inline-block;background:#00477f;color:#fff;text-decoration:none;padding:12px 28px;border-radius:4px;font-size:14px;font-weight:500;">
    Open Task →
  </a>
  <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;">Plumtrips Notification</p>
</div>`
}

async function runTaskReminders() {
  const now = new Date()
  const msNow = now.getTime()

  const openTasks = await Task.find({
    isActive: true,
    dueDate: { $exists: true, $ne: null },
    status: { $nin: ['DONE', 'CANCELLED'] },
    $or: [
      { reminderShown30Min: { $ne: true } },
      { reminderShownDue: { $ne: true } },
      { reminderShownOverdue: { $ne: true } },
    ],
  }).lean()

  for (const task of openTasks) {
    try {
      const dueMs = new Date(task.dueDate!).getTime()
      const minutesUntilDue = (dueMs - msNow) / 60000
      const taskId = String(task._id)

      const updates: Record<string, boolean> = {}

      if (!task.reminderShown30Min && minutesUntilDue >= 25 && minutesUntilDue <= 35) {
        const user = await User.findById(task.assignedTo, 'name email').lean() as any
        if (user?.email) {
          const result = await sendMail({
            to: user.email,
            kind: 'NOTIFICATIONS',
            subject: `[Action Required] Task due in 30 minutes: ${task.title}`,
            html: taskEmailHtml({
              assigneeName: user.name || user.email,
              title: task.title,
              priority: task.priority,
              dueDate: task.dueDate!,
              description: task.description,
              linkedRef: task.linkedRef,
              linkedType: task.linkedType,
              taskId,
              headingLine: 'Task due in 30 minutes',
            }),
          })
          if (result.ok) {
            await notifyUser(
              task.assignedTo, task.workspaceId || '', 'TASK_DUE_SOON',
              'Task due in 30 minutes', task.title,
              `/admin/tasks?highlight=${taskId}`, 'TASK', task._id as any,
            )
            updates.reminderShown30Min = true
            logger.info('[TaskReminder] 30min reminder sent', { taskId, to: user.email })
          }
        }
      }

      if (!task.reminderShownDue && minutesUntilDue >= -5 && minutesUntilDue <= 5) {
        const user = await User.findById(task.assignedTo, 'name email').lean() as any
        if (user?.email) {
          const result = await sendMail({
            to: user.email,
            kind: 'NOTIFICATIONS',
            subject: `[Action Required] Task is due now: ${task.title}`,
            html: taskEmailHtml({
              assigneeName: user.name || user.email,
              title: task.title,
              priority: task.priority,
              dueDate: task.dueDate!,
              description: task.description,
              linkedRef: task.linkedRef,
              linkedType: task.linkedType,
              taskId,
              headingLine: 'Task is due now',
            }),
          })
          if (result.ok) {
            await notifyUser(
              task.assignedTo, task.workspaceId || '', 'TASK_DUE_NOW',
              'Task is due now', task.title,
              `/admin/tasks?highlight=${taskId}`, 'TASK', task._id as any,
            )
            updates.reminderShownDue = true
            logger.info('[TaskReminder] Due-now reminder sent', { taskId, to: user.email })
          }
        }
      }

      if (!task.reminderShownOverdue && minutesUntilDue <= -1440) {
        const user = await User.findById(task.assignedTo, 'name email').lean() as any
        if (user?.email) {
          const result = await sendMail({
            to: user.email,
            kind: 'NOTIFICATIONS',
            subject: `[Overdue] Task overdue 24 hours: ${task.title}`,
            html: taskEmailHtml({
              assigneeName: user.name || user.email,
              title: task.title,
              priority: task.priority,
              dueDate: task.dueDate!,
              description: task.description,
              linkedRef: task.linkedRef,
              linkedType: task.linkedType,
              taskId,
              headingLine: 'Task overdue — 24 hours',
            }),
          })
          if (result.ok) {
            await notifyUser(
              task.assignedTo, task.workspaceId || '', 'TASK_OVERDUE',
              'Task overdue 24 hours', task.title,
              `/admin/tasks?highlight=${taskId}`, 'TASK', task._id as any,
            )
            updates.reminderShownOverdue = true
            logger.info('[TaskReminder] Overdue reminder sent', { taskId, to: user.email })
          }
        }
      }

      if (Object.keys(updates).length > 0) {
        await Task.findByIdAndUpdate(task._id, { $set: updates })
      }
    } catch (e: any) {
      logger.error('[TaskReminder] Failed for task', { taskId: task._id, error: e?.message })
    }
  }
}

export function startTaskReminderCron(): void {
  cron.schedule('*/5 * * * *', async () => {
    logger.info('[TaskReminder] Cron triggered')
    try {
      await runTaskReminders()
    } catch (e: any) {
      logger.error('[TaskReminder] Cron run failed', { error: e?.message })
    }
  })
  logger.info('[TaskReminder] Cron scheduled — every 5 min')
}
