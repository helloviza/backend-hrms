// apps/backend/src/services/video/createVideoAnalysisRecord.ts
//
// Single source of truth for creating a VideoAnalysis row. Both the file
// upload path (POST /pluto/video/register) and the URL intake path
// (POST /pluto/video/from-url) call this — one place sets workspaceId/userId/
// status, so the two front doors can never drift the way the writer and
// reader drifted before 8443d86.

import mongoose from "mongoose";
import VideoAnalysis from "../../models/VideoAnalysis.js";

export type CreateVideoAnalysisRecordInput = {
  workspaceId: mongoose.Types.ObjectId | string;
  userId: mongoose.Types.ObjectId | string;
  conversationId?: string | null;
  s3Key: string;
  originalFileName?: string | null;
  contentType?: string | null;
  durationSec?: number | null;
  sourceUrl?: string | null;
};

export async function createVideoAnalysisRecord(input: CreateVideoAnalysisRecordInput) {
  return VideoAnalysis.create({
    workspaceId: input.workspaceId,
    userId: input.userId,
    conversationId: input.conversationId || null,
    s3Key: input.s3Key,
    originalFileName: input.originalFileName || undefined,
    contentType: input.contentType || "video/mp4",
    durationSec: input.durationSec ?? null,
    sourceUrl: input.sourceUrl || undefined,

    status: "processing",
    progress: 0,
  });
}
