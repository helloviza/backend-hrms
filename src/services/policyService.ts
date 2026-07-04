// apps/backend/src/services/policyService.ts
//
// Loads the active per-workspace travel policy. Tenant-scoped and fail-safe: a
// missing policy or a DB error yields null → the evaluator's
// "no_policy_configured" (IN_POLICY) path, never a request failure.

import TravelPolicy from "../models/TravelPolicy.js";
import { policyRulesFromDoc, type PolicyRules } from "./policyEvaluator.js";

export async function loadWorkspacePolicyRules(
  workspaceObjectId: any,
): Promise<PolicyRules | null> {
  if (!workspaceObjectId) return null;
  try {
    // Scoped by workspaceId (never trust client tenant identity).
    const doc = await TravelPolicy.findOne({
      workspaceId: workspaceObjectId,
      active: true,
    }).lean();
    return policyRulesFromDoc(doc);
  } catch (err: any) {
    console.error("[policyService] failed to load travel policy", { message: err?.message });
    return null; // fail-safe → treated as no policy → IN_POLICY
  }
}
