// apps/backend/src/routes/cstep.training.ts
//
// CSTEP Training — screenshot slide decks for the Travel & Claim module, the
// tenant-scoped twin of the HOUSE Learning Hub (routes/training.ts +
// routes/trainingProgress.ts). Mounted in server.ts as
//   app.use("/api/cstep/training", requireAuth, requireWorkspace, requireFeature("cstepEnabled"), cstepTrainingRouter)
// — the same chain as every other CSTEP router — so it exists only for a
// workspace with CSTEP switched on. The Team Training report is its own
// router (routes/cstep.trainingReport.ts), mounted before this one.
//
//   GET /progress           the caller's own deck progress rows (the host page
//                           folds them into the hub/decks' local records, so
//                           progress follows the learner across devices)
//   PUT /progress/:module   save the caller's own progress on one live deck
//   GET /:file              a hub/deck HTML file from the allowlist below
//
// Files: src/training/cstep/ (copied to dist/training/cstep by the build's
// `cp -r src/training dist/`). Self-contained HTML with screenshots inlined —
// internal material, so served behind auth, never from the frontend's
// public/. pages/cstep/training/CstepTrainingHub.tsx fetches a file with the
// Bearer token and renders it in a blob: iframe. An explicit allowlist, not
// a directory listing: a new deck is one line here plus its PATHS entry in
// the hub (the module list the progress route and report read).
//
// Progress PUT — the same contract as PUT /api/training/progress/:module:
// the body is the deck's localStorage record, sanitised by cleanProgress();
// the row is keyed by the TOKEN's user id and the request's workspace (any
// userId/workspaceId in the body is ignored); one atomic upsert keeps the
// invariants — never backwards (total / maxSlide / updatedAt take the max,
// viewed slides are a union), never un-completed, lastSlide follows the
// newer record — so re-sending a record is idempotent. Only a LIVE deck of
// the CSTEP registry is accepted; a HOUSE module id is refused.
import { Router } from "express";
import path from "node:path";
import mongoose from "mongoose";
import CstepTrainingProgress from "../models/cstep/CstepTrainingProgress.js";
import { cleanProgress, type CleanProgress } from "./trainingProgress.js";
import { CSTEP_TRAINING_DIR, liveCstepTrainingModules } from "../services/cstepTrainingModules.js";
import { ownerId } from "../utils/cstepAccess.js";

const router = Router();

const FILES: Record<string, string> = {
  "cstep-training-hub.html": "cstep-training-hub.html",
  "cstep-setup.html": "cstep-setup.html",
  "cstep-request.html": "cstep-request.html",
  "cstep-approve.html": "cstep-approve.html",
  "cstep-process.html": "cstep-process.html",
  "cstep-finance.html": "cstep-finance.html",
};

const MODULE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const EPOCH = new Date(0);

function callerOid(req: any): mongoose.Types.ObjectId | null {
  const uid = ownerId(req);
  return mongoose.isValidObjectId(uid) ? new mongoose.Types.ObjectId(uid) : null;
}

/** The atomic merge — see the invariants in the header. */
function mergePipeline(p: CleanProgress) {
  return [
    {
      $set: {
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
    viewedSlides: Array.isArray(doc.viewedSlides) ? doc.viewedSlides : [],
    completed: !!doc.completed,
    startedAt: doc.startedAt ?? null,
    updatedAt: doc.updatedAt ?? null,
    completedAt: doc.completedAt ?? null,
  };
}

router.get("/progress", async (req: any, res: any) => {
  try {
    const userId = callerOid(req);
    if (!userId) return res.status(400).json({ error: "No user id on the session" });
    const rows = await CstepTrainingProgress.find({ workspaceId: req.workspaceObjectId, userId }).lean();
    return res.json({ ok: true, progress: rows.map(view) });
  } catch (err: any) {
    console.error("[CSTEP training GET /progress]", err?.message);
    return res.status(500).json({ error: "Could not load your training progress" });
  }
});

router.put("/progress/:module", async (req: any, res: any) => {
  try {
    const module = String(req.params.module || "");
    if (!MODULE_RE.test(module)) return res.status(400).json({ error: "Invalid module id" });
    if (!liveCstepTrainingModules().some((m) => m.id === module)) return res.status(400).json({ error: "Unknown training deck" });

    const userId = callerOid(req);
    if (!userId) return res.status(400).json({ error: "No user id on the session" });
    const ws = req.workspaceObjectId;
    if (!ws || !mongoose.isValidObjectId(ws)) return res.status(400).json({ error: "No workspace on the session" });
    const workspaceId = new mongoose.Types.ObjectId(String(ws));

    const pipeline = mergePipeline(cleanProgress(req.body));
    const filter = { workspaceId, userId, module };
    const opts = { upsert: true, returnDocument: "after" as const };
    let doc: any;
    try {
      doc = await CstepTrainingProgress.collection.findOneAndUpdate(filter, pipeline, opts);
    } catch (err: any) {
      // Two first-ever saves racing: one insert wins the unique index, the
      // loser retries as a plain update of the row that now exists.
      if (err?.code !== 11000) throw err;
      doc = await CstepTrainingProgress.collection.findOneAndUpdate(filter, pipeline, opts);
    }
    return res.json({ ok: true, progress: view(doc) });
  } catch (err: any) {
    console.error("[CSTEP training PUT /progress]", err?.message);
    return res.status(500).json({ error: "Could not save progress" });
  }
});

router.get("/:file", (req: any, res: any) => {
  const file = FILES[String(req.params.file || "")];
  if (!file) return res.status(404).json({ ok: false, message: "Training file not found" });
  // Private to the session that fetched it — never cacheable by a shared cache.
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.sendFile(path.join(CSTEP_TRAINING_DIR, file), { headers: { "Content-Type": "text/html; charset=utf-8" } }, (err: any) => {
    if (err && !res.headersSent) res.status(404).json({ ok: false, message: "Training file not found" });
  });
});

export default router;
