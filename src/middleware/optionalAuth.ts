// apps/backend/src/middleware/optionalAuth.ts
import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt.js";

/**
 * Optional auth:
 * - Never blocks request
 * - Attaches req.user only if token is valid
 * - Silent failure for guests
 */
export function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  try {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      (req as any).user = null;
      return next();
    }

    const token = auth.slice("Bearer ".length).trim();
    if (!token) {
      (req as any).user = null;
      return next();
    }

    const payload = verifyToken(token);
    (req as any).user = payload ?? null;
    return next();
  } catch {
    (req as any).user = null;
    return next();
  }
}

export default optionalAuth;