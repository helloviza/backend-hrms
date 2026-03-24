import { startVideoProcessingWorker } from "./videoProcessingWorker.js";

export function startBackgroundWorkers() {
  startVideoProcessingWorker();
}