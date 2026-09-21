// apps/backend/src/services/plumconnect/campaignRollup.ts
//
// PlumConnect Slice 8 — the read-side Campaign → AdSet → Ad roll-up: the
// campaign dashboard's drill-down. Pure aggregation over existing records;
// it writes nothing and rebuilds nothing.
//
// Per node (ad, then summed upward with de-duplication where it matters):
//   conversations  PlumConnectConversation rows whose referralRaw.source_id
//                  is this ad (a contact who tapped the ad, lead or not)
//   leads          Lead rows whose attribution.sourceId is this ad
//   qualified      of those, status QUALIFIED or CONVERTED (the bot's
//                  completion writes QUALIFIED — Slice 3c/6; CONVERTED is
//                  further along and therefore also qualified)
//   opportunities  Lead.opportunityId → Opportunity (the CRM v2 chain);
//                  won = a stage whose taxonomy entry is closed:"won";
//                  wonValue = Σ dealValue of the won ones — the CRM's own
//                  "revenue" figure (routes/leads.ts rep / funnel reports)
//   invoiced/paid  Lead.companyId → CRMCompany.customerWorkspaceId →
//                  Invoice.workspaceId: Σ grandTotal of non-DRAFT,
//                  non-CANCELLED invoices (paid = status PAID). An invoice
//                  belongs to an account, not a lead, so it is counted ONCE
//                  per node even when several leads share the account —
//                  which is also why campaign totals are computed from the
//                  distinct account set, not by adding the ad rows.
//
// The tree is built from the Ad rows the enrichment worker created; an ad
// not yet enriched (no adset/campaign) sits under the synthetic
// "Unattributed (pending enrichment)" campaign so nothing captured is ever
// hidden from the report. Ad ids seen on a lead but not yet discovered by
// the worker (it has not ticked) are listed there too.
//
// Flagged, not done: the plumtrips flow's "trips per month" answer lives in
// travelRequirement.notes (Slice 6) — there is no Lead field for it, so it
// is not rolled up here. Adding one is an additive Lead schema decision.

import mongoose from "mongoose";
import Lead from "../../models/Lead.js";
import Opportunity from "../../models/Opportunity.js";
import CRMCompany from "../../models/CRMCompany.js";
import Invoice from "../../models/Invoice.js";
import PlumConnectConversation from "../../models/plumconnect/Conversation.js";
import PlumConnectAd from "../../models/plumconnect/Ad.js";
import PlumConnectAdSet from "../../models/plumconnect/AdSet.js";
import PlumConnectCampaign from "../../models/plumconnect/Campaign.js";
import { PIPELINE_STAGES } from "../../models/crmTaxonomy.js";

type AnyObj = Record<string, any>;

export interface RollupTotals {
  conversations: number;
  leads: number;
  qualified: number;
  opportunities: number;
  won: number;
  /** Σ dealValue of won opportunities (the CRM's revenue figure). */
  wonValue: number;
  /** Σ grandTotal of issued (non-draft, non-cancelled) invoices on the accounts these leads belong to. */
  invoiced: number;
  /** Σ grandTotal of PAID invoices on those accounts. */
  paid: number;
}

export interface AdNode {
  metaId: string;
  name: string;
  status: string;
  enrichment: string;
  lastEnrichedAt: Date | null;
  totals: RollupTotals;
}
export interface AdSetNode {
  metaId: string | null;
  name: string;
  status: string;
  totals: RollupTotals;
  ads: AdNode[];
}
export interface CampaignNode {
  metaId: string | null;
  name: string;
  status: string;
  objective: string;
  totals: RollupTotals;
  adSets: AdSetNode[];
}
export interface CampaignRollup {
  range: { from: Date | null; to: Date | null };
  totals: RollupTotals;
  campaigns: CampaignNode[];
  /** Ad ids with pending / failed enrichment (also present in the tree under "Unattributed"). */
  pendingEnrichment: number;
}

export const UNATTRIBUTED_NAME = "Unattributed (pending enrichment)";

const WON_STAGES = new Set<string>();
for (const stages of Object.values(PIPELINE_STAGES)) for (const s of stages as any[]) if (s.closed === "won") WON_STAGES.add(s.key);

function zero(): RollupTotals {
  return { conversations: 0, leads: 0, qualified: 0, opportunities: 0, won: 0, wonValue: 0, invoiced: 0, paid: 0 };
}

interface AdFacts {
  conversations: number;
  leads: number;
  qualified: number;
  opportunities: number;
  won: number;
  wonValue: number;
  /** Distinct billing workspaces reached through Lead.companyId. */
  workspaces: Set<string>;
}

function dateMatch(field: string, from: Date | null, to: Date | null): AnyObj {
  if (!from && !to) return {};
  const m: AnyObj = {};
  if (from) m.$gte = from;
  if (to) m.$lte = to;
  return { [field]: m };
}

/** Sum a set of ad facts into node totals; invoices de-duplicated by workspace. */
function sumFacts(facts: AdFacts[], invoicesByWs: Map<string, { invoiced: number; paid: number }>): RollupTotals {
  const t = zero();
  const ws = new Set<string>();
  for (const f of facts) {
    t.conversations += f.conversations;
    t.leads += f.leads;
    t.qualified += f.qualified;
    t.opportunities += f.opportunities;
    t.won += f.won;
    t.wonValue += f.wonValue;
    for (const w of f.workspaces) ws.add(w);
  }
  for (const w of ws) {
    const inv = invoicesByWs.get(w);
    if (inv) {
      t.invoiced += inv.invoiced;
      t.paid += inv.paid;
    }
  }
  return t;
}

export async function buildCampaignRollup(range: { from?: Date | null; to?: Date | null } = {}): Promise<CampaignRollup> {
  const from = range.from ?? null;
  const to = range.to ?? null;

  // ── Leads per ad id (+ the opportunity and company ids to join) ──────
  const leadRows: any[] = await Lead.aggregate([
    { $match: { "attribution.sourceId": { $nin: ["", null] }, ...dateMatch("createdAt", from, to) } },
    {
      $group: {
        _id: "$attribution.sourceId",
        leads: { $sum: 1 },
        qualified: { $sum: { $cond: [{ $in: [{ $ifNull: ["$status", ""] }, ["QUALIFIED", "CONVERTED"]] }, 1, 0] } },
        opportunityIds: { $addToSet: "$opportunityId" },
        companyIds: { $addToSet: "$companyId" },
      },
    },
  ]);

  // ── Conversations per ad id ──────────────────────────────────────────
  const convRows: any[] = await PlumConnectConversation.aggregate([
    { $match: { "referralRaw.source_id": { $nin: ["", null] }, ...dateMatch("createdAt", from, to) } },
    { $group: { _id: "$referralRaw.source_id", conversations: { $sum: 1 } } },
  ]);

  // ── Opportunities: count / won / wonValue ────────────────────────────
  const oppIds = [...new Set(leadRows.flatMap((r) => (r.opportunityIds as unknown[]).filter(Boolean).map(String)))].map((s) => new mongoose.Types.ObjectId(s));
  const opps: any[] = oppIds.length ? await Opportunity.find({ _id: { $in: oppIds } }).select("_id stage dealValue").lean() : [];
  const oppById = new Map(opps.map((o) => [String(o._id), o]));

  // ── Company → billing workspace → invoices ───────────────────────────
  const companyIds = [...new Set(leadRows.flatMap((r) => (r.companyIds as unknown[]).filter(Boolean).map(String)))].map((s) => new mongoose.Types.ObjectId(s));
  const companies: any[] = companyIds.length ? await CRMCompany.find({ _id: { $in: companyIds } }).select("_id customerWorkspaceId").lean() : [];
  const wsByCompany = new Map<string, string>();
  for (const c of companies) if (c.customerWorkspaceId && mongoose.isValidObjectId(String(c.customerWorkspaceId))) wsByCompany.set(String(c._id), String(c.customerWorkspaceId));
  const wsIds = [...new Set(wsByCompany.values())].map((s) => new mongoose.Types.ObjectId(s));
  const invRows: any[] = wsIds.length
    ? await Invoice.aggregate([
        { $match: { workspaceId: { $in: wsIds }, status: { $nin: ["DRAFT", "CANCELLED"] } } },
        { $group: { _id: "$workspaceId", invoiced: { $sum: { $ifNull: ["$grandTotal", 0] } }, paid: { $sum: { $cond: [{ $eq: ["$status", "PAID"] }, { $ifNull: ["$grandTotal", 0] }, 0] } } } },
      ])
    : [];
  const invoicesByWs = new Map(invRows.map((r) => [String(r._id), { invoiced: Number(r.invoiced || 0), paid: Number(r.paid || 0) }]));

  // ── Facts per ad id ──────────────────────────────────────────────────
  const facts = new Map<string, AdFacts>();
  const factsFor = (id: string) => {
    let f = facts.get(id);
    if (!f) {
      f = { conversations: 0, leads: 0, qualified: 0, opportunities: 0, won: 0, wonValue: 0, workspaces: new Set() };
      facts.set(id, f);
    }
    return f;
  };
  for (const r of convRows) factsFor(String(r._id)).conversations = Number(r.conversations || 0);
  for (const r of leadRows) {
    const f = factsFor(String(r._id));
    f.leads = Number(r.leads || 0);
    f.qualified = Number(r.qualified || 0);
    for (const oid of (r.opportunityIds as unknown[]).filter(Boolean)) {
      const o = oppById.get(String(oid));
      if (!o) continue;
      f.opportunities += 1;
      if (WON_STAGES.has(String(o.stage))) {
        f.won += 1;
        f.wonValue += Number(o.dealValue || 0);
      }
    }
    for (const cid of (r.companyIds as unknown[]).filter(Boolean)) {
      const ws = wsByCompany.get(String(cid));
      if (ws) f.workspaces.add(ws);
    }
  }

  // ── The tree from the enrichment rows ────────────────────────────────
  const adIds = [...facts.keys()];
  const ads: any[] = adIds.length ? await PlumConnectAd.find({ metaId: { $in: adIds } }).lean() : [];
  const adByMeta = new Map(ads.map((a) => [String(a.metaId), a]));
  const adSetIds = [...new Set(ads.map((a) => a.adSetId).filter(Boolean).map(String))].map((s) => new mongoose.Types.ObjectId(s));
  const campaignIds = [...new Set(ads.map((a) => a.campaignId).filter(Boolean).map(String))].map((s) => new mongoose.Types.ObjectId(s));
  const [adSets, campaigns]: [any[], any[]] = await Promise.all([
    adSetIds.length ? PlumConnectAdSet.find({ _id: { $in: adSetIds } }).lean() : Promise.resolve([]),
    campaignIds.length ? PlumConnectCampaign.find({ _id: { $in: campaignIds } }).lean() : Promise.resolve([]),
  ]);
  const adSetById = new Map(adSets.map((s) => [String(s._id), s]));
  const campaignById = new Map(campaigns.map((c) => [String(c._id), c]));

  // campaignKey → adSetKey → ad metaIds
  const tree = new Map<string, Map<string, string[]>>();
  const UNATTRIBUTED = "__unattributed__";
  let pendingEnrichment = 0;
  for (const metaId of adIds) {
    const ad = adByMeta.get(metaId);
    const enriched = ad && ad.enrichment?.status === "enriched" && ad.campaignId;
    if (!enriched) pendingEnrichment += 1;
    const cKey = enriched ? String(ad.campaignId) : UNATTRIBUTED;
    const sKey = enriched && ad.adSetId ? String(ad.adSetId) : UNATTRIBUTED;
    if (!tree.has(cKey)) tree.set(cKey, new Map());
    const sets = tree.get(cKey)!;
    if (!sets.has(sKey)) sets.set(sKey, []);
    sets.get(sKey)!.push(metaId);
  }

  const adNode = (metaId: string): AdNode => {
    const ad = adByMeta.get(metaId);
    return {
      metaId,
      name: String(ad?.name || ""),
      status: String(ad?.status || ""),
      enrichment: String(ad?.enrichment?.status || "undiscovered"),
      lastEnrichedAt: ad?.lastEnrichedAt ?? null,
      totals: sumFacts([facts.get(metaId)!], invoicesByWs),
    };
  };

  const campaignNodes: CampaignNode[] = [];
  for (const [cKey, sets] of tree) {
    const campaign = cKey === UNATTRIBUTED ? null : campaignById.get(cKey);
    const adSetNodes: AdSetNode[] = [];
    const campaignFacts: AdFacts[] = [];
    for (const [sKey, metaIds] of sets) {
      const adSet = sKey === UNATTRIBUTED ? null : adSetById.get(sKey);
      const setFacts = metaIds.map((m) => facts.get(m)!);
      campaignFacts.push(...setFacts);
      adSetNodes.push({
        metaId: adSet ? String(adSet.metaId) : null,
        name: adSet ? String(adSet.name || "") : UNATTRIBUTED_NAME,
        status: adSet ? String(adSet.status || "") : "",
        totals: sumFacts(setFacts, invoicesByWs),
        ads: metaIds.map(adNode).sort((a, b) => b.totals.leads - a.totals.leads || a.metaId.localeCompare(b.metaId)),
      });
    }
    adSetNodes.sort((a, b) => b.totals.leads - a.totals.leads || String(a.metaId).localeCompare(String(b.metaId)));
    campaignNodes.push({
      metaId: campaign ? String(campaign.metaId) : null,
      name: campaign ? String(campaign.name || "") : UNATTRIBUTED_NAME,
      status: campaign ? String(campaign.status || "") : "",
      objective: campaign ? String(campaign.objective || "") : "",
      totals: sumFacts(campaignFacts, invoicesByWs),
      adSets: adSetNodes,
    });
  }
  // Named campaigns first (by leads), the unattributed bucket last.
  campaignNodes.sort((a, b) => Number(a.metaId === null) - Number(b.metaId === null) || b.totals.leads - a.totals.leads || String(a.metaId).localeCompare(String(b.metaId)));

  return {
    range: { from, to },
    totals: sumFacts([...facts.values()], invoicesByWs),
    campaigns: campaignNodes,
    pendingEnrichment,
  };
}
