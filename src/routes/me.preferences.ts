// apps/backend/src/routes/me.preferences.ts
//
// GET    /api/me/preferences/:key   → { ok, key, value | null }   (null = defaults)
// PUT    /api/me/preferences/:key   { value } → { ok, key, value }
// DELETE /api/me/preferences/:key   → { ok, key, value: null }    ("Reset to default")
//
// Always the signed-in user's own row — there is no user id in the path, so
// one user can never read or write another's preferences. Keys and value
// shapes are a closed list (models/UserPreference.ts PREFERENCE_KEYS).
import { Router } from "express";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import UserPreference, { PREFERENCE_KEYS } from "../models/UserPreference.js";

const router = Router();

function ownerId(req: Request): mongoose.Types.ObjectId | null {
  const u: any = (req as any).user;
  const id = String(u?._id || u?.sub || u?.id || "");
  return mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : null;
}

function keyOf(req: Request, res: Response): string | null {
  const key = String(req.params.key || "");
  if (!Object.prototype.hasOwnProperty.call(PREFERENCE_KEYS, key)) {
    res.status(404).json({ error: "Unknown preference" });
    return null;
  }
  return key;
}

router.get("/:key", async (req, res) => {
  const key = keyOf(req, res);
  if (!key) return;
  const userId = ownerId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in" });
  const row: any = await UserPreference.findOne({ userId, key }).select("value").lean();
  res.json({ ok: true, key, value: row?.value ?? null });
});

router.put("/:key", async (req, res) => {
  const key = keyOf(req, res);
  if (!key) return;
  const userId = ownerId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in" });
  const value = PREFERENCE_KEYS[key](req.body?.value);
  if (value == null) return res.status(400).json({ error: "Invalid preference value" });
  await UserPreference.updateOne({ userId, key }, { $set: { value } }, { upsert: true });
  res.json({ ok: true, key, value });
});

router.delete("/:key", async (req, res) => {
  const key = keyOf(req, res);
  if (!key) return;
  const userId = ownerId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in" });
  await UserPreference.deleteOne({ userId, key });
  res.json({ ok: true, key, value: null });
});

export default router;
