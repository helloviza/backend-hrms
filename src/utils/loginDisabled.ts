// apps/backend/src/utils/loginDisabled.ts
//
// Sign-in block for ONE login, separate from the active/inactive model
// (utils/userActiveStatus.ts). Written for the onboarding "front" accounts: an
// onboarding invite to a personal gmail created a User whose email is that
// gmail, while the person works from their real @plumtrips.com account. The
// gmail must not sign in, but the person is not leaving — so `status`, the
// Employee / membership mirrors and every HR record are left alone.
//
// A disabled login is refused everywhere a session or a password can come
// from: POST /auth/login, POST /auth/refresh, POST /auth/forgot-password,
// POST /auth/reset-password (so a welcome link issued before the flag dies
// too), issueSetPasswordLink() and POST /password/admin-set. Every refusal
// looks like the route's ordinary "no such account" / "bad token" reply —
// never a "disabled" hint.
//
// Setting the flag also clears any outstanding set-password token
// (scripts/disable-gmail-front-logins.ts is the writer); reset-password
// refuses a disabled user regardless, so a link that slipped through is dead.
export const LOGIN_DISABLED_FIELDS = ["loginDisabled", "loginDisabledAt", "loginDisabledBy", "loginDisabledReason"] as const;

export function isLoginDisabled(user: { loginDisabled?: unknown } | null | undefined): boolean {
  return user?.loginDisabled === true;
}

/** Mongo filter fragment: users whose login is NOT disabled. */
export function loginEnabledFilter(): { loginDisabled: { $ne: true } } {
  return { loginDisabled: { $ne: true } };
}

// Same message as a missing user: customerUsers' trySendInviteEmailSafe returns
// err.message to the client as inviteEmailError. Callers that need the
// difference check the class.
export class LoginDisabledError extends Error {
  constructor() {
    super("issueSetPasswordLink: user not found");
    this.name = "LoginDisabledError";
  }
}

