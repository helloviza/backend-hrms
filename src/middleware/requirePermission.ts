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

/**
 * The decision requirePermission makes, without answering the request or
 * logging: { ok: true, context } admits (context = what the middleware stamps
 * on req), { ok: false } carries the exact status + body it would send.
 * Reads UserPermission; writes nothing.
 */
export type PermissionDecision =
  | {
      ok: true
      via: 'superadmin' | 'superadmin-role' | 'grant'
      context: { permissionScope: any; permissionAccess: any; permissionLevel?: string }
    }
  | { ok: false; status: 401 | 403; body: Record<string, any> }

export async function decideModulePermission(
  req: Request,
  module: string,
  minAccess: 'READ' | 'WRITE' | 'FULL'
): Promise<PermissionDecision> {
  // L8 SuperAdmin — always bypass
  if (isSuperAdmin(req)) {
    return { ok: true, via: 'superadmin', context: { permissionScope: 'ALL', permissionAccess: 'FULL' } }
  }

  const user = (req as any).user
  const userId = String(user?._id || user?.id || user?.sub || '')
  if (!userId) {
    return { ok: false, status: 401, body: { success: false, message: 'Not authenticated' } }
  }

  // Belt-and-suspenders SUPERADMIN bypass — grants full access without a
  // UserPermission record. isSuperAdmin() above covers most cases; this
  // catches any edge where role normalization hasn't propagated to the
  // isSuperAdmin check (e.g. old JWTs with non-array role field).
  if (Array.isArray(user.roles) && user.roles.includes('SUPERADMIN')) {
    return { ok: true, via: 'superadmin-role', context: { permissionScope: 'ALL', permissionAccess: 'FULL' } }
  }

  const perm = await UserPermission.findOne({ userId }).lean()

  if (!perm) {
    return { ok: false, status: 403, body: { success: false, message: 'Access not granted', module, required: minAccess } }
  }

  const mod = (perm.modules as any)[module]
  if (!mod || mod.access === 'NONE') {
    return { ok: false, status: 403, body: { success: false, message: 'Module access not granted', module, required: minAccess } }
  }

  if (!hasAccess(mod.access, minAccess)) {
    return {
      ok: false,
      status: 403,
      body: { success: false, message: 'Insufficient access level', module, required: minAccess, actual: mod.access },
    }
  }

  return {
    ok: true,
    via: 'grant',
    context: { permissionScope: mod.scope, permissionAccess: mod.access, permissionLevel: perm.level?.code || 'L1' },
  }
}

/** Stamp an admitted decision's context on req, exactly as requirePermission does. */
export function applyPermissionContext(req: Request, d: Extract<PermissionDecision, { ok: true }>): void {
  req.permissionScope = d.context.permissionScope
  req.permissionAccess = d.context.permissionAccess
  if (d.context.permissionLevel !== undefined) req.permissionLevel = d.context.permissionLevel
}

export function requirePermission(
  module: string,
  minAccess: 'READ' | 'WRITE' | 'FULL'
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const d = await decideModulePermission(req, module, minAccess)
    if (!d.ok) {
      const refused = d as Extract<PermissionDecision, { ok: false }>
      return res.status(refused.status).json(refused.body)
    }
    if (d.via === 'superadmin-role') {
      const user = (req as any).user
      logger.info('SUPERADMIN bypass: permission check skipped', {
        userId: String(user?._id || user?.id || user?.sub || ''),
        module,
        minAccess,
        email: user.email,
      })
    }
    // Attach permission context to request
    applyPermissionContext(req, d as Extract<PermissionDecision, { ok: true }>)
    next()
  }
}
