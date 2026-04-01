import { Request, Response, NextFunction } from "express";
export function audit(tag: string) {
  return (req: Request, _res: Response, next: NextFunction) => {

    next();
  };
}
