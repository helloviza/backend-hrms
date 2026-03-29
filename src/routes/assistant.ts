// apps/backend/src/routes/assistant.ts
// Phase 2 – HR / People & Business Copilot powered by real-time HRMS data

import { Router, Request, Response } from "express";
import Attendance from "../models/Attendance.js";
import LeaveRequest from "../models/LeaveRequest.js";
import Document from "../models/Document.js";
import User from "../models/User.js";
import { scopedFindById } from "../middleware/scopedFindById.js";

const router = Router();

/* ---------- types ---------- */

interface AssistantContextStats {
  attendancePercent?: string | number | null;
  leavesTaken?: string | number | null;
  pendingApprovals?: string | number | null;
  docsUploaded?: string | number | null;
}

interface AssistantContextProfile {
  managerName?: string | null;
  department?: string | null;
  location?: string | null;

  // extra optional fields (can be passed from frontend later)
  displayName?: string | null;
  name?: string | null;
  firstName?: string | null;
  email?: string | null;
}

interface AssistantContext {
  stats?: AssistantContextStats;
  profile?: AssistantContextProfile;
}

interface AssistantRequestBody {
  question?: string;
  /**
   * Optional: Phase-1 style context passed by frontend.
   * Still supported, but now we also build context on the server
   * using the logged-in user.
   */
  context?: AssistantContext;
}

interface AssistantResponseBody {
  answer: string;
  intent: string;
}

/* ---------- small helpers ---------- */

const hasWord = (normalized: string, word: string) =>
  normalized.includes(word.toLowerCase());

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return undefined;
    return value;
  }
  if (typeof value === "string") {
    const n = parseFloat(value.replace("%", "").trim());
    if (Number.isNaN(n)) return undefined;
    return n;
  }
  return undefined;
}

function extractFirstName(
  value: string | null | undefined
): string | undefined {
  if (!value) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;

  const parts = trimmed.split(/\s+/);
  return parts[0] || trimmed;
}

/**
 * Merge server-side context (built from HRMS) with any context
 * that frontend still passes from Phase-1.
 * Backend context always wins if both provide a field.
 */
function mergeContexts(
  backend: AssistantContext | undefined,
  fromClient: AssistantContext | undefined
): AssistantContext {
  const stats: AssistantContextStats = {
    attendancePercent:
      backend?.stats?.attendancePercent ?? fromClient?.stats?.attendancePercent,
    leavesTaken:
      backend?.stats?.leavesTaken ?? fromClient?.stats?.leavesTaken,
    pendingApprovals:
      backend?.stats?.pendingApprovals ?? fromClient?.stats?.pendingApprovals,
    docsUploaded:
      backend?.stats?.docsUploaded ?? fromClient?.stats?.docsUploaded,
  };

  const profile: AssistantContextProfile = {
    managerName:
      backend?.profile?.managerName ?? fromClient?.profile?.managerName,
    department:
      backend?.profile?.department ?? fromClient?.profile?.department,
    location: backend?.profile?.location ?? fromClient?.profile?.location,

    displayName:
      backend?.profile?.displayName ?? fromClient?.profile?.displayName,
    name: backend?.profile?.name ?? fromClient?.profile?.name,
    firstName:
      backend?.profile?.firstName ?? fromClient?.profile?.firstName,
    email: backend?.profile?.email ?? fromClient?.profile?.email,
  };

  return { stats, profile };
}

/* ---------- ROLES & CONTEXT HELPERS ---------- */

type UserId = string | number;
type RoleString = string;

interface DashboardStatsLike {
  attendancePercent?: number | string | null;
  attendance_percent?: number | string | null; // snake_case variant
  leavesTaken?: number | string | null;
  leaves_taken?: number | string | null; // snake_case variant
  leavesUsed?: number | string | null;
  pendingApprovals?: number | string | null;
}

interface ProfileLike {
  managerName?: string | null;
  manager_name?: string | null;
  department?: string | null;
  departmentName?: string | null;
  location?: string | null;
  workLocation?: string | null;
  baseLocation?: string | null;

  displayName?: string | null;
  name?: string | null;
  firstName?: string | null;
  email?: string | null;
}

interface DocsSummaryLike {
  count?: number;
  docsCount?: number;
  total?: number;
}

/**
 * Use the same logic as /stats/dashboard for attendance & leaves.
 * IMPORTANT: Adjust the field names (userId / employeeId / employee / ownerId / user)
 * and status values ("PENDING") to match your actual schemas.
 */
async function getDashboardStatsForUser(
  userId: UserId
): Promise<DashboardStatsLike | null> {
  const uid = String(userId);

  // Try multiple possible fields so we don't silently return 0
  const userMatch = {
    $or: [
      { userId: uid },
      { user_id: uid },
      { user: uid },
      { employeeId: uid },
      { employee_id: uid },
      { employee: uid },
      { employeeCode: uid },
      { ownerId: uid },
      { owner: uid },
    ],
  } as any;

  // For pending approvals, we assume a "status" field. Adjust the values if needed.
  const pendingMatch = {
    ...userMatch,
    status: { $in: ["PENDING", "Pending", "pending", "AWAITING_APPROVAL"] },
  } as any;

  const [attendanceCount, leaveCount, pendingCount] = await Promise.all([
    Attendance.countDocuments(userMatch),
    LeaveRequest.countDocuments(userMatch),
    LeaveRequest.countDocuments(pendingMatch),
  ]);

  // Very simple demo % – you can replace this with a smarter formula
  const attendancePercent =
    attendanceCount > 0 ? `${Math.min(attendanceCount, 100)}%` : null;

  const stats: DashboardStatsLike = {
    attendancePercent,
    leavesTaken: leaveCount,
    leavesUsed: leaveCount, // alias
    pendingApprovals: pendingCount,
  };

  // Debug log so you can see exactly what we are computing
  console.log("[assistant] getDashboardStatsForUser", {
    uid,
    attendanceCount,
    leaveCount,
    pendingCount,
    stats,
  });

  return stats;
}

/**
 * Use the same User model as /api/users/profile.
 */
async function getProfileForUser(
  userId: UserId,
  workspaceId?: string,
): Promise<ProfileLike | null> {
  const uid = String(userId);

  const user = await User.findOne({ _id: uid, ...(workspaceId ? { workspaceId } : {}) })
    .select("name firstName email department location managerName")
    .lean();

  if (!user) return null;

  const u: any = user;

  const profile: ProfileLike = {
    managerName: u.managerName || null,
    department: u.department || null,
    location: u.location || null,
    displayName: u.name || u.firstName || null,
    name: u.name || null,
    firstName: u.firstName || null,
    email: u.email || null,
  };

  return profile;
}

/**
 * Use the Document model to count uploaded documents for this user.
 */
async function getDocsSummaryForUser(
  userId: UserId
): Promise<DocsSummaryLike | null> {
  const uid = String(userId);

  const docMatch = {
    $or: [
      { userId: uid },
      { user_id: uid },
      { user: uid },
      { employeeId: uid },
      { employee_id: uid },
      { employee: uid },
      { ownerId: uid },
      { owner: uid },
    ],
  } as any;

  const docCount = await Document.countDocuments(docMatch);

  const summary: DocsSummaryLike = {
    count: docCount,
  };

  return summary;
}

function getPrimaryRole(authUser: any): RoleString {
  const directRole = authUser.role;
  const rolesArray = Array.isArray(authUser.roles) ? authUser.roles : [];
  const firstArrayRole = rolesArray[0];

  return String(directRole || firstArrayRole || "EMPLOYEE");
}

/**
 * Friendly examples depending on role – used in greeting & fallback answers.
 */
function roleExampleQuestions(roleRaw: RoleString): string {
  const role = roleRaw.toUpperCase();

  if (role.includes("SUPER")) {
    return [
      "• “Show me overall system health and active alerts.”",
      "• “Who has Super Admin access right now?”",
      "• “Show last week’s configuration changes or admin actions.”",
    ].join("\n");
  }

  if (role.includes("ADMIN")) {
    return [
      "• “List all users with their roles.”",
      "• “Who has access to HR data?”",
      "• “Show recent login or activity logs.”",
    ].join("\n");
  }

  if (role.includes("ANALYTICS")) {
    return [
      "• “Show headcount and attrition trends.”",
      "• “Compare payroll costs by department this quarter.”",
      "• “Show vendor performance analytics.”",
    ].join("\n");
  }

  if (role.includes("HR")) {
    return [
      "• “Show new joiners and exits this month.”",
      "• “Which employees have incomplete documentation?”",
      "• “Generate an attrition summary by department.”",
    ].join("\n");
  }

  if (role.includes("MANAGER")) {
    return [
      "• “Show my team’s attendance this week.”",
      "• “What leave requests are pending my approval?”",
      "• “Who in my team is on notice or probation?”",
    ].join("\n");
  }

  if (role.includes("VENDOR")) {
    return [
      "• “List approved vendors and compliance status.”",
      "• “Show spend by vendor for this quarter.”",
      "• “Which vendor contracts are expiring soon?”",
    ].join("\n");
  }

  if (role.includes("ASSOCIATION") || role.includes("BUSINESS")) {
    return [
      "• “Show travel spend for my company this month.”",
      "• “What are our most used routes and services?”",
      "• “Show pending service requests or escalations.”",
    ].join("\n");
  }

  // Default: Employee-style examples
  return [
    "• “What is my leave balance?”",
    "• “How is my attendance this month?”",
    "• “Who is my manager?”",
    "• “How many HR documents have I uploaded?”",
  ].join("\n");
}

/**
 * Build backend context using logged-in user.
 * Later this can be role-based (employee / manager / HR, etc.).
 */
async function buildBackendContext(req: Request): Promise<AssistantContext> {
  const authUser: any = (req as any).user || {};
  const clientContext = (req.body as any)?.context || {};
  const clientProfile = clientContext?.profile || {};

  // Prefer `sub`, then other common id fields, THEN `_id` (mongoose doc),
  // THEN anything we might have in client context profile
  const userId: UserId | undefined =
    authUser.sub ??
    authUser.id ??
    authUser.userId ??
    authUser.user_id ??
    authUser.employeeId ??
    authUser._id ??
    clientProfile.userId ??
    clientProfile.id ??
    clientProfile._id ??
    clientProfile.employeeId ??
    clientProfile.employeeCode;

  // Helpful debug to confirm what we're seeing on server side
  console.log("[assistant] authUser id fields", {
    sub: authUser.sub,
    id: authUser.id,
    userId: authUser.userId,
    user_id: authUser.user_id,
    employeeId: authUser.employeeId,
    _id: authUser._id,
    clientProfileKeys: Object.keys(clientProfile || {}),
    resolvedUserId: userId,
  });

  if (!userId) {
    console.log("[assistant] buildBackendContext: no userId resolved");
    return {};
  }

  try {
    const workspaceId = String((req as any).workspaceId || "");
    const [dashboard, profileData, docsSummary] = await Promise.all([
      getDashboardStatsForUser(userId).catch((err) => {
        console.error("[assistant] dashboard stats error:", err);
        return null;
      }),
      getProfileForUser(userId, workspaceId || undefined).catch((err) => {
        console.error("[assistant] profile info error:", err);
        return null;
      }),
      getDocsSummaryForUser(userId).catch((err) => {
        console.error("[assistant] docs summary error:", err);
        return null;
      }),
    ]);

    const stats: AssistantContextStats = {
      attendancePercent:
        dashboard?.attendancePercent ??
        dashboard?.attendance_percent ??
        null,
      leavesTaken:
        dashboard?.leavesTaken ??
        dashboard?.leavesUsed ??
        dashboard?.leaves_taken ??
        null,
      pendingApprovals: dashboard?.pendingApprovals ?? null,
      docsUploaded:
        docsSummary?.count ??
        docsSummary?.docsCount ??
        docsSummary?.total ??
        null,
    };

    const profile: AssistantContextProfile = {
      managerName:
        profileData?.managerName ??
        profileData?.manager_name ??
        null,
      department:
        profileData?.department ??
        profileData?.departmentName ??
        null,
      location:
        profileData?.location ??
        profileData?.workLocation ??
        profileData?.baseLocation ??
        null,
      displayName: profileData?.displayName ?? profileData?.name ?? null,
      name: profileData?.name ?? null,
      firstName: profileData?.firstName ?? null,
      email: profileData?.email ?? null,
    };

    return { stats, profile };
  } catch (err) {
    console.error("[assistant] buildBackendContext fatal error:", err);
    return {};
  }
}

/* ---------- route ---------- */

router.post(
  "/hr",
  async (
    req: Request<{}, AssistantResponseBody, AssistantRequestBody>,
    res: Response<AssistantResponseBody>
  ) => {
    const rawQuestion = req.body?.question ?? "";
    const question = String(rawQuestion).trim();

    if (!question) {
      return res.status(400).json({
        answer: "Please type a question so I can help.",
        intent: "missing_question",
      });
    }

    const normalized = question.toLowerCase();

    // ---- 1) classify intent ----
    let intent: string = "unknown";

    const isGreeting =
      hasWord(normalized, "hi") ||
      hasWord(normalized, "hello") ||
      hasWord(normalized, "hey") ||
      hasWord(normalized, "good morning") ||
      hasWord(normalized, "good evening") ||
      hasWord(normalized, "good afternoon");

    const askedBotHealth =
      hasWord(normalized, "how are you") ||
      hasWord(normalized, "how r u") ||
      hasWord(normalized, "how is your day") ||
      hasWord(normalized, "hope you are doing well") ||
      hasWord(normalized, "hope you are fine");

    if (
      (hasWord(normalized, "leave") || hasWord(normalized, "leaves")) &&
      (hasWord(normalized, "balance") ||
        hasWord(normalized, "allowance") ||
        hasWord(normalized, "left") ||
        hasWord(normalized, "remaining") ||
        hasWord(normalized, "status"))
    ) {
      intent = "leave_balance";
    } else if (
      hasWord(normalized, "attendance") ||
      hasWord(normalized, "timesheet") ||
      hasWord(normalized, "present") ||
      hasWord(normalized, "absent") ||
      hasWord(normalized, "check in") ||
      hasWord(normalized, "check-in") ||
      hasWord(normalized, "checkin")
    ) {
      intent = "attendance_summary";
    } else if (
      hasWord(normalized, "manager") ||
      hasWord(normalized, "reporting manager") ||
      hasWord(normalized, "boss")
    ) {
      intent = "manager_details";
    } else if (
      hasWord(normalized, "document") ||
      hasWord(normalized, "documents") ||
      hasWord(normalized, "docs") ||
      hasWord(normalized, "upload") ||
      hasWord(normalized, "payslip") ||
      hasWord(normalized, "offer letter")
    ) {
      intent = "documents_info";
    } else if (isGreeting || askedBotHealth) {
      intent = "greeting";
    }

    // ---- 2) build real-time context from backend + merge with client ----
    const backendContext = await buildBackendContext(req);
    const clientContext: AssistantContext | undefined = req.body?.context;

    const context: AssistantContext = mergeContexts(
      backendContext,
      clientContext
    );

    const stats = context.stats;
    const profile = context.profile;

    const attendancePercent = toNumber(stats?.attendancePercent);
    const leavesTaken = toNumber(stats?.leavesTaken);
    const pendingApprovals = toNumber(stats?.pendingApprovals);
    const docsUploaded = toNumber(stats?.docsUploaded);

    // Debug – see exactly what numbers the copilot is using
    console.log("[assistant:/hr] merged context", {
      backendContext,
      clientContext,
      mergedStats: stats,
      numeric: {
        attendancePercent,
        leavesTaken,
        pendingApprovals,
        docsUploaded,
      },
    });

    const managerName =
      (profile?.managerName || "").toString().trim() || "Not mapped yet";
    const department =
      (profile?.department || "").toString().trim() || "Not mapped yet";
    const location =
      (profile?.location || "").toString().trim() || "Not set";

    // authenticated user
    const authUser: any = (req as any).user || {};

    // build a FIRST NAME if possible: profile → authUser → email local-part
    const profileNameSource =
      (profile?.firstName || "").toString().trim() ||
      (profile?.displayName || "").toString().trim() ||
      (profile?.name || "").toString().trim();

    const emailFromProfile = (profile?.email || "").toString().trim();
    const emailFromAuth = authUser.email ? String(authUser.email) : "";
    const emailLocalPart =
      (emailFromProfile || emailFromAuth).split("@")[0] || "";

    const firstNameFromProfile = extractFirstName(profileNameSource);
    const firstNameFromAuthFull = extractFirstName(authUser.fullName);
    const firstNameFromAuthName = extractFirstName(authUser.name);
    const firstNameFromEmail = extractFirstName(emailLocalPart);

    const firstName =
      firstNameFromProfile ||
      firstNameFromAuthFull ||
      firstNameFromAuthName ||
      firstNameFromEmail;

    const hasFirstName = !!firstName;
    const displayName: string = firstName || "Dear";

    const primaryRole: string = getPrimaryRole(authUser);
    const roleExamples = roleExampleQuestions(primaryRole);

    // ---- 3) answers (use context first, fall back to generic text) ----
    let answer: string;

    switch (intent) {
      case "leave_balance": {
        // ✅ NEW: treat ANY numeric data (leaves or pending) as meaningful
        const hasLeavesNumber = typeof leavesTaken === "number";
        const hasPendingNumber = typeof pendingApprovals === "number";

        if (hasLeavesNumber || hasPendingNumber) {
          const safeLeaves = hasLeavesNumber ? leavesTaken! : 0;
          const safePending = hasPendingNumber ? pendingApprovals! : 0;

          const leavesLabel =
            typeof safeLeaves === "number"
              ? safeLeaves.toFixed(1).replace(/\.0$/, "")
              : String(safeLeaves);

          answer =
            `Here’s what I can see for you, ${displayName}:\n\n` +
            `• You have taken approximately **${leavesLabel}** day(s) of leave in the current period.\n` +
            `• You also have **${safePending}** leave request(s) pending approval.\n\n` +
            `For your exact **remaining balance**, open the **Leaves** module – ` +
            `the top bar shows your live available / remaining leaves. If anything looks off, ` +
            `don’t worry – just raise a quick ticket to HR and they’ll verify your ledger.`;
        } else {
          answer =
            `I’m not able to read meaningful leave statistics from the system for you right now.\n\n` +
            `Please open the **Leaves** module – the top bar will show your ` +
            `live available / remaining leave balance. If it feels incorrect, ` +
            `you can calmly raise a support ticket and the HR team will help fix it.`;
        }
        break;
      }

      case "attendance_summary": {
        // Also treat 0 or undefined as "no data"
        if (typeof attendancePercent === "number" && attendancePercent > 0) {
          answer =
            `Your attendance for the current period is around **${attendancePercent.toFixed(
              1
            )}%** (based on your live dashboard stats).\n\n` +
            `Try to keep this above **95%** if you’re aiming for the top performance band. ` +
            `You can see a day-by-day breakdown in the **Attendance** or **Dashboard** section.`;
        } else {
          answer =
            `I couldn’t read a live attendance percentage for you from the system just now.\n\n` +
            `You can still view it from the **Dashboard → Attendance** widget. ` +
            `If something feels off, it’s okay – raise an attendance regularisation or connect with HR.`;
        }
        break;
      }

      case "manager_details": {
        if (managerName !== "Not mapped yet") {
          answer =
            `Your reporting manager in the system is **${managerName}**.\n\n` +
            `All approvals (leaves, attendance regularisation, travel, etc.) are routed to them.`;
        } else {
          answer =
            `Your reporting manager is **not mapped yet in the system**.\n\n` +
            `You can gently reach out to HR or your supervisor and request them to link your profile ` +
            `to the correct reporting manager. Once mapped, all approvals will route correctly.`;
        }

        if (department !== "Not mapped yet" || location !== "Not set") {
          answer += `\n\nI also see you as part of **${department}** based out of **${location}** (as per your profile).`;
        }
        break;
      }

      case "documents_info": {
        if (typeof docsUploaded === "number" && docsUploaded > 0) {
          answer =
            `Right now I can see about **${docsUploaded}** document(s) linked to your profile ` +
            `(like ID proofs, letters, or bank details).\n\n` +
            `You can upload more from **My Profile → Quick actions → Upload docs**. ` +
            `That section always reflects the latest documents stored against your HR record.`;
        } else {
          answer =
            `I couldn’t read your document count from the system just now.\n\n` +
            `You can view and manage your HR documents from **My Profile → Upload docs**. ` +
            `If you feel something is missing, it’s perfectly okay to re-upload or check with HR.`;
        }
        break;
      }

      case "greeting": {
        const greetingLine = hasFirstName
          ? `Hi **${displayName}**! 👋`
          : `Hello **Dear**! 👋`;

        if (askedBotHealth) {
          answer =
            `${greetingLine}\n\n` +
            `Thanks for checking in. I’m doing great and fully focused on supporting you.\n\n` +
            `How are *you* feeling today? If work is a bit heavy, we can quickly review your leaves, tasks, or upcoming deadlines.\n\n` +
            `Here are some things you can ask me based on your access (**${primaryRole}**):\n` +
            `${roleExamples}`;
        } else {
          answer =
            `${greetingLine}\n\n` +
            `Hope you’re doing well today. I’m your **PlumTrips People & Business Copilot** – here to make your day a bit easier.\n\n` +
            `Here are a few things you can ask me as **${primaryRole}**:\n` +
            `${roleExamples}`;
        }
        break;
      }

      default: {
        answer =
          `I hear you, ${displayName}, and I’m still learning how to support more complex questions.\n\n` +
          `Right now, as **${primaryRole}**, I can help you with things like:\n` +
          `${roleExamples}\n\n` +
          `If your question is about something very specific (like a unique workflow or policy), ` +
          `you can also check your internal handbook or reach out to HR / Admin – and I’ll gradually learn from those patterns too.`;
        break;
      }
    }

    return res.json({ answer, intent });
  }
);

export default router;
