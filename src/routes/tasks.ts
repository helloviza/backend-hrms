import express from 'express'
import mongoose from 'mongoose'
import { requireAuth } from '../middleware/auth.js'
import { requirePermission } from '../middleware/requirePermission.js'
import { requireWorkspace } from '../middleware/requireWorkspace.js'
import Task, { TASK_PRIORITIES, TASK_STATUSES, TASK_LINKED_TYPES } from '../models/Task.js'
import Lead from '../models/Lead.js'
import User from '../models/User.js'
import logger from '../utils/logger.js'
import { notifyUser } from '../services/notificationDispatch.js'

const router = express.Router()

router.use(requireAuth)
router.use(requireWorkspace)

type AnyObj = Record<string, any>

function uid(user: AnyObj): string {
  return String(user._id || user.id || user.sub || '')
}

/* ── helpers ──────────────────────────────────────────────── */

function isOverdue(task: AnyObj): boolean {
  if (!task.dueDate) return false
  if (task.status === 'DONE' || task.status === 'CANCELLED') return false
  return new Date(task.dueDate) < new Date()
}

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function endOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}

/** Fetch the human-readable ref for a linked entity */
async function fetchLinkedRef(linkedType: string, linkedId: string): Promise<string> {
  try {
    if (linkedType === 'LEAD') {
      const lead = await Lead.findById(linkedId).select('leadCode contactName companyName').lean() as any
      if (lead) return lead.leadCode || lead.companyName || lead.contactName || ''
    }
    if (linkedType === 'TICKET') {
      const { default: Ticket } = await import('../models/Ticket.js')
      const ticket = await Ticket.findById(linkedId).select('ticketRef subject').lean() as any
      if (ticket) return ticket.ticketRef || ticket.subject || ''
    }
    if (linkedType === 'CONTACT') {
      const { default: CRMContact } = await import('../models/CRMContact.js')
      const contact = await CRMContact.findById(linkedId).select('firstName lastName').lean() as any
      if (contact) return `${contact.firstName || ''} ${contact.lastName || ''}`.trim()
    }
    if (linkedType === 'COMPANY') {
      const { default: CRMCompany } = await import('../models/CRMCompany.js')
      const company = await CRMCompany.findById(linkedId).select('name').lean() as any
      if (company) return company.name || ''
    }
  } catch {
    // ref is cosmetic — don't fail task creation
  }
  return ''
}

/* ══════════════════════════════════════════════════════════════
 * GET /counts — stats for current user (before /:id)
 * ══════════════════════════════════════════════════════════════ */
router.get('/counts', requirePermission('tasks', 'READ'), async (req, res) => {
  try {
    const user = (req as any).user as AnyObj
    const myId = uid(user)
    const access = (req as any).permissionAccess as string
    const now = new Date()
    const todayStart = startOfDay(now)
    const todayEnd = endOfDay(now)
    const weekEnd = endOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7))

    const wsId = (req as any).workspaceObjectId
    const baseFilter: AnyObj = { isActive: true }
    if (wsId) baseFilter.workspaceId = wsId
    if (access !== 'FULL') {
      if (mongoose.isValidObjectId(myId)) {
        baseFilter.assignedTo = new mongoose.Types.ObjectId(myId)
      }
    }

    const [myOpen, myOverdue, myDueToday, myDueThisWeek, unassigned] = await Promise.all([
      Task.countDocuments({ ...baseFilter, status: { $in: ['OPEN', 'IN_PROGRESS'] } }),
      Task.countDocuments({
        ...baseFilter,
        status: { $in: ['OPEN', 'IN_PROGRESS'] },
        dueDate: { $lt: now },
      }),
      Task.countDocuments({
        ...baseFilter,
        status: { $in: ['OPEN', 'IN_PROGRESS'] },
        dueDate: { $gte: todayStart, $lte: todayEnd },
      }),
      Task.countDocuments({
        ...baseFilter,
        status: { $in: ['OPEN', 'IN_PROGRESS'] },
        dueDate: { $gte: todayStart, $lte: weekEnd },
      }),
      access === 'FULL'
        ? Task.countDocuments({ isActive: true, assignedTo: null })
        : Promise.resolve(undefined),
    ])

    return res.json({
      myOpen,
      myOverdue,
      myDueToday,
      myDueThisWeek,
      unassigned: access === 'FULL' ? (unassigned as number) : undefined,
    })
  } catch (err) {
    logger.error('tasks GET /counts error', { err })
    return res.status(500).json({ error: 'Failed to load counts' })
  }
})

/* ══════════════════════════════════════════════════════════════
 * GET / — list tasks
 * ══════════════════════════════════════════════════════════════ */
router.get('/', requirePermission('tasks', 'READ'), async (req, res) => {
  try {
    const user = (req as any).user as AnyObj
    const access = (req as any).permissionAccess as string
    const myId = uid(user)
    const q = req.query as AnyObj

    const wsId = (req as any).workspaceObjectId
    const filter: AnyObj = { isActive: true }
    if (wsId) filter.workspaceId = wsId

    // Assignee filter
    const assignedTo = q.assignedTo || 'me'
    if (assignedTo === 'me') {
      if (mongoose.isValidObjectId(myId)) {
        filter.assignedTo = new mongoose.Types.ObjectId(myId)
      }
    } else if (assignedTo !== 'all') {
      if (access !== 'FULL') {
        // Non-FULL users can only see their own
        if (mongoose.isValidObjectId(myId)) {
          filter.assignedTo = new mongoose.Types.ObjectId(myId)
        }
      } else if (mongoose.isValidObjectId(String(assignedTo))) {
        filter.assignedTo = new mongoose.Types.ObjectId(String(assignedTo))
      }
    }
    // 'all' + FULL → no assignee filter

    if (q.status) {
      const statuses = String(q.status).split(',').filter(Boolean)
      filter.status = { $in: statuses }
    }

    if (q.priority) {
      const priorities = String(q.priority).split(',').filter(Boolean)
      filter.priority = { $in: priorities }
    }

    if (q.dueFrom || q.dueTo) {
      filter.dueDate = {}
      if (q.dueFrom) filter.dueDate.$gte = new Date(String(q.dueFrom))
      if (q.dueTo) filter.dueDate.$lte = new Date(String(q.dueTo))
    }

    if (q.linkedType && q.linkedId) {
      filter.linkedType = String(q.linkedType)
      if (mongoose.isValidObjectId(String(q.linkedId))) {
        filter.linkedId = new mongoose.Types.ObjectId(String(q.linkedId))
      }
    } else if (q.linkedType) {
      filter.linkedType = String(q.linkedType)
    }

    if (q.overdue === 'true') {
      filter.dueDate = { $lt: new Date() }
      filter.status = { $nin: ['DONE', 'CANCELLED'] }
    }

    const page = Math.max(1, parseInt(String(q.page || '1'), 10))
    const limit = Math.min(100, Math.max(1, parseInt(String(q.limit || '25'), 10)))
    const skip = (page - 1) * limit

    const now = new Date()
    const todayStart = startOfDay(now)
    const todayEnd = endOfDay(now)

    const [tasks, total, openCount, overdueCount, dueTodayCount] = await Promise.all([
      Task.find(filter)
        .sort({ dueDate: 1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('assignedTo', 'name email')
        .populate('createdBy', 'name email')
        .lean(),
      Task.countDocuments(filter),
      Task.countDocuments({ ...filter, status: { $in: ['OPEN', 'IN_PROGRESS'] } }),
      Task.countDocuments({ ...filter, status: { $nin: ['DONE', 'CANCELLED'] }, dueDate: { $lt: now } }),
      Task.countDocuments({
        ...filter,
        status: { $nin: ['DONE', 'CANCELLED'] },
        dueDate: { $gte: todayStart, $lte: todayEnd },
      }),
    ])

    return res.json({
      tasks,
      total,
      page,
      pages: Math.ceil(total / limit),
      stats: { open: openCount, overdue: overdueCount, dueToday: dueTodayCount },
    })
  } catch (err) {
    logger.error('tasks GET / error', { err })
    return res.status(500).json({ error: 'Failed to list tasks' })
  }
})

/* ══════════════════════════════════════════════════════════════
 * POST / — create task
 * ══════════════════════════════════════════════════════════════ */
router.post('/', requirePermission('tasks', 'WRITE'), async (req, res) => {
  try {
    const user = (req as any).user as AnyObj
    const body = req.body as AnyObj

    if (!body.title || !String(body.title).trim()) {
      return res.status(400).json({ error: 'title is required' })
    }

    const assignedToId = body.assignedTo
      ? String(body.assignedTo)
      : uid(user)

    if (!mongoose.isValidObjectId(assignedToId)) {
      return res.status(400).json({ error: 'Invalid assignedTo userId' })
    }

    if ((body.linkedType && !body.linkedId) || (!body.linkedType && body.linkedId)) {
      return res.status(400).json({ error: 'Both linkedType and linkedId are required together' })
    }

    if (body.linkedType && !(TASK_LINKED_TYPES as readonly string[]).includes(body.linkedType)) {
      return res.status(400).json({ error: `Invalid linkedType` })
    }

    let linkedRef = body.linkedRef || ''
    if (body.linkedType && body.linkedId && mongoose.isValidObjectId(String(body.linkedId))) {
      linkedRef = await fetchLinkedRef(String(body.linkedType), String(body.linkedId))
    }

    const createdById = uid(user)
    const task = await Task.create({
      workspaceId: (req as any).workspaceObjectId || undefined,
      title: String(body.title).trim().slice(0, 200),
      description: body.description ? String(body.description).trim() : undefined,
      assignedTo: new mongoose.Types.ObjectId(assignedToId),
      createdBy: mongoose.isValidObjectId(createdById) ? new mongoose.Types.ObjectId(createdById) : undefined,
      dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
      dueTime: body.dueTime ? String(body.dueTime) : undefined,
      priority: TASK_PRIORITIES.includes(body.priority) ? body.priority : 'MEDIUM',
      linkedType: body.linkedType || undefined,
      linkedId: body.linkedId && mongoose.isValidObjectId(String(body.linkedId))
        ? new mongoose.Types.ObjectId(String(body.linkedId))
        : undefined,
      linkedRef: linkedRef || undefined,
      tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
    })

    const populated = await Task.findById(task._id)
      .populate('assignedTo', 'name email')
      .populate('createdBy', 'name email')
      .lean()

    // Notify assignee if they're not the creator
    if (String(task.assignedTo) !== String(task.createdBy)) {
      notifyUser(
        task.assignedTo,
        (user as any).workspaceId || '',
        'TASK_ASSIGNED',
        'New task assigned to you',
        task.title,
        `/admin/tasks?highlight=${task._id}`,
        'TASK',
        task._id as any,
      ).catch(() => {/* non-fatal */})
    }

    return res.status(201).json({ task: populated })
  } catch (err) {
    logger.error('tasks POST / error', { err })
    return res.status(500).json({ error: 'Failed to create task' })
  }
})

/* ══════════════════════════════════════════════════════════════
 * GET /:id — get single task
 * ══════════════════════════════════════════════════════════════ */
router.get('/:id', requirePermission('tasks', 'READ'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid task ID' })
    }

    const user = (req as any).user as AnyObj
    const access = (req as any).permissionAccess as string
    const myId = uid(user)

    const taskWsId = (req as any).workspaceObjectId
    const task = await Task.findOne({
      _id: req.params.id,
      isActive: true,
      ...(taskWsId && { workspaceId: taskWsId }),
    })
      .populate('assignedTo', 'name email')
      .populate('createdBy', 'name email')
      .lean() as any

    if (!task) return res.status(404).json({ error: 'Task not found' })

    // Non-FULL users may only see tasks assigned to or created by them
    if (access !== 'FULL') {
      const assignedId = String(task.assignedTo?._id || task.assignedTo)
      const createdId = String(task.createdBy?._id || task.createdBy)
      if (assignedId !== myId && createdId !== myId) {
        return res.status(403).json({ error: 'Access denied' })
      }
    }

    return res.json({ task })
  } catch (err) {
    logger.error('tasks GET /:id error', { err })
    return res.status(500).json({ error: 'Failed to get task' })
  }
})

/* ══════════════════════════════════════════════════════════════
 * PATCH /:id — update task
 * ══════════════════════════════════════════════════════════════ */
router.patch('/:id', requirePermission('tasks', 'WRITE'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid task ID' })
    }

    const user = (req as any).user as AnyObj
    const access = (req as any).permissionAccess as string
    const myId = uid(user)
    const body = req.body as AnyObj

    const patchWsId = (req as any).workspaceObjectId
    const task = await Task.findOne({
      _id: req.params.id,
      isActive: true,
      ...(patchWsId && { workspaceId: patchWsId }),
    })
    if (!task) return res.status(404).json({ error: 'Task not found' })

    // Reassignment requires FULL permission or being the creator
    if (body.assignedTo && String(body.assignedTo) !== String(task.assignedTo)) {
      const createdId = String(task.createdBy)
      if (access !== 'FULL' && createdId !== myId) {
        return res.status(403).json({ error: 'Only the creator or a FULL-access user can reassign tasks' })
      }
    }

    const UPDATABLE = ['title', 'description', 'assignedTo', 'dueDate', 'dueTime', 'priority', 'status', 'tags', 'linkedType', 'linkedId', 'linkedRef']
    for (const key of UPDATABLE) {
      if (key in body) {
        (task as any)[key] = body[key]
      }
    }

    const wasNotDone = task.status !== 'DONE'
    if (body.status === 'DONE' && wasNotDone) {
      task.completedAt = new Date()
      task.completedBy = mongoose.isValidObjectId(myId) ? new mongoose.Types.ObjectId(myId) : undefined
    }

    const createdById = String(task.createdBy)
    await task.save()

    // Notify task creator when someone else marks it done
    if (body.status === 'DONE' && wasNotDone && createdById && createdById !== myId) {
      notifyUser(
        createdById,
        (user as any).workspaceId || '',
        'TASK_COMPLETED_BY_OTHER',
        'Task completed',
        task.title,
        `/admin/tasks?highlight=${task._id}`,
        'TASK',
        task._id as any,
      ).catch(() => {/* non-fatal */})
    }

    const populated = await Task.findById(task._id)
      .populate('assignedTo', 'name email')
      .populate('createdBy', 'name email')
      .lean()

    return res.json({ task: populated })
  } catch (err) {
    logger.error('tasks PATCH /:id error', { err })
    return res.status(500).json({ error: 'Failed to update task' })
  }
})

/* ══════════════════════════════════════════════════════════════
 * DELETE /:id — soft delete
 * ══════════════════════════════════════════════════════════════ */
router.delete('/:id', requirePermission('tasks', 'FULL'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid task ID' })
    }

    const delWsId = (req as any).workspaceObjectId
    const task = await Task.findOne({
      _id: req.params.id,
      isActive: true,
      ...(delWsId && { workspaceId: delWsId }),
    })
    if (!task) return res.status(404).json({ error: 'Task not found' })

    task.isActive = false
    await task.save()

    return res.json({ success: true })
  } catch (err) {
    logger.error('tasks DELETE /:id error', { err })
    return res.status(500).json({ error: 'Failed to delete task' })
  }
})

export default router
