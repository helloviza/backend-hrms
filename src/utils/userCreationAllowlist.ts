// apps/backend/src/utils/userCreationAllowlist.ts
import type { CustomerWorkspaceDocument } from "../models/CustomerWorkspace.js";

type Actor = {
  email?: string;
  roles?: string[];
  role?: string;
  hrmsAccessRole?: string;
  hrmsAccessLevel?: string;
};

type Member = {
  memberRole?: string; // e.g. "REQUESTER" | "APPROVER" | "WORKSPACE_LEADER"
};

function normEmail(v: unknown): string {
  return String(v || "").trim().toLowerCase();
}

function normDomain(v: unknown): string {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

export function isStaffPrivileged(actor: Actor | undefined | null): boolean {
  if (!actor) return false;
  const roleBag = new Set(
    [
      ...(Array.isArray(actor.roles) ? actor.roles : []),
      actor.role,
      actor.hrmsAccessRole,
      actor.hrmsAccessLevel,
    ]
      .filter(Boolean)
      .map((x) => String(x).toUpperCase())
  );

  // Accept common variants you may already use:
  return (
    roleBag.has("ADMIN") ||
    roleBag.has("SUPERADMIN") ||
    roleBag.has("SUPER_ADMIN") ||
    roleBag.has("SUPER-ADMIN") ||
    roleBag.has("HR")
  );
}

export function isCustomerSideManager(member: Member | undefined | null): boolean {
  const r = String(member?.memberRole || "").toUpperCase();
  return r === "APPROVER" || r === "WORKSPACE_LEADER" || r === "WORKSPACELEADER";
}

export function ensureUserCreationWhitelisted(params: {
  actor: Actor | undefined | null;
  workspace: CustomerWorkspaceDocument;
  member?: Member | null;
}): { ok: true } | { ok: false; code: number; error: string; detail?: any } {
  const { actor, workspace, member } = params;

  // Staff always allowed (bypass allowlist)
  if (isStaffPrivileged(actor || undefined)) return { ok: true };

  // Only enforce allowlist for customer-side actors
  if (!isCustomerSideManager(member || undefined)) {
    return {
      ok: false,
      code: 403,
      error: "Access restricted",
      detail: { reason: "Only staff or workspace leaders/approvers may manage users." },
    };
  }

  // Existing admin gate must be enabled for customer-side
  if (!workspace.userCreationEnabled) {
    return {
      ok: false,
      code: 403,
      error: "Access restricted",
      detail: { reason: "User Creation is disabled for this workspace. Contact HR/Admin." },
    };
  }

  // Allowlist (deny-by-default)
  const emails = Array.isArray(workspace.userCreationAllowlistEmails)
    ? workspace.userCreationAllowlistEmails.map(normEmail).filter(Boolean)
    : [];
  const domains = Array.isArray(workspace.userCreationAllowlistDomains)
    ? workspace.userCreationAllowlistDomains.map(normDomain).filter(Boolean)
    : [];

  if (emails.length === 0 && domains.length === 0) {
    return {
      ok: false,
      code: 403,
      error: "Access restricted",
      detail: { reason: "Your email/domain isn’t whitelisted for User Creation. Contact HR/Admin." },
    };
  }

  const email = normEmail(actor?.email);
  const domain = email.includes("@") ? email.split("@").pop() || "" : "";

  const ok =
    (email && emails.includes(email)) ||
    (domain && domains.includes(normDomain(domain)));

  if (!ok) {
    return {
      ok: false,
      code: 403,
      error: "Access restricted",
      detail: { reason: "Your email/domain isn’t whitelisted for User Creation. Contact HR/Admin." },
    };
  }

  return { ok: true };
}

// Reusable normalizers for your POST endpoint
export function normalizeAllowlist(input: { emails?: any; domains?: any }) {
  const rawEmails = Array.isArray(input.emails) ? input.emails : [];
  const rawDomains = Array.isArray(input.domains) ? input.domains : [];

  const emails = Array.from(
    new Set(rawEmails.map(normEmail).filter(Boolean))
  );

  const domains = Array.from(
    new Set(rawDomains.map(normDomain).filter(Boolean))
  );

  return { emails, domains };
}
