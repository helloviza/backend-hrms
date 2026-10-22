import { Schema, model, type Document } from "mongoose";

/**
 * LoyaltySweepRun — one row per daily loyalty sweep (jobs/loyaltySweepCron.ts).
 * runKey ("daily:YYYY-MM-DD", IST date) is unique: the first server to insert
 * it owns that day's run, every other server's insert is refused and it
 * skips. The finished row is the checkpoint — counts and duration.
 */
export interface ILoyaltySweepRun extends Document {
  runKey: string;
  host: string;
  status: "RUNNING" | "DONE" | "FAILED";
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  accountsCreated: number;
  accountsReconciled: number;
  accountsSkipped: number;
  rowsWritten: number;
  errorCount: number;
  error?: string;
}

const LoyaltySweepRunSchema = new Schema<ILoyaltySweepRun>(
  {
    runKey: { type: String, required: true, unique: true },
    host: { type: String, default: "" },
    status: { type: String, enum: ["RUNNING", "DONE", "FAILED"], default: "RUNNING" },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
    accountsCreated: { type: Number, default: 0 },
    accountsReconciled: { type: Number, default: 0 },
    accountsSkipped: { type: Number, default: 0 },
    rowsWritten: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },
    error: { type: String },
  },
  { timestamps: false },
);

export default model<ILoyaltySweepRun>("LoyaltySweepRun", LoyaltySweepRunSchema);
