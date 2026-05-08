// Parse a YYYY-MM-DD string as an IST calendar day boundary.
// The API contract: any YYYY-MM-DD passed between frontend and backend means
// the corresponding IST (Asia/Kolkata, UTC+05:30) calendar day.

export function parseISTStart(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000+05:30`);
}

export function parseISTEnd(dateStr: string): Date {
  return new Date(`${dateStr}T23:59:59.999+05:30`);
}
