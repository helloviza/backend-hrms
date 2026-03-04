import { Router } from "express";
import { applyRmFeedback } from "../utils/plutoFeedbackApplier.js";
import { getConversationContext, saveConversationContext } from "../utils/plutoMemory.js";
import type { PlutoRmFeedback } from "../types/plutoFeedback.js";

const router = Router();

router.post("/", async (req, res) => {
  try {
    const feedback = req.body as PlutoRmFeedback;

    if (!feedback.conversationId) {
      return res.status(400).json({ ok: false, message: "conversationId is required" });
    }

    // 1. Pull the trip memory from storage
    let conversationContext = await getConversationContext(feedback.conversationId);
    
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

    // 3. Save it back to the storage room
    await saveConversationContext(feedback.conversationId, conversationContext);

    return res.json({ ok: true, context: conversationContext });
  } catch (err: any) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

export default router;