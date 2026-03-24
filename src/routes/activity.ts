import { Router } from "express";
import requireAuth from "../middleware/auth.js";
import UserPresence from "../models/UserPresence.js";

const r = Router();

r.use(requireAuth);

r.post("/", async (req, res, next) => {
  try {
    const userId = (req as any).user.sub;
    const { idle, idleDuration, timestamp } = req.body;

    let status: "ACTIVE" | "IDLE" | "OFFLINE";
    if (idle === false) {
      status = "ACTIVE";
    } else if (idle === true && idleDuration < 180) {
      status = "IDLE";
    } else {
      status = "OFFLINE";
    }

    await UserPresence.findOneAndUpdate(
      { userId },
      { status, lastActivity: new Date(timestamp), idleDuration },
      { upsert: true, new: true }
    );

    return res.json({ status: "ok" });
  } catch (err) {
    return next(err);
  }
});

export default r;
