// apps/backend/src/services/consumerProfileCompletion.ts
//
// "Profile Completion 62%" and the "Complete Your Profile 5/6" panel.
//
// ── WHY THIS IS COMPUTED, NEVER STORED ────────────────────────────────
// A stored percentage is a denormalisation that goes stale the moment any
// write path forgets to recompute it — and the write paths here are many
// (six sections, three sub-array CRUDs, plus document upload and delete).
// Computing it on read costs nothing: the whole profile is already loaded.
//
// ── WHAT "COMPLETE" MEANS ─────────────────────────────────────────────
// The MINIMUM that makes the tab useful to a visa application — not every
// field on it. The profile is progressive: nothing is mandatory, and a
// consumer must be able to reach 100% without inventing data they do not
// have. So "Personal" does not require a middle name (many people have
// none) and "Travel" does not require an employer (students, retirees).
//
// The six counted tabs deliberately EXCLUDE Account & Security: it has no
// completable state — every field on it already has a working default, so
// counting it would mean every new consumer starts at 1/7 for having done
// nothing.
import type { ConsumerProfileDocument } from "../models/ConsumerProfile.js";

export interface TabCompletion {
  key: string;
  label: string;
  complete: boolean;
  /** Shown under an incomplete row so the panel is actionable, not just red. */
  missing: string[];
}

export interface ProfileCompletion {
  tabs: TabCompletion[];
  completedCount: number;
  totalCount: number;
  percent: number;
}

function present(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Date) return !Number.isNaN(v.getTime());
  return true;
}

/** Collects the labels of the required fields that are still empty. */
function check(pairs: Array<[string, unknown]>): string[] {
  return pairs.filter(([, v]) => !present(v)).map(([label]) => label);
}

export function computeProfileCompletion(
  profile: Pick<
    ConsumerProfileDocument,
    "personal" | "passports" | "contact" | "travel" | "coTravellers"
  >,
  documentCount: number,
): ProfileCompletion {
  const personal = (profile as any).personal ?? {};
  const contact = (profile as any).contact ?? {};
  const travel = (profile as any).travel ?? {};
  const passports: any[] = (profile as any).passports ?? [];
  const coTravellers: any[] = (profile as any).coTravellers ?? [];

  const currentAddress = contact.currentAddress ?? {};

  const personalMissing = check([
    ["First name", personal.firstName],
    ["Last name", personal.lastName],
    ["Date of birth", personal.dateOfBirth],
    ["Nationality", personal.nationality],
  ]);

  // A passport ROW is not enough — an entry with no number and no expiry
  // date carries no information, and counting it would let the panel read
  // 100% for a profile no application could use.
  const usablePassport = passports.find((p) => present(p?.number) && present(p?.expiryDate));
  const passportMissing = passports.length
    ? usablePassport
      ? []
      : ["Passport number and expiry date"]
    : ["At least one passport"];

  const contactMissing = check([
    ["Mobile number", contact.mobile],
    ["Address line 1", currentAddress.line1],
    ["City", currentAddress.city],
    ["Country", currentAddress.country],
  ]);

  // hasPriorVisaRefusal defaults to null and is complete once ANSWERED —
  // `false` is a real answer, so this tests for non-null rather than truth.
  const travelMissing = check([
    ["Occupation", travel.occupation],
    ["Employment type", travel.employmentType],
  ]);
  if (travel.hasPriorVisaRefusal == null) {
    travelMissing.push("Previous visa refusals (yes/no)");
  }

  const tabs: TabCompletion[] = [
    {
      key: "personal",
      label: "Personal Details",
      complete: personalMissing.length === 0,
      missing: personalMissing,
    },
    {
      key: "passport",
      label: "Passport",
      complete: passportMissing.length === 0,
      missing: passportMissing,
    },
    {
      key: "contact",
      label: "Contact & Address",
      complete: contactMissing.length === 0,
      missing: contactMissing,
    },
    {
      key: "travel",
      label: "Travel Profile",
      complete: travelMissing.length === 0,
      missing: travelMissing,
    },
    {
      key: "coTravellers",
      label: "Co-travellers",
      complete: coTravellers.length > 0,
      missing: coTravellers.length > 0 ? [] : ["Add a co-traveller, or skip if you travel alone"],
    },
    {
      key: "documents",
      label: "My Documents",
      complete: documentCount > 0,
      missing: documentCount > 0 ? [] : ["Upload at least one document"],
    },
  ];

  const completedCount = tabs.filter((t) => t.complete).length;

  return {
    tabs,
    completedCount,
    totalCount: tabs.length,
    percent: Math.round((completedCount / tabs.length) * 100),
  };
}
