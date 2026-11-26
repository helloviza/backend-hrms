import { Schema, model } from "mongoose";

const SBTConfigSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, default: {} },
    tboWalletEnabled: { type: Boolean, default: false },
    tboWalletMonthlyLimit: { type: Number, default: 0 },
    // SBT → Manual Booking link (docs/specs/sbt-to-manual-booking-spec.md P1),
    // on the "global" row. OFF = nothing links automatically (the manual
    // import still works). manualLinkEnabledAt is stamped the FIRST time it is
    // switched on: only SBT bookings made since then link automatically —
    // older ones are the P2 backfill's job.
    manualLinkEnabled: { type: Boolean, default: false },
    manualLinkEnabledAt: { type: Date, default: null },
    // "Invoice to" at SBT checkout (spec §3.7, P4), on the "global" row. OFF =
    // the checkout shows no Invoice-to block and stores no bill-to: bookings
    // are invoiced to the company, as before.
    invoiceToEnabled: { type: Boolean, default: false },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true },
);

export default model("SBTConfig", SBTConfigSchema);
