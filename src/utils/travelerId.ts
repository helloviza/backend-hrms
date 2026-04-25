// apps/backend/src/utils/travelerId.ts
import Customer from "../models/Customer.js";
import CustomerMember from "../models/CustomerMember.js";

const STOP_WORDS = new Set([
  "for", "of", "and", "the", "a", "an", "in", "to", "by", "at", "or",
  "pvt", "ltd", "private", "limited", "llp", "inc", "corp", "company",
  "consulting", "services", "solutions", "technologies",
  "productions", "enterprises", "group",
]);

export function deriveWorkspaceCode(companyName: string, override?: string): string {
  if (override && override.trim().length >= 2) {
    return override.trim().toUpperCase().substring(0, 6);
  }

  const words = companyName
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w.toLowerCase()));

  if (words.length === 0) {
    return companyName.replace(/\s/g, "").substring(0, 6).toUpperCase() || "PLUM";
  }

  if (words.length === 1) {
    return words[0].substring(0, 6).toUpperCase();
  }

  const acronym = words.map((w) => w[0].toUpperCase()).join("");
  return acronym.substring(0, 6);
}

export async function generateTravelerId(
  customerId: string,
  companyName: string,
): Promise<string> {
  const customer = await Customer.findById(customerId)
    .select("legalName name workspaceCode")
    .lean();
  const resolvedName = (customer as any)?.legalName || (customer as any)?.name || companyName;
  const code = deriveWorkspaceCode(resolvedName, (customer as any)?.workspaceCode);
  const prefix = `${code}-`;

  const existing = await CustomerMember.find({
    customerId,
    travelerId: { $regex: `^${prefix}` },
  })
    .select("travelerId")
    .lean();

  let maxNum = 0;
  for (const m of existing) {
    const tid = (m as any).travelerId as string | undefined;
    if (!tid) continue;
    const parts = tid.split("-");
    const num = parseInt(parts[parts.length - 1] || "0", 10);
    if (!isNaN(num) && num > maxNum) maxNum = num;
  }

  const next = maxNum + 1;
  const padded = next < 1000 ? String(next).padStart(3, "0") : String(next);
  return `${prefix}${padded}`;
}
