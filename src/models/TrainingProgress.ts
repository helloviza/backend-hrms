// apps/backend/src/models/TrainingProgress.ts
//
// Learning Hub progress, server-side: ONE row per learner per module, keyed by
// User._id — the same id pages/learning/LearningHub.tsx injects as the
// learner id, so the decks' localStorage records and these rows describe the
// same person with no id-space join.
//
// The fields mirror the record the decks write to localStorage
// ({module,total,maxSlide,lastSlide,viewed,completed,startedAt,updatedAt,
// completedAt}); `viewedSlides` replaces the deck's `viewedIdx` map with a
// plain index list so progress from several devices can be merged as a union.
// `updatedAt` is the LEARNER's last activity (from the deck), not a write
// timestamp — hence timestamps:false and a separate `syncedAt`.
//
// Written only by routes/trainingProgress.ts, whose update keeps two
// invariants: progress never moves backwards, and a completed module never
// becomes un-completed.
import mongoose, { Schema, type Document, type Types } from "mongoose";

export interface TrainingProgressDoc extends Document {
  userId: Types.ObjectId;
  workspaceId?: Types.ObjectId | null;
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

const TrainingProgressSchema = new Schema<TrainingProgressDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", default: null, index: true },
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
  { timestamps: false, collection: "trainingprogress" },
);

TrainingProgressSchema.index({ userId: 1, module: 1 }, { unique: true });
TrainingProgressSchema.index({ module: 1, completed: 1 });

const TrainingProgress =
  (mongoose.models.TrainingProgress as mongoose.Model<TrainingProgressDoc>) ||
  mongoose.model<TrainingProgressDoc>("TrainingProgress", TrainingProgressSchema);

export default TrainingProgress;
