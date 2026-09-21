// apps/backend/src/services/plumconnect/flows/concierge.ts
//
// PlumConnect Slice 6 — the concierge (holiday) qualification flow. This is
// the Slice 3c bot RELOCATED, not redesigned: the same three questions in
// the same order with the same copy, the same parsers, the same Lead writes
// (contactName; travelRequirement.destination; travelRequirement.travelDate
// / travelDateEnd; "Dates (as typed)" in travelRequirement.notes on the
// second miss) and the same handover. bot.parity.test.ts pins the whole
// transcript against a recording of the pre-Slice-6 bot.
//
//   ask_name ──answer──▶ ask_destination ──answer──▶ ask_dates ──answer──▶ done

import type { QualificationFlow } from "./types.js";
import { parseDates, parseDestination, parseName, sanitize } from "./parse.js";

const COPY = {
  welcome: (headline: string) =>
    `Hi! Thanks for reaching out to Plumtrips${headline ? ` about "${headline}"` : ""}. To get started, what's your name?`,
  askNameAgain: "Sorry, I didn't catch that — what's your name?",
  askDestination: (name: string) => `Nice to meet you, ${name}! Where would you like to go?`,
  askDestinationAgain: "Which destination did you have in mind?",
  askDates: "Great — when are you planning to travel? (e.g. 12 Oct to 19 Oct)",
  askDatesAgain: "Could you share your travel dates? A rough date is fine, e.g. 15 Nov.",
  handover: (name: string) => `Perfect, ${name}. A Plumtrips holiday planner will be with you shortly.`,
  handoverUnparsed: "Thanks — a Plumtrips holiday planner will pick this up with you shortly.",
};

export const conciergeFlow: QualificationFlow = {
  businessLine: "concierge",
  welcome: COPY.welcome,
  questions: [
    {
      id: "ask_name",
      ask: () => COPY.welcome(""),
      askAgain: COPY.askNameAgain,
      parse: (text) => {
        const name = parseName(text);
        // Overwrite the placeholder (or whatever the profile gave us) with what they said.
        return name ? { display: name, set: { contactName: name } } : null;
      },
    },
    {
      id: "ask_destination",
      ask: COPY.askDestination,
      askAgain: COPY.askDestinationAgain,
      parse: (text) => {
        const destination = parseDestination(text);
        return destination ? { display: destination, set: { "travelRequirement.destination": destination } } : null;
      },
    },
    {
      id: "ask_dates",
      ask: () => COPY.askDates,
      askAgain: COPY.askDatesAgain,
      parse: (text, now) => {
        const dates = parseDates(text, now);
        return dates ? { display: "", set: { "travelRequirement.travelDate": dates.start, "travelRequirement.travelDateEnd": dates.end } } : null;
      },
      // Second miss: keep what they typed for the planner before handing over.
      keepOnGiveUp: (text) => ({ "travelRequirement.notes": `Dates (as typed): ${sanitize(text, 200)}` }),
    },
  ],
  handover: COPY.handover,
  handoverUnparsed: COPY.handoverUnparsed,
};
