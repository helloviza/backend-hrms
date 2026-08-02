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
] as const;
