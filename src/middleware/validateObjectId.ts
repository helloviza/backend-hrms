import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";

export const validateObjectId = (...params: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    for (const param of params) {
      const id = req.params[param];
      if (id && !mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: `Invalid ${param} format` });
      }
    }
    next();
  };
};
