import { startVideoProcessingWorker } from "./videoProcessingWorker.js";
import { startLeaveAccrualWorker } from "./leaveAccrual.worker.js";
import { startExpenseCaptureWorker } from "./expenseCaptureWorker.js";

export function startBackgroundWorkers() {
  startVideoProcessingWorker();
  startLeaveAccrualWorker();
  startExpenseCaptureWorker();
}
