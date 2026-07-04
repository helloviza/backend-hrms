// apps/backend/src/services/arrivalConcierge.ts
//
// Phase 4 (Arrive) — the CONSTRAINED command set. PURE mapping from a button id
// or tolerant inbound text to a reply directive. No LLM, no I/O: inbound text is
// matched against a fixed keyword table (a prompt-injection boundary). The
// orchestrator (arrivalInbound) executes the returned directive.

import { getEmergencyNumbers } from "../data/emergencyContacts.js";
import { ARRIVAL_BUTTONS } from "./arrivalSession.js";

export type ConciergeAction = "REPLY" | "MENU" | "ESCALATE" | "OPT_OUT";

export interface ConciergeResult {
  action: ConciergeAction;
  text?: string;
  buttons?: { id: string; title: string }[];
}

type Command = "hotel" | "booker" | "emergency" | "help" | "stop" | "unknown";

/** Map a button id (authoritative) or tolerant text to a command. */
export function normalizeCommand(buttonId?: string, text?: string): Command {
  const b = String(buttonId || "").trim();
  if (b === "arr_hotel") return "hotel";
  if (b === "arr_booker") return "booker";
  if (b === "arr_help") return "help";

  const t = String(text || "").trim().toLowerCase();
  if (!t) return "unknown";
  if (t === "hotel" || t === "1") return "hotel";
  if (t === "booker" || t === "agent" || t === "2") return "booker";
  if (t === "help" || t === "3") return "help";
  if (t === "emergency" || t === "sos") return "emergency";
  if (t === "stop" || t === "unsubscribe") return "stop";
  return "unknown";
}

function hotelReply(session: any): ConciergeResult {
  const h = session?.hotel;
  if (!h || !h.name) {
    return {
      action: "REPLY",
      text: "I don't have a hotel on file for this trip. Reply 'booker' and I'll share your booker's contact so they can help.",
    };
  }
  const lines: string[] = [`🏨 ${h.name}`];
  if (h.address) lines.push(h.address);
  if (h.phone) lines.push(`Phone: ${h.phone}`);
  if (h.checkInDate) lines.push(`Check-in: ${h.checkInDate}`);
  if (h.address) {
    lines.push(`Map: https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(h.address)}`);
  }
  return { action: "REPLY", text: lines.join("\n") };
}

function bookerReply(session: any): ConciergeResult {
  if (!session?.bookerName && !session?.bookerEmail) {
    return { action: "REPLY", text: "I couldn't find your booker's details on file. Reply HELP and our team will call you." };
  }
  const lines: string[] = [`Your booker: ${session.bookerName || "Travel desk"}`];
  if (session.bookerEmail) lines.push(`Email: ${session.bookerEmail}`);
  if (session.bookerPhone) lines.push(`Phone: ${session.bookerPhone}`);
  lines.push("Or reply HELP and they'll call you.");
  return { action: "REPLY", text: lines.join("\n") };
}

function emergencyReply(session: any): ConciergeResult {
  const e = getEmergencyNumbers(session?.destinationIata);
  const where = session?.destinationCity ? ` in ${session.destinationCity}` : "";
  const text = e.country
    ? `Emergency numbers${where}:\nPolice: ${e.police}\nAmbulance: ${e.ambulance}\nReply HELP to also reach your booker.`
    : `For emergencies${where}, dial 112 from any mobile — it reaches local emergency services. Reply HELP to also reach your booker.`;
  return { action: "REPLY", text };
}

/**
 * Resolve the reply directive for an inbound arrival message. Stateless — the
 * orchestrator applies the menu cap, opt-out status change, and escalation.
 */
export function resolveCommand(session: any, buttonId?: string, text?: string): ConciergeResult {
  switch (normalizeCommand(buttonId, text)) {
    case "hotel":
      return hotelReply(session);
    case "booker":
      return bookerReply(session);
    case "emergency":
      return emergencyReply(session);
    case "help":
      return { action: "ESCALATE" };
    case "stop":
      return { action: "OPT_OUT", text: "You're unsubscribed and won't get further messages for this trip. Safe travels!" };
    default:
      return { action: "MENU", text: "How can I help?", buttons: ARRIVAL_BUTTONS };
  }
}
