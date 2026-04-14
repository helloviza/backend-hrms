import { logTBOCall } from "../utils/tboFileLogger.js";

const TBO_SHARED_BASE =
  process.env.TBO_SHARED_BASE_URL ||
  "http://Sharedapi.tektravels.com/SharedData.svc/rest";

const TBO_AUTH_URL = `${TBO_SHARED_BASE}/Authenticate`;

interface TokenCache {
  token: string;
  expiresAt: number; // unix ms
  acquiredAt: number; // unix ms — when this token was fetched
  agencyId?: number;
  memberId?: number;
}

let cache: TokenCache | null = null;

/** TBO tokens expire at 11:59 PM IST on the day they are generated.
 *  IST = UTC+5:30. We use 11:58 PM as a 2-minute safety buffer. */
function getISTMidnightExpiry(): number {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  // Set to 23:58:00 IST today
  nowIST.setUTCHours(23, 58, 0, 0);
  // Convert back to UTC unix ms
  return nowIST.getTime() - IST_OFFSET_MS;
}

/** Max token age before we force a re-authenticate (20 minutes). */
const MAX_TOKEN_AGE_MS = 20 * 60 * 1000;

export async function getTBOToken(opts?: { forceRefresh?: boolean }): Promise<string> {
  const now = Date.now();
  const forceRefresh = opts?.forceRefresh === true;
  if (cache && cache.expiresAt > now && !forceRefresh) return cache.token;

  const authPayload = {
    ClientId: process.env.TBO_ClientId || "ApiIntegrationNew",
    UserName: process.env.TBO_UserName,
    Password: process.env.TBO_Password,
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
  };

  const start = Date.now();
  const controller = new AbortController();
  const authTimeout = setTimeout(() => controller.abort(), 15_000);
  let data: any;
  try {
    const res = await fetch(TBO_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(authPayload),
      signal: controller.signal,
    });
    const rawText = await res.text();
    if (rawText.startsWith("<") || rawText.startsWith("<?")) {
      throw new Error(`TBO Auth returned XML instead of JSON (HTTP ${res.status}): ${rawText.slice(0, 300)}`);
    }
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error(`TBO Auth returned non-JSON (HTTP ${res.status}): ${rawText.slice(0, 300)}`);
    }
  } catch (e: any) {
    if (e.name === "AbortError") throw new Error("TBO auth timeout after 15s");
    throw e;
  } finally {
    clearTimeout(authTimeout);
  }
  const durationMs = Date.now() - start;

  // Redact password from logged request
  const loggedPayload = { ...authPayload, Password: "***" };
  logTBOCall({ method: "Authenticate", request: loggedPayload, response: data, durationMs });

  const token = data?.TokenId;
  if (!token) {
    const status = data?.Status;
    const errMsg = data?.Error?.ErrorMessage || "No error message";
    const errCode = data?.Error?.ErrorCode ?? "unknown";
    throw new Error(
      `TBO Auth failed — Status: ${status}, ErrorCode: ${errCode}, Message: ${errMsg} | Full: ${JSON.stringify(data)}`
    );
  }

  const expiresAt = getISTMidnightExpiry();
  cache = {
    token,
    expiresAt,
    acquiredAt: Date.now(),
    agencyId: data?.Member?.AgencyId ?? data?.TokenAgencyId,
    memberId: data?.Member?.MemberId ?? data?.TokenMemberId,
  };
  console.log('[TBO] Token refreshed successfully at', new Date().toISOString());

  return token;
}

export function getTokenAcquiredAt(): number {
  return cache?.acquiredAt ?? 0;
}

export function isTokenStale(): boolean {
  if (!cache) return true;
  return (Date.now() - cache.acquiredAt) > MAX_TOKEN_AGE_MS;
}

export function clearTBOToken(): void {
  cache = null;

}

export async function logoutTBO(): Promise<void> {
  if (!cache?.token) { cache = null; return; }
  try {
    const logoutPayload = {
      ClientId: process.env.TBO_ClientId || "ApiIntegrationNew",
      UserName: process.env.TBO_UserName,
      TokenId: cache.token,
      EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    };
    const start = Date.now();
    const logoutRes = await fetch(`${TBO_SHARED_BASE}/Logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(logoutPayload),
    });
    const logoutData = await logoutRes.json().catch(() => ({}));
    logTBOCall({ method: "Logout", request: logoutPayload, response: logoutData, durationMs: Date.now() - start });

  } catch (e) {
    console.warn("[TBO] Logout call failed (cache cleared anyway):", e);
  } finally {
    cache = null;
  }
}

export function getTBOTokenStatus(): {
  hasToken: boolean;
  expiresAt: string | null;
  expiresInMinutes: number | null;
} {
  if (!cache) return { hasToken: false, expiresAt: null, expiresInMinutes: null };
  const msLeft = cache.expiresAt - Date.now();
  return {
    hasToken: true,
    expiresAt: new Date(cache.expiresAt).toISOString(),
    expiresInMinutes: Math.round(msLeft / 60000),
  };
}

export async function getAgencyBalance(): Promise<unknown> {
  const token = await getTBOToken();
  const balPayload = {
    ClientId: process.env.TBO_ClientId || "ApiIntegrationNew",
    TokenAgencyId: cache?.agencyId ?? 0,
    TokenMemberId: cache?.memberId ?? 0,
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    TokenId: token,
  };
  const start = Date.now();
  const res = await fetch(`${TBO_SHARED_BASE}/GetAgencyBalance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(balPayload),
  });
  const data = await res.json();
  logTBOCall({ method: "GetAgencyBalance", request: balPayload, response: data, durationMs: Date.now() - start });
  return data;
}
