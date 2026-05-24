// apps/backend/src/scripts/tbo-prod-probe.ts
//
// PRODUCTION GO-LIVE PROBE for the TBO flight API host split.
//
// Run this FROM the production instance (App Runner exec / EC2 shell) whose
// egress IP (15.206.23.187, via the NAT Gateway) is whitelisted with TBO.
// It proves, BEFORE the real cutover, that:
//   (1) tboprod + live credentials authenticate, and
//   (2) all three production hosts are reachable from the whitelisted IP.
//
// READ-ONLY against TBO. It calls ONLY:
//   - Authenticate        (read)
//   - Search              (read — reachability only, fares ignored)
//   - GetBookingDetails   (read — on a dummy BookingId, error expected)
// It NEVER calls Book, Ticket, ReleasePNR, SendChangeRequest, or anything
// that creates/modifies a booking or spends money.
//
// All credentials and URLs come from environment variables. Nothing is
// hardcoded. Secrets (Password, TokenId) are NEVER printed.
//
// Run: pnpm -C apps/backend tsx src/scripts/tbo-prod-probe.ts

/* ── env vars this probe reads ──────────────────────────────────────────── */

const REQUIRED_ENV = [
  "TBO_ClientId",
  "TBO_UserName",
  "TBO_Password",
  "TBO_EndUserIp",
  "TBO_SHARED_BASE_URL", // auth host
  "TBO_FLIGHT_BASE_URL", // search host
  "TBO_FLIGHT_BOOKING_BASE_URL", // booking host
] as const;

const TIMEOUT_MS = 15_000; // 15s — a firewall block surfaces as a clean timeout, not a hang

/* ── helpers ────────────────────────────────────────────────────────────── */

/** Host label for the table — origin only, never the full path. */
function hostLabel(url: string | undefined): string {
  if (!url) return "(unset)";
  try {
    return new URL(url).host;
  } catch {
    return "(invalid URL)";
  }
}

type CallResult =
  | { layer: "network"; detail: string } // never reached TBO (timeout / reset / TLS / DNS)
  | { layer: "app"; httpStatus: number; json: any }; // got a TBO-level JSON response

/**
 * POST JSON to `${base}${path}` and classify the outcome as either a
 * network-layer failure (we never got through) or an application-layer
 * response (TBO answered — even an error means the firewall let us through).
 */
async function probePost(base: string, path: string, body: object): Promise<CallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const rawText = await res.text();
    // XML or non-JSON still means we reached the host (app layer responded).
    let json: any = null;
    if (rawText.startsWith("<") || rawText.startsWith("<?")) {
      json = { __nonJson: "XML", preview: rawText.slice(0, 200) };
    } else {
      try {
        json = JSON.parse(rawText);
      } catch {
        json = { __nonJson: "text", preview: rawText.slice(0, 200) };
      }
    }
    return { layer: "app", httpStatus: res.status, json };
  } catch (e: any) {
    let detail: string;
    if (e?.name === "AbortError") {
      detail = `TIMEOUT after ${TIMEOUT_MS / 1000}s`;
    } else {
      // fetch wraps connection reset / TLS / DNS errors; surface the cause if present.
      const cause = e?.cause?.code || e?.cause?.message || e?.code || "";
      detail = `${e?.message || String(e)}${cause ? ` (${cause})` : ""}`;
    }
    return { layer: "network", detail };
  } finally {
    clearTimeout(timer);
  }
}

/** Pull a TBO error message out of either top-level or nested Response shapes. */
function tboErrorMessage(json: any): string | null {
  return (
    json?.Error?.ErrorMessage ??
    json?.Response?.Error?.ErrorMessage ??
    null
  );
}

interface Row {
  host: string;
  probe: string;
  pass: boolean;
  detail: string;
}

/* ── main ───────────────────────────────────────────────────────────────── */

async function main() {
  console.log("==================================================================");
  console.log(" TBO PRODUCTION GO-LIVE PROBE  (READ-ONLY — no booking, no money)");
  console.log("==================================================================");
  console.log("");

  // 1. Env var presence — set/missing only, NEVER the values.
  console.log("--- Environment variables (set / MISSING — values never printed) ---");
  const missing: string[] = [];
  for (const key of REQUIRED_ENV) {
    const present = !!process.env[key] && String(process.env[key]).trim() !== "";
    if (!present) missing.push(key);
    console.log(`  ${present ? "[set]    " : "[MISSING]"} ${key}`);
  }
  console.log("");

  const authHost = hostLabel(process.env.TBO_SHARED_BASE_URL);
  const searchHost = hostLabel(process.env.TBO_FLIGHT_BASE_URL);
  const bookingHost = hostLabel(process.env.TBO_FLIGHT_BOOKING_BASE_URL);
  console.log("--- Resolved hosts ---");
  console.log(`  Auth    : ${authHost}`);
  console.log(`  Search  : ${searchHost}`);
  console.log(`  Booking : ${bookingHost}`);
  console.log("");

  if (missing.length > 0) {
    console.log("!!! HALTED — required env vars missing: " + missing.join(", "));
    console.log("    Set them in the prod environment and re-run. No calls were made.");
    process.exit(1);
  }

  const sharedBase = process.env.TBO_SHARED_BASE_URL!.replace(/\/+$/, "");
  const flightBase = process.env.TBO_FLIGHT_BASE_URL!.replace(/\/+$/, "");
  const bookingBase = process.env.TBO_FLIGHT_BOOKING_BASE_URL!.replace(/\/+$/, "");
  const endUserIp = process.env.TBO_EndUserIp!;

  const rows: Row[] = [];
  let tokenId: string | null = null;
  // When auth fails we still probe the search/booking hosts with a dummy token
  // so a blocked host surfaces in the same run. A dummy token cannot pass auth,
  // but for REACHABILITY any TBO JSON response (even "invalid token") proves we
  // got through the firewall.
  const DUMMY_TOKEN = "PROBE_DUMMY_TOKEN";

  /* ── PROBE 1: Authenticate (auth host) ────────────────────────────────── */
  console.log("--- PROBE 1/3: Authenticate ---");
  console.log(`  POST ${authHost}/Authenticate`);
  {
    const result = await probePost(sharedBase, "/Authenticate", {
      ClientId: process.env.TBO_ClientId,
      UserName: process.env.TBO_UserName,
      Password: process.env.TBO_Password,
      EndUserIp: endUserIp,
    });

    if (result.layer === "network") {
      console.log(`  NETWORK FAILURE: ${result.detail}`);
      console.log("  => Not reaching auth host / IP blocked at firewall.");
      rows.push({ host: `${authHost} (auth)`, probe: "Authenticate", pass: false, detail: `network blocked: ${result.detail}` });
    } else {
      const token = result.json?.TokenId;
      const errMsg = tboErrorMessage(result.json);
      const errCode = result.json?.Error?.ErrorCode ?? result.json?.Response?.Error?.ErrorCode ?? null;
      if (token) {
        tokenId = token;
        console.log("  PASS: TokenId received (value hidden).");
        rows.push({ host: `${authHost} (auth)`, probe: "Authenticate", pass: true, detail: "TokenId received" });
      } else {
        // Reached the host (app responded) but no token — classify why.
        const msg = (errMsg || "").toLowerCase();
        let detail: string;
        if (/ip|not registered|whitelist|blocked|access/.test(msg)) {
          detail = `IP NOT whitelisted on auth host (TBO: "${errMsg}")`;
          console.log(`  FAIL: ${detail}`);
        } else if (errCode === 2 || /credential|password|username|invalid user/.test(msg)) {
          detail = `credentials rejected (ErrorCode ${errCode ?? "?"}: "${errMsg}")`;
          console.log(`  FAIL: ${detail}`);
        } else {
          detail = `no TokenId (ErrorCode ${errCode ?? "?"}: "${errMsg ?? "unknown"}")`;
          console.log(`  FAIL: ${detail}`);
        }
        rows.push({ host: `${authHost} (auth)`, probe: "Authenticate", pass: false, detail });
      }
    }
  }
  console.log("");

  /* ── PROBE 2: Search (search host reachability) ───────────────────────── */
  console.log("--- PROBE 2/3: Search (reachability only — fares ignored) ---");
  console.log(`  POST ${searchHost}/Search`);
  {
    const usedDummy = !tokenId;
    if (usedDummy) {
      console.log("  NOTE: auth failed — using a dummy token to test SEARCH-HOST reachability independently.");
    }
    // Minimal valid-shaped one-way domestic search ~30 days out, 1 ADT, economy.
    // We do NOT read fares — ANY TBO JSON response proves we got through the firewall.
    const depart = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const result = await probePost(flightBase, "/Search", {
      EndUserIp: endUserIp,
      TokenId: tokenId ?? DUMMY_TOKEN,
      AdultCount: "1",
      ChildCount: "0",
      InfantCount: "0",
      DirectFlight: "false",
      OneStopFlight: "false",
      JourneyType: "1",
      PreferredAirlines: null,
      Segments: [
        {
          Origin: "DEL",
          Destination: "BOM",
          FlightCabinClass: "1",
          PreferredDepartureTime: `${depart}T00:00:00`,
          PreferredArrivalTime: `${depart}T00:00:00`,
        },
      ],
      Sources: null,
    });

    if (result.layer === "network") {
      console.log(`  NETWORK FAILURE: ${result.detail}`);
      console.log("  => BLOCKED at network layer — search host NOT reachable / not whitelisted.");
      rows.push({ host: `${searchHost} (search)`, probe: "Search reachable", pass: false, detail: `network blocked: ${result.detail}` });
    } else {
      const errMsg = tboErrorMessage(result.json);
      console.log(`  PASS: got through firewall — TBO responded (HTTP ${result.httpStatus}).`);
      console.log(`        ${errMsg ? `TBO app message: "${errMsg}" (fine — reachability is what we tested)` : "TBO returned a search result body."}`);
      const detail = usedDummy
        ? "REACHABLE (auth failed — dummy token, reachability only)"
        : "got through firewall (TBO responded)";
      rows.push({ host: `${searchHost} (search)`, probe: "Search reachable", pass: true, detail });
    }
  }
  console.log("");

  /* ── PROBE 3: GetBookingDetails (booking host reachability) ───────────── */
  console.log("--- PROBE 3/3: GetBookingDetails (dummy id — error expected, reachability only) ---");
  console.log(`  POST ${bookingHost}/GetBookingDetails`);
  {
    const usedDummy = !tokenId;
    if (usedDummy) {
      console.log("  NOTE: auth failed — using a dummy token to test BOOKING-HOST reachability independently.");
    }
    // Dummy/known-bad BookingId. We EXPECT a TBO error (invalid booking / invalid
    // token) — that's a PASS: it proves the booking host is reachable/whitelisted.
    // This reads nothing real.
    const result = await probePost(bookingBase, "/GetBookingDetails", {
      EndUserIp: endUserIp,
      TokenId: tokenId ?? DUMMY_TOKEN,
      BookingId: "1",
    });

    if (result.layer === "network") {
      console.log(`  NETWORK FAILURE: ${result.detail}`);
      console.log("  => BLOCKED at network layer — booking host NOT reachable / not whitelisted.");
      rows.push({ host: `${bookingHost} (booking)`, probe: "GetBookingDetails", pass: false, detail: `network blocked: ${result.detail}` });
    } else {
      const errMsg = tboErrorMessage(result.json);
      console.log(`  PASS: got through firewall — TBO responded (HTTP ${result.httpStatus}).`);
      console.log(`        ${errMsg ? `TBO app message: "${errMsg}" (expected — dummy booking id)` : "TBO returned a body."}`);
      const detail = usedDummy
        ? "REACHABLE (auth failed — dummy token, reachability only)"
        : "got through firewall (TBO responded)";
      rows.push({ host: `${bookingHost} (booking)`, probe: "GetBookingDetails", pass: true, detail });
    }
  }
  console.log("");

  /* ── Results table ────────────────────────────────────────────────────── */
  const hostW = Math.max(4, ...rows.map((r) => r.host.length));
  const probeW = Math.max(5, ...rows.map((r) => r.probe.length));
  const detailW = Math.max(6, ...rows.map((r) => r.detail.length));
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const sep = `+-${"-".repeat(hostW)}-+-${"-".repeat(probeW)}-+--------+-${"-".repeat(detailW)}-+`;

  console.log("==================================================================");
  console.log(" RESULTS");
  console.log("==================================================================");
  console.log(sep);
  console.log(`| ${pad("Host", hostW)} | ${pad("Probe", probeW)} | Result | ${pad("Detail", detailW)} |`);
  console.log(sep);
  for (const r of rows) {
    console.log(`| ${pad(r.host, hostW)} | ${pad(r.probe, probeW)} | ${r.pass ? "PASS  " : "FAIL  "} | ${pad(r.detail, detailW)} |`);
  }
  console.log(sep);
  console.log("");

  // Cutover requires BOTH: auth actually succeeded (real token), AND the search
  // and booking hosts are reachable. A reachability-only PASS on a dummy token
  // (auth failed) must NEVER read as "clear to cut over".
  const authPass = rows.find((r) => r.probe === "Authenticate")?.pass === true;
  const searchPass = rows.find((r) => r.probe === "Search reachable")?.pass === true;
  const bookingPass = rows.find((r) => r.probe === "GetBookingDetails")?.pass === true;

  if (authPass && searchPass && bookingPass) {
    console.log("VERDICT: AUTH OK + ALL THREE HOSTS REACHABLE — clear to cut over.");
    process.exit(0);
  } else if (!authPass && searchPass && bookingPass) {
    console.log("VERDICT: BLOCKED — both flight hosts are REACHABLE, but AUTH FAILED (dummy-token reachability only).");
    console.log("         Fix auth (creds / IP whitelist on the auth host), then re-run. Do NOT cut over.");
    process.exit(1);
  } else {
    console.log("VERDICT: BLOCKED — see table above. Do NOT cut over until auth PASSES and all three hosts are reachable.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Probe crashed unexpectedly:", e);
  process.exit(1);
});
