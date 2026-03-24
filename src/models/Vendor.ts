// apps/backend/src/models/Vendor.ts
import { Schema, model, Document } from "mongoose";

interface IVendor extends Document {
  name?: string;
  vendorCode?: string;
  email?: string;
  phone?: string;
  type?: string;
  kycDocs?: Array<{ key?: string; name?: string }>;
  status?: string;
  businessAssociations?: string[];
  services?: {
    flights?: { enabled?: boolean; notes?: string };
    hotels?: { enabled?: boolean; notes?: string };
    cabs?: { enabled?: boolean; notes?: string };
    forex?: { enabled?: boolean; notes?: string };
    esims?: { enabled?: boolean; notes?: string };
    corporateGifting?: { enabled?: boolean; notes?: string };
    decor?: { enabled?: boolean; notes?: string };
    other?: { enabled?: boolean; notes?: string };
    visa?: { enabled?: boolean; notes?: string; visaCountries?: string[]; tatInDays?: number };
    miceEvents?: { enabled?: boolean; notes?: string; eventTypes?: string[]; maxGroupSize?: number };
    holidays?: { enabled?: boolean; notes?: string; destinations?: string[]; minPax?: number; maxPax?: number };
  };
  ownerId?: Schema.Types.ObjectId;
  onboardingId?: Schema.Types.ObjectId;
  onboardingSnapshot?: any;
  accountTeam?: any;
}

// Core Plumtrips verticals you mentioned
const BUSINESS_ASSOCIATIONS = [
  "FLIGHTS",
  "HOTELS",
  "VISA",
  "MICE_EVENTS",
  "CABS",
  "FOREX",
  "ESIMS",
  "HOLIDAYS",
  "CORPORATE_GIFTING",
  "DECOR",
  "OTHER",
] as const;

function normalizeBusinessAssociation(raw: any): string | null {
  if (!raw) return null;
  const v = String(raw).trim().toUpperCase();

  switch (v) {
    case "FLIGHT":
    case "FLIGHTS":
      return "FLIGHTS";
    case "HOTEL":
    case "HOTELS":
      return "HOTELS";
    case "VISA":
      return "VISA";
    case "MICE":
    case "MICE & EVENTS":
    case "MICE_EVENTS":
    case "EVENTS":
    case "MICE/EVENTS":
      return "MICE_EVENTS";
    case "CAB":
    case "CABS":
    case "TAXI":
    case "GROUND":
    case "GROUND_TRANSPORT":
      return "CABS";
    case "FOREX":
    case "FX":
    case "FOREIGN_EXCHANGE":
      return "FOREX";
    case "ESIM":
    case "ESIMS":
    case "E-SIM":
    case "E-SIMS":
      return "ESIMS";
    case "HOLIDAY":
    case "HOLIDAYS":
    case "PACKAGES":
      return "HOLIDAYS";
    case "CORPORATE_GIFTING":
    case "GIFTING":
    case "CORP_GIFTING":
    case "GIFTS":
      return "CORPORATE_GIFTING";
    case "DECOR":
    case "DÉCOR":
    case "DECORATION":
    case "EVENT_DECOR":
      return "DECOR";
    case "OTHER":
    default:
      return "OTHER";
  }
}

const SimpleServiceSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    notes: { type: String, trim: true },
  },
  { _id: false },
);

const VisaServiceSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    notes: { type: String, trim: true },
    visaCountries: [{ type: String, trim: true }],
    tatInDays: { type: Number, min: 0 },
  },
  { _id: false },
);

const MiceServiceSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    notes: { type: String, trim: true },
    eventTypes: [{ type: String, trim: true }],
    maxGroupSize: { type: Number, min: 0 },
  },
  { _id: false },
);

const HolidayServiceSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    notes: { type: String, trim: true },
    destinations: [{ type: String, trim: true }],
    minPax: { type: Number, min: 0 },
    maxPax: { type: Number, min: 0 },
  },
  { _id: false },
);

const VendorSchema = new Schema<IVendor>(
  {
    name: { type: String, trim: true },

    vendorCode: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      index: true,
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
    },

    phone: { type: String, trim: true },

    type: {
      type: String,
      enum: ["HOTEL", "CAB", "TOUR", "FLIGHT", "OTHER"],
      default: "OTHER",
      set: (v: string) => (v ? String(v).toUpperCase() : "OTHER"),
    },

    kycDocs: [
      {
        key: { type: String, trim: true },
        name: { type: String, trim: true },
      },
    ],

    status: {
      type: String,
      enum: ["NEW", "SHORTLISTED", "APPROVED", "REJECTED"],
      default: "NEW",
      set: (v: string) => (v ? String(v).toUpperCase() : "NEW"),
    },

    businessAssociations: {
      type: [String],
      enum: BUSINESS_ASSOCIATIONS,
      default: ["OTHER"],
      set: (value: any) => {
        const list = Array.isArray(value) ? value : value ? [value] : [];
        const mapped = list
          .map((v) => normalizeBusinessAssociation(v))
          .filter((v): v is string => !!v);
        return mapped.length ? mapped : ["OTHER"];
      },
    },

    services: {
      flights: { type: SimpleServiceSchema, default: () => ({}) },
      hotels: { type: SimpleServiceSchema, default: () => ({}) },
      cabs: { type: SimpleServiceSchema, default: () => ({}) },
      forex: { type: SimpleServiceSchema, default: () => ({}) },
      esims: { type: SimpleServiceSchema, default: () => ({}) },
      corporateGifting: { type: SimpleServiceSchema, default: () => ({}) },
      decor: { type: SimpleServiceSchema, default: () => ({}) },
      other: { type: SimpleServiceSchema, default: () => ({}) },
      visa: { type: VisaServiceSchema, default: () => ({}) },
      miceEvents: { type: MiceServiceSchema, default: () => ({}) },
      holidays: { type: HolidayServiceSchema, default: () => ({}) },
    },

    ownerId: { type: Schema.Types.ObjectId, ref: "User" },

    onboardingId: { type: Schema.Types.ObjectId, ref: "Onboarding" },

    accountTeam: {
      accountManager: {
        userId: { type: Schema.Types.ObjectId, ref: "User" },
        name: { type: String },
        email: { type: String },
        phone: { type: String },
      },
      escalationManager: {
        userId: { type: Schema.Types.ObjectId, ref: "User" },
        name: { type: String },
        email: { type: String },
        phone: { type: String },
      },
      supportContact: {
        userId: { type: Schema.Types.ObjectId, ref: "User" },
        name: { type: String },
        email: { type: String },
        phone: { type: String },
      },
    },

    // ✅ FIXED & VALID
    onboardingSnapshot: {
      type: Schema.Types.Mixed,
    },
  },
  { timestamps: true },
);


VendorSchema.methods.toJSON = function () {
  const obj: any = this.toObject();

  if (obj.type) obj.type = String(obj.type).toUpperCase();
  if (obj.status) obj.status = String(obj.status).toUpperCase();

  if (Array.isArray(obj.businessAssociations)) {
    obj.businessAssociations = obj.businessAssociations.map((v: string) =>
      String(v).toUpperCase(),
    );
  }

  return obj;
};

export default model<IVendor>("Vendor", VendorSchema);
