// apps/backend/src/services/consumerVisaReadiness.ts
//
// "VISA READINESS" — six things a visa application actually needs, and
// whether this consumer has them.
//
// ══════════════════════════════════════════════════════════════════════
// THIS IS NOT services/consumerProfileCompletion.ts WEARING A NEW LABEL.
// ══════════════════════════════════════════════════════════════════════
// The two are asked the same way and answer different questions, and
// collapsing them would be the easy mistake here:
//
//   COMPLETION  "how much of your PROFILE have you filled in" — six TABS
//               of the account area, one of which is co-travellers and
//               another of which is satisfied by ANY single uploaded
//               file. It measures the form.
//
//   READINESS   "could you lodge an application tomorrow" — six ARTEFACTS
//               a mission asks for. Co-travellers are irrelevant to it; a
//               holiday snap in the locker does not make you photograph-
//               ready; and a passport that expires in four months fails
//               here while passing there.
//
// So the numbers genuinely differ, and they are meant to. A profile at
// 100% completion can sit at 4/6 readiness, which is exactly the case
// that makes a readiness gauge worth showing at all.
//
// ── EVERY ITEM IS A REAL STORED SIGNAL ───────────────────────────────
// There is no weighting, no "almost", no partial credit and no invented
// percentage. Six booleans, and the percent is their count over six. If
// an item cannot be answered from data we hold, it is FALSE — never
// optimistically true, because the whole value of this number is that a
// consumer can trust it before they book a flight.
import type { ConsumerProfileDocument } from "../models/ConsumerProfile.js";
import { computeProfileCompletion } from "./consumerProfileCompletion.js";

/**
 * The locker's SHORT document vocabulary, not the ops catalogue's.
 *
 * routes/consumer.applications.ts says this at length where it matches a
 * corridor's checklist: the D2C corridors are seeded with PASSPORT /
 * PHOTO / BANK_STATEMENT, while the ops taxonomy (config/visaDocuments)
 * calls the same three PASSPORT_ORIGINAL / PHOTOGRAPH /
 * APPLICANT_BANK_STATEMENT. Reaching for the catalogue's codes here would
 * miss on every real row and quietly report every consumer as 4/6.
 */
export const READINESS_PHOTO_DOC_CODE = "PHOTO";
export const READINESS_BANK_STATEMENT_DOC_CODE = "BANK_STATEMENT";

/**
 * The six-month rule, as 183 days of milliseconds.
 *
 * Deliberately the SAME arithmetic as the account area's own
 * expiryState() (frontend tabs/PassportTab.tsx), which is what a consumer
 * already sees next to their passport: "Expires in 41 days" with a
 * warning bar. If this service used a calendar-month subtraction instead,
 * the passport tab and the readiness gauge would disagree by a day or two
 * around the boundary — and a reader who is told "you're ready" on one
 * screen and "renew this" on the next has no reason to believe either.
 *
 * 183 days rather than a true six calendar months is that file's existing
 * choice; it is marginally CONSERVATIVE (183 > 182.5), which is the right
 * direction to err for a rule missions enforce strictly.
 */
export const PASSPORT_VALIDITY_WINDOW_MS = 183 * 24 * 60 * 60 * 1000;

/**
 * The completion tab whose field list defines "Personal Details" here.
 *
 * Named rather than inlined so the coupling is greppable: readiness does
 * NOT keep its own copy of the first-name/last-name/DOB/nationality list.
 * It asks completion, because that list is a judgement about what a visa
 * form needs and there must be exactly one of it. consumerVisaReadiness.
 * test.ts asserts this key still resolves, so a rename over there fails a
 * test here instead of silently pinning this item to false forever.
 */
export const READINESS_PERSONAL_TAB_KEY = "personal";

export interface ReadinessItem {
  key: string;
  label: string;
  ready: boolean;
}

export interface VisaReadiness {
  items: ReadinessItem[];
  readyCount: number;
  total: number;
  percent: number;
}

/** Only what this service reads — a document row's code and nothing else. */
export interface ReadinessDocument {
  docCode?: string | null;
}

function present(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  return true;
}

/** A date-ish value as a valid Date, or null. Never NaN, never a guess. */
function asDate(v: unknown): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Whether the consumer holds a passport this application could be lodged
 * on: a real number AND a real expiry date.
 *
 * The same bar consumerProfileCompletion.ts sets, and for the reason it
 * gives — a passport ROW with neither carries no information, and
 * counting it would let a gauge read "ready" for a profile no mission
 * could process.
 */
function usablePassports(passports: any[]): any[] {
  return passports.filter((p) => present(p?.number) && asDate(p?.expiryDate) !== null);
}

export function computeVisaReadiness(
  profile: Pick<
    ConsumerProfileDocument,
    "personal" | "passports" | "contact" | "travel" | "coTravellers"
  >,
  /**
   * The consumer's LIVE locker rows — deleted ones already filtered out
   * by the caller. Taken as the rows rather than a pre-built code set so
   * this function, not its callers, owns the normalisation: `docCode` is
   * stored uppercase but is a free string on older rows, and two call
   * sites upper-casing it separately is one call site forgetting to.
   */
  documents: ReadinessDocument[],
  now: Date = new Date(),
): VisaReadiness {
  const passports: any[] = (profile as any)?.passports ?? [];
  const travel: any = (profile as any)?.travel ?? {};

  const codes = new Set(
    documents
      .map((d) => String(d?.docCode ?? "").trim().toUpperCase())
      .filter((c) => c.length > 0),
  );

  const usable = usablePassports(passports);

  /* ── 2. VALIDITY ──────────────────────────────────────────────────
   * ANY usable passport with more than six months left satisfies this —
   * not specifically the primary one. A consumer holding an expiring
   * passport and a fresh one is genuinely ready to travel, and failing
   * them because the stale one is still flagged primary would be the
   * gauge reporting a data-entry detail as a travel blocker.
   *
   * An EXPIRED passport fails here for free: its delta is negative, so
   * it never clears the window. No separate branch, and therefore no
   * branch that can be got wrong. */
  const validPassport = usable.find((p) => {
    const expiry = asDate(p.expiryDate)!;
    return expiry.getTime() - now.getTime() >= PASSPORT_VALIDITY_WINDOW_MS;
  });

  /* ── 4. PERSONAL DETAILS ──────────────────────────────────────────
   * Delegated whole. The document count passed through is real (the
   * caller's live rows) so nothing here perturbs completion's own
   * arithmetic — but only the `personal` tab's verdict is read, and that
   * tab does not consult documents at all. */
  const completion = computeProfileCompletion(profile, documents.length);
  const personalTab = completion.tabs.find((t) => t.key === READINESS_PERSONAL_TAB_KEY);

  const items: ReadinessItem[] = [
    {
      key: "passport",
      label: "Passport",
      ready: usable.length > 0,
    },
    {
      key: "passportValidity",
      label: "Passport Validity",
      ready: Boolean(validPassport),
    },
    {
      key: "photograph",
      label: "Photograph",
      ready: codes.has(READINESS_PHOTO_DOC_CODE),
    },
    {
      key: "personalDetails",
      label: "Personal Details",
      // `?? false` is the honest reading of a missing tab: unknown is not
      // ready. See READINESS_PERSONAL_TAB_KEY — a test guards the lookup.
      ready: personalTab?.complete ?? false,
    },
    {
      key: "travelHistory",
      label: "Travel History",
      // Entered by hand, and that is the only source there is: nothing in
      // this system observes travel. One recorded trip is the bar.
      ready: Array.isArray(travel.travelHistory) && travel.travelHistory.length > 0,
    },
    {
      key: "bankStatement",
      label: "Bank Statement",
      ready: codes.has(READINESS_BANK_STATEMENT_DOC_CODE),
    },
  ];

  const readyCount = items.filter((i) => i.ready).length;

  return {
    items,
    readyCount,
    total: items.length,
    percent: Math.round((readyCount / items.length) * 100),
  };
}
