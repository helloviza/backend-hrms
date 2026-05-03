import { connectDb } from '../config/db.js'
import CustomerWorkspace from '../models/CustomerWorkspace.js'
import { seedTaskAutomations } from '../services/taskAutomationSeed.js'
import { SYSTEM_WORKSPACE_ID } from '../config/defaultTaskAutomations.js'
import logger from '../utils/logger.js'

async function run() {
  await connectDb()

  // Seed SYSTEM automations (leads, contacts)
  await seedTaskAutomations(SYSTEM_WORKSPACE_ID)
  logger.info('[Backfill] SYSTEM automations seeded')

  // Seed per-workspace automations (tickets, invoices, bookings)
  const workspaces = await CustomerWorkspace.find({}).select('_id').lean()
  logger.info(`[Backfill] Found ${workspaces.length} workspaces`)

  for (const ws of workspaces) {
    await seedTaskAutomations(ws._id.toString())
    logger.info(`[Backfill] Seeded workspace ${ws._id}`)
  }

  logger.info('[Backfill] Done')
  process.exit(0)
}

run().catch((err) => {
  logger.error('[Backfill] Fatal error', { err })
  process.exit(1)
})
