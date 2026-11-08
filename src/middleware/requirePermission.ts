import type { Request, Response, NextFunction } from 'express'
import { UserPermission, hasAccess } from '../models/UserPermission.js'
import { isSuperAdmin } from './isSuperAdmin.js'
import logger from '../utils/logger.js'

declare global {
  namespace Express {
    interface Request {
      permissionScope?:  'NONE' | 'OWN' | 'TEAM' | 'WORKSPACE' | 'ALL'
      permissionAccess?: 'NONE' | 'READ' | 'WRITE' | 'FULL'
      permissionLevel?:  string
    }
  }
}

/**
 * requireAnyPermission — passes when the caller satisfies minAccess on ANY of
 * the listed modules.
 *
 * For capabilities that two different grants can legitimately confer. The
 * voucher upload is the case in point: an ops user holds `adminVouchers` and a
 * self-serve uploader holds `voucherExtract`; both may upload, but only the
 * former may correct or re-render. Chaining two requirePermission calls would
 * AND them, which is the opposite of what is wanted.
 *
 * Permission context is attached from the first module that satisfies the
 * check, in the order given — so list the more privileged module first.
 */
export function requireAnyPermission(
  modules: string[],
  minAccess: 'READ' | 'WRITE' | 'FULL'
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (isSuperAdmin(req)) {
      req.permissionScope  = 'ALL'
      req.permissionAccess = 'FULL'
      return next()
    }

    const user = (req as any).user
    const userId = String(user?._id || user?.id || user?.sub || '')
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Not authenticated' })
    }

    if (Array.isArray(user.roles) && user.roles.includes('SUPERADMIN')) {
      req.permissionScope  = 'ALL'
      req.permissionAccess = 'FULL'
      return next()
    }

    const perm = await UserPermission.findOne({ userId }).lean()
    if (!perm) {
      return res.status(403).json({
        success: false,
        message: 'Access not granted',
        module: modules.join(' | '),
        required: minAccess,
      })
    }

    for (const module of modules) {
      const mod = (perm.modules as any)[module]
      if (!mod || mod.access === 'NONE') continue
      if (!hasAccess(mod.access, minAccess)) continue

      req.permissionScope  = mod.scope
      req.permissionAccess = mod.access
      req.permissionLevel  = perm.level?.code || 'L1'
      return next()
    }

    return res.status(403).json({
      success: false,
      message: 'Module access not granted',
      module: modules.join(' | '),
      required: minAccess,
    })
  }
}

/**
 * hasModulePermission — the boolean answer to "would requirePermission(module,
 * minAccess) let this request through?", WITHOUT sending a response.
 *
 * Mirrors requirePermission below branch-for-branch (isSuperAdmin → roles
 * SUPERADMIN → UserPermission.modules[module] access check). requirePermission
 * itself is intentionally not refactored onto this; parity is pinned by
 * hasModulePermission.test.ts instead. Used by GET /users/profile to tell the
 * UI whether the profile-edit routes will accept the caller (audit H5).
 */
export async function hasModulePermission(
  req: Request,
  module: string,
  minAccess: 'READ' | 'WRITE' | 'FULL'
): Promise<boolean> {
  if (isSuperAdmin(req)) return true
  const user = (req as any).user
  const userId = String(user?._id || user?.id || user?.sub || '')
  if (!userId) return false
  if (Array.isArray(user.roles) && user.roles.includes('SUPERADMIN')) return true
  const perm = await UserPermission.findOne({ userId }).lean()
  if (!perm) return false
  const mod = (perm.modules as any)?.[module]
  if (!mod || mod.access === 'NONE') return false
  return hasAccess(mod.access, minAccess)
}

export function requirePermission(
  module: string,
  minAccess: 'READ' | 'WRITE' | 'FULL'
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // L8 SuperAdmin — always bypass
    if (isSuperAdmin(req)) {
      req.permissionScope  = 'ALL'
      req.permissionAccess = 'FULL'
      return next()
    }

    const user = (req as any).user
    const userId = String(user?._id || user?.id || user?.sub || '')
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Not authenticated',
      })
    }

    // Belt-and-suspenders SUPERADMIN bypass — grants full access without a
    // UserPermission record. isSuperAdmin() above covers most cases; this
    // catches any edge where role normalization hasn't propagated to the
    // isSuperAdmin check (e.g. old JWTs with non-array role field).
    if (Array.isArray(user.roles) && user.roles.includes('SUPERADMIN')) {
      logger.info('SUPERADMIN bypass: permission check skipped', {
        userId,
        module,
        minAccess,
        email: user.email,
      })
      req.permissionScope  = 'ALL'
      req.permissionAccess = 'FULL'
      return next()
    }

    const perm = await UserPermission.findOne({ userId }).lean()

    if (!perm) {
      return res.status(403).json({
        success: false,
        message: 'Access not granted',
        module,
        required: minAccess,
      })
    }

    const mod = (perm.modules as any)[module]
    if (!mod || mod.access === 'NONE') {
      return res.status(403).json({
        success: false,
        message: 'Module access not granted',
        module,
        required: minAccess,
      })
    }

    if (!hasAccess(mod.access, minAccess)) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient access level',
        module,
        required: minAccess,
        actual: mod.access,
      })
    }

    // Attach permission context to request
    req.permissionScope  = mod.scope
    req.permissionAccess = mod.access
    req.permissionLevel  = perm.level?.code || 'L1'

    next()
  }
}
