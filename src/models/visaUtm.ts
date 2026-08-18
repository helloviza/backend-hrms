// apps/backend/src/models/visaUtm.ts
//
// THE FIVE UTM PARAMETERS, defined once and embedded in two places (the
// Master Sheet row and the ticket) — the same "one definition, N
// consumers" rule models/visaCaseSource.ts states for the channel enum.
//
// ══════════════════════════════════════════════════════════════════════
// ALL FIVE ARE CAPTURED, EVEN THOUGH ONLY ONE IS A COLUMN.
// ══════════════════════════════════════════════════════════════════════
// utm_source is what the sheet shows. The other four are stored anyway,
// because attribution is retrospective by nature: the question "which
// CREATIVE converted" is asked months after the click, and a parameter
// that was not captured at the click cannot be recovered afterwards. They
// cost five short strings per row.
//
// ── EMPTY IS THE EXPECTED STATE RIGHT NOW ────────────────────────────
// Nothing populates these until real campaign traffic arrives. A row with
// five empty strings is CORRECT and means "arrived without campaign
// tags" — direct, organic, or a link somebody typed. It is deliberately
// NOT null-vs-empty-vs-absent: one representation (empty string) so a
// reader never has to decide whether three different blanks mean three
// different things.
//
// ── WHY NOT A FREE-FORM OBJECT ───────────────────────────────────────
// A `Map` or bare object would accept whatever a query string contained,
// which is an unbounded write surface fed directly by a URL. Five named
// fields, trimmed and length-capped at the schema, is the whole contract.
import { Schema } from "mongoose";

export interface VisaUtm {
  source: string;
  medium: string;
  campaign: string;
  content: string;
  term: string;
}

/** The query-string names, in canonical order. */
export const UTM_PARAM_NAMES = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

/**
 * A cap that is generous for a real campaign tag and hostile to anyone
 * using the query string as storage. Applied at the schema so it holds
 * however the value arrives.
 */
const MAX_UTM_LENGTH = 200;

const utmField = { type: String, default: "", trim: true, maxlength: MAX_UTM_LENGTH } as const;

export const VisaUtmSchema = new Schema<VisaUtm>(
  {
    source: utmField,
    medium: utmField,
    campaign: utmField,
    content: utmField,
    term: utmField,
  },
  { _id: false },
);

/**
 * Normalise a client-supplied UTM payload into the stored shape.
 *
 * Accepts either the query-string names (utm_source) or the short field
 * names (source), because the browser reads one and the API speaks the
 * other, and making the client translate is how the two drift. Anything
 * unrecognised is dropped — this is a whitelist, and it is fed by a URL.
 */
export function normaliseUtm(input: any): VisaUtm {
  const pick = (short: string): string => {
    const raw = input?.[short] ?? input?.[`utm_${short}`] ?? "";
    return String(raw ?? "").trim().slice(0, MAX_UTM_LENGTH);
  };
  return {
    source: pick("source"),
    medium: pick("medium"),
    campaign: pick("campaign"),
    content: pick("content"),
    term: pick("term"),
  };
}

/** True when nothing was actually captured — used to avoid overwriting a
 *  real first-touch attribution with a later empty one. */
export function isUtmEmpty(utm: VisaUtm | null | undefined): boolean {
  if (!utm) return true;
  return !utm.source && !utm.medium && !utm.campaign && !utm.content && !utm.term;
}
