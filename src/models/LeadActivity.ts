import mongoose, { Document, Schema } from "mongoose";

// ── Phase 1 / Slice 2 (CRM_V2_OPPORTUNITY): generalized IN PLACE ──────
// LeadActivity is the CRM's append-only timeline (PRD N). Slice 2 makes it
// polymorphic without touching a single existing row:
//
//   • `subject { type, id }` — what the activity is about. New rows written
//     under the flag carry it (LEAD or OPPORTUNITY today; CONTACT / COMPANY
//     reserved). Rows written before Slice 2 have only `leadId`.
//   • `leadId` is no longer required, but it is STILL WRITTEN for every
//     opportunity activity (the opportunity's source lead), so the lead
//     timeline, enrichLeads' latest-activity lookup and the ageing queries —
//     all keyed on leadId — keep seeing the whole story with no query change.
//   • Backfill-on-READ: activitySubject(row) aliases a legacy row to
//     { LEAD, leadId }. Hydrated docs get it via post("init"); lean rows and
//     aggregations call the helper. Nothing ever rewrites history (risk M1/M11).
//   • A row must carry leadId OR subject.id — enforced at validate, so a
//     half-written generalisation cannot produce an orphan.
//   • `demo` joins the type list so "a demo happened" survives the
//     retirement of the demo_scheduled stage (it becomes ENGAGED + a demo
//     activity). `meeting` stays for everything that is not a demo.
//   • `fromStatus/toStatus` record a LEAD-status transition in the new
//     taxonomy alongside `fromStage/toStage`, which keep the legacy values the
//     unchanged frontend renders. An OPPORTUNITY stage_change uses
//     fromStage/toStage with the pipeline's stage keys. Read every one of
//     them through crmTaxonomy.stageLabel().
//   • `automatedByRule` = "" for a human write; a rule/migration id otherwise.

export const ACTIVITY_TYPES = [
  "note", "call", "email", "meeting", "demo",
  "stage_change", "assignment", "follow_up",
  "won", "lost", "invite_sent",
] as const;
export type ActivityType = typeof ACTIVITY_TYPES[number];

export const ACTIVITY_SUBJECT_TYPES = ["LEAD", "OPPORTUNITY", "CONTACT", "COMPANY"] as const;
export type ActivitySubjectType = (typeof ACTIVITY_SUBJECT_TYPES)[number];

export interface ActivitySubject {
  type: ActivitySubjectType;
  id: mongoose.Types.ObjectId;
}

export interface LeadActivityDoc extends Document {
  leadId?: mongoose.Types.ObjectId | null;
  subject?: ActivitySubject | null;
  type: ActivityType;
  note: string;
  fromStage?: string;
  toStage?: string;
  fromStatus?: string;
  toStatus?: string;
  automatedByRule: string;
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  createdAt: Date;
}

const SubjectSchema = new Schema<ActivitySubject>(
  {
    type: { type: String, enum: ACTIVITY_SUBJECT_TYPES, required: true },
    id: { type: Schema.Types.ObjectId, required: true },
  },
  { _id: false },
);

const LeadActivitySchema = new Schema<LeadActivityDoc>(
  {
    leadId: { type: Schema.Types.ObjectId, ref: "Lead", default: null },
    subject: { type: SubjectSchema, default: undefined },
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    note: { type: String, default: "" },
    fromStage: { type: String },
    toStage: { type: String },
    fromStatus: { type: String },
    toStatus: { type: String },
    automatedByRule: { type: String, trim: true, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    createdByName: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

LeadActivitySchema.index({ leadId: 1, createdAt: -1 });
LeadActivitySchema.index({ "subject.type": 1, "subject.id": 1, createdAt: -1 }, { sparse: true });
LeadActivitySchema.index({ automatedByRule: 1 }, { sparse: true });

/** Backfill-on-read alias: the subject of any row, legacy or new. Pure —
 *  works on lean rows and aggregation output; never writes. */
export function activitySubject(row: {
  subject?: { type?: string; id?: any } | null;
  leadId?: any;
}): { type: ActivitySubjectType; id: mongoose.Types.ObjectId } | null {
  if (row?.subject?.type && row.subject.id) {
    return { type: row.subject.type as ActivitySubjectType, id: row.subject.id };
  }
  if (row?.leadId) return { type: "LEAD", id: row.leadId };
  return null;
}

// Hydrated legacy rows read as { LEAD, leadId } in memory only. post("init")
// runs after the raw doc is loaded; setting the path here does NOT mark it
// modified, so an accidental .save() of a history row still writes nothing new.
LeadActivitySchema.post("init", function (this: any) {
  if (!this.subject && this.leadId) {
    this.subject = { type: "LEAD", id: this.leadId };
    this.unmarkModified("subject");
  }
});

// A row is about SOMETHING: leadId or subject.id (two-step from risk M11 —
// fields first, then the validator, never a dropped leadId).
LeadActivitySchema.pre("validate", function (next) {
  if (!this.leadId && !(this.subject && this.subject.id)) {
    return next(new Error("LeadActivity needs leadId or subject.id"));
  }
  // A LEAD-subject row keeps leadId populated too, so every leadId-keyed
  // consumer keeps working without a query change.
  if (this.subject && this.subject.type === "LEAD" && !this.leadId) {
    this.leadId = this.subject.id;
  }
  next();
});

const LeadActivity = mongoose.model<LeadActivityDoc>("LeadActivity", LeadActivitySchema);
export default LeadActivity;
