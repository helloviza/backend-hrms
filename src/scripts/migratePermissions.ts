// apps/backend/src/scripts/migratePermissions.ts
// One-time migration:
//   1. Migrate BillingPermission → UserPermission (billing modules only)
//   2. Auto-grant L1 to all staff users without a UserPermission doc
//
// Safe to run multiple times — idempotent via findOneAndUpdate / upsert logic.
// Run with: npx tsx apps/backend/src/scripts/migratePermissions.ts

import { connectDb } from '../config/db.js'
import BillingPermission from '../models/BillingPermission.js'
import { UserPermission } from '../models/UserPermission.js'
import User from '../models/User.js'
import { LEVEL_TEMPLATES, LEVEL_METADATA } from '../config/levelTemplates.js'

const STAFF_ROLES = ['EMPLOYEE', 'MANAGER', 'HR', 'ADMIN']

const BILLING_PAGE_MAP: Record<string, { access: string; scope: string }> = {
  manualBookings:  { access: 'WRITE', scope: 'OWN' },
  invoices:        { access: 'FULL',  scope: 'ALL' },
  reports:         { access: 'READ',  scope: 'OWN' },
  companySettings: { access: 'FULL',  scope: 'ALL' },
}

const L1_TEMPLATE  = LEVEL_TEMPLATES['L1']
const L1_META      = LEVEL_METADATA.find(m => m.code === 'L1')!

async function run() {
  await connectDb()
  console.log('Connected to MongoDB\n')

  let billingMigrated  = 0
  let newL1Grants      = 0
  let skipped          = 0
  const errors: string[] = []

  // ── STEP 2: Migrate BillingPermission → UserPermission ───────────────────────
  console.log('STEP 2 — Migrating BillingPermission records...')

  const billingDocs = await BillingPermission.find().lean().exec()
  console.log(`  Found ${billingDocs.length} BillingPermission docs`)

  for (const bp of billingDocs as any[]) {
    try {
      const user = await User.findOne(
        bp.userId
          ? { _id: bp.userId }
          : { email: bp.email?.toLowerCase() },
        { _id: 1, email: 1, workspaceId: 1, roles: 1 }
      ).lean().exec() as any

      if (!user) {
        console.log(`  SKIP — no user found for userId=${bp.userId} email=${bp.email}`)
        skipped++
        continue
      }

      const userId    = String(user._id)
      const email     = String(user.email).toLowerCase()
      const wsId      = String(user.workspaceId)
      const grantedBy = bp.grantedBy || 'system-migration'

      // Build billing module overrides from pages[]
      const billingOverrides: Record<string, { access: string; scope: string }> = {}
      for (const page of (bp.pages || []) as string[]) {
        if (BILLING_PAGE_MAP[page]) {
          billingOverrides[page] = BILLING_PAGE_MAP[page]
        }
      }

      const existing = await UserPermission.findOne({ userId }).exec()

      if (existing) {
        // Update only the four billing modules
        const updateFields: Record<string, any> = { updatedBy: grantedBy, updatedAt: new Date() }
        for (const [mod, perm] of Object.entries(billingOverrides)) {
          updateFields[`modules.${mod}`] = perm
        }
        await UserPermission.updateOne({ userId }, { $set: updateFields })
        console.log(`  UPDATE userId=${userId} billing modules: [${Object.keys(billingOverrides).join(', ')}]`)
      } else {
        // Create from L1 template then override billing modules
        const modules = { ...L1_TEMPLATE } as any
        for (const [mod, perm] of Object.entries(billingOverrides)) {
          modules[mod] = perm
        }

        await UserPermission.create({
          userId,
          email,
          workspaceId: wsId,
          universe: 'STAFF',
          level: {
            code:        L1_META.code,
            name:        L1_META.name,
            designation: '',
          },
          modules,
          grantedBy,
          grantedAt: new Date(),
        })
        console.log(`  CREATE userId=${userId} (L1 + billing overrides: [${Object.keys(billingOverrides).join(', ')}])`)
      }

      billingMigrated++
    } catch (e: any) {
      const msg = `BillingPermission userId=${bp.userId}: ${e.message}`
      console.error(`  ERROR — ${msg}`)
      errors.push(msg)
    }
  }

  console.log(`  Done — ${billingMigrated} migrated, ${skipped} skipped\n`)

  // ── STEP 3: Auto-grant L1 to staff users without a UserPermission doc ─────────
  console.log('STEP 3 — Auto-granting L1 to staff users without a UserPermission...')

  const staffUsers = await User.find(
    { roles: { $in: STAFF_ROLES, $nin: ['SUPERADMIN'] } },
    { _id: 1, email: 1, workspaceId: 1 }
  ).lean().exec() as any[]

  console.log(`  Found ${staffUsers.length} staff users`)

  for (const u of staffUsers) {
    try {
      const userId = String(u._id)
      const exists = await UserPermission.exists({ userId })
      if (exists) {
        skipped++
        continue
      }

      await UserPermission.create({
        userId,
        email:       String(u.email).toLowerCase(),
        workspaceId: String(u.workspaceId),
        universe:    'STAFF',
        level: {
          code:        L1_META.code,
          name:        L1_META.name,
          designation: '',
        },
        modules:   { ...L1_TEMPLATE },
        grantedBy: 'system-migration',
        grantedAt: new Date(),
      })

      console.log(`  L1 granted → userId=${userId} email=${u.email}`)
      newL1Grants++
    } catch (e: any) {
      const msg = `User ${u._id}: ${e.message}`
      console.error(`  ERROR — ${msg}`)
      errors.push(msg)
    }
  }

  console.log(`  Done — ${newL1Grants} new L1 grants\n`)

  // ── STEP 4: Summary ───────────────────────────────────────────────────────────
  console.log('Migration complete:')
  console.log(`  BillingPermission migrated: ${billingMigrated}`)
  console.log(`  New L1 grants created:      ${newL1Grants}`)
  console.log(`  Skipped (already exists):   ${skipped}`)
  console.log(`  Errors:                     ${errors.length}`)
  if (errors.length) {
    for (const e of errors) console.log(`    - ${e}`)
  }

  // ── STEP 5: Disconnect ────────────────────────────────────────────────────────
  process.exit(0)
}

run().catch((e) => {
  console.error('Migration failed:', e)
  process.exit(1)
})
