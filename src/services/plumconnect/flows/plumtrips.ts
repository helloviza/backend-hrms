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

// Track C: copy lives in the store under plumtrips.* (messages.ts).
const byName = ({ previousAnswer }: { previousAnswer: string }) => ({ name: previousAnswer });

export const plumtripsFlow: QualificationFlow = {
  businessLine: "plumtrips",
  welcome: { key: "plumtrips.welcome", withHeadline: "plumtrips.welcome_headline" },
  questions: [
    {
      id: "ask_name",
      ask: { key: "plumtrips.welcome" },
      askAgain: { key: "plumtrips.ask_name_again" },
      parse: (text) => {
        const name = parseName(text);
        return name ? { display: name, set: { contactName: name } } : null;
      },
    },
    {
      id: "ask_company",
      ask: { key: "plumtrips.ask_company", vars: byName },
      askAgain: { key: "plumtrips.ask_company_again" },
      parse: (text) => {
        const company = parseCompany(text);
        return company ? { display: company, set: { companyName: company } } : null;
      },
    },
    {
      id: "ask_travellers",
      ask: { key: "plumtrips.ask_travellers" },
      askAgain: { key: "plumtrips.ask_travellers_again" },
      parse: (text) => {
        const n = parseCount(text);
        return n === null ? null : { display: String(n), set: { companySize: companySizeBucket(n), "travelRequirement.travellerCount": n } };
      },
      keepOnGiveUp: (text) => ({ "travelRequirement.notes": `Travelling employees (as typed): ${sanitize(text, 200)}` }),
    },
    {
      id: "ask_trips",
      ask: { key: "plumtrips.ask_trips" },
      askAgain: { key: "plumtrips.ask_trips_again" },
      parse: (text) => {
        const n = parseCount(text);
        return n === null ? null : { display: String(n), set: { "travelRequirement.notes": `Approx trips per month: ${n}` } };
      },
      keepOnGiveUp: (text) => ({ "travelRequirement.notes": `Trips per month (as typed): ${sanitize(text, 200)}` }),
    },
  ],
  handover: "plumtrips.handover",
  handoverUnparsed: "plumtrips.handover_unparsed",
};
