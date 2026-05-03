import mongoose, { Schema, Document } from 'mongoose'

export const AUTOMATION_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const
export const AUTOMATION_ENTITY_TYPES = ['LEAD', 'CONTACT', 'COMPANY', 'BOOKING', 'TICKET', 'INVOICE'] as const
export const AUTOMATION_ASSIGNEE_RULE_TYPES = ['OWNER', 'SPECIFIC'] as const

export type AutomationPriority = typeof AUTOMATION_PRIORITIES[number]
export type AutomationEntityType = typeof AUTOMATION_ENTITY_TYPES[number]

export interface ITaskAutomation extends Document {
  workspaceId: string
  triggerKey: string
  label: string
  enabled: boolean
  titleTemplate: string
  descriptionTemplate?: string
  dueOffsetMinutes: number
  priority: AutomationPriority
  assigneeRule: {
    type: 'OWNER' | 'SPECIFIC'
    userId?: mongoose.Types.ObjectId
  }
  tags: string[]
  entityType: AutomationEntityType
  description?: string
  createdBy?: mongoose.Types.ObjectId
  updatedBy?: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const taskAutomationSchema = new Schema<ITaskAutomation>(
  {
    workspaceId: { type: String, required: true },
    triggerKey: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    enabled: { type: Boolean, default: true },

    titleTemplate: { type: String, required: true, trim: true },
    descriptionTemplate: { type: String },

    dueOffsetMinutes: { type: Number, default: 1440 },

    priority: {
      type: String,
      enum: AUTOMATION_PRIORITIES,
      default: 'MEDIUM',
    },

    assigneeRule: {
      type: {
        type: String,
        enum: AUTOMATION_ASSIGNEE_RULE_TYPES,
        default: 'OWNER',
      },
      userId: { type: Schema.Types.ObjectId, ref: 'User' },
    },

    tags: [{ type: String }],

    entityType: {
      type: String,
      enum: AUTOMATION_ENTITY_TYPES,
      required: true,
    },

    description: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
)

taskAutomationSchema.index({ workspaceId: 1, triggerKey: 1 }, { unique: true })
taskAutomationSchema.index({ workspaceId: 1, enabled: 1 })
taskAutomationSchema.index({ workspaceId: 1, entityType: 1 })

export default mongoose.model<ITaskAutomation>('TaskAutomation', taskAutomationSchema)
