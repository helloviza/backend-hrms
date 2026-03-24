#!/usr/bin/env node
/**
 * deploy-check.mjs
 *
 * 1. Triggers App Runner redeployment via AWS SDK
 * 2. Polls /api/health every 10s until uptime < 60s (fresh deploy)
 * 3. Runs hotel city search smoke test with admin credentials
 * 4. Prints PASS / FAIL
 *
 * Usage:
 *   node scripts/deploy-check.mjs
 *
 * Required env vars (from .env or exported):
 *   APPRUNNER_SERVICE_ARN  — App Runner service ARN
 *   AWS_REGION             — e.g. ap-south-1
 *   ADMIN_EMAIL            — admin login email
 *   ADMIN_PASSWORD         — admin login password
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

// ─── Config ──────────────────────────────────────────────────────────────────

const SERVICE_ARN = process.env.APPRUNNER_SERVICE_ARN;
const REGION = process.env.AWS_REGION || "ap-south-1";
const API_BASE = process.env.PROD_API_BASE || "https://api.hrms.plumtrips.com";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const POLL_INTERVAL_MS = 10_000; // 10 seconds
const MAX_POLL_ATTEMPTS = 60;    // 10 minutes max wait
const UPTIME_THRESHOLD = 60;     // seconds — fresh deploy indicator

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function fail(msg) {
  console.error(`\n${"=".repeat(50)}`);
  console.error(`  FAIL: ${msg}`);
  console.error(`${"=".repeat(50)}\n`);
  process.exit(1);
}

function pass(msg) {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  PASS: ${msg}`);
  console.log(`${"=".repeat(50)}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Step 1: Trigger App Runner Redeployment ─────────────────────────────────

async function triggerDeploy() {
  if (!SERVICE_ARN) {
    fail("APPRUNNER_SERVICE_ARN not set in env");
  }

  log("Importing @aws-sdk/client-apprunner...");
  const { AppRunnerClient, StartDeploymentCommand } = await import(
    "@aws-sdk/client-apprunner"
  );

  const client = new AppRunnerClient({ region: REGION });
  log(`Triggering redeployment for: ${SERVICE_ARN}`);

  const result = await client.send(
    new StartDeploymentCommand({ ServiceArn: SERVICE_ARN })
  );

  const operationId = result.OperationId;
  log(`Deployment triggered — OperationId: ${operationId}`);
  return operationId;
}

// ─── Step 2: Poll /api/health Until Uptime Resets ────────────────────────────

async function waitForFreshDeploy() {
  log(`Polling ${API_BASE}/api/health every ${POLL_INTERVAL_MS / 1000}s...`);
  log(`Waiting for uptime < ${UPTIME_THRESHOLD}s (fresh instance)\n`);

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) {
        const data = await res.json();
        const uptime = Math.round(data.uptime || 9999);

        if (uptime < UPTIME_THRESHOLD) {
          log(`Uptime: ${uptime}s — fresh deploy detected!`);
          return data;
        }

        log(`Attempt ${attempt}/${MAX_POLL_ATTEMPTS} — uptime: ${uptime}s (waiting for restart)`);
      } else {
        log(`Attempt ${attempt}/${MAX_POLL_ATTEMPTS} — HTTP ${res.status} (deploying...)`);
      }
    } catch (err) {
      log(`Attempt ${attempt}/${MAX_POLL_ATTEMPTS} — ${err.cause?.code || err.message} (deploying...)`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  fail(`Timed out after ${MAX_POLL_ATTEMPTS} attempts — deploy did not complete`);
}

// ─── Step 3: Smoke Test — Login + Hotel City Search ──────────────────────────

async function smokeTest() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    fail("ADMIN_EMAIL and ADMIN_PASSWORD must be set in env");
  }

  // 3a. Login to get JWT
  log("Logging in as admin...");
  const loginRes = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });

  if (!loginRes.ok) {
    const body = await loginRes.text();
    fail(`Login failed (HTTP ${loginRes.status}): ${body.slice(0, 200)}`);
  }

  const loginData = await loginRes.json();
  const token = loginData.token || loginData.accessToken;
  if (!token) {
    fail(`Login response missing token: ${JSON.stringify(loginData).slice(0, 200)}`);
  }
  log("Login OK — token acquired");

  // 3b. Hotel city search
  log('Testing GET /api/sbt/hotels/cities?q=Mumbai ...');
  const cityRes = await fetch(
    `${API_BASE}/api/sbt/hotels/cities?q=Mumbai`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!cityRes.ok) {
    const body = await cityRes.text();
    fail(`Hotel city search failed (HTTP ${cityRes.status}): ${body.slice(0, 200)}`);
  }

  const cityData = await cityRes.json();

  // Handle both real TBO response (array) and mock response ({ cities: [] })
  const cities = Array.isArray(cityData) ? cityData : cityData.cities || [];
  if (!cities.length) {
    fail("Hotel city search returned 0 results for 'Mumbai'");
  }

  const mumbai = cities.find(
    (c) => (c.CityName || c.cityName || "").toLowerCase() === "mumbai"
  );
  if (!mumbai) {
    fail(`'Mumbai' not found in results: ${JSON.stringify(cities.slice(0, 3))}`);
  }

  log(`Hotel city search OK — found ${cities.length} cities, Mumbai confirmed`);

  // 3c. Health endpoint (verify rate limit headers present)
  log("Checking rate limit headers...");
  const healthRes = await fetch(`${API_BASE}/api/health`);
  const rlLimit = healthRes.headers.get("ratelimit-limit");
  const rlRemaining = healthRes.headers.get("ratelimit-remaining");

  if (rlLimit) {
    log(`Rate limiting active — limit: ${rlLimit}, remaining: ${rlRemaining}`);
  } else {
    log("Warning: rate limit headers not present on /api/health");
  }

  return { cities: cities.length, rateLimitActive: !!rlLimit };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n" + "=".repeat(50));
  console.log("  DEPLOY CHECK — plumtrips-hrms backend");
  console.log("=".repeat(50) + "\n");

  // Step 1
  await triggerDeploy();

  // Step 2
  const health = await waitForFreshDeploy();
  log(`New instance: env=${health.env}, time=${health.time}`);

  // Step 3
  const results = await smokeTest();

  // Report
  pass(
    [
      "Deployment verified",
      `  Server: ${API_BASE}`,
      `  Uptime: ${Math.round(health.uptime)}s`,
      `  Hotel cities: ${results.cities} results`,
      `  Rate limiting: ${results.rateLimitActive ? "active" : "headers not detected"}`,
    ].join("\n")
  );
}

main().catch((err) => {
  fail(err.message || String(err));
});
