// apps/backend/src/utils/plutoIntentGuard.ts

import type { PlutoReplyV1 } from "../types/pluto.js";

/**
 * HR / payroll / attendance asks, matched with their inflections. These are
 * unambiguous enough to check on EVERY turn, follow-ups included: "how many
 * leaves do I have" used to slip past the old whole-word `leave` check (plural)
 * and go to the model, which answered it as travel (QC 2026-11-09, F-23).
 *
 * Bare "leave" is deliberately NOT here — "leave it for now", "we leave at 6"
 * are ordinary chat. Only the HR shapes of it are: the plural, a typed leave,
 * leave + balance/request/…, applying for / taking leave.
 */
const STRONG_HR: Array<{ topic: HrTopic; re: RegExp }> = [
  { topic: "leave", re: /\bleaves\b/i },
  { topic: "leave", re: /\bleave\s+(balances?|requests?|applications?|status|approvals?|encashment|days?|quota|left|history)\b/i },
  { topic: "leave", re: /\b(sick|casual|earned|annual|privilege|maternity|paternity|comp(ensatory)?|optional|unpaid)\s+leaves?\b/i },
  { topic: "leave", re: /\b(apply|applied|applying|take|taking|took|request|requesting)\s+(for\s+)?(an?\s+|my\s+|some\s+)?leaves?\b/i },
  { topic: "pay", re: /\bpay\s?slips?\b/i },
  { topic: "pay", re: /\bsalar(y|ies)\b/i },
  { topic: "pay", re: /\bpayroll\b/i },
  { topic: "pay", re: /\b(form\s?16|ctc|tds\s+deduct\w*)\b/i },
  { topic: "attendance", re: /\battendance\b/i },
  { topic: "attendance", re: /\btime\s?sheets?\b/i },
  { topic: "attendance", re: /\bpunch(ed|ing)?\s+(in|out)\b/i },
  { topic: "attendance", re: /\bregulari[sz](e|ation)\b/i },
];

/**
 * Broader admin words, checked on the FIRST turn only (unchanged behaviour).
 * On a follow-up they are far too likely to be about the trip in hand —
 * "is this within policy?", "send it for approval".
 */
const WEAK_HR = ["leave", "hr", "policy", "employee", "admin", "approval"];

/**
 * Travel signals. If ANY of these appears, the message is treated as a
 * legitimate travel question even when it also contains an HR term
 * (e.g. "when should I LEAVE for the airport", "baggage POLICY",
 * "trip APPROVAL", "ok leave flights for now"). This is the guard against
 * false-positive redirects.
 */
const TRAVEL_SIGNALS = [
  "travel", "trip", "trips", "tour", "tours", "journey",
  "flight", "flights", "fly", "flying", "flew", "airline", "airlines",
  "airport", "airfare", "fare", "ticket", "tickets", "booking", "book",
  "hotel", "hotels", "resort", "resorts", "stay", "accommodation", "lodging",
  "holiday", "holidays", "vacation", "getaway", "honeymoon",
  "itinerary", "destination", "destinations", "city", "country",
  "baggage", "luggage", "visa", "passport", "boarding", "check-in", "checkin",
  "departure", "arrival", "layover", "transit", "lounge", "cabin", "seat",
  "mice", "event", "events", "conference", "offsite", "off-site", "summit",
  "cruise", "beach", "sightseeing", "excursion", "package", "weekend",
];

export type HrTopic = "leave" | "pay" | "attendance";

const hasWholeWord = (text: string, word: string): boolean => {
  // Escape regex specials in the keyword, then bound it on word boundaries.
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
};

const hasTravelSignal = (text: string): boolean => TRAVEL_SIGNALS.some((w) => hasWholeWord(text, w));

/** Which HR areas the message is about (strong matches only), in a stable order. */
export function hrTopicsOf(prompt: string): HrTopic[] {
  const text = String(prompt || "");
  const found = new Set<HrTopic>();
  for (const { topic, re } of STRONG_HR) if (re.test(text)) found.add(topic);
  return (["leave", "pay", "attendance"] as HrTopic[]).filter((t) => found.has(t));
}

/**
 * True ONLY when the message is genuinely off-domain: it carries an HR term
 * AND no travel signal at all.
 *  - First turn: a strong HR match or one of the broad admin words.
 *  - Follow-up (`followUp: true`): strong HR matches only.
 * A travel question that merely mentions a flagged word ("leave for the
 * airport", "baggage policy") returns false either way.
 */
export function isOffDomainQuery(prompt: string, opts: { followUp?: boolean } = {}): boolean {
  const text = String(prompt || "");
  const strong = hrTopicsOf(text).length > 0;
  const weak = !opts.followUp && WEAK_HR.some((w) => hasWholeWord(text, w));
  if (!strong && !weak) return false;
  return !hasTravelSignal(text);
}

/** The HRMS page for each area — paths from the frontend router (router.tsx). */
export const HRMS_LINKS: Record<HrTopic, { label: string; href: string }> = {
  leave: { label: "Open Leaves", href: "/leaves/my" },
  pay: { label: "Open Payslips", href: "/payroll/my-payslips" },
  attendance: { label: "Open Attendance", href: "/attendance/reports" },
};

const TOPIC_WORDS: Record<HrTopic, string> = {
  leave: "leave balance and requests",
  pay: "payslips and salary",
  attendance: "attendance",
};

/**
 * Polite, non-throwing redirect rendered by the frontend exactly like any
 * other Pluto reply (title / context / nextSteps), plus `links` to the HRMS
 * page that actually answers it. Returned with HTTP 200 so an off-domain
 * question never produces a 500 / page error.
 */
export function buildOffDomainRedirect(prompt = ""): PlutoReplyV1 {
  const topics = hrTopicsOf(prompt);
  const shown: HrTopic[] = topics.length > 0 ? topics : ["leave", "pay", "attendance"];
  const where =
    topics.length > 0
      ? `You'll find your ${topics.map((t) => TOPIC_WORDS[t]).join(" and ")} in HRMS — ${topics.length > 1 ? "the links below open them" : "the link below opens it"}.`
      : "For leave, payslips or attendance, the links below open the right HRMS page.";
  return {
    title: "That's one for HRMS",
    context:
      `I'm your travel concierge, so I can't see HR records. ${where} ` +
      "Anything travel-related I can help with?",
    tripType: "business",
    links: shown.map((t) => HRMS_LINKS[t]),
    nextSteps: [
      "Plan a business trip",
      "Find flights or hotels",
    ],
    handoff: false,
  };
}
