// DEAD as of 0.3 — no in-repo caller; verify no external hits before removing.
// See controllers/flightController.ts for the full note.
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getFlightStatus } from '../controllers/flightController.js';

const router = Router();
router.use(requireAuth);

router.get('/status', getFlightStatus);

export default router;