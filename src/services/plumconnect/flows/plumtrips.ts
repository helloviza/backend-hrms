// apps/backend/src/services/plumconnect/flows/plumtrips.ts
//
// PlumConnect Slice 6 — the plumtrips (corporate travel / sales)
// qualification flow. Asked of a contact the Intent Engine routed to
// plumtrips (enquiryType "corporate_account", type "company" — Slice 5), one
// question per turn:
//
//   ask_name ──▶ ask_company ──▶ ask_travellers ──▶ ask_trips ──▶ done
//
// Lead mapping — EXISTING fields only, nothing added to the schema:
//   name        → contactName
//   company     → companyName (denormalised; Company anchoring stays a
//                 sales-rep action — createLead() ran with an empty name)
//   travellers  → companySize (the COMPANY_SIZES bucket the CRM form uses)
//                 + travelRequirement.travellerCount (the number itself)
//   trips/month → travelRequirement.notes "Approx trips per month: N"
//                 (the Lead has no volume field; a dedicated one is a
//                 separate, additive schema decision — see the commit body)

import { COMPANY_SIZES } from "../../../models/Lead.js";
import type { QualificationFlow } from "./types.js";
import { parseCompany, parseCount, parseName, sanitize } from "./parse.js";

/** The CRM form's size bucket for a head-count. */
export function companySizeBucket(n: number): (typeof COMPANY_SIZES)[number] {
  if (n <= 10) return "1-10";
  if (n <= 50) return "11-50";
  if (n <= 200) return "51-200";
  if (n <= 500) return "201-500";
  return "500+";
}

const COPY = {
  welcome: (headline: string) =>
    `Hi! Thanks for reaching out to Plumtrips${headline ? ` about "${headline}"` : ""}. To get started, what's your name?`,
  askNameAgain: "Sorry, I didn't catch that — what's your name?",
  askCompany: (name: string) => `Nice to meet you, ${name}! Which company are you with?`,
  askCompanyAgain: "Which company or organisation is this for?",
  askTravellers: "Thanks. Roughly how many employees travel for work? (a number is fine, e.g. 50)",
  askTravellersAgain: "Could you give a rough number of travelling employees? e.g. 20",
  askTrips: "And roughly how many trips a month does the team take? (e.g. 10)",
  askTripsAgain: "A rough number of trips per month is fine, e.g. 5.",
  handover: (name: string) => `Perfect, ${name}. A Plumtrips corporate travel specialist will be with you shortly.`,
  handoverUnparsed: "Thanks — a Plumtrips corporate travel specialist will pick this up with you shortly.",
};

export const plumtripsFlow: QualificationFlow = {
  businessLine: "plumtrips",
  welcome: COPY.welcome,
  questions: [
    {
      id: "ask_name",
      ask: () => COPY.welcome(""),
      askAgain: COPY.askNameAgain,
      parse: (text) => {
        const name = parseName(text);
        return name ? { display: name, set: { contactName: name } } : null;
      },
    },
    {
      id: "ask_company",
      ask: COPY.askCompany,
      askAgain: COPY.askCompanyAgain,
      parse: (text) => {
        const company = parseCompany(text);
        return company ? { display: company, set: { companyName: company } } : null;
      },
    },
    {
      id: "ask_travellers",
      ask: () => COPY.askTravellers,
      askAgain: COPY.askTravellersAgain,
      parse: (text) => {
        const n = parseCount(text);
        return n === null ? null : { display: String(n), set: { companySize: companySizeBucket(n), "travelRequirement.travellerCount": n } };
      },
      keepOnGiveUp: (text) => ({ "travelRequirement.notes": `Travelling employees (as typed): ${sanitize(text, 200)}` }),
    },
    {
      id: "ask_trips",
      ask: () => COPY.askTrips,
      askAgain: COPY.askTripsAgain,
      parse: (text) => {
        const n = parseCount(text);
        return n === null ? null : { display: String(n), set: { "travelRequirement.notes": `Approx trips per month: ${n}` } };
      },
      keepOnGiveUp: (text) => ({ "travelRequirement.notes": `Trips per month (as typed): ${sanitize(text, 200)}` }),
    },
  ],
  handover: COPY.handover,
  handoverUnparsed: COPY.handoverUnparsed,
};
