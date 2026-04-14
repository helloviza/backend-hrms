// apps/backend/src/scripts/diag-tbo-auth.ts
// Diagnostic: force a fresh TBO authentication and log the full response.
// Run: pnpm -C apps/backend tsx src/scripts/diag-tbo-auth.ts

import { clearTBOToken, getTBOTokenStatus } from "../services/tbo.auth.service.js";

const TBO_SHARED_BASE =
  process.env.TBO_SHARED_BASE_URL ||
  "http://Sharedapi.tektravels.com/SharedData.svc/rest";

const TBO_AUTH_URL = `${TBO_SHARED_BASE}/Authenticate`;

async function main() {
  console.log("=== TBO Auth Diagnostic ===\n");

  // 1. Credentials summary (variable names only, no values)
  console.log("--- Credentials being sent ---");
  console.log("ClientId  env var : TBO_ClientId   (fallback: 'ApiIntegrationNew')");
  console.log("UserName  env var : TBO_UserName");
  console.log("Password  env var : TBO_Password");
  console.log("EndUserIp env var : TBO_EndUserIp  (fallback: '1.1.1.1')");
  console.log("");
  console.log("Resolved ClientId :", process.env.TBO_ClientId || "ApiIntegrationNew (default)");
  console.log("TBO_UserName set  :", !!process.env.TBO_UserName);
  console.log("TBO_Password set  :", !!process.env.TBO_Password);
  console.log("EndUserIp         :", process.env.TBO_EndUserIp || "1.1.1.1 (default)");
  console.log("Auth URL          :", TBO_AUTH_URL);
  console.log("");

  // 2. Clear any in-memory cache
  clearTBOToken();
  const statusBefore = getTBOTokenStatus();
  console.log("--- Token cache BEFORE refresh ---");
  console.log(JSON.stringify(statusBefore, null, 2));
  console.log("");

  // 3. Fire the raw auth request
  const authPayload = {
    ClientId: process.env.TBO_ClientId || "ApiIntegrationNew",
    UserName: process.env.TBO_UserName,
    Password: process.env.TBO_Password,
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
  };

  console.log("--- Sending auth request ---");
  const start = Date.now();
  let rawText = "";
  let httpStatus = 0;
  let data: any = null;
  let fetchError: string | null = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(TBO_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(authPayload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    httpStatus = res.status;
    rawText = await res.text();
  } catch (e: any) {
    fetchError = e.name === "AbortError" ? "TIMEOUT after 15s" : String(e);
  }
  const durationMs = Date.now() - start;

  console.log(`HTTP Status  : ${httpStatus}`);
  console.log(`Duration     : ${durationMs}ms`);
  console.log(`Fetch error  : ${fetchError ?? "none"}`);
  console.log(`Raw response : ${rawText.slice(0, 2000)}`);
  console.log("");

  // 4. Parse
  if (fetchError) {
    console.log("!!! Network-level failure — could not reach TBO auth endpoint !!!");
    process.exit(1);
  }
  if (rawText.startsWith("<") || rawText.startsWith("<?")) {
    console.log("!!! TBO returned XML — possible wrong endpoint or firewall block !!!");
    process.exit(1);
  }
  try {
    data = JSON.parse(rawText);
  } catch {
    console.log("!!! Response is not valid JSON !!!");
    process.exit(1);
  }

  console.log("--- Parsed response (full) ---");
  console.log(JSON.stringify(data, null, 2));
  console.log("");

  // 5. Interpret
  const token = data?.TokenId;
  const status = data?.Status;
  const errCode = data?.Error?.ErrorCode ?? data?.Response?.Error?.ErrorCode ?? null;
  const errMsg  = data?.Error?.ErrorMessage ?? data?.Response?.Error?.ErrorMessage ?? null;

  console.log("--- Interpretation ---");
  console.log("TokenId present :", !!token);
  console.log("Status          :", status);
  console.log("ErrorCode       :", errCode ?? "none");
  console.log("ErrorMessage    :", errMsg ?? "none");

  if (errCode === 2) {
    console.log("\n[!] ErrorCode 2 = InvalidCredentials.");
    console.log("    TBO_UserName / TBO_Password are being rejected by TBO.");
    console.log("    Note: TBO B2B API credentials are separate from the web portal login.");
    console.log("    Check with TBO support whether the API user is active and correct.");
  } else if (errCode === 6) {
    console.log("\n[!] ErrorCode 6 on a fresh auth — unexpected. Token may already be invalidated server-side.");
  } else if (!token) {
    console.log("\n[!] No TokenId in response — auth failed. See ErrorCode/ErrorMessage above.");
  } else {
    console.log("\n[OK] Auth succeeded — token acquired.");
    console.log("     AgencyId :", data?.Member?.AgencyId ?? data?.TokenAgencyId ?? "not in response");
    console.log("     MemberId :", data?.Member?.MemberId ?? data?.TokenMemberId ?? "not in response");
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("Diagnostic failed:", e);
  process.exit(1);
});
