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
// Track C: the copy lives in the canned-message store under concierge.*
// (services/plumconnect/messages.ts holds today's exact strings as the
// seed / fallback); this file names the keys.
//
//   ask_name ──answer──▶ ask_destination ──answer──▶ ask_dates ──answer──▶ done

import type { QualificationFlow } from "./types.js";
import { parseDates, parseDestination, parseName, sanitize } from "./parse.js";

const byName = ({ previousAnswer }: { previousAnswer: string }) => ({ name: previousAnswer });

export const conciergeFlow: QualificationFlow = {
  businessLine: "concierge",
  welcome: { key: "concierge.welcome", withHeadline: "concierge.welcome_headline" },
  questions: [
    {
      id: "ask_name",
      ask: { key: "concierge.welcome" },
      askAgain: { key: "concierge.ask_name_again" },
      parse: (text) => {
        const name = parseName(text);
        // Overwrite the placeholder (or whatever the profile gave us) with what they said.
        return name ? { display: name, set: { contactName: name } } : null;
      },
    },
    {
      id: "ask_destination",
      ask: { key: "concierge.ask_destination", vars: byName },
      askAgain: { key: "concierge.ask_destination_again" },
      parse: (text) => {
        const destination = parseDestination(text);
        return destination ? { display: destination, set: { "travelRequirement.destination": destination } } : null;
      },
    },
    {
      id: "ask_dates",
      ask: { key: "concierge.ask_dates" },
      askAgain: { key: "concierge.ask_dates_again" },
      parse: (text, now) => {
        const dates = parseDates(text, now);
        return dates ? { display: "", set: { "travelRequirement.travelDate": dates.start, "travelRequirement.travelDateEnd": dates.end } } : null;
      },
      // Second miss: keep what they typed for the planner before handing over.
      keepOnGiveUp: (text) => ({ "travelRequirement.notes": `Dates (as typed): ${sanitize(text, 200)}` }),
    },
  ],
  handover: "concierge.handover",
  handoverUnparsed: "concierge.handover_unparsed",
};
