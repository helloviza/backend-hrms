// apps/backend/src/routes/trainingProgress.ts
//
// PUT /api/training/progress/:module — the caller saves THEIR OWN Learning Hub
// progress for one module. Mounted in server.ts as
//   app.use("/api/training/progress", requireAuth, requireWorkspace, requireHouse, trainingProgressRouter)
// — the same HOUSE-only gate chain as /api/training (training is HOUSE-only).
//
// The body is the record a deck writes to localStorage (see the shared PT
// block in src/training/*.html): {total,maxSlide,lastSlide,viewed,viewedIdx,
// completed,startedAt,updatedAt,completedAt}. pages/learning/LearningHub.tsx
// forwards it here (live saves, coalesced) and for the one-time "sync this
// browser" catch-up.
//
// Own row only: the row is keyed by the TOKEN's user id; any userId in the
// body is ignored, so nobody can write someone else's progress.
//
// One atomic upsert (aggregation-pipeline update), so concurrent saves from
// two tabs or devices can't undo each other. Invariants:
//   • never backwards — total / maxSlide / updatedAt take the max, the viewed
//     slide set is a union, so re-sending an older record changes nothing;
//   • never un-completed — completed stays true once true; completedAt and
//     startedAt keep the earliest value;
//   • lastSlide (the resume point) follows whichever record is newer.
// Re-PUTting the same record is therefore idempotent — which is what makes
// the sync button safe to press repeatedly.
import { Router } from "express";
import mongoose from "mongoose";
import TrainingProgress from "../models/TrainingProgress.js";
import { userIdOf } from "../services/expense.access.js";
import logger from "../utils/logger.js";

const router = Router();

const MODULE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_SLIDES = 2000;
const EPOCH = new Date(0);

function int(v: unknown, max: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0;
}

/** ISO/Date → Date, or null. A learner clock far in the future is capped at now. */
function when(v: unknown, now: Date): Date | null {
  if (v == null || v === "") return null;
  const d = new Date(v as any);
  if (isNaN(d.getTime())) return null;
  return d.getTime() > now.getTime() + 5 * 60_000 ? now : d;
}

export interface CleanProgress {
  total: number;
  maxSlide: number;
  lastSlide: number;
  viewed: number;
  viewedSlides: number[];
  completed: boolean;
  startedAt: Date | null;
  updatedAt: Date | null;
  completedAt: Date | null;
}

/** Sanitize a deck record. Pure; exported for tests. */
export function cleanProgress(body: any, now = new Date()): CleanProgress {
  const b = body && typeof body === "object" ? body : {};
  const total = int(b.total, MAX_SLIDES);
  const cap = total > 0 ? total - 1 : MAX_SLIDES;
  const idx = new Set<number>();
  const src = Array.isArray(b.viewedSlides) ? b.viewedSlides : b.viewedIdx && typeof b.viewedIdx === "object" ? Object.keys(b.viewedIdx) : [];
  for (const k of src) {
    const n = Math.floor(Number(k));
    if (Number.isFinite(n) && n >= 0 && n <= cap) idx.add(n);
    if (idx.size >= MAX_SLIDES) break;
  }
  const viewedSlides = [...idx].sort((x, y) => x - y);
  const completed = b.completed === true;
  const updatedAt = when(b.updatedAt, now);
  return {
    total,
    maxSlide: Math.min(int(b.maxSlide, MAX_SLIDES), cap),
    lastSlide: Math.min(int(b.lastSlide, MAX_SLIDES), cap),
    viewed: Math.min(Math.max(int(b.viewed, MAX_SLIDES), viewedSlides.length), total || MAX_SLIDES),
    viewedSlides,
    completed,
    startedAt: when(b.startedAt, now),
    updatedAt,
    completedAt: completed ? when(b.completedAt, now) ?? updatedAt ?? now : null,
  };
}

/** The atomic merge — see the invariants in the header. */
function mergePipeline(p: CleanProgress, workspaceId: mongoose.Types.ObjectId | null) {
  return [
    {
      $set: {
        workspaceId: { $ifNull: ["$workspaceId", workspaceId] },
        total: { $max: ["$total", p.total] },
        maxSlide: { $max: ["$maxSlide", p.maxSlide] },
        lastSlide: {
          $cond: [
            { $gte: [p.updatedAt ?? EPOCH, { $ifNull: ["$updatedAt", EPOCH] }] },
            p.lastSlide,
            { $ifNull: ["$lastSlide", p.lastSlide] },
          ],
        },
        viewedSlides: { $setUnion: [{ $ifNull: ["$viewedSlides", []] }, { $literal: p.viewedSlides }] },
        completed: { $or: [{ $eq: ["$completed", true] }, p.completed] },
        // $min/$max ignore null and missing, so an absent side never wins.
        completedAt: { $min: ["$completedAt", p.completedAt] },
        startedAt: { $min: ["$startedAt", p.startedAt] },
        updatedAt: { $max: ["$updatedAt", p.updatedAt] },
        syncedAt: "$$NOW",
      },
    },
    { $set: { viewed: { $max: [{ $size: "$viewedSlides" }, "$viewed", p.viewed] } } },
  ];
}

function view(doc: any) {
  return {
    module: doc.module,
    total: doc.total,
    maxSlide: doc.maxSlide,
    lastSlide: doc.lastSlide,
    viewed: doc.viewed,
    completed: !!doc.completed,
    startedAt: doc.startedAt ?? null,
    updatedAt: doc.updatedAt ?? null,
    completedAt: doc.completedAt ?? null,
  };
}

router.put("/:module", async (req: any, res: any) => {
  try {
    const module = String(req.params.module || "");
    if (!MODULE_RE.test(module)) return res.status(400).json({ error: "Invalid module id" });

    const uid = userIdOf(req.user);
    if (!mongoose.isValidObjectId(uid)) return res.status(400).json({ error: "No user id on the session" });
    const userId = new mongoose.Types.ObjectId(uid);
    const ws = req.workspaceObjectId;
    const workspaceId = ws && mongoose.isValidObjectId(ws) ? new mongoose.Types.ObjectId(String(ws)) : null;

    const pipeline = mergePipeline(cleanProgress(req.body), workspaceId);
    const filter = { userId, module };
    const opts = { upsert: true, returnDocument: "after" as const };
    let doc: any;
    try {
      doc = await TrainingProgress.collection.findOneAndUpdate(filter, pipeline, opts);
    } catch (err: any) {
      // Two first-ever saves racing: one insert wins the unique index, the
      // loser retries as a plain update of the row that now exists.
      if (err?.code !== 11000) throw err;
      doc = await TrainingProgress.collection.findOneAndUpdate(filter, pipeline, opts);
    }
    return res.json({ ok: true, progress: view(doc) });
  } catch (err: any) {
    logger.error("training progress PUT error", { err: err?.message });
    return res.status(500).json({ error: "Could not save progress" });
  }
});

export default router;
