// apps/backend/src/models/cstep/CstepTrainingProgress.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepTrainingProgress
 * ---------------------
 * CSTEP Training deck progress: ONE row per learner per deck, per workspace —
 * the tenant-scoped twin of models/TrainingProgress.ts (the HOUSE Learning
 * Hub). Same shape, so the decks' localStorage record (the shared PT block in
 * src/training/cstep/*.html) maps field for field; `viewedSlides` replaces
 * the deck's `viewedIdx` map with a plain index list so progress from several
 * devices merges as a union. `updatedAt` is the LEARNER's last activity (from
 * the deck), not a write timestamp — hence timestamps:false and `syncedAt`.
 *
 * Written only by routes/cstep.training.ts, whose atomic update keeps the
 * same invariants as the HOUSE route: progress never moves backwards, a
 * completed deck never becomes un-completed, and a caller writes only their
 * own row (userId from the token, workspaceId from requireWorkspace).
 *
 * Its own collection: the guided-tour version (per-lesson status, removed)
 * used the default `csteptrainingprogresses` with a lessonKey unique index.
 */
export interface ICstepTrainingProgress extends Document {
  workspaceId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  module: string;
  total: number;
  maxSlide: number;
  lastSlide: number;
  viewedSlides: number[];
  viewed: number;
  completed: boolean;
  startedAt?: Date | null;
  updatedAt?: Date | null;
  completedAt?: Date | null;
  syncedAt?: Date;
}

const CstepTrainingProgressSchema = new Schema<ICstepTrainingProgress>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    module: { type: String, required: true, trim: true },
    total: { type: Number, default: 0 },
    maxSlide: { type: Number, default: 0 },
    lastSlide: { type: Number, default: 0 },
    viewedSlides: { type: [Number], default: undefined },
    viewed: { type: Number, default: 0 },
    completed: { type: Boolean, default: false },
    startedAt: { type: Date, default: null },
    updatedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    syncedAt: { type: Date },
  },
  { timestamps: false, collection: "csteptrainingdeckprogress" },
);

CstepTrainingProgressSchema.index({ workspaceId: 1, userId: 1, module: 1 }, { unique: true });
CstepTrainingProgressSchema.index({ workspaceId: 1, module: 1, completed: 1 });

CstepTrainingProgressSchema.plugin(workspaceScopePlugin);

const CstepTrainingProgress =
  (mongoose.models.CstepTrainingProgress as mongoose.Model<ICstepTrainingProgress>) ||
  mongoose.model<ICstepTrainingProgress>("CstepTrainingProgress", CstepTrainingProgressSchema);

export default CstepTrainingProgress;
