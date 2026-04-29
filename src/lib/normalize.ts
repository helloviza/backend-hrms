// Shared normalization utilities for TBO payload building.

/** Strip trailing period from TBO title values (TBO spec accepts Mr/Mrs/Ms/Mstr, not Mr./Mrs./etc.) */
export function normalizeTitle(title: string): string {
  if (!title) return title;
  return title.trim().replace(/\.$/, "");
}

/**
 * Remove Phoneno / Email keys when empty or nullish.
 * TBO rejects payloads where these fields are present but empty string.
 */
export function stripEmptyContactFields<T extends Record<string, unknown>>(passenger: T): T {
  const cleaned = { ...passenger };
  if (!cleaned["Phoneno"]) delete cleaned["Phoneno"];
  if (!cleaned["Email"]) delete cleaned["Email"];
  return cleaned as T;
}
