import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { loadSessionMembership, MEMBERSHIP_REVOKED_BODY } from '../middleware/requireWorkspace.js'
import { holdsSeveralCompanies, sessionCompany } from '../services/activeMembership.js'
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

// Company switcher Phase 3c: someone in two or more companies sees the
// notifications of the company this session is in (customer tokens carry no
// workspaceId claim); a revoked second-company session gets null (401).
// Everyone else: the token's workspaceId, exactly as before.
async function wsid(req: any): Promise<string | null> {
  if (req.user?.mid && (await holdsSeveralCompanies(req))) {
    if ((await sessionCompany(req)).kind === 'revoked') return null
    const live = await loadSessionMembership(req.user)
    if (live) return String(live.workspaceId)
  }
  return String(req.user?.workspaceId || '')
}

function revoked(res: any) {
  return res.status(401).json(MEMBERSHIP_REVOKED_BODY)
}

router.get('/', async (req: any, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(50, Number(req.query.limit) || 20)
    const ws = await wsid(req)
    if (ws === null) return revoked(res)
    const notifications = await listNotifications(uid(req.user), ws, page, limit)
    return res.json({ notifications })
  } catch {
    return res.status(500).json({ error: 'Failed to fetch notifications' })
  }
})

router.get('/unread-count', async (req: any, res) => {
  try {
    const ws = await wsid(req)
    if (ws === null) return revoked(res)
    const count = await getUnreadCount(uid(req.user), ws)
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
    const ws = await wsid(req)
    if (ws === null) return revoked(res)
    await markAllRead(uid(req.user), ws)
    return res.json({ ok: true })
  } catch {
    return res.status(500).json({ error: 'Failed to mark all read' })
  }
})

export default router
