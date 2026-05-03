import cron from 'node-cron'
import mongoose from 'mongoose'
import Task from '../models/Task.js'
import User from '../models/User.js'
import { sendMail } from '../utils/mailer.js'
import logger from '../utils/logger.js'

const FRONTEND = process.env.FRONTEND_ORIGIN || 'https://hrms.plumtrips.com'

const PRIORITY_COLORS: Record<string, string> = {
  URGENT: '#dc2626',
  HIGH: '#d97706',
  MEDIUM: '#2563eb',
  LOW: '#6b7280',
}

function priorityBadge(p: string) {
  const color = PRIORITY_COLORS[p] || '#6b7280'
  return `<span style="display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;background:${color}15;color:${color};border:1px solid ${color}40;">${p}</span>`
}

function daysAgo(d: Date): string {
  const days = Math.floor((Date.now() - d.getTime()) / 86400000)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

function taskRow(task: any, showOverdue = false) {
  const link = `${FRONTEND}/admin/tasks?highlight=${task._id}`
  return `
<tr>
  <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;vertical-align:top;">
    ${priorityBadge(task.priority)}
  </td>
  <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;vertical-align:top;">
    <a href="${link}" style="color:#00477f;text-decoration:none;font-weight:500;font-size:14px;">${task.title}</a>
    ${task.linkedRef ? `<div style="font-size:12px;color:#6b7280;margin-top:2px;">Linked: ${task.linkedRef}</div>` : ''}
    ${showOverdue && task.dueDate ? `<div style="font-size:12px;color:#dc2626;margin-top:2px;">Was due ${daysAgo(new Date(task.dueDate))}</div>` : ''}
  </td>
  <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;vertical-align:top;text-align:right;">
    <a href="${link}" style="color:#00477f;font-size:13px;text-decoration:none;">[Open]</a>
  </td>
</tr>`
}

function buildDigestHtml(opts: {
  userName: string
  dueToday: any[]
  overdue: any[]
  dueTomorrow: any[]
}) {
  const { userName, dueToday, overdue, dueTomorrow } = opts
  const total = dueToday.length + overdue.length

  const sections: string[] = []

  if (dueToday.length > 0) {
    sections.push(`
<h3 style="margin:24px 0 8px;font-size:15px;font-weight:700;color:#1c1c1c;border-bottom:2px solid #e5e7eb;padding-bottom:6px;">
  DUE TODAY (${dueToday.length})
</h3>
<table style="width:100%;border-collapse:collapse;">${dueToday.map((t) => taskRow(t)).join('')}</table>`)
  }

  if (overdue.length > 0) {
    sections.push(`
<h3 style="margin:24px 0 8px;font-size:15px;font-weight:700;color:#dc2626;border-bottom:2px solid #fee2e2;padding-bottom:6px;">
  OVERDUE (${overdue.length})
</h3>
<table style="width:100%;border-collapse:collapse;">${overdue.map((t) => taskRow(t, true)).join('')}</table>`)
  }

  if (dueTomorrow.length > 0) {
    sections.push(`
<h3 style="margin:24px 0 8px;font-size:15px;font-weight:700;color:#374151;border-bottom:2px solid #f3f4f6;padding-bottom:6px;">
  DUE TOMORROW (${dueTomorrow.length}) — preview
</h3>
<table style="width:100%;border-collapse:collapse;">${dueTomorrow.map((t) => taskRow(t)).join('')}</table>`)
  }

  return `
<div style="font-family:DM Sans,sans-serif;max-width:640px;margin:auto;padding:32px;background:#fff;color:#1c1c1c;">
  <h2 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;font-weight:600;color:#1c1c1c;margin:0 0 8px;">
    Your tasks for today
  </h2>
  <p style="margin:0 0 4px;color:#6b7280;font-size:14px;">Hi ${userName},</p>
  <p style="margin:0 0 0;color:#6b7280;font-size:14px;">
    You have <strong style="color:#1c1c1c;">${dueToday.length} task${dueToday.length !== 1 ? 's' : ''} due today</strong>
    ${overdue.length > 0 ? ` and <strong style="color:#dc2626;">${overdue.length} overdue</strong>` : ''}.
  </p>
  ${sections.join('')}
  <div style="margin-top:28px;">
    <a href="${FRONTEND}/admin/tasks"
       style="display:inline-block;background:#00477f;color:#fff;text-decoration:none;padding:12px 28px;border-radius:4px;font-size:14px;font-weight:500;">
      Open My Tasks →
    </a>
  </div>
  <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;">Plumtrips Notification · Daily digest · ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' })}</p>
</div>`
}

async function runTaskDigest() {
  const now = new Date()

  const istOffset = 5.5 * 60 * 60 * 1000
  const nowIST = new Date(now.getTime() + istOffset)

  const startOfTodayIST = new Date(Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate()) - istOffset)
  const endOfTodayIST = new Date(startOfTodayIST.getTime() + 86400000)
  const endOfTomorrowIST = new Date(endOfTodayIST.getTime() + 86400000)

  // Get all open tasks that have a dueDate
  const candidateTasks = await Task.find({
    isActive: true,
    dueDate: { $exists: true, $ne: null },
    status: { $nin: ['DONE', 'CANCELLED'] },
  }).lean()

  // Group by assignedTo
  const byUser = new Map<string, { dueToday: any[]; overdue: any[]; dueTomorrow: any[] }>()

  for (const task of candidateTasks) {
    const userId = String(task.assignedTo)
    if (!byUser.has(userId)) byUser.set(userId, { dueToday: [], overdue: [], dueTomorrow: [] })
    const bucket = byUser.get(userId)!
    const due = new Date(task.dueDate!)

    if (due >= startOfTodayIST && due < endOfTodayIST) {
      bucket.dueToday.push(task)
    } else if (due < startOfTodayIST) {
      bucket.overdue.push(task)
    } else if (due >= endOfTodayIST && due < endOfTomorrowIST) {
      bucket.dueTomorrow.push(task)
    }
  }

  let sent = 0
  let skipped = 0

  for (const [userId, { dueToday, overdue, dueTomorrow }] of byUser) {
    if (dueToday.length === 0 && overdue.length === 0 && dueTomorrow.length === 0) {
      skipped++
      continue
    }
    try {
      const user = await User.findById(userId, 'name email').lean() as any
      if (!user?.email) continue

      const total = dueToday.length + overdue.length
      const subject = `Your tasks for today — ${dueToday.length} due${overdue.length > 0 ? `, ${overdue.length} overdue` : ''}`

      await sendMail({
        to: user.email,
        kind: 'NOTIFICATIONS',
        subject,
        html: buildDigestHtml({
          userName: user.name || user.email,
          dueToday,
          overdue,
          dueTomorrow,
        }),
      })
      sent++
      logger.info('[TaskDigest] Digest sent', { userId, dueToday: dueToday.length, overdue: overdue.length, to: user.email })
    } catch (e: any) {
      logger.error('[TaskDigest] Failed for user', { userId, error: e?.message })
    }
  }

  logger.info('[TaskDigest] Run complete', { sent, skipped })
}

export function startTaskDigestCron(): void {
  cron.schedule('0 10 * * *', async () => {
    logger.info('[TaskDigest] Cron triggered')
    try {
      await runTaskDigest()
    } catch (e: any) {
      logger.error('[TaskDigest] Cron run failed', { error: e?.message })
    }
  }, { timezone: 'Asia/Kolkata' })
  logger.info('[TaskDigest] Cron scheduled — daily 10:00 AM IST')
}
