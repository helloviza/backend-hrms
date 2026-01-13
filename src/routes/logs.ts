import { Router } from "express";

const r = Router();

/**
 * GET /api/logs/recent
 * Returns the most recent activity logs for the dashboard.
 * Later, you can replace this with a Mongo aggregation from your audit collection.
 */
r.get("/recent", async (_req, res, next) => {
  try {
    // Temporary mock data — replace with real DB fetch later
    const logs = [
      { message: "Profile updated", date: new Date().toISOString() },
      { message: "Leave request submitted", date: new Date().toISOString() },
      { message: "Document uploaded", date: new Date().toISOString() },
    ];
    res.json(logs);
  } catch (err) {
    next(err);
  }
});

export default r;
