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

// workspaceId used for internal (non-CustomerWorkspace) automations — leads, contacts
export const SYSTEM_WORKSPACE_ID = 'SYSTEM'
