import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { env } from "./env.js";

export const s3 = new S3Client({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  // Default handler has no timeouts, so a stalled connection (e.g. a blip on
  // the NAT-gateway egress path) hangs the SDK call indefinitely instead of
  // erroring and letting the SDK's own retry logic (maxAttempts below) kick
  // in. Bounded generously for uploads/downloads well under our 2MB limits.
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 5_000,
    socketTimeout: 15_000,
  }),
  maxAttempts: 3,
});
