import { Router } from "express";
import requireAuth from "../middleware/auth.js";
import Meeting from "../models/Meeting.js";

const r = Router();

r.use(requireAuth);

r.post("/", async (req, res, next) => {
  try {
    const userId = (req as any).user.sub;
    const { title } = req.body;

    if (!title) {
      return res.status(400).json({ error: "title is required" });
    }

    const roomId = `plumtrips-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const meeting = await Meeting.create({
      roomId,
      title,
      createdBy: userId,
    });

    return res.json({ roomId: meeting.roomId, meetingUrl: `/meeting/${meeting.roomId}` });
  } catch (err) {
    return next(err);
  }
});

r.get("/:roomId", async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ roomId: req.params.roomId }).lean();
    if (!meeting) {
      return res.status(404).json({ error: "Meeting not found" });
    }
    return res.json(meeting);
  } catch (err) {
    return next(err);
  }
});

export default r;
