import type { Request, Response, NextFunction } from "express";

export function requireRoles(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const u = (req as any).user as { roles?: string[] };
    if (u?.roles?.includes("SUPERADMIN")) return next();
    if (!u?.roles?.some((r) => roles.includes(r))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}

export default requireRoles;
