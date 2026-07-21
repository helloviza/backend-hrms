import CustomerMember from "../models/CustomerMember.js";

/**
 * CustomerMember.role is the authoritative per-workspace role for a member —
 * confirmed by tracing the JWT itself (routes/auth.ts's buildAuthSafeUser
 * looks up CustomerMember and sets customerMemberRole from member.role,
 * which is what every real backend authorization check then reads). It is
 * NOT User.roles (account-type level: CUSTOMER/VENDOR/EMPLOYEE, not a
 * workspace role) and NOT User.customerMemberRole, a field that doesn't
 * exist on the User schema at all — a prior bug (Team tab showing "CUSTOMER"
 * for everyone) came from reading that nonexistent field and silently
 * falling back to roles[0].
 *
 * Shared by every screen that needs to show or gate on a member's workspace
 * role (Team tab, Workspace Permissions) so they can't independently drift
 * out of sync with each other or with the JWT again.
 */
export async function getCustomerMemberRoleMap(customerId: string): Promise<Map<string, string>> {
  const memberRoles = await CustomerMember.find({ customerId }).select("email role").lean();
  return new Map(memberRoles.map((m: any) => [m.email, m.role]));
}

/**
 * Resolve one member's display role: CustomerMember.role (via the map from
 * getCustomerMemberRoleMap) first, then the account-type roles/role fields
 * as a fallback for users with no CustomerMember record, then "CUSTOMER".
 */
export function resolveMemberRole(
  roleMap: Map<string, string>,
  email: string,
  fallbackRoles?: string[] | null,
  fallbackRole?: string | null,
): string {
  return (
    roleMap.get(email) ||
    (Array.isArray(fallbackRoles) && fallbackRoles[0]) ||
    fallbackRole ||
    "CUSTOMER"
  );
}
