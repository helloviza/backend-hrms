// apps/backend/src/scripts/migratePermissionTiers.ts
// One-time migration: backfill status, tier, roleType, and grantedModules
// on all existing UserPermission documents.
//
// Idempotent — safe to re-run; skips docs already at tier > 0.
// Run with: npx tsx src/scripts/migratePermissionTiers.ts

import { connectDb } from '../config/db.js'
import { UserPermission } from '../models/UserPermission.js'
import User from '../models/User.js'

const MODULES_TIER_3 = [
  'bookings', 'billing', 'hrops', 'payroll', 'reports',
  'adminQueue', 'sbt', 'approvalFlow', 'vendorAssignments',
  'people', 'access', 'onboarding',
]

const MODULES_TIER_2 = [
  'bookings', 'billing', 'hrops', 'payroll', 'reports',
  'adminQueue', 'people', 'access', 'onboarding',
]

const MODULES_TIER_1 = ['profile', 'myBookings', 'myInvoices']

// level.code → roleType
function roleTypeFromCode(code: string): 'EMPLOYEE' | 'CLIENT' | 'VENDOR' | 'SUPERADMIN' {
  if (code === 'SuperAdmin') return 'SUPERADMIN'
  if (code === 'VENDOR') return 'VENDOR'
  if (code === 'CUSTOMER_SBT' || code === 'CUSTOMER_APPROVAL') return 'CLIENT'
  return 'EMPLOYEE'
}

async function run() {
  await connectDb()
  console.log('Connected to MongoDB\n')

  const all = await UserPermission.find().lean().exec() as any[]
  console.log(`Found ${all.length} UserPermission docs\n`)

  let updated = 0
  let skipped = 0
  const errors: string[] = []

  for (const doc of all) {
    try {
      const userId = String(doc.userId)

      // Look up the User to determine if they are a SuperAdmin
      const user = await User.findOne(
        { _id: userId },
        { roles: 1, hrmsAccessRole: 1 }
      ).lean().exec() as any

      const roles: string[] = user?.roles ?? []
      const hrmsRole: string = user?.hrmsAccessRole ?? ''
      const isSuperAdmin =
        roles.some((r: string) => r.toLowerCase() === 'superadmin') ||
        hrmsRole.toLowerCase() === 'superadmin' ||
        doc.level?.code === 'SuperAdmin'

      // Derive roleType from level.code, but override to SUPERADMIN if applicable
      const detectedRoleType = isSuperAdmin
        ? 'SUPERADMIN'
        : roleTypeFromCode(doc.level?.code ?? '')

      // Derive tier
      let tier: number
      if (isSuperAdmin) {
        tier = 3
      } else if (detectedRoleType === 'CLIENT' || detectedRoleType === 'VENDOR') {
        tier = 1
      } else {
        tier = 2
      }

      // Derive grantedModules
      let grantedModules: string[]
      if (tier === 3) grantedModules = MODULES_TIER_3
      else if (tier === 2) grantedModules = MODULES_TIER_2
      else if (tier === 1) grantedModules = MODULES_TIER_1
      else grantedModules = []

      await UserPermission.updateOne(
        { _id: doc._id },
        {
          $set: {
            status: 'active',
            tier,
            roleType: detectedRoleType,
            grantedModules,
          },
        }
      )

      console.log(
        `  UPDATED userId=${userId} | tier=${tier} | roleType=${detectedRoleType} | modules=[${grantedModules.join(', ')}]`
      )
      updated++
    } catch (e: any) {
      const msg = `userId=${doc.userId}: ${e.message}`
      console.error(`  ERROR — ${msg}`)
      errors.push(msg)
    }
  }

  // Backfill source: 'migration' on all docs that predate the source field
  await UserPermission.updateMany(
    { source: { $exists: false } },
    { $set: { source: 'migration' } }
  )
  console.log('Marked all existing grants as source: migration')

  console.log('\nMigration complete:')
  console.log(`  Updated: ${updated}`)
  console.log(`  Skipped: ${skipped}`)
  console.log(`  Errors:  ${errors.length}`)
  if (errors.length) {
    for (const e of errors) console.log(`    - ${e}`)
  }

  process.exit(0)
}

run().catch((e) => {
  console.error('Migration failed:', e)
  process.exit(1)
})
