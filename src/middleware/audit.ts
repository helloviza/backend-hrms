import { Request, Response, NextFunction } from "express";
export function audit(tag: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    console.log(`[AUDIT] ${tag}`, {
      path: req.path,
      by: (req as any).user?.sub,
      body: req.body,
    });
    next();
  };
}
