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
