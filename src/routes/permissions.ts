import express from 'express'
import { requireAuth } from '../middleware/auth.js'
import { requireSuperAdmin } from '../middleware/requireSuperAdmin.js'
import { isSuperAdmin } from '../middleware/isSuperAdmin.js'
import { UserPermission, PermissionTier } from '../models/UserPermission.js'
import { LEVEL_TEMPLATES, LEVEL_METADATA } from '../config/levelTemplates.js'
import BillingPermission from '../models/BillingPermission.js'
import User from '../models/User.js'
import logger from '../utils/logger.js'

const router = express.Router()

function levelToRole(code: string): string {
  switch (code) {
    case 'L1': return 'EMPLOYEE'
    case 'L2': return 'EMPLOYEE'
    case 'L3': return 'MANAGER'
    case 'L4': return 'MANAGER'
    case 'L5': return 'HR'
    case 'L6': return 'ADMIN'
    case 'L7': return 'ADMIN'
    case 'L8': return 'SUPERADMIN'
    case 'CUSTOMER_SBT': return 'CUSTOMER'
    case 'CUSTOMER_APPROVAL': return 'CUSTOMER'
    case 'VENDOR': return 'VENDOR'
    default: return 'EMPLOYEE'
  }
}

function levelToTier(code: string): PermissionTier {
  switch (code) {
    case 'L8': return 3
    case 'L5': case 'L6': case 'L7': return 2
    default: return 1
  }
}

function roleToRolesArray(hrmsAccessRole: string): string[] {
  switch (hrmsAccessRole) {
    case 'SUPERADMIN': return ['SUPERADMIN']
    case 'ADMIN':      return ['ADMIN']
    case 'HR':         return ['HR']
    case 'MANAGER':    return ['MANAGER']
    case 'CUSTOMER':   return ['CUSTOMER']
    case 'VENDOR':     return ['VENDOR']
    default:           return ['EMPLOYEE']
  }
}

// ── GET /api/permissions/my-access ──────────────────────────────────────────
// Open to all authenticated users. Fast path — called on every page load.
router.get('/my-access', requireAuth, async (req: any, res: any) => {
  try {
    if (isSuperAdmin(req)) {
      const allModules: Record<string, { access: string; scope: string }> = {}
      const moduleKeys = Object.keys(LEVEL_TEMPLATES['L8'])
      for (const k of moduleKeys) {
        allModules[k] = { access: 'FULL', scope: 'ALL' }
      }
      return res.json({
        isSuperAdmin: true,
        level: { code: 'L8', name: 'Super Admin' },
        modules: allModules,
        tier: 3,
        roleType: 'SUPERADMIN',
        status: 'active',
        grantedModules: [
          'bookings', 'billing', 'hrops',
          'payroll', 'reports', 'adminQueue',
          'people', 'access', 'onboarding',
        ],
      })
    }

    const userId = String(req.user?._id || req.user?.id || req.user?.sub || '')
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Not authenticated' })
    }

    const perm = await UserPermission.findOne({ userId }).lean()

    if (!perm) {
      const userDoc = await User.findById(userId, 'roles').lean() as any
      const isExternal =
        userDoc?.roles?.includes('CUSTOMER') ||
        userDoc?.roles?.includes('VENDOR') ||
        userDoc?.roles?.includes('CLIENT') ||
        userDoc?.roles?.includes('WORKSPACE_LEADER') ||
        userDoc?.roles?.includes('REQUESTER') ||
        userDoc?.roles?.includes('APPROVER')

      if (isExternal) {
        const isWL = userDoc?.roles?.some(
          (r: string) => r.toUpperCase().replace(/[\s\-_]/g, '') === 'WORKSPACELEADER'
        )
        return res.json({
          tier: isWL ? 2 : 1,
          roleType: 'CLIENT',
          status: 'active',
          grantedModules: isWL
            ? ['bookings', 'billing', 'profile', 'access']
            : ['bookings', 'billing', 'profile'],
          source: 'auto',
        })
      }

      return res.json({ notGranted: true })
    }

    // TENANT_ADMIN / Workspace Admin: perm doc has roleType SUPERADMIN but
    // user.roles[] does not contain SUPERADMIN so isSuperAdmin(req) is false.
    // Treat these docs as full-access superadmin so PermissionGuard passes.
    if (perm.roleType === 'SUPERADMIN') {
      const allModules: Record<string, { access: string; scope: string }> = {}
      const moduleKeys = Object.keys(LEVEL_TEMPLATES['L8'] ?? {})
      // Fall back to the known module list if template is unavailable
      const keys = moduleKeys.length > 0 ? moduleKeys : [
        'myProfile', 'attendance', 'leaves', 'leaveApprovals', 'holidays',
        'holidayManagement', 'orgChart', 'policies', 'teamProfiles', 'teamPresence',
        'teamCalendar', 'hrWorkspace', 'onboarding', 'people', 'masterData',
        'payroll', 'payrollAdmin', 'adminQueue', 'manualBookings', 'invoices',
        'reports', 'companySettings', 'adminVouchers', 'voucherExtract',
        'analytics', 'workspaceSettings', 'accessConsole', 'sbt',
        'sbtSearch', 'sbtBookings', 'sbtRequest', 'approvals', 'travelSpend',
        'vendorProfile',
      ]
      for (const k of keys) {
        allModules[k] = { access: 'FULL', scope: 'ALL' }
      }
      return res.json({
        isSuperAdmin: true,
        level: perm.level,
        modules: allModules,
        tier: 3,
        roleType: 'SUPERADMIN',
        status: 'active',
        grantedModules: perm.grantedModules,
      })
    }

    // For CUSTOMER_SBT / CUSTOMER_APPROVAL level grants that predate the
    // grantedModules field, backfill the customer module list so hasModule()
    // returns true for bookings/billing/profile on the frontend.
    const isCustomerLevel =
      perm.level?.code === 'CUSTOMER_SBT' || perm.level?.code === 'CUSTOMER_APPROVAL'
    if (isCustomerLevel && (!perm.grantedModules || perm.grantedModules.length === 0)) {
      const doc: any = { ...perm }
      doc.grantedModules = ['bookings', 'billing', 'profile']
      return res.json(doc)
    }

    return res.json(perm)
  } catch (err: any) {
    logger.error('[PERMISSION] my-access error', { error: err.message })
    return res.status(500).json({ success: false, message: 'Error fetching access' })
  }
})

// ── GET /api/permissions/levels ─────────────────────────────────────────────
// Open to all authenticated users. Used by frontend dropdowns.
router.get('/levels', requireAuth, (_req: any, res: any) => {
  return res.json(LEVEL_METADATA)
})

// ── All management routes below require SuperAdmin ───────────────────────────
router.use(requireAuth, requireSuperAdmin)

// ── GET /api/permissions/templates/:levelCode ────────────────────────────────
router.get('/templates/:levelCode', (req: any, res: any) => {
  const { levelCode } = req.params
  const template = LEVEL_TEMPLATES[levelCode]
  if (!template) {
    return res.status(404).json({ success: false, message: `No template for level: ${levelCode}` })
  }
  return res.json(template)
})

// ── GET /api/permissions/list ────────────────────────────────────────────────
router.get('/list', async (req: any, res: any) => {
  try {
    const { universe, workspaceId, search, page = '1', limit = '50' } = req.query
    const filter: Record<string, any> = {}
    if (universe) filter.universe = universe
    if (workspaceId) filter.workspaceId = workspaceId
    if (search) filter.email = { $regex: String(search), $options: 'i' }

    // Source filter applies to everyone
    filter.source = { $in: ['onboarding', 'manual'] }

    // WorkspaceId only for non-SuperAdmin
    if (!isSuperAdmin(req)) {
      filter.workspaceId = String(req.workspaceObjectId)
    }

    // Only show active and suspended grants (not revoked)
    filter.status = { $in: ['active', 'suspended'] }

    const pageNum = Math.max(1, parseInt(page as string, 10))
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10)))

    const [docs, total] = await Promise.all([
      UserPermission.find(filter)
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      UserPermission.countDocuments(filter),
    ])

    // Populate display names from User collection
    const userIds = docs.map(d => d.userId)
    const users = await User.find(
      { _id: { $in: userIds } },
      { _id: 1, name: 1, firstName: 1, lastName: 1, email: 1 }
    ).lean()

    const nameMap: Record<string, string> = {}
    for (const u of users) {
      const id = String((u as any)._id)
      const name =
        (u as any).name ||
        [(u as any).firstName, (u as any).lastName].filter(Boolean).join(' ') ||
        (u as any).email ||
        ''
      nameMap[id] = name
    }

    const result = docs.map(d => ({
      ...d,
      displayName: nameMap[d.userId] || d.email,
    }))

    return res.json({ data: result, total, page: pageNum, limit: limitNum })
  } catch (err: any) {
    logger.error('[PERMISSION] list error', { error: err.message })
    return res.status(500).json({ success: false, message: 'Error listing permissions' })
  }
})

// ── POST /api/permissions/grant ──────────────────────────────────────────────
router.post('/grant', async (req: any, res: any) => {
  try {
    const { email, workspaceId, universe, levelCode, designation, modules: moduleOverrides } = req.body

    if (!email || !universe || !levelCode) {
      return res.status(400).json({ success: false, message: 'email, universe, and levelCode are required' })
    }

    const template = LEVEL_TEMPLATES[levelCode]
    if (!template) {
      return res.status(400).json({ success: false, message: `Unknown levelCode: ${levelCode}` })
    }

    const normalizedEmail = String(email).toLowerCase()
    const user = await User.findOne({
      $or: [{ email: normalizedEmail }, { officialEmail: normalizedEmail }],
    }).lean()

    if (!user) {
      return res.status(404).json({ success: false, message: `No user found with email: ${email}` })
    }

    const userId = String((user as any)._id)
    const resolvedWorkspaceId = workspaceId || String((user as any).workspaceId || 'global')

    const levelMeta = LEVEL_METADATA.find(l => l.code === levelCode)
    const modules = moduleOverrides ? { ...template, ...moduleOverrides } : { ...template }

    const adminEmail = String(req.user?.email || req.user?._id || 'unknown')

    const saved = await UserPermission.findOneAndUpdate(
      { userId },
      {
        $set: {
          userId,
          email: normalizedEmail,
          workspaceId: resolvedWorkspaceId,
          universe,
          level: {
            code: levelCode,
            name: levelMeta?.name || levelCode,
            designation: designation || '',
          },
          modules,
          tier: levelToTier(levelCode),
          source: 'manual',
          grantedBy: adminEmail,
          grantedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    )

    // Sync hrmsAccessRole to User doc — non-fatal
    const grantRole = levelToRole(levelCode)
    try {
      await User.findOneAndUpdate(
        { email: normalizedEmail },
        { $set: { hrmsAccessRole: grantRole, roles: roleToRolesArray(grantRole) } }
      )
    } catch (syncErr) {
      logger.warn('[permissions/grant] hrmsAccessRole sync failed:', syncErr)
    }

    logger.info(`[PERMISSION] GRANT ${normalizedEmail} → ${levelCode} by ${adminEmail}`)
    return res.json({ success: true, data: saved })
  } catch (err: any) {
    logger.error('[PERMISSION] grant error', { error: err.message })
    return res.status(500).json({ success: false, message: 'Error granting permission' })
  }
})

// ── PATCH /api/permissions/update ────────────────────────────────────────────
router.patch('/update', async (req: any, res: any) => {
  try {
    const { userId, modules: moduleChanges, level: levelChanges, levelCode: levelCodeBody, designation } = req.body

    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required' })
    }

    const existing = await UserPermission.findOne({ userId })
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Permission doc not found' })
    }

    if (moduleChanges) {
      for (const [key, val] of Object.entries(moduleChanges)) {
        ;(existing.modules as any)[key] = val
      }
    }

    // Accept levelCode as a top-level field (sent by AccessConsole frontend)
    const resolvedLevelCode = levelCodeBody || levelChanges?.code
    if (resolvedLevelCode) {
      existing.level.code = resolvedLevelCode
      const levelMeta = LEVEL_METADATA.find(l => l.code === resolvedLevelCode)
      if (levelMeta) existing.level.name = levelMeta.name
      existing.tier = levelToTier(resolvedLevelCode)
    } else if (levelChanges) {
      if (levelChanges.name) existing.level.name = levelChanges.name
    }

    if (designation !== undefined) {
      existing.level.designation = designation
    }

    const adminEmail = String(req.user?.email || req.user?._id || 'unknown')
    existing.updatedBy = adminEmail
    existing.updatedAt = new Date()

    await existing.save()

    // Sync hrmsAccessRole to User doc — non-fatal
    const updateRole = levelToRole(existing.level.code)
    try {
      await User.findOneAndUpdate(
        { email: existing.email.toLowerCase() },
        { $set: { hrmsAccessRole: updateRole, roles: roleToRolesArray(updateRole) } }
      )
    } catch (syncErr) {
      logger.warn('[permissions/update] hrmsAccessRole sync failed:', syncErr)
    }

    logger.info(`[PERMISSION] UPDATE ${existing.email} by ${adminEmail}`)
    return res.json({ success: true, data: existing })
  } catch (err: any) {
    logger.error('[PERMISSION] update error', { error: err.message })
    return res.status(500).json({ success: false, message: 'Error updating permission' })
  }
})

// ── POST /api/permissions/apply-template ─────────────────────────────────────
router.post('/apply-template', async (req: any, res: any) => {
  try {
    const { userId, levelCode } = req.body

    if (!userId || !levelCode) {
      return res.status(400).json({ success: false, message: 'userId and levelCode are required' })
    }

    const template = LEVEL_TEMPLATES[levelCode]
    if (!template) {
      return res.status(400).json({ success: false, message: `Unknown levelCode: ${levelCode}` })
    }

    const existing = await UserPermission.findOne({ userId })
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Permission doc not found' })
    }

    const levelMeta = LEVEL_METADATA.find(l => l.code === levelCode)

    existing.modules = { ...template } as any
    existing.level.code = levelCode
    existing.level.name = levelMeta?.name || levelCode
    existing.tier = levelToTier(levelCode)
    // designation intentionally preserved

    const adminEmail = String(req.user?.email || req.user?._id || 'unknown')
    existing.source = 'manual'
    existing.updatedBy = adminEmail
    existing.updatedAt = new Date()

    await existing.save()

    // Sync hrmsAccessRole to User doc — non-fatal
    const templateRole = levelToRole(levelCode)
    try {
      await User.findOneAndUpdate(
        { email: existing.email.toLowerCase() },
        { $set: { hrmsAccessRole: templateRole, roles: roleToRolesArray(templateRole) } }
      )
    } catch (syncErr) {
      logger.warn('[permissions/apply-template] hrmsAccessRole sync failed:', syncErr)
    }

    logger.info(`[PERMISSION] TEMPLATE ${existing.email} → ${levelCode} by ${adminEmail}`)
    return res.json({ success: true, data: existing })
  } catch (err: any) {
    logger.error('[PERMISSION] apply-template error', { error: err.message })
    return res.status(500).json({ success: false, message: 'Error applying template' })
  }
})

// ── POST /api/permissions/revoke ─────────────────────────────────────────────
router.post('/revoke', async (req: any, res: any) => {
  try {
    const { userId } = req.body
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required' })
    }

    const doc = await UserPermission.findOneAndDelete({ userId })
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Permission doc not found' })
    }

    const adminEmail = String(req.user?.email || req.user?._id || 'unknown')
    logger.info(`[PERMISSION] REVOKE ${doc.email} by ${adminEmail}`)

    return res.json({ success: true })
  } catch (err: any) {
    logger.error('[PERMISSION] revoke error', { error: err.message })
    return res.status(500).json({ success: false, message: 'Error revoking permission' })
  }
})

// ── GET /api/permissions/search-users ────────────────────────────────────────
router.get('/search-users', async (req: any, res: any) => {
  try {
    const { q } = req.query
    if (!q || String(q).trim().length < 1) {
      return res.json([])
    }

    const term = String(q).trim()
    const regex = { $regex: term, $options: 'i' }

    const users = await User.find(
      { $or: [{ email: regex }, { officialEmail: regex }, { name: regex }] },
      { _id: 1, name: 1, firstName: 1, lastName: 1, email: 1, workspaceId: 1 }
    )
      .limit(20)
      .lean()

    if (users.length === 0) return res.json([])

    const userIds = users.map(u => String((u as any)._id))
    const permDocs = await UserPermission.find(
      { userId: { $in: userIds } },
      { userId: 1, level: 1 }
    ).lean()

    const permMap: Record<string, string> = {}
    for (const p of permDocs) {
      permMap[p.userId] = p.level?.code || ''
    }

    const result = users.map(u => {
      const id = String((u as any)._id)
      return {
        userId: id,
        email: (u as any).email || '',
        name:
          (u as any).name ||
          [(u as any).firstName, (u as any).lastName].filter(Boolean).join(' ') ||
          (u as any).email ||
          '',
        workspaceId: String((u as any).workspaceId || ''),
        currentLevel: permMap[id] || null,
      }
    })

    return res.json(result)
  } catch (err: any) {
    logger.error('[PERMISSION] search-users error', { error: err.message })
    return res.status(500).json({ success: false, message: 'Error searching users' })
  }
})

// ── POST /api/permissions/migrate ────────────────────────────────────────────
// One-time migration from BillingPermission → UserPermission.
// Does NOT delete BillingPermission docs.
router.post('/migrate', async (req: any, res: any) => {
  const summary = { migrated: 0, skipped: 0, errors: [] as string[] }

  try {
    const billingDocs = await BillingPermission.find({}).lean()

    for (const bp of billingDocs) {
      try {
        // Resolve user
        let user = await User.findById(bp.userId).lean().catch(() => null)
        if (!user) {
          user = await User.findOne({ email: bp.email }).lean()
        }
        if (!user) {
          summary.errors.push(`User not found for userId=${bp.userId} email=${bp.email}`)
          summary.skipped++
          continue
        }

        const userId = String((user as any)._id)

        // Map BillingPermission.pages to module permissions
        const pages: string[] = Array.isArray(bp.pages) ? bp.pages : []
        const billingModules: Record<string, { access: string; scope: string }> = {}
        if (pages.includes('manualBookings')) billingModules['manualBookings'] = { access: 'WRITE', scope: 'OWN' }
        if (pages.includes('invoices'))       billingModules['invoices']       = { access: 'FULL',  scope: 'ALL' }
        if (pages.includes('reports'))        billingModules['reports']        = { access: 'READ',  scope: 'OWN' }
        if (pages.includes('companySettings')) billingModules['companySettings'] = { access: 'FULL', scope: 'ALL' }

        const existing = await UserPermission.findOne({ userId })

        if (existing) {
          // Merge billing modules into existing doc without overwriting other permissions
          for (const [key, val] of Object.entries(billingModules)) {
            ;(existing.modules as any)[key] = val
          }
          existing.updatedBy = 'migration'
          existing.updatedAt = new Date()
          await existing.save()
        } else {
          // Create new doc using L1 template + billing overrides
          const l1 = { ...LEVEL_TEMPLATES['L1'] }
          const modules = { ...l1, ...billingModules }
          await UserPermission.create({
            userId,
            email: String((user as any).email || bp.email).toLowerCase(),
            workspaceId: bp.workspaceId || String((user as any).workspaceId || 'global'),
            universe: 'STAFF',
            level: { code: 'L1', name: 'Employee', designation: '' },
            modules,
            grantedBy: 'migration',
            grantedAt: new Date(),
          })
        }

        summary.migrated++
      } catch (rowErr: any) {
        summary.errors.push(`userId=${bp.userId}: ${rowErr.message}`)
        summary.skipped++
      }
    }

    logger.info('[PERMISSION] MIGRATE complete', summary)
    return res.json({ success: true, ...summary })
  } catch (err: any) {
    logger.error('[PERMISSION] migrate error', { error: err.message })
    return res.status(500).json({ success: false, message: 'Migration failed', error: err.message })
  }
})

export default router
