const SHARED_BASE =
  process.env.TBO_SHARED_BASE_URL ||
  "http://Sharedapi.tektravels.com/SharedData.svc/rest";

interface TokenCache {
  token: string;
  expiresAt: number; // unix ms
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

export async function getTBOToken(): Promise<string> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.token;

  const res = await fetch(`${SHARED_BASE}/Authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      ClientId: process.env.TBO_ClientId || "ApiIntegrationNew",
      UserName: process.env.TBO_UserName,
      Password: process.env.TBO_Password,
      EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    }),
  });

  const data = await res.json() as any;
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
    agencyId: data?.Member?.AgencyId ?? data?.TokenAgencyId,
    memberId: data?.Member?.MemberId ?? data?.TokenMemberId,
  };

  const minLeft = Math.round((expiresAt - Date.now()) / 60000);
  console.log(`[TBO] Token refreshed — valid for ~${minLeft} min (expires at IST 23:58)`);
  return token;
}

export function clearTBOToken(): void {
  cache = null;
  console.log("[TBO] Token cache cleared manually — will re-authenticate on next request");
}

export async function logoutTBO(): Promise<void> {
  if (!cache?.token) { cache = null; return; }
  try {
    await fetch(`${SHARED_BASE}/Logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        ClientId: process.env.TBO_ClientId || "ApiIntegrationNew",
        UserName: process.env.TBO_UserName,
        TokenId: cache.token,
        EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
      }),
    });
    console.log("[TBO] Logout successful");
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
  const res = await fetch(`${SHARED_BASE}/GetAgencyBalance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      ClientId: process.env.TBO_ClientId || "ApiIntegrationNew",
      TokenAgencyId: cache?.agencyId ?? 0,
      TokenMemberId: cache?.memberId ?? 0,
      EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
      TokenId: token,
    }),
  });
  return res.json();
}
