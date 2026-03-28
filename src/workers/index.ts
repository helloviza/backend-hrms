import { startVideoProcessingWorker } from "./videoProcessingWorker.js";
import { startLeaveAccrualWorker } from "./leaveAccrual.worker.js";

export function startBackgroundWorkers() {
  startVideoProcessingWorker();
  startLeaveAccrualWorker();
}
