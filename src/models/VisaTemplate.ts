// apps/backend/src/models/VisaTemplate.ts
//
// Phase 10a — global (NOT workspace-scoped) reference data: the downloadable
// form-template registry (task brief §6 — "eleven distinct templates across
// seven countries, heavily reused"). VisaRule.documentGroups[].templateCode
// (see VisaRule.ts) optionally references a row here by `code`.
//
// s3Key is nullable BY DESIGN — nothing uploads a template file yet in this
// phase ("Nothing uploads templates yet; this is the schema so the
// checklist can point at one"). A row with s3Key: null is a placeholder the
// checklist can already reference; a future upload step fills it in later
// without a schema change or re-pointing any VisaRule.
import mongoose, { Schema, type Document, type Model } from "mongoose";

export interface VisaTemplateDocument extends Document {
  code: string; // stable code, e.g. "SCHENGEN_VISA_APPLICATION_FORM" — unique
  name: string;
  description: string;
  s3Key: string | null; // null until the real file is uploaded
  applicableCountries: string[]; // ISO 3166-1 alpha-2 codes

  createdAt?: Date;
  updatedAt?: Date;
}

const VisaTemplateSchema = new Schema<VisaTemplateDocument>(
  {
    code: { type: String, required: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    s3Key: { type: String, default: null },
    applicableCountries: {
      type: [String],
      default: [],
      set: (values: string[]) => (values || []).map((v) => v.trim().toUpperCase()),
    },
  },
  { timestamps: true },
);

VisaTemplateSchema.index({ code: 1 }, { unique: true });
// "Which templates apply to this destination" — checklist rendering path.
VisaTemplateSchema.index({ applicableCountries: 1 });

const VisaTemplate: Model<VisaTemplateDocument> =
  mongoose.models.VisaTemplate || mongoose.model<VisaTemplateDocument>("VisaTemplate", VisaTemplateSchema);

export default VisaTemplate;
