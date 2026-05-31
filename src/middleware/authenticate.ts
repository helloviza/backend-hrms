// apps/backend/src/middleware/authenticate.ts
import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import { runWithDemoContext } from "../utils/demoContext.js";

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing token" });
  }
  const token = auth.split(" ")[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!);
    (req as any).user = payload;
    // Establish the request-scoped demo context (see utils/demoContext.ts).
    runWithDemoContext(
      {
        isDemoUser: (payload as any)?.isDemoUser === true,
        userId: (payload as any)?._id || (payload as any)?.sub,
        sessionId: (payload as any)?.sessionId,
      },
      () => next(),
    );
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}
