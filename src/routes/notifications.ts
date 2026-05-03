import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import {
  markRead,
  markAllRead,
  getUnreadCount,
  listNotifications,
} from '../services/notificationDispatch.js'

const router = Router()
router.use(requireAuth)

function uid(user: any): string {
  return String(user?._id || user?.id || '')
}

function wsid(user: any): string {
  return String(user?.workspaceId || '')
}

router.get('/', async (req: any, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(50, Number(req.query.limit) || 20)
    const notifications = await listNotifications(uid(req.user), wsid(req.user), page, limit)
    return res.json({ notifications })
  } catch {
    return res.status(500).json({ error: 'Failed to fetch notifications' })
  }
})

router.get('/unread-count', async (req: any, res) => {
  try {
    const count = await getUnreadCount(uid(req.user), wsid(req.user))
    return res.json({ count })
  } catch {
    return res.status(500).json({ error: 'Failed to get unread count' })
  }
})

router.patch('/:id/read', async (req: any, res) => {
  try {
    const notification = await markRead(req.params.id, uid(req.user))
    if (!notification) return res.status(404).json({ error: 'Notification not found' })
    return res.json({ notification })
  } catch {
    return res.status(500).json({ error: 'Failed to mark read' })
  }
})

router.post('/mark-all-read', async (req: any, res) => {
  try {
    await markAllRead(uid(req.user), wsid(req.user))
    return res.json({ ok: true })
  } catch {
    return res.status(500).json({ error: 'Failed to mark all read' })
  }
})

export default router
