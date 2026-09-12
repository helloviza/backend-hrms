// Slice 2 — the vocabulary module is pure; these pin the transition table,
// the read-side alias table and the two-vocabulary milestone matcher that
// Sales Pulse depends on (risk M1/M4).
import { describe, it, expect } from "vitest";
import {
  LEAD_STATUSES,
  LEGACY_LEAD_STAGES,
  LEGACY_TRANSITIONS,
  LEGACY_OPPORTUNITY_STAGES,
  PIPELINE_STAGES,
  OPPORTUNITY_PIPELINES,
  STATUS_TO_LEGACY_STAGE,
  legacyStageToStatus,
  pipelineForLeadType,
  pipelineStage,
  closedStage,
  isClosedOpportunityStage,
  stageLabel,
  activityHitsMilestone,
} from "./crmTaxonomy.js";

describe("legacy stage → status transition table", () => {
  it("covers every legacy stage exactly once", () => {
    expect(Object.keys(LEGACY_TRANSITIONS).sort()).toEqual([...LEGACY_LEAD_STAGES].sort());
  });

  it("maps per the reviewer-locked table", () => {
    expect(legacyStageToStatus("new")).toBe("NEW");
    expect(legacyStageToStatus("email_sent")).toBe("CONTACTED");
    expect(legacyStageToStatus("contacted")).toBe("CONTACTED");
    expect(legacyStageToStatus("follow_up")).toBe("CONTACTED");
    expect(legacyStageToStatus("demo_scheduled")).toBe("ENGAGED");
    expect(legacyStageToStatus("proposal_sent")).toBe("CONVERTED");
    expect(legacyStageToStatus("negotiation")).toBe("CONVERTED");
    expect(legacyStageToStatus("won")).toBe("CONVERTED");
    expect(legacyStageToStatus("lost")).toBe("LOST");
    expect(legacyStageToStatus(undefined)).toBe("NEW");
    expect(legacyStageToStatus("garbage")).toBe("NEW");
  });

  it("only proposal_sent / negotiation / won create an Opportunity; demo_scheduled does not", () => {
    for (const s of LEGACY_LEAD_STAGES) {
      const t = LEGACY_TRANSITIONS[s];
      const shouldHave = (LEGACY_OPPORTUNITY_STAGES as readonly string[]).includes(s);
      expect(!!t.opportunityStage, s).toBe(shouldHave);
    }
    expect(LEGACY_TRANSITIONS.demo_scheduled.logDemo).toBe(true);
    expect(LEGACY_TRANSITIONS.follow_up.preserveFollowUp).toBe(true);
  });

  it("every opportunityStage the table names exists in its pipeline", () => {
    for (const s of LEGACY_OPPORTUNITY_STAGES) {
      const map = LEGACY_TRANSITIONS[s].opportunityStage!;
      for (const p of OPPORTUNITY_PIPELINES) {
        expect(pipelineStage(p, map[p]), `${s}/${p}`).not.toBeNull();
      }
    }
  });

  it("reverse map lands every status on a legacy stage", () => {
    for (const st of LEAD_STATUSES) {
      expect(LEGACY_LEAD_STAGES).toContain(STATUS_TO_LEGACY_STAGE[st]);
    }
  });

  it("individual leads go to travel_enquiry, everything else to corporate", () => {
    expect(pipelineForLeadType("individual")).toBe("travel_enquiry");
    expect(pipelineForLeadType("company")).toBe("corporate");
    expect(pipelineForLeadType(null)).toBe("corporate");
  });
});

describe("pipeline stage tables (PRD H)", () => {
  it("each pipeline has exactly one won and one lost stage and probabilities 0..100", () => {
    for (const p of OPPORTUNITY_PIPELINES) {
      const list = PIPELINE_STAGES[p];
      expect(list.filter((s) => s.closed === "won")).toHaveLength(1);
      expect(list.filter((s) => s.closed === "lost")).toHaveLength(1);
      for (const s of list) {
        expect(s.probability).toBeGreaterThanOrEqual(0);
        expect(s.probability).toBeLessThanOrEqual(100);
      }
      expect(pipelineStage(p, closedStage(p, "won"))!.probability).toBe(100);
      expect(pipelineStage(p, closedStage(p, "lost"))!.probability).toBe(0);
      expect(isClosedOpportunityStage(p, closedStage(p, "won"))).toBe(true);
      expect(isClosedOpportunityStage(p, list[0].key)).toBe(false);
    }
  });

  it("corporate carries the PRD probabilities", () => {
    const c = Object.fromEntries(PIPELINE_STAGES.corporate.map((s) => [s.key, s.probability]));
    expect(c).toEqual({ new_enquiry: 10, qualified: 25, discovery: 45, proposal: 65, negotiation: 80, closed_won: 100, closed_lost: 0 });
  });
});

describe("stageLabel — read-side alias across all three vocabularies", () => {
  it("labels legacy stages, lead statuses and opportunity stages", () => {
    expect(stageLabel("demo_scheduled")).toBe("Demo Scheduled");
    expect(stageLabel("ENGAGED")).toBe("Engaged");
    expect(stageLabel("options_sent")).toBe("Options / quote sent");
    expect(stageLabel("closed_won")).toBe("Closed Won");
    expect(stageLabel("")).toBe("");
    expect(stageLabel("something_else")).toBe("something_else");
  });
});

describe("activityHitsMilestone — both vocabularies", () => {
  it("legacy stage_change rows", () => {
    expect(activityHitsMilestone({ type: "stage_change", toStage: "demo_scheduled" }, "demo")).toBe(true);
    expect(activityHitsMilestone({ type: "stage_change", toStage: "proposal_sent" }, "proposal")).toBe(true);
    expect(activityHitsMilestone({ type: "stage_change", toStage: "negotiation" }, "negotiation")).toBe(true);
    expect(activityHitsMilestone({ type: "stage_change", toStage: "contacted" }, "demo")).toBe(false);
  });
  it("legacy terminal activity types", () => {
    expect(activityHitsMilestone({ type: "won" }, "won")).toBe(true);
    expect(activityHitsMilestone({ type: "lost" }, "lost")).toBe(true);
    expect(activityHitsMilestone({ type: "note" }, "won")).toBe(false);
  });
  it("new-taxonomy lead rows (toStatus / demo type)", () => {
    expect(activityHitsMilestone({ type: "stage_change", subjectType: "LEAD", toStage: "demo_scheduled", toStatus: "ENGAGED" }, "demo")).toBe(true);
    expect(activityHitsMilestone({ type: "demo" }, "demo")).toBe(true);
    expect(activityHitsMilestone({ type: "stage_change", subjectType: "LEAD", toStatus: "LOST" }, "lost")).toBe(true);
  });
  it("opportunity rows use the pipeline vocabulary and never the lead one", () => {
    expect(activityHitsMilestone({ type: "stage_change", subjectType: "OPPORTUNITY", toStage: "proposal" }, "proposal")).toBe(true);
    expect(activityHitsMilestone({ type: "stage_change", subjectType: "OPPORTUNITY", toStage: "options_sent" }, "proposal")).toBe(true);
    expect(activityHitsMilestone({ type: "stage_change", subjectType: "OPPORTUNITY", toStage: "closed_won" }, "won")).toBe(true);
    expect(activityHitsMilestone({ type: "stage_change", subjectType: "OPPORTUNITY", toStage: "closed_lost" }, "lost")).toBe(true);
    // a lead-vocabulary value on an opportunity row is not a hit
    expect(activityHitsMilestone({ type: "stage_change", subjectType: "OPPORTUNITY", toStage: "proposal_sent" }, "proposal")).toBe(false);
  });
});
