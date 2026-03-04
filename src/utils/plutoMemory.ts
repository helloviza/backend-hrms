// apps/backend/src/utils/plutoMemory.ts

// This is a simple "Storage Room" to keep track of conversations
const storage = new Map<string, any>();

export async function getConversationContext(id: string) {
  return storage.get(id) || null;
}

export async function saveConversationContext(id: string, context: any) {
  storage.set(id, context);
}