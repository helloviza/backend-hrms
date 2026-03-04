// apps/backend/src/routes/copilot.ts
import { Router } from "express";
import OpenAI from "openai";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const hasApiKey = !!process.env.OPENAI_API_KEY;
const openai = hasApiKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Small helper to extract safe requester context from req.user
function getRequesterContext(user: any) {
  if (!user) return "Unknown user";
  const name =
    user.firstName ||
    user.name ||
    user.fullName ||
    user.email ||
    `User#${user.id || user._id || "unknown"}`;
  return `${name} (id: ${user.id || user._id || "n/a"})`;
}

router.post("/manager", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user || null;
    const body = req.body || {};

    const question: string = (body.question || "").toString().trim();
    if (!question) {
      return res.status(400).json({ error: "Question is required." });
    }

    // mode: "manager" | "hr-admin" (default: manager)
    const rawMode = (body.mode || "").toString().toLowerCase();
    const mode: "manager" | "hr-admin" =
      rawMode.includes("hr") || rawMode.includes("admin") ? "hr-admin" : "manager";

    // Optional focus on a specific employee/team member
    const employeeId =
      body.employeeId ||
      body.teamMemberId ||
      body.memberId ||
      body.targetEmployeeId ||
      null;

    const requesterCtx = getRequesterContext(user);

    const focusLine = employeeId
      ? `The requester has selected a specific person with internal id "${employeeId}". You may refer to them as "the selected employee" or "the selected team member", but do NOT invent any details or exact balances that are not explicitly provided.`
      : `No specific employee has been selected. Answer at an org-level or team-level only.`;

    // 🔹 DEMO / no-billing mode when there is no API key
    if (!hasApiKey) {
      const who = mode === "hr-admin" ? "HR admin" : "manager";
      const focusSuffix = employeeId
        ? `\n\nSelected person id: ${employeeId}`
        : "";

      return res.json({
        mode: "demo",
        answer:
          `Copilot is running in DEMO mode on this server (no OpenAI billing).\n\n` +
          `You are using the ${who} view.\n\n` +
          `You asked: "${question}".${focusSuffix}\n\n` +
          `Right now I can't call an AI model, but here are a few things you can do inside PlumTrips HRMS:\n` +
          (mode === "hr-admin"
            ? `• Open the HR Admin dashboard to see total employees, active/inactive counts, open leave requests, and attendance.\n` +
              `• Use filters (date range, department, location, status) to slice the data.\n` +
              `• Export employees / leaves / attendance to CSV or Excel from the HR Admin dashboard.\n`
            : `• Open the Manager dashboard (/dashboard/manager) to see your team availability and who is on leave.\n` +
              `• Click on any team member to view their profile, attendance, and leave summary (excluding salary data).\n` +
              `• Use filters for date range and status to understand patterns in your team’s attendance and leave.\n`)
      });
    }

    const roleLine =
      mode === "hr-admin"
        ? "You are assisting HR administrators with org-wide questions (across all employees)."
        : "You are assisting people managers with questions about their team and nearby org context.";

    const systemPrompt = `
You are PlumTrips HR Copilot.

${roleLine}

CRITICAL RULES:
- You must NEVER reveal salary, compensation, CTC, or pay-related details.
- If you don't have explicit data (exact leave balance, exact attendance %, specific numbers), do NOT invent them.
- Instead, explain how the user can find this information inside the PlumTrips HRMS dashboards or profiles.
- Keep answers concise, practical, and action-oriented.
- If the user asks something that would require looking at confidential pay or performance data, politely refuse and redirect them to internal HR policies.

When useful, suggest which page to check, for example:
- "HR Admin Dashboard" for org-level metrics, exports, and filters.
- "Manager Dashboard" for team availability and member profiles.
- "Employee profile / attendance / leave pages" for a single person.

Respond in a professional but friendly tone.
    `.trim();

    const userPrompt = `
Requester context: ${requesterCtx}
Mode: ${mode}

${focusLine}

Manager/HR question:
"${question}"

If you need data that is not available in this prompt (such as exact remaining leave days of a specific person),
you must NOT fabricate numbers. Instead, tell the requester which page or feature inside the HRMS they should open
to view or confirm those details.
    `.trim();

    const completion = await openai!.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
    });

    const answer =
      completion.choices[0]?.message?.content ||
      "I’m not sure how to answer that yet, but you can usually find more details in the HR Admin or Manager dashboards.";

    return res.json({ mode: "live", answer });
  } catch (err: any) {
    console.error("Copilot /manager error", err);

    const status = err?.status || err?.statusCode;
    const code = err?.code || err?.data?.code;

    // 🔹 Gracefully handle quota / billing errors
    if (status === 429 || code === "insufficient_quota") {
      return res.status(200).json({
        mode: "quota_exceeded",
        answer:
          "Copilot is temporarily running in demo mode because the OpenAI API quota has been exhausted.\n\n" +
          "You can still use the HR Admin and Manager dashboards (filters, exports, profile views) to answer most of your questions directly from live data.",
      });
    }

    return res.status(500).json({
      error: "Failed to generate Copilot response.",
    });
  }
});

export default router;
