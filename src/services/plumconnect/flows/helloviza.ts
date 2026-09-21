// apps/backend/src/services/plumconnect/flows/helloviza.ts
//
// PlumConnect Slice 6 — the helloviza (visa) qualification flow. Asked of a
// contact the Intent Engine routed to helloviza (enquiryType "visa", type
// "individual" — Slice 5), one question per turn:
//
//   ask_name ──▶ ask_country ──▶ ask_visa_type ──▶ done
//
// Lead mapping — EXISTING fields only:
//   name      → contactName
//   country   → travelRequirement.destination (as typed, capped) +
//               travelRequirement.destinationCountry (ISO-2 via
//               utils/countryCodes.ts when the table knows it, else "")
//   visa type → travelRequirement.notes "Visa type: Tourist" (a fixed
//               category from VISA_TYPES; the second miss keeps the text)

import type { QualificationFlow } from "./types.js";
import { parseDestination, parseName, parseVisaType, resolveCountry, sanitize } from "./parse.js";

// Track C: copy lives in the store under helloviza.* (messages.ts).
const byName = ({ previousAnswer }: { previousAnswer: string }) => ({ name: previousAnswer });

export const hellovizaFlow: QualificationFlow = {
  businessLine: "helloviza",
  welcome: { key: "helloviza.welcome", withHeadline: "helloviza.welcome_headline" },
  questions: [
    {
      id: "ask_name",
      ask: { key: "helloviza.welcome" },
      askAgain: { key: "helloviza.ask_name_again" },
      parse: (text) => {
        const name = parseName(text);
        return name ? { display: name, set: { contactName: name } } : null;
      },
    },
    {
      id: "ask_country",
      ask: { key: "helloviza.ask_country", vars: byName },
      askAgain: { key: "helloviza.ask_country_again" },
      parse: (text) => {
        const destination = parseDestination(text);
        if (!destination) return null;
        const country = resolveCountry(destination);
        return {
          display: country?.name ?? destination,
          set: { "travelRequirement.destination": destination, "travelRequirement.destinationCountry": country?.iso2 ?? "" },
        };
      },
    },
    {
      id: "ask_visa_type",
      ask: { key: "helloviza.ask_visa_type" },
      askAgain: { key: "helloviza.ask_visa_type_again" },
      parse: (text) => {
        const type = parseVisaType(text);
        return type ? { display: type, set: { "travelRequirement.notes": `Visa type: ${type}` } } : null;
      },
      keepOnGiveUp: (text) => ({ "travelRequirement.notes": `Visa type (as typed): ${sanitize(text, 200)}` }),
    },
  ],
  handover: "helloviza.handover",
  handoverUnparsed: "helloviza.handover_unparsed",
};
