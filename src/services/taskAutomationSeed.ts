import TaskAutomation from '../models/TaskAutomation.js'
import { DEFAULT_AUTOMATIONS } from '../config/defaultTaskAutomations.js'
import logger from '../utils/logger.js'

export async function seedTaskAutomations(workspaceId: string): Promise<void> {
  try {
    const existing = await TaskAutomation.find({ workspaceId }).select('triggerKey').lean()
    const existingKeys = new Set(existing.map((a: any) => a.triggerKey))

    const toInsert = DEFAULT_AUTOMATIONS.filter((a) => !existingKeys.has(a.triggerKey))

    if (toInsert.length === 0) return

    await TaskAutomation.insertMany(
      toInsert.map((a) => ({
        workspaceId,
        triggerKey: a.triggerKey,
        label: a.label,
        entityType: a.entityType,
        enabled: a.enabled,
        titleTemplate: a.titleTemplate,
        dueOffsetMinutes: a.dueOffsetMinutes,
        priority: a.priority,
        assigneeRule: a.assigneeRule,
        tags: a.tags,
      })),
      { ordered: false }
    )

    logger.info('[TaskAutomationSeed] Seeded automations', {
      workspaceId,
      count: toInsert.length,
      keys: toInsert.map((a) => a.triggerKey),
    })
  } catch (err) {
    logger.error('[TaskAutomationSeed] Seed failed', { workspaceId, err })
  }
}
