// apps/backend/src/routes/holidays.ts
import { Router, Request, Response, NextFunction } from "express";
import requireAuth from "../middleware/auth.js";
import Holiday from "../models/Holiday.js";

const router = Router();

// 🔒 Protect holidays API with auth (same style as other HRMS routes)
router.use(requireAuth as any);

// Type alignment with frontend's RawHoliday
type RawHoliday = {
  _id?: string;
  date?: string;
  name?: string;
  region?: string;
  // frontend also supports type/description/etc, but our model doesn't yet
  type?: string;
  description?: string;
};

// Optional static fallback in case DB is empty
const STATIC_HOLIDAYS: RawHoliday[] = [
  {
    date: "2025-01-01",
    name: "New Year’s Day",
    type: "GENERAL",
    description: "Company-wide holiday to welcome the new year.",
  },
  {
    date: "2025-01-26",
    name: "Republic Day",
    type: "GENERAL",
    description: "National holiday (India).",
  },
  {
    date: "2025-03-14",
    name: "PlumTrips Foundation Day",
    type: "GENERAL",
    description: "Internal company holiday.",
  },
  {
    date: "2025-08-15",
    name: "Independence Day",
    type: "GENERAL",
    description: "National holiday (India).",
  },
  {
    date: "2025-10-20",
    name: "Diwali (Optional)",
    type: "OPTIONAL",
    description: "Festival of lights – optional holiday as per policy.",
  },
];

/**
 * GET /api/holidays
 *
 * Returns company holidays. For now:
 *  - If DB has Holiday documents → use them
 *  - If DB is empty → return a static sample list
 *
 * Shape matches what Holidays.tsx expects:
 *   { items: RawHoliday[] }
 */
router.get(
  "/",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      // Load from Mongo
      const docs = await Holiday.find().lean();

      let items: RawHoliday[];

      if (Array.isArray(docs) && docs.length > 0) {
        items = docs.map((h: any) => ({
          _id: String(h._id),
          date: h.date || undefined,
          name: h.name || "Holiday",
          region: h.region || "All locations / Company-wide",
          // type/description not in schema yet – can be added later
        }));
        return res.json({ items, source: "db" });
      }

      // If no DB holidays configured yet, fall back to static ones
      items = STATIC_HOLIDAYS;
      return res.json({ items, source: "static" });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
