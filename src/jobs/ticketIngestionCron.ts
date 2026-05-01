// NOTE: This cron assumes single-instance App Runner deployment.
// If horizontal scaling is enabled, implement a distributed lock
// (Redis/Mongo TTL doc) before this can run safely.
import cron from "node-cron";
import logger from "../utils/logger.js";
import { fetchUnprocessedMessages } from "../services/gmail.js";
import { ingestEmailToTicket } from "../services/ticketIngestion.js";

let isRunning = false;

export function startTicketIngestionCron(): void {
  if (process.env.TICKETING_CRON_ENABLED !== "true") {
    logger.info("[TicketCron] Ticket ingestion cron is DISABLED (set TICKETING_CRON_ENABLED=true to enable)");
    return;
  }

  cron.schedule("* * * * *", async () => {
    if (isRunning) {
      logger.warn("[TicketCron] Skipped — previous run still in flight");
      return;
    }

    isRunning = true;
    const startedAt = Date.now();

    try {
      const messages = await fetchUnprocessedMessages();

      if (messages.length === 0) {
        logger.debug("[TicketCron] No new messages");
        return;
      }

      logger.info("[TicketCron] Messages to ingest", { count: messages.length });

      let processed = 0;
      let skipped = 0;
      const errors: Array<{ msgId: string; error: string }> = [];

      for (const msg of messages) {
        try {
          const result = await ingestEmailToTicket(msg);
          if ("skipped" in result && result.skipped) {
            skipped++;
          } else {
            processed++;
          }
        } catch (err: any) {
          errors.push({ msgId: msg.id || "unknown", error: err.message || String(err) });
          logger.error("[TicketCron] Ingestion failed for message", {
            msgId: msg.id,
            error: err.message,
          });
        }
      }

      logger.info("[TicketCron] Cycle complete", {
        processed,
        skipped,
        errors: errors.length,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (err: any) {
      logger.error("[TicketCron] Top-level failure (Gmail unreachable or auth expired)", {
        error: err.message,
        stack: err.stack,
      });
    } finally {
      isRunning = false;
    }
  });

  logger.info("[TicketCron] Ticket ingestion cron scheduled (every 60s)");
}
