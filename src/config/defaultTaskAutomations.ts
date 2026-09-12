import type { AutomationEntityType, AutomationPriority } from '../models/TaskAutomation.js'

export interface DefaultAutomation {
  triggerKey: string
  label: string
  entityType: AutomationEntityType
  enabled: boolean
  titleTemplate: string
  dueOffsetMinutes: number
  priority: AutomationPriority
  assigneeRule: { type: 'OWNER' | 'SPECIFIC' }
  tags: string[]
}

export const DEFAULT_AUTOMATIONS: DefaultAutomation[] = [
  // ── LEAD ──────────────────────────────────────────────────────────
  {
    triggerKey: 'lead.created',
    label: 'When new lead created',
    entityType: 'LEAD',
    enabled: true,
    titleTemplate: 'First contact with {{leadName}}',
    dueOffsetMinutes: 1440,
    priority: 'HIGH',
    assigneeRule: { type: 'OWNER' },
    tags: ['auto'],
  },
  {
    triggerKey: 'lead.stage_contacted',
    label: 'Lead moved to Contacted',
    entityType: 'LEAD',
    enabled: true,
    titleTemplate: 'Schedule demo with {{leadName}}',
    dueOffsetMinutes: 4320,
    priority: 'MEDIUM',
    assigneeRule: { type: 'OWNER' },
    tags: ['auto'],
  },
  {
    triggerKey: 'lead.stage_demo',
    label: 'Lead moved to Demo Scheduled',
    entityType: 'LEAD',
    enabled: true,
    titleTemplate: 'Follow up post demo with {{leadName}}',
    dueOffsetMinutes: 1440,
    priority: 'MEDIUM',
    assigneeRule: { type: 'OWNER' },
    tags: ['auto'],
  },
  {
    triggerKey: 'lead.stage_proposal',
    label: 'Lead moved to Proposal Sent',
    entityType: 'LEAD',
    enabled: true,
    titleTemplate: 'Follow up on proposal — {{leadName}}',
    dueOffsetMinutes: 2880,
    priority: 'MEDIUM',
    assigneeRule: { type: 'OWNER' },
    tags: ['auto'],
  },
  {
    triggerKey: 'lead.won',
    label: 'Lead marked Won',
    entityType: 'LEAD',
    enabled: true,
    titleTemplate: 'Send onboarding to {{leadName}}',
    dueOffsetMinutes: 60,
    priority: 'HIGH',
    assigneeRule: { type: 'OWNER' },
    tags: ['auto'],
  },
  {
    triggerKey: 'lead.next_followup',
    label: 'Lead has next follow-up date',
    entityType: 'LEAD',
    enabled: true,
    titleTemplate: 'Follow up: {{leadName}}',
    dueOffsetMinutes: 0,
    priority: 'MEDIUM',
    assigneeRule: { type: 'OWNER' },
    tags: ['auto'],
  },
  // ── TICKET ────────────────────────────────────────────────────────
  {
    triggerKey: 'ticket.created',
    label: 'When new ticket created',
    entityType: 'TICKET',
    enabled: true,
    titleTemplate: 'Respond to {{ticketRef}}',
    dueOffsetMinutes: 30,
    priority: 'HIGH',
    assigneeRule: { type: 'OWNER' },
    tags: ['auto'],
  },
  // ticket.awaiting_24h and ticket.sla_at_risk are cron-driven — TODO: implement in v2
  // ── INVOICE ───────────────────────────────────────────────────────
  {
    triggerKey: 'invoice.created',
    label: 'Invoice generated',
    entityType: 'INVOICE',
    enabled: true,
    titleTemplate: 'Send invoice {{invoiceNo}} to client',
    dueOffsetMinutes: 1440,
    priority: 'HIGH',
    assigneeRule: { type: 'OWNER' },
    tags: ['auto'],
  },
  // invoice.unpaid_7d and invoice.unpaid_30d are cron-driven — TODO: implement in v2
  // ── BOOKING ───────────────────────────────────────────────────────
  {
    triggerKey: 'booking.created_pending',
    label: 'Booking created PENDING',
    entityType: 'BOOKING',
    enabled: true,
    titleTemplate: 'Confirm booking {{bookingRef}}',
    dueOffsetMinutes: 120,
    priority: 'HIGH',
    assigneeRule: { type: 'OWNER' },
    tags: ['auto'],
  },
  // ── CONTACT ───────────────────────────────────────────────────────
  {
    triggerKey: 'contact.created',
    label: 'Contact created',
    entityType: 'CONTACT',
    enabled: true,
    titleTemplate: 'Welcome call with {{contactName}}',
    dueOffsetMinutes: 10080,
    priority: 'MEDIUM',
    assigneeRule: { type: 'OWNER' },
    tags: ['auto'],
  },
]

// ── Slice 2 (CRM_V2_OPPORTUNITY) — new-taxonomy triggers ─────────────────
// Under the flag the lead routes fire these keys instead of the legacy
// lead.stage_* ones (which hardcode the retired 9-stage enum). Every new key
// has a LEGACY ALIAS so the TaskAutomation rows already in prod keep firing
// until an admin seeds/edits the new rows: triggerTaskAutomation() looks up
// the new key first and falls back to the alias (risk M5: "keep old keys as
// aliases"). Seeded only when the flag is on (services/taskAutomationSeed.ts)
// so the OFF state adds no rows.
export const OPPORTUNITY_AUTOMATIONS: DefaultAutomation[] = [
  {
    triggerKey: 'lead.status_contacted',
    label: 'Lead status → Contacted',
    entityType: 'LEAD',
    enabled: true,
    titleTemplate: 'Schedule demo with {{leadName}}',
    dueOffsetMinutes: 4320,
    priority: 'MEDIUM',
    assigneeRule: { type: 'OWNER' },
    tags: ['auto'],
  },
  {
    triggerKey: 'lead.status_engaged',
    label: 'Lead status → Engaged (demo held / requirement captured)',
    entityType: 'LEAD',
    enabled: true,
    titleTemplate: 'Follow up post demo with {{leadName}}',
    dueOffsetMinutes: 1440,
    priority: 'MEDIUM',
    assigneeRule: { type: 'OWNER' },
    tags: ['auto'],
  },
  {
    triggerKey: 'opportunity.stage_proposal',
    label: 'Opportunity → Proposal / quote sent',
    entityType: 'OPPORTUNITY',
    enabled: true,
    titleTemplate: 'Follow up on proposal — {{leadName}}',
    dueOffsetMinutes: 2880,
    priority: 'MEDIUM',
    assigneeRule: { type: 'OWNER' },
    tags: ['auto'],
  },
  {
    triggerKey: 'opportunity.stage_negotiation',
    label: 'Opportunity → Negotiation / decision',
    entityType: 'OPPORTUNITY',
    enabled: true,
    titleTemplate: 'Close out negotiation — {{leadName}}',
    dueOffsetMinutes: 1440,
    priority: 'HIGH',
    assigneeRule: { type: 'OWNER' },
    tags: ['auto'],
  },
  {
    triggerKey: 'opportunity.won',
    label: 'Opportunity Closed Won',
    entityType: 'OPPORTUNITY',
    enabled: true,
    titleTemplate: 'Send onboarding to {{leadName}}',
    dueOffsetMinutes: 60,
    priority: 'HIGH',
    assigneeRule: { type: 'OWNER' },
    tags: ['auto'],
  },
  {
    triggerKey: 'opportunity.lost',
    label: 'Opportunity Closed Lost',
    entityType: 'OPPORTUNITY',
    enabled: false,
    titleTemplate: 'Log loss review — {{leadName}}',
    dueOffsetMinutes: 2880,
    priority: 'LOW',
    assigneeRule: { type: 'OWNER' },
    tags: ['auto'],
  },
]

/** new key → the legacy key an existing prod TaskAutomation row may carry. */
export const TRIGGER_KEY_ALIASES: Record<string, string> = {
  'lead.status_contacted': 'lead.stage_contacted',
  'lead.status_engaged': 'lead.stage_demo',
  'opportunity.stage_proposal': 'lead.stage_proposal',
  'opportunity.won': 'lead.won',
}

// workspaceId used for internal (non-CustomerWorkspace) automations — leads, contacts
export const SYSTEM_WORKSPACE_ID = 'SYSTEM'
