// apps/backend/src/services/approvalWorkflow/config.ts
//
// The approval-workflow config: its shape, and the ONE function that turns
// untrusted input (a JSON file given to the publish script, later the admin
// page) into a stored config — sanitizeWorkflowConfig. Anything it cannot
// accept is an error listing every problem; nothing is silently dropped that
// would change routing.
//
// Supported in this build (StatusNeo, 4 Dec): REQUEST-phase steps of type
// DEPARTMENT_HEAD, REPORTING_MANAGER and DEFAULT_APPROVER, as APPROVER or
// WATCHER, with decisionRule ANY. The SidVin types (TRAVELLER_ACK,
// PROJECT_SPOC, FIXED_GROUP, COST_APPROVAL), raisedBy DESK and the COST phase
// are named in the type for the next build but are refused here, so a config
// can never promise routing the engine does not do.
import { APPROVAL_EMAIL_MAP } from "../approvalEmails/map.js";

export type StepType =
  | "DEPARTMENT_HEAD"
  | "REPORTING_MANAGER"
  | "DEFAULT_APPROVER"
  | "TRAVELLER_ACK"
  | "PROJECT_SPOC"
  | "FIXED_GROUP"
  | "COST_APPROVAL";
export type StepRole = "APPROVER" | "WATCHER";
export type StepFallback = "SKIP" | "DEFAULT_APPROVER" | "REFUSE_SUBMIT";
export type WatcherEvent = "submitted" | "approved" | "declined" | "booking_done";
export type LeadersMayDecide = "ALLOW" | "DENY" | "OVERRIDE_WITH_REASON";

export interface WorkflowStep {
  key: string;
  label: string;
  phase: "REQUEST" | "COST";
  type: StepType;
  role: StepRole;
  decisionRule: "ANY" | "ALL";
  fallback: StepFallback;
  fallbackUserId: string | null;
  /** The assignee already approved an earlier step: AUTO_PASS = not asked again. */
  samePersonRule: "AUTO_PASS" | "ASK_AGAIN";
  /** The assignee is the requester. NEXT_IN_LINE for a department head = their reporting manager, then the fallback (D4). */
  selfRule: "SKIP" | "NEXT_IN_LINE" | "REFUSE";
  watcherEvents: WatcherEvent[];
  reminders: { afterHours: number[] };
}

export interface WorkflowConfig {
  enabled: boolean;
  template: "STANDARD" | "DEPT_HEAD_WATCHER" | "MULTI_LEVEL_COST" | "CUSTOM";
  raisedBy: "EMPLOYEE" | "DESK" | "BOTH";
  /** Hide the request form's search panel; /approvals/search/* answers 403 REQUEST_ONLY_MODE. */
  requestOnlyMode: boolean;
  /** D8. An option named "Other" needs free text. */
  purpose: { required: boolean; options: string[] };
  /** D6. ALL_SERVICES_BOOKED: done when every requested service has a confirmed booking (or staff Close). */
  completion: "FIRST_BOOKING" | "ALL_SERVICES_BOOKED";
  /** D3. OVERRIDE_WITH_REASON: a Workspace Leader may approve / decline in-app with a mandatory reason. */
  leadersMayDecide: LeadersMayDecide;
  steps: WorkflowStep[];
  groups: Array<{ key: string; name: string; memberUserIds: string[] }>;
  email: {
    /** D1: the client's travel admins — "approved" and "booking done" emails. */
    travelAdminEmails: string[];
    sender: { level: "A"; displayName: string; replyTo: string };
    events: Record<string, { enabled?: boolean }>;
  };
}

export const SUPPORTED_STEP_TYPES: StepType[] = ["DEPARTMENT_HEAD", "REPORTING_MANAGER", "DEFAULT_APPROVER"];
export const ALL_STEP_TYPES: StepType[] = [
  "DEPARTMENT_HEAD",
  "REPORTING_MANAGER",
  "DEFAULT_APPROVER",
  "TRAVELLER_ACK",
  "PROJECT_SPOC",
  "FIXED_GROUP",
  "COST_APPROVAL",
];
export const WATCHER_EVENTS: WatcherEvent[] = ["submitted", "approved", "declined", "booking_done"];
export const OTHER_PURPOSE = "Other";

export class WorkflowConfigError extends Error {
  constructor(public problems: string[]) {
    super(`Invalid approval workflow config:\n  - ${problems.join("\n  - ")}`);
  }
}

const str = (v: any) => String(v ?? "").trim();
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KEY_RX = /^[a-z][a-z0-9_-]{0,31}$/;

function oneOf<T extends string>(v: any, allowed: readonly T[], dflt: T, field: string, problems: string[]): T {
  if (v === undefined || v === null || v === "") return dflt;
  const s = str(v).toUpperCase() as T;
  const hit = allowed.find((a) => a.toUpperCase() === s);
  if (!hit) {
    problems.push(`${field}: "${v}" is not one of ${allowed.join(" | ")}`);
    return dflt;
  }
  return hit;
}

function leadersValue(v: any, problems: string[]): LeadersMayDecide {
  if (v === undefined || v === null || v === "") return "ALLOW";
  if (v === true) return "ALLOW";
  if (v === false) return "DENY";
  return oneOf(v, ["ALLOW", "DENY", "OVERRIDE_WITH_REASON"] as const, "ALLOW", "leadersMayDecide", problems);
}

function emails(v: any, field: string, problems: string[]): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    problems.push(`${field}: must be a list of email addresses`);
    return [];
  }
  const out: string[] = [];
  for (const e of v) {
    const s = str(e).toLowerCase();
    if (!EMAIL_RX.test(s)) problems.push(`${field}: "${e}" is not an email address`);
    else if (!out.includes(s)) out.push(s);
  }
  return out;
}

function sanitizeStep(raw: any, i: number, problems: string[]): WorkflowStep {
  const at = `steps[${i}]`;
  const key = str(raw?.key).toLowerCase();
  if (!KEY_RX.test(key)) problems.push(`${at}.key: "${raw?.key ?? ""}" must be 1–32 of a–z, 0–9, _ or -, starting with a letter`);
  const label = str(raw?.label);
  if (!label) problems.push(`${at}.label: required`);
  const phase = oneOf(raw?.phase, ["REQUEST", "COST"] as const, "REQUEST", `${at}.phase`, problems);
  if (phase === "COST") problems.push(`${at}.phase: COST steps are not supported yet (SidVin build)`);
  const type = oneOf(raw?.type, ALL_STEP_TYPES, "DEFAULT_APPROVER", `${at}.type`, problems);
  if (raw?.type && !SUPPORTED_STEP_TYPES.includes(type)) {
    problems.push(`${at}.type: ${type} is not supported yet (supported: ${SUPPORTED_STEP_TYPES.join(", ")})`);
  }
  const role = oneOf(raw?.role, ["APPROVER", "WATCHER"] as const, "APPROVER", `${at}.role`, problems);
  if (!raw?.role) problems.push(`${at}.role: required (APPROVER | WATCHER)`);
  const decisionRule = oneOf(raw?.decisionRule, ["ANY", "ALL"] as const, "ANY", `${at}.decisionRule`, problems);
  if (decisionRule === "ALL") problems.push(`${at}.decisionRule: ALL is not supported yet`);
  const fallback = oneOf(
    raw?.fallback,
    ["SKIP", "DEFAULT_APPROVER", "REFUSE_SUBMIT"] as const,
    role === "WATCHER" ? "SKIP" : "DEFAULT_APPROVER",
    `${at}.fallback`,
    problems,
  );
  if (role === "WATCHER" && fallback !== "SKIP") problems.push(`${at}.fallback: a WATCHER step can only SKIP when nobody resolves`);
  if (type === "DEFAULT_APPROVER" && raw?.fallback && fallback !== "REFUSE_SUBMIT" && fallback !== "SKIP") {
    problems.push(`${at}.fallback: a DEFAULT_APPROVER step cannot fall back to itself`);
  }
  const samePersonRule = oneOf(raw?.samePersonRule, ["AUTO_PASS", "ASK_AGAIN"] as const, "AUTO_PASS", `${at}.samePersonRule`, problems);
  const selfRule = oneOf(raw?.selfRule, ["SKIP", "NEXT_IN_LINE", "REFUSE"] as const, "NEXT_IN_LINE", `${at}.selfRule`, problems);

  let watcherEvents: WatcherEvent[] = [];
  if (raw?.watcherEvents !== undefined) {
    if (!Array.isArray(raw.watcherEvents)) problems.push(`${at}.watcherEvents: must be a list`);
    else {
      for (const ev of raw.watcherEvents) {
        const e = str(ev).toLowerCase() as WatcherEvent;
        if (!WATCHER_EVENTS.includes(e)) problems.push(`${at}.watcherEvents: "${ev}" is not one of ${WATCHER_EVENTS.join(" | ")}`);
        else if (!watcherEvents.includes(e)) watcherEvents.push(e);
      }
    }
  }
  if (role === "APPROVER" && watcherEvents.length) problems.push(`${at}.watcherEvents: only a WATCHER step has watcher events`);
  if (role === "WATCHER" && raw?.watcherEvents === undefined) watcherEvents = [...WATCHER_EVENTS];

  const afterHours: number[] = [];
  const rh = raw?.reminders?.afterHours;
  if (rh !== undefined) {
    if (!Array.isArray(rh)) problems.push(`${at}.reminders.afterHours: must be a list of hours`);
    else
      for (const h of rh) {
        const n = Number(h);
        if (!Number.isFinite(n) || n <= 0 || n > 24 * 14) problems.push(`${at}.reminders.afterHours: ${h} must be 1–336`);
        else afterHours.push(n);
      }
  }

  return {
    key,
    label,
    phase,
    type,
    role,
    decisionRule,
    fallback,
    fallbackUserId: null,
    samePersonRule,
    selfRule,
    watcherEvents,
    reminders: { afterHours: afterHours.sort((a, b) => a - b) },
  };
}

/** Untrusted input → a stored config. Throws WorkflowConfigError listing every problem. */
export function sanitizeWorkflowConfig(raw: any): WorkflowConfig {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new WorkflowConfigError(["config must be an object"]);

  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") problems.push("enabled: must be true or false");
  const enabled = raw.enabled === true;
  const template = oneOf(raw.template, ["STANDARD", "DEPT_HEAD_WATCHER", "MULTI_LEVEL_COST", "CUSTOM"] as const, "CUSTOM", "template", problems);
  const raisedBy = oneOf(raw.raisedBy, ["EMPLOYEE", "DESK", "BOTH"] as const, "EMPLOYEE", "raisedBy", problems);
  if (raisedBy !== "EMPLOYEE") problems.push(`raisedBy: ${raisedBy} is not supported yet (SidVin build); use EMPLOYEE`);
  if (raw.requestOnlyMode !== undefined && typeof raw.requestOnlyMode !== "boolean") problems.push("requestOnlyMode: must be true or false");
  const requestOnlyMode = raw.requestOnlyMode === true;

  const p = raw.purpose ?? {};
  if (p.required !== undefined && typeof p.required !== "boolean") problems.push("purpose.required: must be true or false");
  const options: string[] = [];
  if (p.options !== undefined && p.options !== null) {
    if (!Array.isArray(p.options)) problems.push("purpose.options: must be a list");
    else
      for (const o of p.options) {
        const s = str(o);
        if (!s || s.length > 60) problems.push(`purpose.options: "${o}" must be 1–60 characters`);
        else if (options.some((x) => x.toLowerCase() === s.toLowerCase())) problems.push(`purpose.options: "${s}" is listed twice`);
        else options.push(s);
      }
  }
  const purpose = { required: p.required === true, options };

  const completion = oneOf(raw.completion, ["FIRST_BOOKING", "ALL_SERVICES_BOOKED"] as const, "FIRST_BOOKING", "completion", problems);
  const leadersMayDecide = leadersValue(raw.leadersMayDecide, problems);

  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  if (!Array.isArray(raw.steps)) problems.push("steps: must be a list");
  const steps = rawSteps.map((s: any, i: number) => sanitizeStep(s, i, problems));
  const keys = new Set<string>();
  for (const s of steps) {
    if (keys.has(s.key)) problems.push(`steps: key "${s.key}" is used twice`);
    keys.add(s.key);
  }
  if (!steps.some((s: WorkflowStep) => s.role === "APPROVER")) problems.push("steps: at least one APPROVER step is required");

  if (raw.groups !== undefined && (!Array.isArray(raw.groups) || raw.groups.length)) {
    problems.push("groups: approver groups are not supported yet (SidVin build); use []");
  }

  const em = raw.email ?? {};
  const travelAdminEmails = emails(em.travelAdminEmails, "email.travelAdminEmails", problems);
  const sender = em.sender ?? {};
  const level = oneOf(sender.level, ["A"] as const, "A", "email.sender.level", problems);
  const displayName = str(sender.displayName);
  if (displayName.length > 80 || /[<>"\r\n]/.test(displayName)) problems.push("email.sender.displayName: at most 80 characters, no < > \" or line breaks");
  const replyTo = str(sender.replyTo).toLowerCase();
  if (replyTo && !EMAIL_RX.test(replyTo)) problems.push(`email.sender.replyTo: "${sender.replyTo}" is not an email address`);
  const events: Record<string, { enabled?: boolean }> = {};
  if (em.events !== undefined) {
    if (!em.events || typeof em.events !== "object" || Array.isArray(em.events)) problems.push("email.events: must be an object");
    else
      for (const [k, v] of Object.entries(em.events as Record<string, any>)) {
        const spec: any = (APPROVAL_EMAIL_MAP as any)[k];
        if (!spec) problems.push(`email.events: "${k}" is not an approval email event`);
        else if (v && v.enabled === false && (spec.link === "decision-request" || spec.link === "decision-proposal"))
          problems.push(`email.events.${k}: carries a decision link and cannot be switched off`);
        else if (spec.audience !== "customer" && v && v.enabled === false) problems.push(`email.events.${k}: staff emails cannot be switched off`);
        else if (!v || typeof v !== "object" || (v.enabled !== undefined && typeof v.enabled !== "boolean"))
          problems.push(`email.events.${k}: must be { enabled: true | false }`);
        else events[k] = v.enabled === undefined ? {} : { enabled: v.enabled };
      }
  }

  if (problems.length) throw new WorkflowConfigError(problems);
  return {
    enabled,
    template,
    raisedBy,
    requestOnlyMode,
    purpose,
    completion,
    leadersMayDecide,
    steps,
    groups: [],
    email: { travelAdminEmails, sender: { level, displayName, replyTo }, events },
  };
}

/** The config fields of a stored version, in a stable order (for comparing and copying). */
export function configOf(v: any): WorkflowConfig {
  return sanitizeWorkflowConfig({
    enabled: v?.enabled,
    template: v?.template,
    raisedBy: v?.raisedBy,
    requestOnlyMode: v?.requestOnlyMode,
    purpose: { required: v?.purpose?.required, options: v?.purpose?.options },
    completion: v?.completion,
    leadersMayDecide: v?.leadersMayDecide,
    steps: (v?.steps || []).map((s: any) => ({ ...s, ...(s?.role === "APPROVER" ? { watcherEvents: undefined } : {}) })),
    groups: v?.groups || [],
    email: v?.email,
  });
}

/** Field-level differences between two configs, for the audit row. */
export function configChanges(from: WorkflowConfig | null, to: WorkflowConfig): { field: string; from: unknown; to: unknown }[] {
  const out: { field: string; from: unknown; to: unknown }[] = [];
  const keys: (keyof WorkflowConfig)[] = ["enabled", "template", "raisedBy", "requestOnlyMode", "purpose", "completion", "leadersMayDecide", "steps", "groups", "email"];
  for (const k of keys) {
    const a = from ? JSON.stringify(from[k]) : undefined;
    const b = JSON.stringify(to[k]);
    if (a !== b) out.push({ field: k, from: from ? from[k] : null, to: to[k] });
  }
  return out;
}

/** A purpose answer checked against the config (D8). Returns the stored shape or an error message. */
export function checkPurpose(
  cfg: Pick<WorkflowConfig, "purpose">,
  raw: any,
): { ok: true; purpose: { code: string; text: string } | null } | { ok: false; error: string } {
  const code = str(raw?.code ?? (typeof raw === "string" ? raw : ""));
  const text = str(raw?.text).slice(0, 300);
  if (!code) {
    return cfg.purpose.required ? { ok: false, error: "Choose the purpose of travel." } : { ok: true, purpose: null };
  }
  const opts = cfg.purpose.options;
  const hit = opts.length ? opts.find((o) => o.toLowerCase() === code.toLowerCase()) : code.slice(0, 60);
  if (!hit) return { ok: false, error: `Choose a purpose from the list: ${opts.join(", ")}.` };
  if (hit.toLowerCase() === OTHER_PURPOSE.toLowerCase() && !text) return { ok: false, error: "Say what the purpose of travel is." };
  return { ok: true, purpose: { code: hit, text } };
}
