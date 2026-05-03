import mongoose from 'mongoose'
import Task from '../models/Task.js'
import TaskAutomation from '../models/TaskAutomation.js'
import User from '../models/User.js'
import logger from '../utils/logger.js'

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
  const admin = await (User as any).findOne({ roles: { $in: ['ADMIN', 'SUPERADMIN'] } })
    .select('_id')
    .lean()
  if (admin) return admin._id as mongoose.Types.ObjectId

  return null
}

export async function triggerTaskAutomation(
  triggerKey: string,
  context: TriggerContext
): Promise<InstanceType<typeof Task> | null> {
  try {
    const automation = await TaskAutomation.findOne({
      workspaceId: context.workspaceId,
      triggerKey,
      enabled: true,
    }).lean()

    if (!automation) return null

    // Dedup: skip if an open auto-task for this trigger+entity already exists
    const existing = await Task.findOne({
      autoTriggerKey: triggerKey,
      linkedId: context.entityId,
      status: { $nin: ['DONE', 'CANCELLED'] },
    }).lean()

    if (existing) {
      logger.info('[TaskAutomation] Skipping dedup — open task exists', {
        triggerKey,
        entityId: context.entityId,
        existingTaskId: existing._id,
      })
      return null
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
      return null
    }

    // Use first admin as createdBy for auto-tasks
    const systemUser = await (User as any)
      .findOne({ roles: { $in: ['ADMIN', 'SUPERADMIN'] } })
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

    return task
  } catch (err) {
    // Never throw — task automation failures must not break entity creation
    logger.error('[TaskAutomation] triggerTaskAutomation error', { triggerKey, err })
    return null
  }
}
