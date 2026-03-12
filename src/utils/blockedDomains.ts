export const BLOCKED_DOMAINS = [
  "gmail.com", "hotmail.com", "yahoo.com", "outlook.com",
  "icloud.com", "protonmail.com", "live.com", "msn.com",
  "rediffmail.com", "ymail.com", "aol.com", "zoho.com",
  "mail.com", "inbox.com", "gmx.com",
];

export function isGenericDomain(domain: string): boolean {
  return BLOCKED_DOMAINS.includes(domain.toLowerCase().trim());
}
