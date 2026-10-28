import mongoose from 'mongoose'
import Task from '../models/Task.js'
import TaskAutomation from '../models/TaskAutomation.js'
import User from '../models/User.js'
import logger from '../utils/logger.js'
import { TRIGGER_KEY_ALIASES } from '../config/defaultTaskAutomations.js'
import { HOUSE_WORKSPACE_ID } from '../middleware/requirePlatformAdmin.js'

const PLUMTRIPS_ADMIN_FILTER = {
  $or: [
    { roles: 'SUPERADMIN' },
    { roles: 'ADMIN', workspaceId: new mongoose.Types.ObjectId(HOUSE_WORKSPACE_ID) },
  ],
}

export interface TriggerContext {
  workspaceId: string
  entityType: string
  entityId: mongoose.Types.ObjectId
  entityRef?: string
  ownerId?: mongoose.Types.ObjectId | string | null
  variables: Record<string, string>
  eventDate?: Date
}

function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`)
}

async function resolveAssignee(
  rule: { type: string; userId?: mongoose.Types.ObjectId },
  context: TriggerContext
): Promise<mongoose.Types.ObjectId | null> {
  if (rule.type === 'SPECIFIC' && rule.userId) {
    return rule.userId
  }

  if (rule.type === 'OWNER' && context.ownerId) {
    const id = context.ownerId
    if (mongoose.isValidObjectId(String(id))) {
      return new mongoose.Types.ObjectId(String(id))
    }
  }

  // Fallback: first ADMIN or SUPERADMIN user
  // Plumtrips' own admins only — never a customer company's ADMIN, who would
  // then be handed Plumtrips' internal (lead / booking) tasks.
  const admin = await (User as any).findOne(PLUMTRIPS_ADMIN_FILTER)
    .select('_id')
    .lean()
  if (admin) return admin._id as mongoose.Types.ObjectId

  return null
}

/**
 * Why a trigger did or did not produce a task. `automation_missing` (no row)
 * and `automation_disabled` (row toggled off) are the cases that used to be
 * indistinguishable from success to anyone but the database — callers that
 * face a user (the disposition route) surface them instead of swallowing them.
 */
export type TaskAutomationOutcome =
  | 'created'
  | 'automation_missing'
  | 'automation_disabled'
  | 'open_task_exists'
  | 'no_assignee'
  | 'error'

export async function triggerTaskAutomation(
  triggerKey: string,
  context: TriggerContext
): Promise<InstanceType<typeof Task> | null> {
  return (await runTaskAutomation(triggerKey, context)).task
}

/** triggerTaskAutomation, plus the outcome. Never throws. */
export async function runTaskAutomation(
  triggerKey: string,
  context: TriggerContext
): Promise<{ task: InstanceType<typeof Task> | null; outcome: TaskAutomationOutcome }> {
  try {
    // Slice 2: a new-taxonomy key resolves to its own row first, then to the
    // legacy alias row that may already exist in prod (config/
    // defaultTaskAutomations.ts TRIGGER_KEY_ALIASES). Whichever row matched,
    // the task is stamped with the key that was FIRED, and dedup looks at
    // both spellings so a lead cannot get one task per vocabulary.
    const alias = TRIGGER_KEY_ALIASES[triggerKey]
    const keys = alias ? [triggerKey, alias] : [triggerKey]
    let automation: any = null
    for (const k of keys) {
      automation = await TaskAutomation.findOne({
        workspaceId: context.workspaceId,
        triggerKey: k,
        enabled: true,
      }).lean()
      if (automation) break
    }

    if (!automation) {
      // Tell a toggled-off row from a missing one — one extra read, and only
      // on the path that creates nothing.
      const disabled = await TaskAutomation.exists({
        workspaceId: context.workspaceId,
        triggerKey: { $in: keys },
      })
      return { task: null, outcome: disabled ? 'automation_disabled' : 'automation_missing' }
    }

    // Dedup: skip if an open auto-task for this trigger+entity already exists
    const existing = await Task.findOne({
      autoTriggerKey: { $in: keys },
      linkedId: context.entityId,
      status: { $nin: ['DONE', 'CANCELLED'] },
    }).lean()

    if (existing) {
      logger.info('[TaskAutomation] Skipping dedup — open task exists', {
        triggerKey,
        entityId: context.entityId,
        existingTaskId: existing._id,
      })
      return { task: null, outcome: 'open_task_exists' }
    }

    const title = renderTemplate(automation.titleTemplate, context.variables)
    const description = automation.descriptionTemplate
      ? renderTemplate(automation.descriptionTemplate, context.variables)
      : undefined

    const baseDate = context.eventDate ?? new Date()
    const dueDate = new Date(baseDate.getTime() + automation.dueOffsetMinutes * 60 * 1000)

    const assigneeId = await resolveAssignee(automation.assigneeRule as any, context)
    if (!assigneeId) {
      logger.warn('[TaskAutomation] Could not resolve assignee — skipping task creation', { triggerKey })
      return { task: null, outcome: 'no_assignee' }
    }

    // Use first admin as createdBy for auto-tasks
    const systemUser = await (User as any)
      .findOne(PLUMTRIPS_ADMIN_FILTER)
      .select('_id')
      .lean()
    const createdById = systemUser?._id ?? assigneeId

    const task = await Task.create({
      workspaceId: context.workspaceId,
      title,
      description,
      assignedTo: assigneeId,
      createdBy: createdById,
      dueDate,
      priority: automation.priority,
      status: 'OPEN',
      linkedType: context.entityType as any,
      linkedId: context.entityId,
      linkedRef: context.entityRef,
      tags: automation.tags,
      isActive: true,
      autoTriggerKey: triggerKey,
    })

    logger.info('[TaskAutomation] Task created', {
      triggerKey,
      taskId: task._id,
      title,
      entityId: context.entityId,
    })

    return { task, outcome: 'created' }
  } catch (err) {
    // Never throw — task automation failures must not break entity creation
    logger.error('[TaskAutomation] triggerTaskAutomation error', { triggerKey, err })
    return { task: null, outcome: 'error' }
  }
}
