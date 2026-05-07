// Diagnostic — print TBO's actual city names for a few country codes so we can
// align the cert-inventory-snapshot curated city list with TBO's spelling.
// Run: pnpm exec tsx src/scripts/diag-tbo-citylist.ts IN AU ID TH US
import "dotenv/config";
import { tboFetchFailed } from "../utils/tboFetchGuard.js";

function staticAuthHeader(): string {
  const u = process.env.TBO_HOTEL_STATIC_USERNAME;
  const p = process.env.TBO_HOTEL_STATIC_PASSWORD;
  if (!u || !p) throw new Error("TBO creds missing");
  return `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
}

const NEEDLES: Record<string, string[]> = {
  IN: ["delhi", "mumbai", "bombay", "bengal", "bangalore", "chennai", "madras", "hyderabad", "kolkata", "calcutta", "jaipur", "pune", "ahmedabad", "agra", "kochi", "cochin", "udaipur", "goa"],
  AU: ["sydney", "melbourne", "brisbane", "gold coast", "perth", "adelaide"],
  ID: ["bali", "denpasar", "jakarta", "yogyakarta", "ubud", "kuta"],
  TH: ["bangkok", "phuket", "pattaya", "chiang mai", "krabi", "samui"],
  US: ["new york", "los angeles", "las vegas", "miami", "san francisco", "manhattan", "vegas"],
};

async function main() {
  const codes = process.argv.slice(2);
  if (codes.length === 0) {
    console.log("Usage: tsx diag-tbo-citylist.ts <CC> [CC...]");
    return;
  }
  for (const cc of codes) {
    const url = `https://api.tbotechnology.in/TBOHolidays_HotelAPI/CityList?CountryCode=${cc}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: staticAuthHeader() },
      body: JSON.stringify({ CountryCode: cc }),
      signal: AbortSignal.timeout(30_000),
    });
    if (await tboFetchFailed(`CityList[${cc}]`, url, res)) continue;
    const data = (await res.json()) as { CityList?: { Code: string; Name: string }[] };
    const cities = data?.CityList ?? [];
    console.log(`\n=== ${cc} — ${cities.length} cities ===`);
    const needles = (NEEDLES[cc] ?? []).map((s) => s.toLowerCase());
    if (needles.length === 0) {
      console.log("(no needles configured for this country, printing first 30)");
      cities.slice(0, 30).forEach((c) => console.log(`  ${c.Code}  ${c.Name}`));
      continue;
    }
    const hits = cities.filter((c) => {
      const n = (c.Name || "").toLowerCase();
      return needles.some((needle) => n.includes(needle));
    });
    console.log(`Matches for needles [${needles.join(", ")}]: ${hits.length}`);
    hits.slice(0, 40).forEach((c) => console.log(`  ${c.Code}  ${c.Name}`));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
