import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import { fetchUnprocessedMessages } from "../services/gmail.js";
import { ingestEmailToTicket } from "../services/ticketIngestion.js";
import logger from "../utils/logger.js";

const router = express.Router();

router.use(requireAuth);

router.use((req, res, next) => {
  if (!isSuperAdmin(req)) {
    return res.status(403).json({ success: false, error: "SUPERADMIN access required" });
  }
  next();
});

router.post("/ingest-now", async (req, res) => {
  logger.info("[TicketsAdmin] Manual ingest triggered", { by: (req as any).user?.email });

  let messages: Awaited<ReturnType<typeof fetchUnprocessedMessages>> = [];

  try {
    messages = await fetchUnprocessedMessages();
  } catch (err) {
    logger.error("[TicketsAdmin] fetchUnprocessedMessages failed", { err });
    return res.status(500).json({
      success: false,
      error: "Failed to fetch messages from Gmail",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  let processed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const msg of messages) {
    try {
      const result = await ingestEmailToTicket(msg);
      if ("skipped" in result && result.skipped) {
        skipped++;
      } else {
        processed++;
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error("[TicketsAdmin] ingestEmailToTicket failed", { gmailId: msg.id, err });
      errors.push(`${msg.id}: ${detail}`);
    }
  }

  logger.info("[TicketsAdmin] Ingest complete", {
    fetched: messages.length,
    processed,
    skipped,
    errors: errors.length,
  });

  return res.json({ success: true, fetched: messages.length, processed, skipped, errors });
});

export default router;
