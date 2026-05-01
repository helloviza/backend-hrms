import TicketLead, { type ITicketLead } from "../models/TicketLead.js";
import Customer from "../models/Customer.js";
import logger from "../utils/logger.js";
import mongoose, { Types } from "mongoose";

const COMMON_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in",
  "outlook.com", "hotmail.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com",
  "rediffmail.com", "ymail.com",
]);

const PHONE_RE = /(?:\+91[-.\s]?)?[6-9]\d{9}/g;

function extractCompanyFromDomain(email: string): string | undefined {
  const domain = email.split("@")[1];
  if (!domain || COMMON_DOMAINS.has(domain.toLowerCase())) return undefined;
  const parts = domain.split(".");
  return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
}

function extractPhone(signature: string): string | undefined {
  const matches = signature.match(PHONE_RE);
  return matches?.[0]?.replace(/[-.\s]/g, "") ?? undefined;
}

export interface LeadResolution {
  lead: ITicketLead & mongoose.Document;
  workspaceId?: Types.ObjectId;
}

export async function findOrCreateLead(opts: {
  email: string;
  name?: string;
  signature?: string;
}): Promise<LeadResolution> {
  const email = opts.email.toLowerCase().trim();

  let workspaceId: Types.ObjectId | undefined;

  const customer = await Customer.findOne({
    $or: [
      { email },
      { "contacts.officialEmail": email },
    ],
  }).select("_id").lean();

  if (customer) {
    workspaceId = customer._id as unknown as Types.ObjectId;
    logger.info("[LeadResolver] Matched customer workspace", { email, customerId: workspaceId });
  }

  const existing = await TicketLead.findOne({ email });

  if (existing) {
    existing.ticketCount += 1;
    existing.lastTicketAt = new Date();
    if (workspaceId && !existing.linkedCustomerId) {
      existing.linkedCustomerId = workspaceId as unknown as mongoose.Schema.Types.ObjectId;
    }
    await existing.save();
    const resolvedWs = workspaceId ?? (existing.linkedCustomerId as unknown as Types.ObjectId | undefined);
    return { lead: existing, workspaceId: resolvedWs };
  }

  const company = opts.signature
    ? (extractCompanyFromDomain(email) ?? undefined)
    : extractCompanyFromDomain(email);

  const phone = opts.signature ? extractPhone(opts.signature) : undefined;

  const lead = await TicketLead.create({
    email,
    name: opts.name || "",
    phone,
    company,
    firstSeenAt: new Date(),
    lastTicketAt: new Date(),
    ticketCount: 1,
    status: "NEW",
    linkedCustomerId: workspaceId,
  });

  logger.info("[LeadResolver] Created new TicketLead", { email, leadId: lead._id });
  return { lead, workspaceId };
}
