/**
 * Loyalty Points — LOCAL demo data for walking Phases 1–2 in a browser.
 *
 * Four demo client companies, one per Rewards card state, each with a
 * workspace (loyaltyRewardsEnabled ON) and a client login with billing access:
 *
 *   A  Demo Eligible Ltd      GSTIN; ₹25L paid before the start; after it two
 *                             PAID + two SENT (one overdue) invoices and one
 *                             issued credit note → Ready to use + On the way
 *   B  Demo Locked Pvt Ltd    GSTIN; ₹12L before; one PAID + one SENT after
 *                             → Locked + progress bar + On the way
 *   C  Demo Future Start      GSTIN; account startDateOverride 2026-12-01
 *                             → "starts on" state
 *   D  Demo Unregistered      no GSTIN → not-enrolled state
 *
 * plus a company-A user WITHOUT billing access (must not see Rewards), and the
 * programme start date (LoyaltySettings.launchDate) set to 2026-10-01 IST.
 *
 * It does NOT compute points. Run scripts/loyalty-reconcile.ts afterwards,
 * exactly as production would.
 *
 * USAGE (from apps/backend)
 *   node --env-file=.env.development --import tsx scripts/dev/seed-loyalty-demo.ts           # (re)seed
 *   node --env-file=.env.development --import tsx scripts/loyalty-reconcile.ts               # earn points
 *   node --env-file=.env.development --import tsx scripts/dev/seed-loyalty-demo.ts --status  # balances
 *   node --env-file=.env.development --import tsx scripts/dev/seed-loyalty-demo.ts --reset   # remove it all
 *
 * SAFETY. Refuses to run unless MONGO_URI is a local host (127.0.0.1 /
 * localhost — seed/assertLocalDatabase.ts), checked again on the live
 * connection. Every document it writes carries seedTag "loyalty-demo" (raw
 * inserts, so the field survives Mongoose's strict mode); --reset and the
 * re-seed remove only those, plus the loyalty accounts / ledger rows /
 * unlock emails that belong to the demo customers. If the settings row did
 * not exist, the seed creates it (tagged, with the earn rate starting on the
 * demo launch date) and --reset deletes it; otherwise --reset restores the
 * launch date it changed, from its own change-log entry.
 *
 * Invoices are NOT isDemo (that flag excludes an invoice from loyalty) — the
 * tag is seedTag, and every number starts LDEMO-.
 */
import "../../src/bootstrap/loadSecrets.js";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { env } from "../../src/config/env.js";
import { assertLocalDatabase } from "../../src/seed/assertLocalDatabase.js";
import Customer, { normalizeCustomerLegalName } from "../../src/models/Customer.js";
import CustomerWorkspace from "../../src/models/CustomerWorkspace.js";
import CustomerMember from "../../src/models/CustomerMember.js";
import User from "../../src/models/User.js";
import Invoice from "../../src/models/Invoice.js";
import CreditNote from "../../src/models/CreditNote.js";
import LoyaltySettings, { DEFAULT_LAUNCH_DATE } from "../../src/models/LoyaltySettings.js";
import LoyaltyAccount from "../../src/models/LoyaltyAccount.js";
import LoyaltyLedger from "../../src/models/LoyaltyLedger.js";
import EmailOutbox from "../../src/models/EmailOutbox.js";
import { ensureAccountForCustomer, getLoyaltySettings } from "../../src/services/loyalty.js";

const TAG = "loyalty-demo";
const ACTOR = "script:seed-loyalty-demo";
const PASSWORD = "LoyaltyDemo!2026";
const LAUNCH = new Date("2026-10-01T00:00:00+05:30");
const GST = 0.18;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

const RESET = process.argv.includes("--reset");
const STATUS = process.argv.includes("--status");

const ist = (day: string) => new Date(`${day}T11:00:00+05:30`);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

interface InvoiceSpec {
  no: string;
  taxable: number;
  day: string;
  status: "SENT" | "PAID";
  dueDay?: string;
  paidDay?: string;
}

interface CompanySpec {
  key: string;
  legalName: string;
  slug: string;
  gstin: string | null;
  email: string;
  firstName: string;
  lastName: string;
  startDateOverride?: Date;
  invoices: InvoiceSpec[];
  creditNote?: { no: string; onInvoice: string; taxable: number; day: string };
}

// Five ₹5L invoices before the start = ₹25L for company A, and so on.
const past = (prefix: string, count: number, taxable: number): InvoiceSpec[] =>
  Array.from({ length: count }, (_, i) => ({
    no: `${prefix}-P${i + 1}`,
    taxable,
    day: `2026-0${5 + i}-10`,
    status: "PAID" as const,
    paidDay: `2026-0${5 + i}-20`,
  }));

const COMPANIES: CompanySpec[] = [
  {
    key: "A", legalName: "Demo Eligible Ltd", slug: "loyalty-demo-eligible", gstin: "27AAACD1001A1Z5",
    email: "billing@demo-eligible.test", firstName: "Asha", lastName: "Eligible",
    invoices: [
      ...past("LDEMO-A", 5, 500_000),
      { no: "LDEMO-A-101", taxable: 200_000, day: "2026-10-03", status: "PAID", paidDay: "2026-10-12" },
      { no: "LDEMO-A-102", taxable: 150_000, day: "2026-10-06", status: "PAID", paidDay: "2026-10-15" },
      { no: "LDEMO-A-103", taxable: 80_000, day: "2026-10-02", status: "SENT", dueDay: "2026-10-12" }, // overdue
      { no: "LDEMO-A-104", taxable: 60_000, day: "2026-10-14", status: "SENT", dueDay: "2026-11-13" },
    ],
    creditNote: { no: "LDEMO-CN-A-101", onInvoice: "LDEMO-A-101", taxable: 30_000, day: "2026-10-14" },
  },
  {
    key: "B", legalName: "Demo Locked Pvt Ltd", slug: "loyalty-demo-locked", gstin: "27AAACD1002B1Z3",
    email: "billing@demo-locked.test", firstName: "Bharat", lastName: "Locked",
    invoices: [
      ...past("LDEMO-B", 3, 400_000),
      { no: "LDEMO-B-101", taxable: 120_000, day: "2026-10-05", status: "PAID", paidDay: "2026-10-13" },
      { no: "LDEMO-B-102", taxable: 50_000, day: "2026-10-09", status: "SENT", dueDay: "2026-11-08" },
    ],
  },
  {
    key: "C", legalName: "Demo Future Start", slug: "loyalty-demo-future", gstin: "27AAACD1003C1Z1",
    email: "billing@demo-future.test", firstName: "Chitra", lastName: "Future",
    startDateOverride: new Date("2026-12-01T00:00:00+05:30"),
    invoices: [
      ...past("LDEMO-C", 2, 400_000),
      { no: "LDEMO-C-101", taxable: 100_000, day: "2026-10-07", status: "PAID", paidDay: "2026-10-16" },
    ],
  },
  {
    key: "D", legalName: "Demo Unregistered", slug: "loyalty-demo-unregistered", gstin: null,
    email: "billing@demo-unregistered.test", firstName: "Dev", lastName: "Unregistered",
    invoices: [
      ...past("LDEMO-D", 1, 300_000),
      { no: "LDEMO-D-101", taxable: 50_000, day: "2026-10-08", status: "PAID", paidDay: "2026-10-17" },
    ],
  },
];
const NO_BILLING = { email: "traveller@demo-eligible.test", firstName: "Tara", lastName: "Traveller", company: "A" };
const DEMO_EMAILS = [...COMPANIES.map((c) => c.email), NO_BILLING.email];

/** Builds a document through its Mongoose model (defaults + validation), tags it, inserts it raw. */
async function insertTagged(model: mongoose.Model<any>, data: Record<string, unknown>, times?: { createdAt: Date }) {
  const doc = new model(data);
  const err = doc.validateSync();
  if (err) throw err;
  const obj: any = doc.toObject({ depopulate: true });
  obj.seedTag = TAG;
  const at = times?.createdAt ?? new Date();
  obj.createdAt = at;
  obj.updatedAt = at;
  await model.collection.insertOne(obj);
  return obj;
}

async function demoCustomerIds(): Promise<string[]> {
  const rows = await Customer.collection.find({ seedTag: TAG }, { projection: { _id: 1 } }).toArray();
  return rows.map((r) => String(r._id));
}

async function teardown(): Promise<void> {
  const customerIds = await demoCustomerIds();
  const accounts = await LoyaltyAccount.collection
    .find({ $or: [{ seedTag: TAG }, { memberCustomerIds: { $in: customerIds } }] }, { projection: { _id: 1 } })
    .toArray();
  const accountIds = accounts.map((a) => a._id);
  const counts: Record<string, number> = {};
  const del = async (name: string, model: mongoose.Model<any>, filter: Record<string, unknown>) => {
    counts[name] = (await model.collection.deleteMany(filter)).deletedCount ?? 0;
  };
  // LoyaltyLedger.accountId is a string; match both forms, plus any row naming a demo customer.
  await del("loyalty ledger rows", LoyaltyLedger, {
    $or: [{ accountId: { $in: [...accountIds, ...accountIds.map(String)] } }, { customerId: { $in: customerIds } }],
  });
  await del("loyalty accounts", LoyaltyAccount, { _id: { $in: accountIds } });
  await del("unlock emails", EmailOutbox, { event: "loyalty_unlocked", to: { $in: DEMO_EMAILS } });
  await del("credit notes", CreditNote, { seedTag: TAG });
  await del("invoices", Invoice, { seedTag: TAG });
  await del("customer members", CustomerMember, { seedTag: TAG });
  await del("users", User, { seedTag: TAG });
  await del("workspaces", CustomerWorkspace, { seedTag: TAG });
  await del("customers", Customer, { seedTag: TAG });
  console.log(`[loyalty-demo] removed: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")}`);
}

/** Deletes the settings row if this script created it; else restores the launch date it replaced. */
async function restoreLaunchDate(): Promise<void> {
  const s: any = await LoyaltySettings.collection.findOne({ key: "global" });
  if (s?.seedTag === TAG) {
    await LoyaltySettings.collection.deleteOne({ _id: s._id });
    console.log("[loyalty-demo] settings row removed (the seed created it; the next read recreates the defaults)");
    return;
  }
  const mine = [...(s?.changeLog ?? [])].reverse().find((c: any) => c.by === ACTOR && c.field === "launchDate");
  if (!mine) return;
  const original = mine.old ? new Date(mine.old) : null;
  if (!original || original.getTime() === new Date(s.launchDate).getTime()) return;
  await LoyaltySettings.collection.updateOne({ key: "global" }, {
    $set: { launchDate: original },
    $push: { changeLog: { at: new Date(), by: ACTOR, field: "launchDate", old: s.launchDate, new: original, reason: "Loyalty demo removed (--reset)" } } as any,
  });
  console.log(`[loyalty-demo] launchDate restored to ${original.toISOString()}`);
}

async function setLaunchDate(): Promise<void> {
  if (!(await LoyaltySettings.collection.findOne({ key: "global" }))) {
    // No row yet: create it with the demo launch date BEFORE the first read,
    // so the seeded earn rate also starts on 2026-10-01.
    await LoyaltySettings.create({
      key: "global", launchDate: LAUNCH,
      changeLog: [{ at: new Date(), by: ACTOR, field: "launchDate", old: DEFAULT_LAUNCH_DATE, new: LAUNCH, reason: "Local loyalty demo" }],
    });
    await LoyaltySettings.collection.updateOne({ key: "global" }, { $set: { seedTag: TAG } });
    await getLoyaltySettings();
    console.log(`[loyalty-demo] settings row created with launchDate ${LAUNCH.toISOString()} (2026-10-01 IST)`);
    return;
  }
  const s = await getLoyaltySettings();
  if (new Date(s.launchDate).getTime() === LAUNCH.getTime()) return;
  await LoyaltySettings.collection.updateOne({ key: "global" }, {
    $set: { launchDate: LAUNCH },
    $push: { changeLog: { at: new Date(), by: ACTOR, field: "launchDate", old: s.launchDate, new: LAUNCH, reason: "Local loyalty demo" } } as any,
  });
  console.log(`[loyalty-demo] launchDate ${new Date(s.launchDate).toISOString()} → ${LAUNCH.toISOString()} (2026-10-01 IST)`);
}

async function seed(): Promise<void> {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  for (const c of COMPANIES) {
    const customerId = new mongoose.Types.ObjectId();
    const cid = String(customerId);
    const customerDoc: Record<string, unknown> = {
      _id: customerId, legalName: c.legalName, name: c.legalName, type: "CUSTOMER", customerType: "BUSINESS",
      status: "ACTIVE", isActive: true, email: c.email,
      ...(c.gstin ? { gstNumber: c.gstin, gstStatus: "REGISTERED" } : {}),
    };
    const customer = await insertTagged(Customer, customerDoc);
    await Customer.collection.updateOne({ _id: customerId }, { $set: { legalNameNormalized: normalizeCustomerLegalName(customer) } });

    const ws = await insertTagged(CustomerWorkspace, {
      customerId: cid, slug: c.slug, companyName: c.legalName, status: "ACTIVE", accessMode: "INVITE_ONLY",
      config: {
        travelFlow: "SBT",
        features: { loyaltyRewardsEnabled: true, invoicesEnabled: true, sbtEnabled: true, flightBookingEnabled: true, hotelBookingEnabled: true },
      },
    });
    await Customer.collection.updateOne({ _id: customerId }, { $set: { workspaceId: String(ws._id) } });

    const people = [{ email: c.email, firstName: c.firstName, lastName: c.lastName, canViewBilling: true }];
    if (NO_BILLING.company === c.key) people.push({ ...NO_BILLING, canViewBilling: false });
    for (const p of people) {
      await insertTagged(User, {
        email: p.email, passwordHash, firstName: p.firstName, lastName: p.lastName, name: `${p.firstName} ${p.lastName}`,
        roles: ["CUSTOMER"], workspaceId: ws._id, customerId: cid, businessId: cid,
        isActive: true, status: "ACTIVE", canViewBilling: p.canViewBilling,
      });
      await insertTagged(CustomerMember, {
        customerId: cid, email: p.email, name: `${p.firstName} ${p.lastName}`, role: "REQUESTER", isActive: true, travelerId: "",
      });
    }

    const byNo = new Map<string, any>();
    for (const i of c.invoices) {
      const at = ist(i.day);
      const gst = Math.round(i.taxable * GST);
      const inv = await insertTagged(Invoice, {
        invoiceNo: i.no, workspaceId: ws._id, status: i.status, invoiceDate: at, generatedAt: at,
        dueDate: i.dueDay ? ist(i.dueDay) : addDays(at, 15),
        sentAt: at, ...(i.paidDay ? { paidAt: ist(i.paidDay) } : {}),
        subtotal: i.taxable, totalGST: gst, igstAmount: gst, grandTotal: i.taxable + gst, supplyType: "IGST",
        lineItems: [{ description: "Travel services (loyalty demo)", quantity: 1, amount: i.taxable, gstAmount: gst, total: i.taxable + gst }],
        clientDetails: { companyName: c.legalName, gstin: c.gstin ?? "", email: c.email, state: "Maharashtra" },
        issuerDetails: { companyName: "Plumtrips", state: "Maharashtra" },
        billingPeriod: i.day.slice(0, 7),
      }, { createdAt: at }); // createdAt on/after the start is what lets it earn
      byNo.set(i.no, inv);
    }

    if (c.creditNote) {
      const orig = byNo.get(c.creditNote.onInvoice);
      const at = ist(c.creditNote.day);
      const gst = Math.round(c.creditNote.taxable * GST);
      await insertTagged(CreditNote, {
        creditNoteNo: c.creditNote.no, workspaceId: ws._id, status: "ISSUED", issuedAt: at, creditNoteDate: at, generatedAt: at,
        originalInvoiceId: orig._id, originalInvoiceNo: orig.invoiceNo, originalInvoiceDate: orig.invoiceDate,
        originalInvoiceAmount: orig.grandTotal, serviceCategory: "FLIGHT",
        reasonId: new mongoose.Types.ObjectId(), reasonText: "Partial refund (loyalty demo)",
        gstReasonCode: "07", gstReasonText: "Others", isFullCredit: false,
        subtotal: c.creditNote.taxable, totalGST: gst, igstAmount: gst, grandTotal: c.creditNote.taxable + gst, supplyType: "IGST",
        clientDetails: { companyName: c.legalName, gstin: c.gstin ?? "", email: c.email },
      }, { createdAt: at });
    }

    if (c.startDateOverride) {
      const acct = await ensureAccountForCustomer(cid, ACTOR);
      if (!acct) throw new Error(`no loyalty account for ${c.legalName}`);
      await LoyaltyAccount.collection.updateOne({ _id: acct._id }, {
        $set: { startDateOverride: c.startDateOverride, seedTag: TAG },
        $push: { changeLog: { at: new Date(), by: ACTOR, field: "startDateOverride", old: null, new: c.startDateOverride, reason: "Local loyalty demo" } } as any,
      });
    }

    console.log(`[loyalty-demo] ${c.key} ${c.legalName}  customer ${cid}  workspace ${ws._id}  ${c.invoices.length} invoice(s)${c.creditNote ? " + 1 credit note" : ""}`);
  }
}

async function status(): Promise<void> {
  const settings = await getLoyaltySettings({ create: false });
  console.log(`[loyalty-demo] launchDate ${new Date(settings.launchDate).toISOString()} · threshold ${inr(settings.thresholdInr)} · redemptionOpen ${settings.redemptionOpen}`);
  const customerIds = await demoCustomerIds();
  const names = new Map(
    (await Customer.collection.find({ seedTag: TAG }, { projection: { legalName: 1 } }).toArray()).map((c) => [String(c._id), c.legalName]),
  );
  for (const cid of customerIds) {
    const a: any = await LoyaltyAccount.collection.findOne({ memberCustomerIds: cid });
    if (!a) { console.log(`  ${names.get(cid)}: no loyalty account`); continue; }
    const b = a.balances ?? {};
    const notice = a.unlockNotice ? ` · unlock notice claimed (${a.unlockNotice.recipients} recipient(s))` : "";
    console.log(
      `  ${String(names.get(cid)).padEnd(22)} ready ${b.ready ?? 0} · on the way ${b.onTheWay ?? 0} · locked ${b.locked ?? 0}` +
        ` · cumulative ${inr(a.cumulativeInr ?? 0)} · ${a.eligibleAt ? "eligible" : "not eligible"}` +
        `${a.startDateOverride ? ` · starts ${new Date(a.startDateOverride).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })}` : ""}${notice}`,
    );
  }
}

async function main() {
  const uri = env.MONGO_URI;
  assertLocalDatabase(uri);
  await mongoose.connect(uri);
  // Belt and braces: the host we actually reached, not just the string we parsed.
  const host = String(mongoose.connection.host || "").toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    await mongoose.disconnect();
    throw new Error(`REFUSING: connected host is "${host}", not 127.0.0.1 / localhost.`);
  }
  console.log(`[loyalty-demo] connected to ${host} (db: ${mongoose.connection.name})`);

  if (STATUS) {
    await status();
  } else {
    await teardown();
    if (RESET) {
      await restoreLaunchDate();
    } else {
      await setLaunchDate();
      await seed();
      console.log(`[loyalty-demo] done. Password for every demo login: ${PASSWORD}`);
      console.log("[loyalty-demo] next: node --env-file=.env.development --import tsx scripts/loyalty-reconcile.ts");
    }
  }
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
