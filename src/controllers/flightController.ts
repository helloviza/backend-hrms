// apps/backend/src/controllers/flightController.ts
//
// DEAD as of 0.3 — no in-repo caller; verify no external hits before removing.
// The only caller was the concierge frontend, which now reads flight status from
// the turn reply (one AeroAPI call per status query instead of two). Left in
// place because monitors / mobile / gateway callers would not show up in a grep.
// getDelightfulFlightStatus still delegates to the corrected occurrence
// selection, so an unknown external caller gets the right flight, not the old
// +2-day window head.
import { Request, Response } from 'express';
// Explicit .js extension is required for 'nodenext' resolution
// Change line 4 to this:
import { getDelightfulFlightStatus as fetchFlightFromApi } from '../services/flightService.js';
/**
 * Controller to handle incoming HTTP requests for flight status.
 * Coordinates between the Express request and the Flight Service.
 */
export const getFlightStatus = async (req: Request, res: Response) => {
  try {
    const { flightNumber } = req.query;

    // 1. Validation: Ensure flightNumber is present and a string
    if (!flightNumber || typeof flightNumber !== 'string') {
      return res.status(400).json({ 
        error: "A valid flightNumber query parameter is required (e.g., ?flightNumber=BA123)" 
      });
    }

    // 2. Service Call: Fetch data from Aviationstack
    // We trim the flight number to prevent empty space errors
    const flightData = await fetchFlightFromApi(flightNumber.trim());

    // 3. Success Response: Send the flight data to Pluto's frontend
    return res.json(flightData);

  } catch (error: any) {
    // Log the error for backend debugging
    console.error(`[FlightController] Error fetching flight status: ${error.message}`);

    // Return a structured error to the frontend
    return res.status(500).json({ 
      error: error.message || "An internal error occurred while fetching flight data" 
    });
  }
};