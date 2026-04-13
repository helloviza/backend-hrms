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
  const userClients = clients.get(userId);
  console.log('[SSE] Sending to:', userId, 'event:', event, 'clients:', userClients?.length);
  if (!userClients) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  userClients.forEach((res) => {
    try {
      res.write(payload);
    } catch {
      // client already disconnected — will be cleaned up on 'close'
    }
  });
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
