// apps/backend/src/utils/plutoIntentGuard.ts

const BLOCKED_KEYWORDS = [
  "salary",
  "payroll",
  "leave",
  "attendance",
  "hr",
  "policy",
  "employee",
  "admin",
  "approval",
  "timesheet",
];

export function assertTravelIntent(prompt: string): void {
  const lower = prompt.toLowerCase();

  for (const word of BLOCKED_KEYWORDS) {
    if (lower.includes(word)) {
      throw new Error(
        "Pluto.ai handles travel, holidays, business trips, MICE & events only."
      );
    }
  }
}