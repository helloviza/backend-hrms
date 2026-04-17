import type { Response } from "express";

// Map of userId → array of SSE Response connections (multi-tab support)
const clients = new Map<string, Response[]>();

export function addClient(userId: string, res: Response): void {
  const existing = clients.get(userId) || [];
  clients.set(userId, [...existing, res]);
}

export function removeClient(userId: string, res: Response): void {
  const existing = clients.get(userId) || [];
  const updated = existing.filter((r) => r !== res);
  if (updated.length === 0) {
    clients.delete(userId);
  } else {
    clients.set(userId, updated);
  }
}

export function sendToUser(userId: string, event: string, data: unknown): void {
  const conns = clients.get(userId);
  console.log('[SSE] Sending to:', userId, 'event:', event, 'clients:', conns?.length);
  if (!conns?.length) return;

  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const alive: Response[] = [];

  for (const res of conns) {
    try {
      if (res.writableEnded || res.destroyed) {
        // Stale connection — skip and don't keep
        continue;
      }
      res.write(payload);
      alive.push(res);
    } catch {
      // Write failed — connection is dead, don't add to alive list
    }
  }

  // Prune Map to only living connections
  if (alive.length !== conns.length) {
    if (alive.length === 0) {
      clients.delete(userId);
    } else {
      clients.set(userId, alive);
    }
  }
}

export function sendToUsers(userIds: string[], event: string, data: unknown): void {
  userIds.forEach((uid) => sendToUser(uid, event, data));
}

export function getOnlineUsers(): string[] {
  return Array.from(clients.keys());
}

export function isOnline(userId: string): boolean {
  return clients.has(userId);
}

export function getClientCount(userId: string): number {
  return clients.get(userId)?.length ?? 0;
}
