import express from 'express'
import mongoose from 'mongoose'
import { requireAuth } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/rbac.js'
import TaskAutomation from '../models/TaskAutomation.js'
import { seedTaskAutomations } from '../services/taskAutomationSeed.js'
import { SYSTEM_WORKSPACE_ID } from '../config/defaultTaskAutomations.js'
import logger from '../utils/logger.js'

const router = express.Router()

router.use(requireAuth)
router.use(requireAdmin)

// GET /api/admin/task-automations
router.get('/', async (req: any, res: any) => {
  try {
    const automations = await TaskAutomation.find({
      workspaceId: { $in: [SYSTEM_WORKSPACE_ID, ...(req.workspaceId ? [req.workspaceId] : [])] },
    })
      .sort({ entityType: 1, triggerKey: 1 })
      .lean()

    res.json({ ok: true, automations })
  } catch (err: any) {
    logger.error('[TaskAutomations GET]', { err })
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/admin/task-automations/:id
router.patch('/:id', async (req: any, res: any) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid ID' })
    }

    const ALLOWED = [
      'enabled',
      'titleTemplate',
      'descriptionTemplate',
      'dueOffsetMinutes',
      'priority',
      'assigneeRule',
      'tags',
      'label',
      'description',
    ]

    const update: Record<string, any> = { updatedBy: req.user._id }
    for (const key of ALLOWED) {
      if (key in req.body) update[key] = req.body[key]
    }

    const automation = await TaskAutomation.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, runValidators: true }
    ).lean()

    if (!automation) return res.status(404).json({ error: 'Automation not found' })

    res.json({ ok: true, automation })
  } catch (err: any) {
    logger.error('[TaskAutomations PATCH]', { err })
    res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/task-automations/seed
router.post('/seed', async (req: any, res: any) => {
  try {
    await seedTaskAutomations(SYSTEM_WORKSPACE_ID)
    const automations = await TaskAutomation.find({ workspaceId: SYSTEM_WORKSPACE_ID }).lean()
    res.json({ ok: true, count: automations.length })
  } catch (err: any) {
    logger.error('[TaskAutomations seed]', { err })
    res.status(500).json({ error: err.message })
  }
})

export default router
