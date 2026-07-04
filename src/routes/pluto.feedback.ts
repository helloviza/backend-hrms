import { Router } from "express";
import { applyRmFeedback } from "../utils/plutoFeedbackApplier.js";
import { getConversationContext, saveConversationContext } from "../utils/plutoMemory.js";
import type { PlutoRmFeedback } from "../types/plutoFeedback.js";

const router = Router();

router.post("/", async (req: any, res) => {
  try {
    const feedback = req.body as PlutoRmFeedback;

    if (!feedback.conversationId) {
      return res.status(400).json({ ok: false, message: "conversationId is required" });
    }

    // Tenant identity from req (set by auth/workspace middleware once mounted).
    // AMENDMENT O: this route stays UNMOUNTED — wiring a dead RM feedback API is a
    // separate product decision, not a side effect of the security migration. The
    // tenant-aware call sites are fixed regardless.
    const workspaceObjectId = (req as any).workspaceObjectId;
    const userId = (req as any).user?._id;

    // 1. Pull the trip memory (workspace-scoped)
    let conversationContext = await getConversationContext({
      workspaceObjectId,
      userId,
      conversationId: feedback.conversationId,
    });

    if (!conversationContext) {
      // If it's a new trip, create a blank slate
      conversationContext = { id: feedback.conversationId, locked: {}, state: "DISCOVERY" };
    }

    // 2. Apply the Human Manager's changes
    const { updatedLocked, updatedState } = applyRmFeedback(
      conversationContext.locked,
      conversationContext.state,
      feedback
    );

    conversationContext.locked = updatedLocked;
    conversationContext.state = updatedState;

    // 3. Save it back (workspace-scoped upsert)
    await saveConversationContext({
      workspaceObjectId,
      userId,
      conversationId: feedback.conversationId,
      context: conversationContext,
    });

    return res.json({ ok: true, context: conversationContext });
  } catch (err: any) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

export default router;