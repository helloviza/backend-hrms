import { startVideoProcessingWorker } from "./videoProcessingWorker.js";
import { startLeaveAccrualWorker } from "./leaveAccrual.worker.js";
import { startExpenseCaptureWorker } from "./expenseCaptureWorker.js";
import { startTripWatchWorker } from "./tripWatchWorker.js";
import { startDocumentExtractionWorker } from "./documentExtractionWorker.js";
// PlumConnect Slice 8 — idle unless PLUMCONNECT_ENABLED; enriches only with a token.
import { startPlumConnectEnrichmentWorker } from "./plumconnectEnrichmentWorker.js";

export function startBackgroundWorkers() {
  startVideoProcessingWorker();
  startLeaveAccrualWorker();
  startExpenseCaptureWorker();
  startTripWatchWorker();
  startDocumentExtractionWorker();
  startPlumConnectEnrichmentWorker();
}
