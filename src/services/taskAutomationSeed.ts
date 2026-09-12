import TaskAutomation from '../models/TaskAutomation.js'
import { DEFAULT_AUTOMATIONS, OPPORTUNITY_AUTOMATIONS } from '../config/defaultTaskAutomations.js'
import { isCrmV2OpportunityEnabled } from '../config/crmV2.js'
import logger from '../utils/logger.js'

export async function seedTaskAutomations(workspaceId: string): Promise<void> {
  try {
    const existing = await TaskAutomation.find({ workspaceId }).select('triggerKey').lean()
    const existingKeys = new Set(existing.map((a: any) => a.triggerKey))

    // Slice 2: the new-taxonomy rows are seeded only under CRM_V2_OPPORTUNITY
    // so the OFF state adds nothing (the legacy rows stay and keep firing
    // through the alias lookup either way).
    const catalogue = isCrmV2OpportunityEnabled()
      ? [...DEFAULT_AUTOMATIONS, ...OPPORTUNITY_AUTOMATIONS]
      : DEFAULT_AUTOMATIONS
    const toInsert = catalogue.filter((a) => !existingKeys.has(a.triggerKey))

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
