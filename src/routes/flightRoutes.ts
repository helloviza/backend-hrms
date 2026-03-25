import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getFlightStatus } from '../controllers/flightController.js';

const router = Router();
router.use(requireAuth);

router.get('/status', getFlightStatus);

export default router;