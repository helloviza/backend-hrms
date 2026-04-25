import { Schema, model, type Document } from "mongoose";

export interface ITravelForm extends Document {
  workspaceId: Schema.Types.ObjectId;
  bookingId: Schema.Types.ObjectId | null;
  requestIds?: Schema.Types.ObjectId[];
  requestId?: Schema.Types.ObjectId | null; // legacy, kept for backward compat
  bookingType: "flight" | "hotel";
  formType: "domestic" | "international";
  status: "draft" | "submitted" | "approved" | "rejected";

  // Auto-populated from booking
  travelerName: string;
  travelerGender: "M" | "F" | "";
  origin: string;
  destination: string;
  departureDate: string;
  returnDate: string;
  departureTimeSlot: string;
  returnTimeSlot: string;
  modeOfTravel: string;
  transportRequirement: string;
  purposeOfTour: string;
  invoiceAmount: number;
  flightFare?: number;
  hotelFare?: number;

  // Domestic — user fills
  eventDates: string;
  accommodationRequirement: string;
  projectName: string;
  fundsAvailability: string;
  sponsorshipDetails: string;
  mealPreference: "Veg" | "NonVeg" | "";
  additionalDetails: string;

  // International — user fills
  designation: string;
  countriesVisited: string[];
  totalDaysAbsent: number;
  accommodationRequired: boolean;
  accommodationSuggestion: string;
  forexAdvance: string;
  sponsorshipAttached: boolean;
  briefJustification: string;
  expectedOutcome: string;
  travelExtended: boolean;
  personalHolidayDays: string;
  contactWhileTraveling: string;
  projectDebitability: string;
  internationalRoamingApproved: boolean;

  // Signatures
  requestorSignature: string;
  requestorSignatureDate: string;
  approverSignature: string;
  approverSignatureDate: string;

  travelerId?: string;

  // PDF
  pdfS3Key: string;
  pdfGeneratedAt?: Date;

  // Audit
  createdBy: Schema.Types.ObjectId;
  updatedBy: Schema.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const TravelFormSchema = new Schema<ITravelForm>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    bookingId: { type: Schema.Types.ObjectId, required: false, index: true, default: null },
    requestIds: [{ type: Schema.Types.ObjectId, ref: "SBTRequest" }],
    requestId: { type: Schema.Types.ObjectId, ref: "SBTRequest", required: false, default: null },
    bookingType: { type: String, enum: ["flight", "hotel"], required: true },
    formType: { type: String, enum: ["domestic", "international"], required: true },
    status: {
      type: String,
      enum: ["draft", "submitted", "approved", "rejected"],
      default: "draft",
      required: true,
    },

    travelerName: { type: String, default: "" },
    travelerGender: { type: String, enum: ["M", "F", "Male", "Female", ""], default: "" },
    origin: { type: String, default: "" },
    destination: { type: String, default: "" },
    departureDate: { type: String, default: "" },
    returnDate: { type: String, default: "" },
    departureTimeSlot: { type: String, default: "" },
    returnTimeSlot: { type: String, default: "" },
    modeOfTravel: { type: String, default: "" },
    transportRequirement: { type: String, default: "" },
    purposeOfTour: { type: String, default: "" },
    invoiceAmount: { type: Number, default: 0 },
    flightFare: { type: Number, default: 0 },
    hotelFare: { type: Number, default: 0 },

    eventDates: { type: String, default: "" },
    accommodationRequirement: { type: String, default: "" },
    projectName: { type: String, default: "" },
    fundsAvailability: { type: String, default: "" },
    sponsorshipDetails: { type: String, default: "" },
    mealPreference: { type: String, enum: ["Veg", "NonVeg", ""], default: "" },
    additionalDetails: { type: String, default: "" },

    designation: { type: String, default: "" },
    countriesVisited: { type: [String], default: [] },
    totalDaysAbsent: { type: Number, default: 0 },
    accommodationRequired: { type: Boolean, default: false },
    accommodationSuggestion: { type: String, default: "" },
    forexAdvance: { type: String, default: "" },
    sponsorshipAttached: { type: Boolean, default: false },
    briefJustification: { type: String, default: "" },
    expectedOutcome: { type: String, default: "" },
    travelExtended: { type: Boolean, default: false },
    personalHolidayDays: { type: String, default: "" },
    contactWhileTraveling: { type: String, default: "" },
    projectDebitability: { type: String, default: "" },
    internationalRoamingApproved: { type: Boolean, default: false },

    requestorSignature: { type: String, default: "" },
    requestorSignatureDate: { type: String, default: "" },
    approverSignature: { type: String, default: "" },
    approverSignatureDate: { type: String, default: "" },

    travelerId: { type: String, default: "" },

    pdfS3Key: { type: String, default: "" },
    pdfGeneratedAt: { type: Date },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

TravelFormSchema.index({ workspaceId: 1, bookingId: 1 });

export default model<ITravelForm>("TravelForm", TravelFormSchema);
