// Manual probe for TBO CountryList. Verifies:
//  1. The GET-method fix returns valid JSON instead of "Method Not Allowed".
//  2. The shared tboFetchFailed guard correctly identifies 4xx/5xx responses
//     and lets callers fall back without crashing on res.json().
// Run: pnpm --filter @plumtrips/hrms-backend exec tsx src/scripts/probe-tbo-countrylist.ts
import "dotenv/config";
import { tboFetchFailed } from "../utils/tboFetchGuard.js";

function staticAuthHeader(): string {
  const u = process.env.TBO_HOTEL_STATIC_USERNAME;
  const p = process.env.TBO_HOTEL_STATIC_PASSWORD;
  if (!u || !p) throw new Error("TBO_HOTEL_STATIC_USERNAME / PASSWORD not set");
  return `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
}

const URL = "https://api.tbotechnology.in/TBOHolidays_HotelAPI/CountryList";

async function probeWithGuard(method: "GET" | "POST"): Promise<void> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: staticAuthHeader(),
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: "{}" } : {}),
  };
  const res = await fetch(URL, init);
  const ct = res.headers.get("content-type") || "";
  console.log(`[${method}] HTTP ${res.status} content-type: ${ct}`);

  // Same guard the production code now uses.
  if (await tboFetchFailed("CountryList", URL, res)) {
    console.log(`[${method}] guard returned true → caller would fall back ✓`);
    return;
  }
  const data = (await res.json()) as { CountryList?: { Code: string; Name: string }[] };
  const list = data?.CountryList ?? [];
  console.log(`[${method}] guard returned false; CountryList length: ${list.length}`);
  console.log(`[${method}] first 3: ${JSON.stringify(list.slice(0, 3))}`);
}

(async () => {
  console.log("--- Old behaviour (POST) — should hit the guard ---");
  try { await probeWithGuard("POST"); } catch (e: any) { console.log(`POST threw (BAD): ${e?.message}`); }
  console.log("--- New behaviour (GET) — should bypass the guard and parse JSON ---");
  try { await probeWithGuard("GET"); } catch (e: any) { console.log(`GET threw (BAD): ${e?.message}`); }
})();
