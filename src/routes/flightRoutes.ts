import { Router } from 'express';
import { getFlightStatus } from '../controllers/flightController.js';

const router = Router();

// This maps the specific function to the HTTP GET method
router.get('/status', getFlightStatus);

export default router;