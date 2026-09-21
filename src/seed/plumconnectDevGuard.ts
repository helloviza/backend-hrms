// apps/backend/src/seed/plumconnectDevGuard.ts
//
// The ONE prod-guard for everything PlumConnect runs locally: the dev seed
// (src/scripts/plumconnect-seed-dev.ts) and the one-command bootstrap
// (scripts/plumconnect-local.mjs) both call this before opening a connection.
// It lived inline in the seed; shared now so the two cannot drift.
//
// Refuses unless ALL hold:
//   • NODE_ENV is not "production"
//   • the URI passes assertLocalDatabase() (loopback host, never mongodb+srv)
//   • the URI does not even LOOK like the production cluster
// There is no override flag, by design.

import { assertLocalDatabase } from "./assertLocalDatabase.js";

export const PROD_LOOKALIKE = /prod|mongodb\.net|atlas|amazonaws|plumtrips_hrms/i;

/** The URI with credentials masked, for messages. */
export function maskUri(uri: string): string {
  return String(uri || "").replace(/\/\/[^@]*@/, "//<creds>@");
}

/**
 * Returns the reason this is NOT a safe dev target, or null when it is.
 * Pure: reads nothing but its arguments.
 */
export function plumconnectDevTargetProblem(uri: string, nodeEnv: string | undefined): string | null {
  if (nodeEnv === "production") return "NODE_ENV is 'production'. This writes fake data and never runs there.";
  try {
    assertLocalDatabase(String(uri || ""));
  } catch (e) {
    return (e as Error).message;
  }
  if (PROD_LOOKALIKE.test(String(uri || ""))) return `MONGO_URI looks like a production target (${maskUri(uri)}).`;
  return null;
}

/** Throws with the reason when the target is not a safe dev target. */
export function assertPlumConnectDevTarget(uri: string, nodeEnv: string | undefined = process.env.NODE_ENV): void {
  const problem = plumconnectDevTargetProblem(uri, nodeEnv);
  if (problem) throw new Error(problem);
}
