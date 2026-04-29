import { getTBOToken, logoutTBO } from "./tbo.auth.service.js";

/**
 * Wraps a TBO API call with InValidSession (ResponseStatus=4 / ErrorCode=6) detection
 * and a single retry after token refresh.
 *
 * CROSS-002: Sprint 1 (GAP-03) only added this retry to the Book endpoint.
 * Phase 2 applies it to PreBook, GenerateVoucher, verifyBookingStatus,
 * SendChangeRequest, and GetChangeRequestStatus.
 *
 * The fn receives the current TokenId on each invocation so token-in-body
 * calls (GetBookingDetail, Cancel, GenerateVoucher) receive a fresh token on retry.
 * Calls using only Basic Auth (PreBook) can ignore the tokenId parameter.
 */
export async function withTBOSessionRetry<T>(
  fn: (tokenId: string) => Promise<T>,
  responseStatusCheck: (result: T) => boolean = (r: any) =>
    r?.ResponseStatus === 4 || r?.Error?.ErrorCode === 6,
): Promise<T> {
  let tokenId = await getTBOToken();
  let result = await fn(tokenId);

  if (responseStatusCheck(result)) {
    await logoutTBO();
    tokenId = await getTBOToken({ forceRefresh: true });
    result = await fn(tokenId);

    if (responseStatusCheck(result)) {
      throw new Error("TBO_AUTH_PERSISTENT_FAILURE: Authentication failed after retry.");
    }
  }

  return result;
}
