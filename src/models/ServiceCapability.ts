// apps/backend/src/models/ServiceCapability.ts
import mongoose, { Schema, InferSchemaType } from "mongoose";

/**
 * Single collection for both Vendor + Business service mappings.
 * We key by ownerType + ownerId + kind, and store simple meta.
 */

const ServiceCapabilitySchema = new Schema(
  {
    ownerType: {
      type: String,
      enum: ["VENDOR", "BUSINESS"],
      required: true,
    },
    ownerId: {
      type: String,
      required: true,
      index: true,
    },
    kind: {
      type: String,
      required: true,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    meta: {
      notes: { type: String },
      priorityLevel: { type: Number },
      destinations: [{ type: String }],
      visaCountries: [{ type: String }],
      maxGroupSize: { type: Number },
    },
  },
  {
    timestamps: true,
  },
);

// Ensure one record per ownerType + ownerId + kind
ServiceCapabilitySchema.index(
  { ownerType: 1, ownerId: 1, kind: 1 },
  { unique: true },
);

export type ServiceCapabilityDoc = InferSchemaType<
  typeof ServiceCapabilitySchema
> & {
  _id: mongoose.Types.ObjectId;
};

const ServiceCapability = (mongoose.models.ServiceCapability ||
  mongoose.model<ServiceCapabilityDoc>(
    "ServiceCapability",
    ServiceCapabilitySchema,
  )) as mongoose.Model<ServiceCapabilityDoc>;

export default ServiceCapability;
