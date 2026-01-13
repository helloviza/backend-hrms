// apps/backend/src/routes/assistantHr.ts
import { Router, Request, Response } from "express";

const router = Router();

type HrAssistantBody = {
  question?: string;
  context?: {
    stats?: any;
    profile?: any;
  };
};

// --- helpers ---------------------------------------------------

function normaliseQuestion(q: string): string {
  return q.toLowerCase().trim();
}

function detectIntent(normalised: string): string {
  if (!normalised) return "SMALL_TALK";

  if (
    normalised.includes("leave balance") ||
    (normalised.includes("leave") && normalised.includes("remain")) ||
    (normalised.includes("leaves") && normalised.includes("left"))
  ) {
    return "LEAVE_BALANCE";
  }

  if (
    normalised.includes("attendance") ||
    normalised.includes("present") ||
    normalised.includes("absent")
  ) {
    return "ATTENDANCE_SUMMARY";
  }

  if (normalised.includes("manager") || normalised.includes("reporting")) {
    return "MANAGER_LOOKUP";
  }

  if (
    normalised.includes("document") ||
    normalised.includes("docs") ||
    normalised.includes("upload")
  ) {
    return "DOCS_HELP";
  }

  if (
    normalised.includes("hi") ||
    normalised.includes("hello") ||
    normalised.includes("hey")
  ) {
    return "SMALL_TALK";
  }

  return "GENERIC";
}

function getFirstName(profile: any): string {
  const name: string | undefined =
    profile?.name || profile?.fullName || profile?.displayName;
  if (name && typeof name === "string" && name.trim().length > 0) {
    return name.trim().split(/\s+/)[0];
  }

  const email: string | undefined = profile?.email;
  if (email && typeof email === "string" && email.includes("@")) {
    return email.split("@")[0];
  }

  return "there";
}

function parseNumeric(value: unknown): number | null {
  if (value == null) return null;

  if (typeof value === "number") {
    return Number.isNaN(value) ? null : value;
  }

  const str = String(value).trim();
  if (!str) return null;

  const cleaned = str.replace(/[^\d.]/g, "");
  if (!cleaned) return null;

  const n = Number.parseFloat(cleaned);
  if (Number.isNaN(n)) return null;

  return n;
}

// --- intent handlers --------------------------------------------

function handleLeaveBalance(profile: any, stats: any): { answer: string; intent: string } {
  const firstName = getFirstName(profile);

  const leavesTakenRaw =
    stats?.leavesTaken ??
    stats?.leaves_used ??
    stats?.usedLeaves ??
    stats?.leavesThisYear;

  const entitlementRaw =
    stats?.leaveEntitlement ??
    stats?.annualLeaves ??
    process.env.DEFAULT_ANNUAL_LEAVES ??
    "18";

  const takenNum = parseNumeric(leavesTakenRaw);
  const entitlementNum = parseNumeric(entitlementRaw);

  // ✅ IMPORTANT: treat 0 as valid (not as "no data")
  if (takenNum !== null) {
    const remaining =
      entitlementNum !== null ? Math.max(entitlementNum - takenNum, 0) : null;

    let answer = `Here’s what I can see for you, ${firstName}:\n\n`;

    if (entitlementNum !== null) {
      answer += `• You’ve taken about **${takenNum} day(s)** of leave this year out of an estimated **${entitlementNum} day(s)**.\n`;
      if (remaining !== null) {
        answer += `• That leaves you with roughly **${remaining} day(s)** still available.\n\n`;
      } else {
        answer += "\n";
      }
    } else {
      answer += `• You’ve taken about **${takenNum} day(s)** of leave so far this year.\n\n`;
    }

    answer +=
      "For the exact, official balance, please open the **Leaves** module in PlumTrips HRMS – the top bar will show your live available / remaining leave balance.";

    return { answer, intent: "LEAVE_BALANCE" };
  }

  // Fallback when we *really* have no stats
  const fallback =
    "I’m not able to read your leave statistics from the system right now.\n\n" +
    "Please open the **Leaves** module – the top bar will show your live available / remaining leave balance. " +
    "If anything looks incorrect, you can calmly raise a support ticket and the HR team will help fix it.";

  return { answer: fallback, intent: "LEAVE_BALANCE" };
}

function handleAttendanceSummary(profile: any, stats: any): { answer: string; intent: string } {
  const firstName = getFirstName(profile);
  const attendanceRaw =
    stats?.attendancePercent ??
    stats?.attendance ??
    stats?.attendanceRate;

  const attNum = parseNumeric(attendanceRaw);

  if (attNum !== null) {
    const answer =
      `Here’s your attendance snapshot, ${firstName}:\n\n` +
      `• Your recorded attendance is around **${attNum.toFixed(1)}%** for the current period.\n` +
      "• For a top performance band, we generally expect attendance above **95%**.\n\n" +
      "You can see a detailed day-wise view under the **Attendance** module.";

    return { answer, intent: "ATTENDANCE_SUMMARY" };
  }

  const fallback =
    "I’m not able to read your detailed attendance from the system right now.\n\n" +
    "Please open the **Attendance** module – it will show your check-ins, late marks, and overall percentage.";
  return { answer: fallback, intent: "ATTENDANCE_SUMMARY" };
}

function handleManagerLookup(profile: any): { answer: string; intent: string } {
  const firstName = getFirstName(profile);
  const managerName: string | undefined =
    profile?.managerName || profile?.manager || profile?.reportingManager;

  if (managerName && managerName.trim()) {
    const answer =
      `Hi ${firstName}, according to the HR system your reporting manager is:\n\n` +
      `• **${managerName.trim()}**\n\n` +
      "If this is not correct, please reach out to HR so they can update your reporting line.";
    return { answer, intent: "MANAGER_LOOKUP" };
  }

  const fallback =
    "I don’t see a manager mapped to your profile yet.\n\n" +
    "Please raise this with HR so they can assign the correct reporting manager in PlumTrips HRMS.";
  return { answer: fallback, intent: "MANAGER_LOOKUP" };
}

function handleDocsHelp(profile: any, stats: any): { answer: string; intent: string } {
  const firstName = getFirstName(profile);
  const docsUploaded = parseNumeric(
    stats?.docsUploaded ?? stats?.documentsCount ?? stats?.docs
  );

  let answer =
    `Here’s how documents work for you, ${firstName}:\n\n` +
    "• Go to **My Profile → Documents** and use the **Upload docs** quick action.\n" +
    "• You can upload ID proofs, bank details, and any other HR-required documents (PDF / JPG / PNG / DOCX).\n";

  if (docsUploaded !== null) {
    answer += `\nRight now the system shows **${docsUploaded} document(s)** linked to your profile.`;
  }

  answer +=
    "\n\nIf something is missing or uploaded to the wrong category, HR can help you relabel or replace the file.";

  return { answer, intent: "DOCS_HELP" };
}

function handleSmallTalk(profile: any): { answer: string; intent: string } {
  const firstName = getFirstName(profile);
  const answer =
    `Hi ${firstName}! 👋 I’m your PlumTrips HR Copilot.\n\n` +
    "You can ask me things like:\n" +
    "• *What is my leave balance?*\n" +
    "• *How is my attendance this month?*\n" +
    "• *Who is my manager?*\n" +
    "• *How do I upload my documents?*\n\n" +
    "Whenever you’re ready, type your question in simple English.";
  return { answer, intent: "SMALL_TALK" };
}

function handleGeneric(profile: any): { answer: string; intent: string } {
  const firstName = getFirstName(profile);
  const answer =
    `I’ve captured your question, ${firstName}, but I don’t yet have a dedicated workflow for this.\n\n` +
    "Right now I’m best at HR basics like **leaves, attendance, manager details, and documents**.\n" +
    "Try re-phrasing your question with one of those topics, and I’ll do my best to help.";
  return { answer, intent: "GENERIC" };
}

// --- route ------------------------------------------------------

router.post(
  "/hr",
  async (req: Request<unknown, unknown, HrAssistantBody>, res: Response) => {
    try {
      const question = (req.body?.question || "").trim();
      const context = req.body?.context || {};
      const stats = context.stats || {};
      const profile = context.profile || {};

      const normalised = normaliseQuestion(question);
      const intent = detectIntent(normalised);

      let result:
        | { answer: string; intent: string }
        | undefined;

      switch (intent) {
        case "LEAVE_BALANCE":
          result = handleLeaveBalance(profile, stats);
          break;
        case "ATTENDANCE_SUMMARY":
          result = handleAttendanceSummary(profile, stats);
          break;
        case "MANAGER_LOOKUP":
          result = handleManagerLookup(profile);
          break;
        case "DOCS_HELP":
          result = handleDocsHelp(profile, stats);
          break;
        case "SMALL_TALK":
          result = handleSmallTalk(profile);
          break;
        default:
          result = handleGeneric(profile);
          break;
      }

      res.json({
        answer: result.answer,
        intent: result.intent,
      });
    } catch (err) {
      console.error("HR assistant error:", err);
      res.status(200).json({
        answer:
          "Sorry, I couldn’t fetch an answer just now. Please try again in a moment or open the respective HR module directly.",
        intent: "ERROR",
      });
    }
  }
);

export default router;
