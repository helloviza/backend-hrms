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

const COPY = {
  welcome: (headline: string) =>
    `Hi! Thanks for reaching out to Helloviza${headline ? ` about "${headline}"` : ""}. To get started, what's your name?`,
  askNameAgain: "Sorry, I didn't catch that — what's your name?",
  askCountry: (name: string) => `Nice to meet you, ${name}! Which country do you need a visa for?`,
  askCountryAgain: "Which country is the visa for?",
  askVisaType: "Got it. What type of visa is it — tourist, business, student, work, transit or medical?",
  askVisaTypeAgain: "Is that a tourist, business, student, work, transit or medical visa?",
  handover: (name: string) => `Perfect, ${name}. A Helloviza visa expert will be with you shortly.`,
  handoverUnparsed: "Thanks — a Helloviza visa expert will pick this up with you shortly.",
};

export const hellovizaFlow: QualificationFlow = {
  businessLine: "helloviza",
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
      id: "ask_country",
      ask: COPY.askCountry,
      askAgain: COPY.askCountryAgain,
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
      ask: () => COPY.askVisaType,
      askAgain: COPY.askVisaTypeAgain,
      parse: (text) => {
        const type = parseVisaType(text);
        return type ? { display: type, set: { "travelRequirement.notes": `Visa type: ${type}` } } : null;
      },
      keepOnGiveUp: (text) => ({ "travelRequirement.notes": `Visa type (as typed): ${sanitize(text, 200)}` }),
    },
  ],
  handover: COPY.handover,
  handoverUnparsed: COPY.handoverUnparsed,
};
