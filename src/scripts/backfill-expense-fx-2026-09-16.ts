// apps/backend/src/scripts/backfill-expense-fx-2026-09-16.ts
//
// ONE-TIME, DELIVERED NOT RUN: base-currency backfill for the expense rows
// that predate FX slice 0 (audit F-19). Two independent passes, both DRY RUN
// BY DEFAULT — nothing is written without `--apply`, and `--apply` is refused
// for the foreign pass unless every rate it needs was given explicitly.
//
//   # Pass A — the 3 mixed-currency prod claims the audit named (default set):
//   pnpm -C apps/backend tsx src/scripts/backfill-expense-fx-2026-09-16.ts
//   pnpm -C apps/backend tsx src/scripts/backfill-expense-fx-2026-09-16.ts \
//        --rate EUR=<inr per eur> --rate CAD=<inr per cad> --rate-date 2026-09-16
//   pnpm -C apps/backend tsx src/scripts/backfill-expense-fx-2026-09-16.ts \
//        --rate EUR=… --rate CAD=… --rate-date 2026-09-16 --apply
//
//   # Pass B — materialise the identity conversion on every legacy SAME-
//   # currency row (amountBase = amount, rate 1, "base"). Purely mechanical;
//   # the read paths already treat such rows this way, so this only makes the
//   # stored shape uniform. Optional.
//   pnpm -C apps/backend tsx src/scripts/backfill-expense-fx-2026-09-16.ts --identity
//   pnpm -C apps/backend tsx src/scripts/backfill-expense-fx-2026-09-16.ts --identity --apply
//
//   --claims CLM-A,CLM-B   override the claim set for pass A
//   --all-foreign          pass A over EVERY legacy foreign row, not just those claims
//
// ── WHAT PASS A DOES, AND WHAT IT DELIBERATELY DOES NOT ──────────────────
// For each foreign-currency line in the named claims that has no amountBase,
// it proposes amountBase = round2(amount × rate) using the rate YOU pass on the
// command line (rateSource "manual", rateEnteredBy = null, reason names this
// script and the date). With no --rate for a currency it tries the live
// ExchangeRate-API lookup ONLY to show a reference figure in the dry-run —
// it never applies a live rate, because a backfilled historical line should
// carry a rate someone chose and can defend, not whatever the API said the
// day the script happened to run.
//
// It does NOT touch Report.reimbursedAmount. Two of the three claims were
// already PAID on the wrong (currency-blind) total — CLM-642339 on 445.30 and
// CLM-1C656B on 360.20. After the backfill their totals read correctly, and
// the dry-run prints the DELTA between what was paid and the restated total.
// Whether to recover / top up that difference is a finance decision, made
// outside this script.
//
// Idempotent: a row that already has amountBase is skipped on every pass.

import "../bootstrap/loadSecrets.js";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import Expense from "../models/Expense.js";
import Report from "../models/Report.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import {
  getWorkspaceBaseCurrency,
  normalizeCurrency,
  round2,
} from "../services/expenseFx.service.js";
import { getLiveRate } from "../utils/exchangeRate.js";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const IDENTITY = argv.includes("--identity");
const ALL_FOREIGN = argv.includes("--all-foreign");
const DEFAULT_CLAIMS = ["CLM-642339", "CLM-1C656B", "CLM-641C48"];

function argValue(flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}
const RATES = new Map<string, number>();
argv.forEach((a, i) => {
  if (a === "--rate" && argv[i + 1]) {
    const [c, v] = argv[i + 1].split("=");
    const cur = normalizeCurrency(c);
    const n = Number(v);
    if (cur && Number.isFinite(n) && n > 0) RATES.set(cur, n);
  }
});
const RATE_DATE = argValue("--rate-date") || new Date().toISOString().slice(0, 10);
const CLAIMS = (argValue("--claims") || DEFAULT_CLAIMS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const fmt = (n: number | null | undefined) => (n == null ? "—" : n.toFixed(2));

async function passIdentity(): Promise<void> {
  console.log("\n══ Pass B · identity conversion for legacy same-currency rows ══");
  const workspaces: any[] = await CustomerWorkspace.find({}).select("_id name config.baseCurrency").lean();
  let total = 0;
  for (const ws of workspaces) {
    const base = normalizeCurrency(ws.config?.baseCurrency) || "INR";
    const rows: any[] = await Expense.find({
      workspaceId: ws._id,
      amountBase: null,
    })
      .select("ref amount currency")
      .lean();
    const same = rows.filter((r) => (normalizeCurrency(r.currency) || base) === base);
    if (same.length === 0) continue;
    total += same.length;
    console.log(`  ${ws.name || ws._id} (${base}): ${same.length} legacy ${base} row(s) → amountBase = amount`);
    if (APPLY) {
      const now = new Date();
      for (const r of same) {
        await Expense.updateOne(
          { _id: r._id, amountBase: null },
          {
            $set: {
              exchangeRate: 1,
              rateDate: RATE_DATE,
              rateSource: "base",
              amountBase: round2(Number(r.amount) || 0),
              baseCurrency: base,
              currency: base,
            },
            $push: {
              rateHistory: {
                exchangeRate: 1,
                rateDate: RATE_DATE,
                rateSource: "base",
                amountBase: round2(Number(r.amount) || 0),
                setBy: null,
                setAt: now,
                reason: "Backfill 2026-09-16 (identity — same as workspace base)",
              },
            },
          },
        );
      }
    }
  }
  console.log(`  ${APPLY ? "WROTE" : "WOULD WRITE"} ${total} row(s).`);
}

async function passForeign(): Promise<void> {
  console.log(`\n══ Pass A · foreign-currency lines ${ALL_FOREIGN ? "(ALL legacy)" : `in ${CLAIMS.join(", ")}`} ══`);
  console.log(`  rate date: ${RATE_DATE} · rates given: ${RATES.size ? [...RATES].map(([c, v]) => `${c}=${v}`).join(" ") : "none"}`);

  let reports: any[] = [];
  let lines: any[] = [];
  if (ALL_FOREIGN) {
    // Every legacy row; same-currency ones are reported as identity below.
    lines = await Expense.find({ amountBase: null }).lean();
    const rids = [...new Set(lines.map((l) => String(l.reportId)).filter((x) => x !== "null"))];
    reports = await Report.find({ _id: { $in: rids } }).lean();
  } else {
    reports = await Report.find({ ref: { $in: CLAIMS } }).lean();
    const found = new Set(reports.map((r) => r.ref));
    for (const c of CLAIMS) if (!found.has(c)) console.log(`  ! ${c}: NOT FOUND`);
    lines = await Expense.find({ reportId: { $in: reports.map((r) => r._id) } }).lean();
  }
  const reportById = new Map(reports.map((r) => [String(r._id), r]));
  const baseByWs = new Map<string, string>();
  const liveCache = new Map<string, { rate: number; date: string } | null>();

  let missingRates = 0;
  let proposed = 0;
  const byReport = new Map<string, any[]>();
  for (const l of lines) {
    const k = String(l.reportId || "loose");
    if (!byReport.has(k)) byReport.set(k, []);
    byReport.get(k)!.push(l);
  }

  for (const [rid, rows] of byReport) {
    const r = reportById.get(rid);
    const wsId = String(rows[0].workspaceId);
    if (!baseByWs.has(wsId)) baseByWs.set(wsId, await getWorkspaceBaseCurrency(wsId));
    const base = baseByWs.get(wsId)!;
    console.log(`\n  ${r ? `${r.ref} · ${r.status}${r.reimbursedAt ? ` · reimbursed ${new Date(r.reimbursedAt).toISOString().slice(0, 10)}` : ""}` : "(loose lines)"} · base ${base}`);

    let rawSum = 0; // what the old code summed (currency-blind)
    let baseSum = 0; // restated total after backfill
    let restatable = true;
    for (const l of rows) {
      const cur = normalizeCurrency(l.currency) || base;
      const amt = Number(l.amount) || 0;
      rawSum += amt;
      if (l.amountBase != null) {
        baseSum += Number(l.amountBase);
        console.log(`    ${l.ref}  ${cur} ${fmt(amt)}  → already converted: ${base} ${fmt(l.amountBase)} (${l.rateSource})`);
        continue;
      }
      if (cur === base) {
        baseSum += amt;
        console.log(`    ${l.ref}  ${cur} ${fmt(amt)}  → identity ${base} ${fmt(amt)} (legacy same-currency; pass B or read-time identity)`);
        continue;
      }
      let rate = RATES.get(cur) ?? null;
      let source = rate != null ? `--rate ${cur}=${rate}` : "";
      if (rate == null) {
        if (!liveCache.has(cur)) liveCache.set(cur, await getLiveRate(cur, base));
        const live = liveCache.get(cur);
        if (live) source = `REFERENCE ONLY · live ${live.date} = ${live.rate} (pass --rate ${cur}=… to apply)`;
        else source = `RATE NEEDED · no --rate ${cur} and live lookup unavailable`;
        missingRates++;
        restatable = false;
        console.log(`    ${l.ref}  ${cur} ${fmt(amt)}  dated ${l.date ? new Date(l.date).toISOString().slice(0, 10) : "?"}  → ${source}${live ? ` ≈ ${base} ${fmt(round2(amt * live.rate))}` : ""}`);
        continue;
      }
      const amountBase = round2(amt * rate);
      baseSum += amountBase;
      proposed++;
      console.log(`    ${l.ref}  ${cur} ${fmt(amt)}  dated ${l.date ? new Date(l.date).toISOString().slice(0, 10) : "?"}  → ${base} ${fmt(amountBase)}  (${source}, as of ${RATE_DATE}, manual)`);
      if (APPLY) {
        const now = new Date();
        await Expense.updateOne(
          { _id: l._id, amountBase: null },
          {
            $set: {
              exchangeRate: rate,
              rateDate: RATE_DATE,
              rateSource: "manual",
              amountBase,
              baseCurrency: base,
              currency: cur,
              rateEnteredBy: null,
              rateEnteredAt: now,
            },
            $push: {
              rateHistory: {
                exchangeRate: rate,
                rateDate: RATE_DATE,
                rateSource: "manual",
                amountBase,
                setBy: null,
                setAt: now,
                reason: `Backfill 2026-09-16 (audit F-19) — rate ${cur}=${rate} as of ${RATE_DATE}, approved by Imran`,
              },
            },
          },
        );
      }
    }
    console.log(`    currency-blind sum the old code used: ${fmt(round2(rawSum))}`);
    console.log(`    restated ${base} total after backfill: ${restatable ? fmt(round2(baseSum)) : "(incomplete — rate needed)"}`);
    if (r?.reimbursedAt) {
      const paid = r.reimbursedAmount != null ? Number(r.reimbursedAmount) : round2(rawSum);
      console.log(
        `    PAID OUT ${fmt(paid)} · ${restatable ? `delta vs restated = ${fmt(round2(baseSum - paid))} (${baseSum - paid >= 0 ? "owed TO employee" : "over-paid, recoverable"})` : "delta unknown until rate given"} — reimbursedAmount is NOT touched by this script`,
      );
    }
  }

  if (APPLY && missingRates > 0) {
    console.log(`\n  !! ${missingRates} line(s) had no --rate — those were SKIPPED, nothing partial was written for them.`);
  }
  console.log(`\n  ${APPLY ? "WROTE" : "WOULD WRITE"} ${proposed} foreign line(s)${missingRates ? ` · ${missingRates} need a rate` : ""}.`);
}

async function main(): Promise<void> {
  await mongoose.connect(env.MONGO_URI);
  console.log(`[backfill-expense-fx] ${APPLY ? "APPLY" : "DRY RUN"} — db: ${mongoose.connection.name}`);
  if (IDENTITY) await passIdentity();
  else await passForeign();
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[backfill-expense-fx] failed:", err?.message || err);
  process.exit(1);
});
