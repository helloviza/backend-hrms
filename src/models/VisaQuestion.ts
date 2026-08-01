// apps/backend/src/models/VisaQuestion.ts
//
// Phase 10a — global (NOT workspace-scoped) reference data: the shared
// questionnaire bank (task brief §7). USA/UK/France/Canada each have their
// own questionnaire; UAE/Laos/China do not — but the QUESTIONS repeat
// heavily across the ones that do (marital status, employment history,
// prior refusals, who is paying, countries visited, parents' details), so
// this is one bank every VisaRule.questions[] selects from by `code`,
// rather than each rule re-declaring its own copy.
//
// Conditional follow-ups (task brief's own example: "have you been refused
// a visa" -> country, date, reason) are modelled as `followUps`: when the
// answer to THIS question equals a trigger value, the listed follow-up
// question codes are also asked. Follow-up questions are ordinary bank
// entries themselves (no separate "follow-up question" type) — a question
// can be any rule's top-level question AND someone else's follow-up.
//
// Schema only — nothing here builds the form or accepts an answer
// submission route; see VisaApplication.ts's questionnaireAnswers for where
// an answer eventually lands.
import mongoose, { Schema, type Document, type Model } from "mongoose";

export const VISA_QUESTION_ANSWER_TYPES = ["BOOLEAN", "TEXT", "DATE", "SELECT", "COUNTRY"] as const;
export type VisaQuestionAnswerType = (typeof VISA_QUESTION_ANSWER_TYPES)[number];

export interface VisaQuestionFollowUp {
  whenAnswerEquals: unknown; // Mixed — compared against the parent question's answer
  questionCodes: string[]; // VisaQuestion.code refs to ask when the trigger matches
}

export interface VisaQuestionDocument extends Document {
  code: string; // stable, e.g. "PRIOR_VISA_REFUSAL" — unique
  prompt: string;
  answerType: VisaQuestionAnswerType;
  options: string[]; // only meaningful when answerType === "SELECT"
  category?: string; // free-text grouping for questionnaire display, e.g. "TRAVEL_HISTORY"
  followUps: VisaQuestionFollowUp[];
  isActive: boolean;

  // Provenance marker — see VisaDocumentType.seedSource's identical
  // convention. Set only at creation, never overwritten on update.
  seedSource?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

const VisaQuestionFollowUpSchema = new Schema<VisaQuestionFollowUp>(
  {
    whenAnswerEquals: { type: Schema.Types.Mixed, required: true },
    questionCodes: { type: [String], required: true, default: [] },
  },
  { _id: false },
);

const VisaQuestionSchema = new Schema<VisaQuestionDocument>(
  {
    code: { type: String, required: true, trim: true, uppercase: true },
    prompt: { type: String, required: true, trim: true },
    answerType: { type: String, enum: VISA_QUESTION_ANSWER_TYPES, required: true },
    options: { type: [String], default: [] },
    category: { type: String, trim: true },
    followUps: { type: [VisaQuestionFollowUpSchema], default: [] },
    isActive: { type: Boolean, default: true },
    seedSource: { type: String, trim: true },
  },
  { timestamps: true },
);

VisaQuestionSchema.index({ code: 1 }, { unique: true });
VisaQuestionSchema.index({ category: 1 });

const VisaQuestion: Model<VisaQuestionDocument> =
  mongoose.models.VisaQuestion || mongoose.model<VisaQuestionDocument>("VisaQuestion", VisaQuestionSchema);

export default VisaQuestion;
