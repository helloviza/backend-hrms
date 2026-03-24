import { Request, Response, NextFunction } from "express";
export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  console.error("[GLOBAL ERROR]", err?.type || "", err?.status || 500, err?.message, err?.stack?.slice(0, 300));
  if (res.headersSent) return;
  try {
    res.status(err?.status || 500).json({
      error: err?.message || "Server error",
      type: err?.type,
    });
  } catch {
    res.status(500).end(JSON.stringify({ error: "Server error" }));
  }
}
