import express from 'express'
import mongoose from 'mongoose'
import { requireAuth } from '../middleware/auth.js'
import { requireSuperAdmin } from '../middleware/requireSuperAdmin.js'
import { requireSuperAdminOrTenantAdmin } from '../middleware/requireSuperAdminOrTenantAdmin.js'
import { requireWorkspace } from '../middleware/requireWorkspace.js'
import { isSuperAdmin } from '../middleware/isSuperAdmin.js'
import { UserPermission, PermissionTier } from '../models/UserPermission.js'
import { LEVEL_TEMPLATES, LEVEL_METADATA } from '../config/levelTemplates.js'
import BillingPermission from '../models/BillingPermission.js'
import User from '../models/User.js'
import Customer from '../models/Customer.js'
import logger from '../utils/logger.js'
import { MODULE_GROUP_MAP } from '../utils/moduleGroups.js'
import CustomerWorkspace from '../models/CustomerWorkspace.js'
import { allowedModuleKeysFor } from '../utils/featureToModules.js'
import { CUSTOMER_DEMO_SEED_EMAILS } from '../config/demoSeedAllowlist.js'

const router = express.Router()

// Plumtrips/HOUSE internal workspace. The SBT module row in the Access Console
// drives the real User.sbtEnabled flag ONLY for this workspace — client/tenant
// grants are intentionally left untouched.
const HOUSE_WORKSPACE_ID = '69679a7628330a58d29f2254'

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

    // Derive grantedModules from modules object for STAFF users so that
    // nav sections appear even when the DB doc's grantedModules array is empty.
    if (perm.universe === 'STAFF') {
      const modules = (perm.modules as any) || {}
      const existingGranted = perm.grantedModules || []
      const derived = new Set<string>(existingGranted)

      for (const [group, children] of Object.entries(MODULE_GROUP_MAP)) {
        const hasAny = children.some((child: string) => {
          const m = modules[child]
          return m?.access && m.access !== 'NONE'
        })
        if (hasAny) derived.add(group)
      }

      return res.json({ ...perm, grantedModules: Array.from(derived) })
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

// ── All management routes below: SuperAdmin OR TENANT_ADMIN (workspace-scoped) ─
// Per-endpoint handlers below MUST enforce workspaceId scoping for non-SuperAdmin
// callers using (req as any).isPlatformSuperAdmin.
router.use(requireAuth, requireSuperAdminOrTenantAdmin, requireWorkspace)

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

    // WorkspaceId + STAFF universe only for non-SuperAdmin (tenant admins)
    if (!isSuperAdmin(req)) {
      filter.workspaceId = String(req.workspaceObjectId)
      filter.universe = 'STAFF'
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

    // Populate display names from User collection. sbtEnabled is included so the
    // Access Console SBT row can be seeded from the REAL field (User.sbtEnabled),
    // not the legacy UserPermission.modules.sbt — see AccessConsole openManage.
    const userIds = docs.map(d => d.userId)
    const users = await User.find(
      { _id: { $in: userIds } },
      { _id: 1, name: 1, firstName: 1, lastName: 1, email: 1, sbtEnabled: 1 }
    ).lean()

    const nameMap: Record<string, string> = {}
    const sbtMap: Record<string, boolean> = {}
    for (const u of users) {
      const id = String((u as any)._id)
      const name =
        (u as any).name ||
        [(u as any).firstName, (u as any).lastName].filter(Boolean).join(' ') ||
        (u as any).email ||
        ''
      nameMap[id] = name
      sbtMap[id] = (u as any).sbtEnabled === true
    }

    const result = docs.map(d => ({
      ...d,
      displayName: nameMap[d.userId] || d.email,
      sbtEnabled: sbtMap[d.userId] ?? false,
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

    // Tenant-admin scoping: enforce workspace boundary + STAFF universe.
    const isSuper = (req as any).isPlatformSuperAdmin === true
    if (!isSuper) {
      if (String((user as any).workspaceId) !== String(req.workspaceObjectId)) {
        return res.status(403).json({ success: false, message: 'Cannot grant access to users outside your workspace' })
      }
      if (universe !== 'STAFF') {
        return res.status(403).json({ success: false, message: 'Tenant admins can only grant STAFF access' })
      }
    }

    const userId = String((user as any)._id)
    const resolvedWorkspaceId = isSuper
      ? (workspaceId || String((user as any).workspaceId || 'global'))
      : String(req.workspaceObjectId)

    const levelMeta = LEVEL_METADATA.find(l => l.code === levelCode)
    const modules: Record<string, any> = moduleOverrides
      ? { ...template, ...moduleOverrides }
      : { ...template }

    // Stage 3: feature-flag gate. Strip module keys whose required feature
    // flags are not enabled on the caller's workspace. SuperAdmin bypasses;
    // HOUSE workspace bypass is handled inside allowedModuleKeysFor.
    if (!isSuper) {
      const workspace = await CustomerWorkspace.findById(req.workspaceObjectId)
      const allowed = allowedModuleKeysFor(workspace)
      const disallowed = Object.keys(modules).filter(k => !allowed.has(k))
      if (disallowed.length > 0) {
        logger.warn(
          `[permissions/grant] Stripped ${disallowed.length} disallowed module keys for tenant ${req.workspaceObjectId}: ${disallowed.join(', ')}`
        )
        for (const key of disallowed) {
          delete modules[key]
        }
      }
    }

    const adminEmail = String(req.user?.email || req.user?._id || 'unknown')

    // HOUSE-scoped: the SBT module row drives the real User.sbtEnabled flag.
    // Refuse to enable when the workspace is in approval flow (avoids a
    // nav-shows-but-book-fails half-state). Other workspaces are untouched.
    const isHouseGrant = String(resolvedWorkspaceId) === HOUSE_WORKSPACE_ID
    const grantSbtAccess = (modules as any).sbt?.access as string | undefined
    const grantEnableSbt = !!grantSbtAccess && grantSbtAccess !== 'NONE'
    if (isHouseGrant && grantEnableSbt) {
      const houseWs = await CustomerWorkspace.findById(HOUSE_WORKSPACE_ID).select('travelMode').lean()
      if ((houseWs as any)?.travelMode === 'APPROVAL_FLOW') {
        return res.status(409).json({ success: false, message: 'Cannot enable SBT. Company uses approval flow.', code: 'APPROVAL_FLOW_CONFLICT' })
      }
    }

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

    // HOUSE-scoped: write the real SBT flag the booking/nav layer reads.
    // canRaiseRequest is coupled inverse to sbtEnabled for parity with
    // /workspace/permissions (a booker is not simultaneously a requestor).
    if (isHouseGrant) {
      try {
        await User.findOneAndUpdate(
          { email: normalizedEmail },
          { $set: { sbtEnabled: grantEnableSbt, canRaiseRequest: !grantEnableSbt } }
        )
      } catch (sbtErr) {
        logger.warn('[permissions/grant] HOUSE sbtEnabled sync failed:', sbtErr)
      }
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

    // Tenant-admin scoping: existing doc must be in caller's workspace.
    const isSuper = (req as any).isPlatformSuperAdmin === true
    if (!isSuper && String(existing.workspaceId) !== String(req.workspaceObjectId)) {
      return res.status(403).json({ success: false, message: 'Cannot modify permissions outside your workspace' })
    }

    // Stage 3: feature-flag gate on incoming change-set only. Disallowed keys
    // already present on the existing doc (legacy grants) are preserved as-is.
    if (!isSuper && moduleChanges && typeof moduleChanges === 'object') {
      const workspace = await CustomerWorkspace.findById(req.workspaceObjectId)
      const allowed = allowedModuleKeysFor(workspace)
      for (const key of Object.keys(moduleChanges)) {
        if (!allowed.has(key)) {
          logger.warn(
            `[permissions/update] Stripped disallowed module key ${key} for tenant ${req.workspaceObjectId}`
          )
          delete (moduleChanges as any)[key]
        }
      }
    }

    if (moduleChanges) {
      for (const [key, val] of Object.entries(moduleChanges)) {
        ;(existing.modules as any)[key] = val
      }
    }

    // HOUSE-scoped: SBT module row drives the real User.sbtEnabled flag.
    // Computed from the merged doc so an explicit NONE disables SBT. Refuse to
    // enable under approval flow. Other workspaces are untouched.
    const isHouseUpd = String(existing.workspaceId) === HOUSE_WORKSPACE_ID
    const updSbtAccess = (existing.modules as any).sbt?.access as string | undefined
    const updEnableSbt = !!updSbtAccess && updSbtAccess !== 'NONE'
    if (isHouseUpd && updEnableSbt) {
      const houseWs = await CustomerWorkspace.findById(HOUSE_WORKSPACE_ID).select('travelMode').lean()
      if ((houseWs as any)?.travelMode === 'APPROVAL_FLOW') {
        return res.status(409).json({ success: false, message: 'Cannot enable SBT. Company uses approval flow.', code: 'APPROVAL_FLOW_CONFLICT' })
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

    // HOUSE-scoped: write the real SBT flag the booking/nav layer reads.
    if (isHouseUpd) {
      try {
        await User.findOneAndUpdate(
          { email: existing.email.toLowerCase() },
          { $set: { sbtEnabled: updEnableSbt, canRaiseRequest: !updEnableSbt } }
        )
      } catch (sbtErr) {
        logger.warn('[permissions/update] HOUSE sbtEnabled sync failed:', sbtErr)
      }
    }

    logger.info(`[PERMISSION] UPDATE ${existing.email} by ${adminEmail}`)
    return res.json({ success: true, data: existing })
  } catch (err: any) {
    logger.error('[PERMISSION] update error', { error: err.message })
    return res.status(500).json({ success: false, message: 'Error updating permission' })
  }
})

// ── PATCH /api/permissions/demo-access ───────────────────────────────────────
// Demo Platform — grant or revoke a STAFF user's ability to impersonate
// mapped demo seed users. Router-level gate is requireSuperAdminOrTenantAdmin
// (too loose for this feature), so we re-gate with requireSuperAdmin here.
router.patch('/demo-access', requireSuperAdmin, async (req: any, res: any) => {
  try {
    const { userId, enabled, mappedSeedUsers } = req.body

    if (!userId || !mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ error: 'userId required and must be a valid ObjectId' })
    }

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be boolean' })
    }

    if (enabled && !Array.isArray(mappedSeedUsers)) {
      return res.status(400).json({ error: 'mappedSeedUsers must be an array when enabled is true' })
    }

    // Validate target user exists and is a STAFF account.
    // Carve-out: a CUSTOMER-universe account may still receive demoAccess IFF
    // its own email is a literal CUSTOMER_DEMO_SEED_EMAILS member (e.g. a demo
    // seed sub-impersonating other demo seeds). This is dormant today — no
    // customer-side granter exists yet — but keeps the door narrow and
    // explicit rather than reopening it wide later.
    const targetRep: any = await User.findById(userId).lean()
    if (!targetRep) {
      return res.status(404).json({ error: 'User not found' })
    }
    const targetRepEmailLower = String(targetRep.email || '').toLowerCase()
    const targetRepIsCustomer = targetRep.accountType === 'CUSTOMER' || targetRep.userType === 'CUSTOMER'
    const targetRepIsAllowlistedCustomerSeed =
      targetRepIsCustomer && (CUSTOMER_DEMO_SEED_EMAILS as readonly string[]).includes(targetRepEmailLower)
    if (targetRepIsCustomer && !targetRepIsAllowlistedCustomerSeed) {
      return res.status(422).json({ error: 'Demo access can only be granted to STAFF users, not customer-side users' })
    }

    // If enabled, validate every mappedSeedUsers entry is a real demo user
    if (enabled && mappedSeedUsers.length > 0) {
      const seedUserDocs: any[] = await User.find(
        { _id: { $in: mappedSeedUsers.map((id: string) => new mongoose.Types.ObjectId(id)) } },
        { _id: 1, isDemoUser: 1, email: 1, accountType: 1, userType: 1 }
      ).lean()

      const invalidSeeds = seedUserDocs.filter((u: any) => !u.isDemoUser)
      if (invalidSeeds.length > 0) {
        return res.status(422).json({
          error: 'Some mapped users are not configured as demo seed users',
          invalidUserIds: invalidSeeds.map((u: any) => String(u._id)),
        })
      }

      if (seedUserDocs.length !== mappedSeedUsers.length) {
        return res.status(404).json({ error: 'Some mappedSeedUsers do not exist' })
      }
    }

    // Apply the update
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          'demoAccess.enabled': enabled,
          'demoAccess.mappedSeedUsers': enabled
            ? mappedSeedUsers.map((id: string) => new mongoose.Types.ObjectId(id))
            : [],
        },
      }
    )

    const adminEmail = String(req.user?.email || req.user?._id || 'unknown')
    logger.info(
      `[demo-access] Updated ${targetRep.email}: enabled=${enabled}, mappedSeedUsers count=${
        enabled ? mappedSeedUsers.length : 0
      }, by ${adminEmail}`
    )

    return res.json({
      ok: true,
      userId,
      demoAccess: {
        enabled,
        mappedSeedUsers: enabled ? mappedSeedUsers : [],
      },
    })
  } catch (err: any) {
    logger.error('[demo-access] error', { error: err.message })
    return res.status(500).json({ error: 'demo_access_update_failed', message: err.message })
  }
})

// ── GET /api/permissions/demo-access/:userId ─────────────────────────────────
// Demo Platform — read the current demoAccess config for a user so the
// admin UI can pre-populate Step 4 when editing. SuperAdmin-only.
router.get('/demo-access/:userId', requireSuperAdmin, async (req: any, res: any) => {
  try {
    const { userId } = req.params
    if (!userId || !mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ error: 'invalid_user_id' })
    }
    const u: any = await User.findById(userId, { demoAccess: 1, isDemoUser: 1 }).lean()
    if (!u) return res.status(404).json({ error: 'not_found' })
    return res.json({
      enabled: u.demoAccess?.enabled === true,
      mappedSeedUsers: (u.demoAccess?.mappedSeedUsers || []).map((id: any) => String(id)),
      isDemoUser: u.isDemoUser === true,
    })
  } catch (err: any) {
    logger.error('[demo-access GET] error', { error: err.message })
    return res.status(500).json({ error: 'fetch_failed' })
  }
})

// ── GET /api/permissions/demo-seed-users ─────────────────────────────────────
// Demo Platform — populates the admin UI checkbox list of all possible
// demo seed users in the system. SuperAdmin-only.
router.get('/demo-seed-users', requireSuperAdmin, async (_req: any, res: any) => {
  try {
    const users: any[] = await User.find(
      { isDemoUser: true },
      { _id: 1, email: 1, name: 1, firstName: 1, lastName: 1, customerId: 1, accountType: 1 }
    ).lean()

    const customerIds = [
      ...new Set(users.map((u: any) => u.customerId).filter(Boolean)),
    ]
    const customers: any[] = await Customer.find(
      { _id: { $in: customerIds } },
      { _id: 1, name: 1 }
    ).lean()
    const customerNameMap = new Map(customers.map((c: any) => [String(c._id), c.name]))

    return res.json({
      users: users.map((u: any) => ({
        _id: String(u._id),
        email: u.email,
        name:
          u.name ||
          `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() ||
          u.email,
        customerName: customerNameMap.get(String(u.customerId)) || 'Unknown',
      })),
    })
  } catch (err: any) {
    logger.error('[demo-seed-users] error', { error: err.message })
    return res.status(500).json({ error: 'fetch_failed' })
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

    // Tenant-admin scoping: existing doc must be in caller's workspace.
    const isSuper = (req as any).isPlatformSuperAdmin === true
    if (!isSuper && String(existing.workspaceId) !== String(req.workspaceObjectId)) {
      return res.status(403).json({ success: false, message: 'Cannot apply template outside your workspace' })
    }

    const levelMeta = LEVEL_METADATA.find(l => l.code === levelCode)

    // Stage 3: feature-flag gate. Filter the resolved template to only modules
    // grantable for the caller's workspace. SuperAdmin and HOUSE bypass.
    const modulesToApply: Record<string, any> = { ...template }
    if (!isSuper) {
      const workspace = await CustomerWorkspace.findById(req.workspaceObjectId)
      const allowed = allowedModuleKeysFor(workspace)
      const disallowed = Object.keys(modulesToApply).filter(k => !allowed.has(k))
      if (disallowed.length > 0) {
        logger.warn(
          `[permissions/apply-template] Stripped ${disallowed.length} disallowed module keys for tenant ${req.workspaceObjectId}: ${disallowed.join(', ')}`
        )
        for (const key of disallowed) {
          delete modulesToApply[key]
        }
      }
    }

    existing.modules = modulesToApply as any
    existing.level.code = levelCode
    existing.level.name = levelMeta?.name || levelCode
    existing.tier = levelToTier(levelCode)
    // designation intentionally preserved

    // HOUSE-scoped: applying a template sets the SBT module per the level,
    // which drives the real User.sbtEnabled flag. Refuse to enable under
    // approval flow. Other workspaces are untouched.
    const isHouseTpl = String(existing.workspaceId) === HOUSE_WORKSPACE_ID
    const tplSbtAccess = (modulesToApply as any).sbt?.access as string | undefined
    const tplEnableSbt = !!tplSbtAccess && tplSbtAccess !== 'NONE'
    if (isHouseTpl && tplEnableSbt) {
      const houseWs = await CustomerWorkspace.findById(HOUSE_WORKSPACE_ID).select('travelMode').lean()
      if ((houseWs as any)?.travelMode === 'APPROVAL_FLOW') {
        return res.status(409).json({ success: false, message: 'Cannot enable SBT. Company uses approval flow.', code: 'APPROVAL_FLOW_CONFLICT' })
      }
    }

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

    // HOUSE-scoped: write the real SBT flag the booking/nav layer reads.
    if (isHouseTpl) {
      try {
        await User.findOneAndUpdate(
          { email: existing.email.toLowerCase() },
          { $set: { sbtEnabled: tplEnableSbt, canRaiseRequest: !tplEnableSbt } }
        )
      } catch (sbtErr) {
        logger.warn('[permissions/apply-template] HOUSE sbtEnabled sync failed:', sbtErr)
      }
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

    const existing = await UserPermission.findOne({ userId })
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Permission doc not found' })
    }

    // Tenant-admin scoping: existing doc must be in caller's workspace.
    const isSuper = (req as any).isPlatformSuperAdmin === true
    if (!isSuper && String(existing.workspaceId) !== String(req.workspaceObjectId)) {
      return res.status(403).json({ success: false, message: 'Cannot revoke access outside your workspace' })
    }

    await UserPermission.deleteOne({ _id: existing._id })

    const adminEmail = String(req.user?.email || req.user?._id || 'unknown')
    logger.info(`[PERMISSION] REVOKE ${existing.email} by ${adminEmail}`)

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

    const filter: Record<string, any> = {
      $or: [{ email: regex }, { officialEmail: regex }, { name: regex }],
    }

    // Tenant-admin scoping: restrict User search to caller's workspace.
    const isSuper = (req as any).isPlatformSuperAdmin === true
    if (!isSuper) {
      filter.workspaceId = req.workspaceObjectId
    }

    const users = await User.find(
      filter,
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
// SuperAdmin-only (router-level gate allows TENANT_ADMIN; explicit re-gate here).
router.post('/migrate', requireSuperAdmin, async (req: any, res: any) => {
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
