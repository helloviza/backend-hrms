// apps/backend/src/config/visaQuestionBankSeed.ts
//
// Phase 10a's shared VisaQuestion bank seed data — task brief §7's own list
// of repeated questions: marital status, employment history, prior
// refusals (+ its conditional country/date/reason follow-ups), who is
// funding the trip, countries visited, parents' details.
//
// Originally defined inline in migrations/2026-08-02-visa-checklist-model-
// v2.ts; moved here (Phase 10c) so it can be imported as plain, side-
// effect-free data. That migration file's module scope calls main() on
// import (guarded only by NODE_ENV/VITEST checks meant for the test
// runner, not for a plain script) — a checklist-extraction script that
// imported VISA_QUESTION_BANK_SEED from it for read-only matching was
// discovered to be silently triggering that migration's own dry-run
// against the live database as an import side effect. This file has no
// such side effect; the migration script now imports its seed data from
// here instead of defining it, and re-exports it for its own test file's
// backward compatibility.
import type { VisaQuestionAnswerType, VisaQuestionFollowUp } from "../models/VisaQuestion.js";

export interface VisaQuestionSeed {
  code: string;
  prompt: string;
  answerType: VisaQuestionAnswerType;
  options?: string[];
  category: string;
  followUps: VisaQuestionFollowUp[];
}

export const VISA_QUESTION_BANK_SEED: readonly VisaQuestionSeed[] = [
  {
    code: "MARITAL_STATUS",
    prompt: "What is your marital status?",
    answerType: "SELECT",
    options: ["SINGLE", "MARRIED", "DIVORCED", "WIDOWED"],
    category: "PERSONAL",
    followUps: [],
  },
  {
    code: "EMPLOYMENT_HISTORY",
    prompt: "Describe your employment history for the last 5 years.",
    answerType: "TEXT",
    category: "EMPLOYMENT",
    followUps: [],
  },
  {
    code: "PRIOR_VISA_REFUSAL",
    prompt: "Have you ever been refused a visa by any country?",
    answerType: "BOOLEAN",
    category: "TRAVEL_HISTORY",
    followUps: [
      {
        whenAnswerEquals: true,
        questionCodes: ["PRIOR_VISA_REFUSAL_COUNTRY", "PRIOR_VISA_REFUSAL_DATE", "PRIOR_VISA_REFUSAL_REASON"],
      },
    ],
  },
  {
    code: "PRIOR_VISA_REFUSAL_COUNTRY",
    prompt: "Which country refused your visa?",
    answerType: "COUNTRY",
    category: "TRAVEL_HISTORY",
    followUps: [],
  },
  {
    code: "PRIOR_VISA_REFUSAL_DATE",
    prompt: "On what date were you refused?",
    answerType: "DATE",
    category: "TRAVEL_HISTORY",
    followUps: [],
  },
  {
    code: "PRIOR_VISA_REFUSAL_REASON",
    prompt: "What reason was given for the refusal?",
    answerType: "TEXT",
    category: "TRAVEL_HISTORY",
    followUps: [],
  },
  {
    code: "TRIP_FUNDED_BY",
    prompt: "Who is funding this trip?",
    answerType: "SELECT",
    options: ["SELF", "EMPLOYER", "SPONSOR", "OTHER"],
    category: "FINANCIAL",
    followUps: [],
  },
  {
    code: "COUNTRIES_VISITED_LAST_5_YEARS",
    prompt: "List the countries you have visited in the last 5 years.",
    answerType: "TEXT",
    category: "TRAVEL_HISTORY",
    followUps: [],
  },
  {
    code: "PARENTS_DETAILS",
    prompt: "Provide your parents' full names and dates of birth.",
    answerType: "TEXT",
    category: "PERSONAL",
    followUps: [],
  },

  // ── Added post-27-PDF bulk run (Phase 10c follow-up) — questions that
  // recurred across 9-12 of the 28 checklists under exact wording distinct
  // from any question already above (matchQuestion is exact-prompt match,
  // with no alias mechanism — see models/VisaQuestion.ts). Left out: the UK's
  // ~15-question employment/financial sub-flow (genuinely UK-specific, one
  // country) and Father's/Mother's name/DOB (3 and 2 countries respectively —
  // below the 4-country bar this batch used to decide what's shared vs a
  // one-off).
  {
    code: "EMPLOYMENT_STATUS",
    prompt: "What is your employment status?",
    answerType: "SELECT",
    options: ["EMPLOYED", "SELF_EMPLOYED", "UNEMPLOYED", "RETIRED", "OTHER"],
    category: "EMPLOYMENT",
    followUps: [],
  },
  // Two real, distinct exact phrasings for the same underlying "is a third
  // party paying" concept — kept as separate entries (not merged into one)
  // because VisaQuestion has no alias field; each independently recurs
  // across several checklists in its own exact wording.
  {
    code: "TRIP_COST_SPONSORED_BY_SOMEONE_ELSE",
    prompt: "Will someone else will be paying towards the cost of your trip?",
    answerType: "BOOLEAN",
    category: "FINANCIAL",
    followUps: [{ whenAnswerEquals: true, questionCodes: ["TRIP_FUNDED_BY"] }],
  },
  {
    code: "TRIP_COST_SPONSORED_BY_ANYONE",
    prompt: "Will anyone be paying towards the cost of your visit?",
    answerType: "BOOLEAN",
    category: "FINANCIAL",
    followUps: [{ whenAnswerEquals: true, questionCodes: ["TRIP_FUNDED_BY"] }],
  },
  // The five standard Schengen uniform-application-form questions — always
  // seen together, across the same 6 Schengen checklists (Czech Republic,
  // Denmark, Finland, Germany, Spain, Sweden). One shared set, not per-country
  // copies.
  {
    code: "SCHENGEN_OTHER_COUNTRIES_VISIT",
    prompt: "Are you visiting any other Schengen countries during your stay?",
    answerType: "BOOLEAN",
    category: "SCHENGEN",
    followUps: [],
  },
  {
    code: "SCHENGEN_FIRST_ENTRY_COUNTRY",
    prompt: "What is your first country of entry?",
    answerType: "COUNTRY",
    category: "SCHENGEN",
    followUps: [],
  },
  {
    code: "SCHENGEN_PRIOR_VISA_5YRS",
    prompt: "Have you been issued Schengen visa in the past 5 years?",
    answerType: "BOOLEAN",
    category: "SCHENGEN",
    followUps: [],
  },
  {
    code: "SCHENGEN_FINGERPRINTS_TAKEN",
    prompt: "Have your digital fingerprints previously been taken in connection with a previous application for a Schengen visa?",
    answerType: "BOOLEAN",
    category: "SCHENGEN",
    followUps: [],
  },
  {
    code: "SCHENGEN_STAY_DURATION",
    prompt: "How long are you planning to stay in Schengen area?",
    answerType: "TEXT",
    category: "SCHENGEN",
    followUps: [],
  },
] as const;
