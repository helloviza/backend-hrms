// apps/backend/src/models/ExpenseBand.ts
import mongoose, { Schema, type Document } from "mongoose";

export interface IExpenseBand extends Document {
  workspaceId: mongoose.Types.ObjectId;
  bandNumber: number;
  bandName: string;
  maxFlightFarePerPerson: number;
  maxHotelFarePerNight: number;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

const ExpenseBandSchema = new Schema<IExpenseBand>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "CustomerWorkspace",
      required: true,
    },
    bandNumber: {
      type: Number,
      required: true,
      min: 1,
      max: 10,
    },
    bandName: { type: String, default: "" },
    maxFlightFarePerPerson: { type: Number, default: 0 },
    maxHotelFarePerNight: { type: Number, default: 0 },
    currency: { type: String, default: "INR" },
  },
  { timestamps: true },
);

ExpenseBandSchema.index({ workspaceId: 1, bandNumber: 1 }, { unique: true });

const ExpenseBand =
  (mongoose.models.ExpenseBand as mongoose.Model<IExpenseBand>) ||
  mongoose.model<IExpenseBand>("ExpenseBand", ExpenseBandSchema);

export default ExpenseBand;
