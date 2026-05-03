import mongoose, { Schema, Document } from 'mongoose'

export const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const
export const TASK_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const
export const TASK_LINKED_TYPES = ['LEAD', 'CONTACT', 'COMPANY', 'BOOKING', 'TICKET', 'INVOICE'] as const

export type TaskPriority = typeof TASK_PRIORITIES[number]
export type TaskStatus = typeof TASK_STATUSES[number]
export type TaskLinkedType = typeof TASK_LINKED_TYPES[number]

export interface ITask extends Document {
  workspaceId?: string
  title: string
  description?: string
  assignedTo: mongoose.Types.ObjectId
  createdBy: mongoose.Types.ObjectId
  dueDate?: Date
  dueTime?: string
  priority: TaskPriority
  status: TaskStatus
  linkedType?: TaskLinkedType
  linkedId?: mongoose.Types.ObjectId
  linkedRef?: string
  tags?: string[]
  completedAt?: Date
  completedBy?: mongoose.Types.ObjectId
  isActive: boolean
  reminderShown30Min?: boolean
  reminderShownDue?: boolean
  reminderShownOverdue?: boolean
  autoTriggerKey?: string
  createdAt: Date
  updatedAt: Date
}

const taskSchema = new Schema<ITask>(
  {
    workspaceId: { type: String },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String },

    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    dueDate: { type: Date },
    dueTime: { type: String },

    priority: {
      type: String,
      enum: TASK_PRIORITIES,
      default: 'MEDIUM',
    },
    status: {
      type: String,
      enum: TASK_STATUSES,
      default: 'OPEN',
    },

    linkedType: { type: String, enum: TASK_LINKED_TYPES },
    linkedId: { type: Schema.Types.ObjectId },
    linkedRef: { type: String },

    tags: [{ type: String }],
    completedAt: { type: Date },
    completedBy: { type: Schema.Types.ObjectId, ref: 'User' },

    isActive: { type: Boolean, default: true },
    reminderShown30Min: { type: Boolean, default: false },
    reminderShownDue: { type: Boolean, default: false },
    reminderShownOverdue: { type: Boolean, default: false },
    autoTriggerKey: { type: String },
  },
  { timestamps: true }
)

taskSchema.index({ workspaceId: 1, assignedTo: 1, status: 1 })
taskSchema.index({ workspaceId: 1, dueDate: 1 })
taskSchema.index({ linkedType: 1, linkedId: 1 })
taskSchema.index({ workspaceId: 1, isActive: 1 })
taskSchema.index({ autoTriggerKey: 1, linkedId: 1 }, { sparse: true })

export default mongoose.model<ITask>('Task', taskSchema)
