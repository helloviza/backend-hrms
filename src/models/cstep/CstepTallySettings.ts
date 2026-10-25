// apps/backend/src/models/cstep/CstepTallySettings.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";
import { CSTEP_EXPENSE_CATEGORIES, type CstepExpenseCategory } from "./expenseCategories.js";

/**
 * CstepTallySettings
 * ------------------
 * One per workspace, CSTEP-Admin edited: what the Finance "Export to Tally"
 * sheet (routes/cstep.tally.ts) writes into Company Name / Voucher Type, and
 * which expense ledger a paid vendor line is debited to — by the vendor's
 * type (CstepVendorType), falling back to defaultLedger for a type with no
 * mapping. The credit side is always the vendor's own ledger (its name).
 *
 * Locations: the debit row's "Locations " column carries locationLabel (the
 * Tally cost-centre category, "Locations" unless changed) and "Location CC"
 * the code locationMap gives the line's location — the traveller's base
 * (TravellerProfile.workLocation) or the trip's destination, per
 * locationSource. A location with no entry goes out as its own text.
 *
 * reimbursement (Finance-a Stage 2): the reimbursement journal's ledgers.
 * Each settlement line's expense category (expenseCategories.ts) maps to an
 * expense ledger, with defaultLedger for a category that has none. The TAX
 * category goes to taxLedger (the IGST ledger) and is never in
 * categoryLedgerMap. advanceLedger is what an Expense Claim's advance is
 * cleared from. The employee side is either one control ledger with the
 * employee as its cost centre (CONTROL), or a ledger per employee named
 * from the traveller (PER_EMPLOYEE, by employeeLedgerName). A workspace
 * saved before Stage 2 has no reimbursement block; routes/cstep.tally.ts
 * reads the defaults below then.
 */
export const CSTEP_TALLY_LOCATION_SOURCES = ["BASE", "DESTINATION"] as const;
export type CstepTallyLocationSource = (typeof CSTEP_TALLY_LOCATION_SOURCES)[number];

export const CSTEP_TALLY_EMPLOYEE_LEDGER_MODES = ["CONTROL", "PER_EMPLOYEE"] as const;
export type CstepTallyEmployeeLedgerMode = (typeof CSTEP_TALLY_EMPLOYEE_LEDGER_MODES)[number];
/** A per-employee ledger's name: the traveller's name, their employee id, or "Name (ID)". */
export const CSTEP_TALLY_EMPLOYEE_LEDGER_NAMES = ["NAME", "EMPLOYEE_ID", "NAME_AND_ID"] as const;
export type CstepTallyEmployeeLedgerName = (typeof CSTEP_TALLY_EMPLOYEE_LEDGER_NAMES)[number];
export const CSTEP_TALLY_DEFAULT_CONTROL_LEDGER = "Staff Reimbursement Payable";

export interface ICstepTallyReimbursementSettings {
  defaultLedger: string;
  categoryLedgerMap: Array<{ category: CstepExpenseCategory; ledger: string }>;
  taxLedger: string;
  advanceLedger: string;
  employeeLedgerMode: CstepTallyEmployeeLedgerMode;
  controlLedger: string;
  employeeLedgerName: CstepTallyEmployeeLedgerName;
}

export interface ICstepTallySettings extends Document {
  workspaceId: mongoose.Types.ObjectId;
  companyName: string;
  voucherType: string;
  defaultLedger: string;
  ledgerMap: Array<{ vendorTypeId: mongoose.Types.ObjectId; ledger: string }>;
  locationLabel: string;
  locationSource: CstepTallyLocationSource;
  locationMap: Array<{ location: string; code: string }>;
  reimbursement?: ICstepTallyReimbursementSettings;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const CstepTallySettingsSchema = new Schema<ICstepTallySettings>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, unique: true },
    companyName: { type: String, trim: true, default: "" },
    voucherType: { type: String, trim: true, default: "Journal" },
    defaultLedger: { type: String, trim: true, default: "" },
    ledgerMap: {
      type: [
        {
          _id: false,
          vendorTypeId: { type: Schema.Types.ObjectId, ref: "CstepVendorType", required: true },
          ledger: { type: String, trim: true, required: true },
        },
      ],
      default: [],
    },
    locationLabel: { type: String, trim: true, default: "Locations" },
    locationSource: { type: String, enum: CSTEP_TALLY_LOCATION_SOURCES, default: "BASE" },
    locationMap: {
      type: [
        {
          _id: false,
          location: { type: String, trim: true, required: true },
          code: { type: String, trim: true, required: true },
        },
      ],
      default: [],
    },
    reimbursement: {
      type: new Schema<ICstepTallyReimbursementSettings>(
        {
          defaultLedger: { type: String, trim: true, default: "" },
          categoryLedgerMap: {
            type: [
              {
                _id: false,
                category: { type: String, enum: CSTEP_EXPENSE_CATEGORIES, required: true },
                ledger: { type: String, trim: true, required: true },
              },
            ],
            default: [],
          },
          taxLedger: { type: String, trim: true, default: "" },
          advanceLedger: { type: String, trim: true, default: "" },
          employeeLedgerMode: { type: String, enum: CSTEP_TALLY_EMPLOYEE_LEDGER_MODES, default: "CONTROL" },
          controlLedger: { type: String, trim: true, default: CSTEP_TALLY_DEFAULT_CONTROL_LEDGER },
          employeeLedgerName: { type: String, enum: CSTEP_TALLY_EMPLOYEE_LEDGER_NAMES, default: "NAME_AND_ID" },
        },
        { _id: false },
      ),
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

CstepTallySettingsSchema.plugin(workspaceScopePlugin);

const CstepTallySettings =
  (mongoose.models.CstepTallySettings as mongoose.Model<ICstepTallySettings>) ||
  mongoose.model<ICstepTallySettings>("CstepTallySettings", CstepTallySettingsSchema);

export default CstepTallySettings;
