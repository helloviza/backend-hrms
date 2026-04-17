import mongoose from "mongoose";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { sbtLogger } from "../utils/logger.js";
import { env } from "../config/env.js";

// The 13 tenant-isolated collections
const TENANT_COLLECTIONS = [
  "employees",
  "onboardings",
  "customers",
  "vendors",
  "leaves",
  "leavepolicies",
  "leavebalances",
  "sbtbookings",
  "conversations",
  "messages",
  "documents",
  "businessservices",
  "usagemetrics",
];

/**
 * Generate a URL-safe slug from company name.
 * "Inteletek AI" → "inteletekAI" → "inteletekAI" lowercased letters only
 * "Acme Corp Ltd." → "acmecorpltd"
 */
export function generateSlug(companyName: string): string {
  return companyName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 30);
}

/**
 * Ensure slug is unique — append 4-char random suffix if taken.
 */
export async function ensureUniqueSlug(
  baseSlug: string,
  CustomerWorkspace: mongoose.Model<any>,
): Promise<string> {
  const existing = await CustomerWorkspace.findOne({ slug: baseSlug })
    .select("_id")
    .lean();
  if (!existing) return baseSlug;
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${baseSlug.slice(0, 26)}${suffix}`;
}

/**
 * Provision all 13 isolated MongoDB collections for a tenant.
 * Collections are named: {collectionName}_{slug}
 * Uses db.createCollection() — safe to call even if already exists (code 48 ignored).
 */
export async function provisionTenantCollections(slug: string): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB connection not ready");

  for (const col of TENANT_COLLECTIONS) {
    const name = `${col}_${slug}`;
    try {
      await db.createCollection(name);
      sbtLogger.info(`[TENANT PROVISION] Created collection: ${name}`);
    } catch (err: any) {
      // 48 = NamespaceExists — already exists, safe to ignore
      if (err?.code === 48) {
        sbtLogger.info(`[TENANT PROVISION] Collection exists: ${name}`);
      } else {
        throw err;
      }
    }
  }
}

/**
 * Provision S3 folder structure for a tenant.
 * Creates a placeholder .keep file at workspaces/{workspaceId}/.keep
 * using the same S3 client pattern as s3Upload.ts.
 */
export async function provisionTenantS3(workspaceId: string): Promise<void> {
  const s3 = new S3Client({
    region: env.AWS_REGION,
    credentials:
      env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
  });

  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: `workspaces/${workspaceId}/.keep`,
      Body: "",
      ContentType: "application/octet-stream",
    }),
  );

  sbtLogger.info(
    `[TENANT PROVISION] S3 folder created: workspaces/${workspaceId}/`,
  );
}

/**
 * Seed default data for a new tenant workspace.
 * - Default LeavePolicy (uses schema defaults; workspaceId required)
 * - Default departments (6 standard depts)
 * Non-fatal — logs warnings and continues on failure.
 */
export async function seedTenantDefaults(workspaceId: string): Promise<void> {
  const wsOid = new mongoose.Types.ObjectId(workspaceId);

  // Seed default leave policy
  try {
    const LeavePolicyModel = mongoose.models["LeavePolicy"] as
      | mongoose.Model<any>
      | undefined;
    if (LeavePolicyModel) {
      const existing = await LeavePolicyModel.findOne({
        workspaceId: wsOid,
      }).lean();
      if (!existing) {
        await LeavePolicyModel.create({ workspaceId: wsOid });
        sbtLogger.info(
          `[TENANT PROVISION] Default LeavePolicy seeded for ${workspaceId}`,
        );
      }
    }
  } catch (err) {
    sbtLogger.warn(`[TENANT PROVISION] LeavePolicy seed skipped: ${err}`);
  }

  // Seed default departments
  try {
    const DepartmentModel = mongoose.models["Department"] as
      | mongoose.Model<any>
      | undefined;
    if (DepartmentModel) {
      const existing = await DepartmentModel.findOne({
        workspaceId: wsOid,
      }).lean();
      if (!existing) {
        const defaultDepts = [
          "Engineering",
          "Sales",
          "Marketing",
          "Operations",
          "Finance",
          "HR",
        ];
        await DepartmentModel.insertMany(
          defaultDepts.map((name) => ({ name, workspaceId: wsOid })),
        );
        sbtLogger.info(
          `[TENANT PROVISION] Default departments seeded for ${workspaceId}`,
        );
      }
    }
  } catch (err) {
    sbtLogger.warn(`[TENANT PROVISION] Department seed skipped: ${err}`);
  }
}

/**
 * Full tenant provisioning — call this after workspace creation.
 * Runs all steps and logs each one.
 * S3 failure is non-fatal; collection + seed failures propagate.
 */
export async function provisionNewTenant(
  workspaceId: string,
  customerId: string,
  slug: string,
): Promise<void> {
  sbtLogger.info(
    `[TENANT PROVISION] Starting for workspace: ${workspaceId} slug: ${slug}`,
  );

  await provisionTenantCollections(slug);

  try {
    await provisionTenantS3(workspaceId);
  } catch (err) {
    sbtLogger.error(`[TENANT PROVISION] S3 failed (non-fatal): ${err}`);
  }

  await seedTenantDefaults(workspaceId);

  sbtLogger.info(
    `[TENANT PROVISION] Complete for workspace: ${workspaceId}`,
  );
}
