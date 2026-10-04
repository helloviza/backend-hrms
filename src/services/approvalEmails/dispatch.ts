// apps/backend/src/services/approvalEmails/dispatch.ts
//
// notifyApproval(event, ctx): the only way the approval flows send email.
// Recipients come from the email map (map.ts) — roles resolved against the
// request as it is NOW — then the map-wide rules are applied (excluded roles,
// the actor, deactivated people, one copy per person), each email is rendered
// (templates.ts) and handed to the outbox (emailOutbox.ts), which tries it at
// once and retries a failure.
import { DISABLE_EMAILS } from "../../routes/approvals.security.js";
import { DESK_EMAIL } from "../actorNames.js";
import {
  activeLeaderEmails,
  inactiveEmails,
  proposalDeciders,
  proposalOpsEmails,
  requestDeciders,
  workspaceOf,
} from "../approvalDeciders.js";
import { enqueueEmail, type OutboxResult } from "../emailOutbox.js";
import type { MailAttachment } from "../../utils/mailer.js";
import { APPROVAL_EMAIL_MAP, type ApprovalEmailEvent, type EmailEventSpec, type EmailRole } from "./map.js";
import { renderApprovalEmail, type EmailCtx } from "./templates.js";
import { caseCode } from "./links.js";

type AnyObj = Record<string, any>;
const norm = (v: any) => String(v ?? "").trim().toLowerCase();

export type NotifyOpts = {
  attachments?: MailAttachment[];
  /** History rows for the request: pushed only once the send succeeds / finally fails. */
  onSent?: AnyObj | null;
  onFailed?: AnyObj | null;
};

export type NotifyResult = {
  to: string[];
  cc: string[];
  results: OutboxResult[];
  /** True when every email of the event reached SMTP on the first try. */
  delivered: boolean;
  skipped?: "disabled" | "no-trigger" | "no-recipients";
};

async function resolveRole(role: EmailRole, spec: EmailEventSpec, ctx: EmailCtx, cache: Map<string, string[]>): Promise<string[]> {
  const ar = ctx.ar || {};
  const key = role === "deciders" ? `deciders:${spec.decidersOf || "request"}` : role;
  if (cache.has(key)) return cache.get(key)!;
  let out: string[] = [];
  switch (role) {
    case "requester":
      out = [norm(ar.frontlinerEmail)];
      break;
    case "approver":
      out = [norm(ar.managerEmail)];
      break;
    case "leaders":
      out = await activeLeaderEmails(await workspaceOf(ar), ar);
      break;
    case "deciders":
      out = spec.decidersOf === "proposal" ? await proposalDeciders(ar) : await requestDeciders(ar);
      break;
    case "asker":
      out = [norm(ctx.asker)];
      break;
    case "agent":
      out = [norm(ctx.agent?.email || ar?.meta?.adminAssigned?.agentEmail)];
      break;
    case "proposalStaff":
      out = proposalOpsEmails(ctx.proposal || {});
      break;
    case "desk":
      out = [norm(DESK_EMAIL)];
      break;
  }
  out = out.map(norm).filter(Boolean);
  cache.set(key, out);
  return out;
}

/** Who gets this event, after every map rule. Exported for tests and the renderer. */
export async function recipientsFor(event: ApprovalEmailEvent, ctx: EmailCtx): Promise<{ to: string[]; cc: string[] }> {
  const spec: EmailEventSpec = APPROVAL_EMAIL_MAP[event];
  const cache = new Map<string, string[]>();
  const gather = async (roles: EmailRole[]) => (await Promise.all(roles.map((r) => resolveRole(r, spec, ctx, cache)))).flat();

  const excluded = new Set(await gather(spec.exclude));
  if (spec.excludeActor && ctx.actorEmail) excluded.add(norm(ctx.actorEmail));
  const desk = norm(DESK_EMAIL);

  const uniq = (list: string[]) => Array.from(new Set(list)).filter((e) => e && !excluded.has(e));
  let to = uniq(await gather(spec.to));
  let cc = uniq(await gather(spec.cc)).filter((e) => !to.includes(e));

  const dead = await inactiveEmails([...to, ...cc].filter((e) => e !== desk));
  to = to.filter((e) => !dead.has(e));
  cc = cc.filter((e) => !dead.has(e));
  return { to, cc };
}

export async function notifyApproval(event: ApprovalEmailEvent, ctx: EmailCtx, opts: NotifyOpts = {}): Promise<NotifyResult> {
  const spec: EmailEventSpec = APPROVAL_EMAIL_MAP[event];
  if (!spec.trigger) return { to: [], cc: [], results: [], delivered: false, skipped: "no-trigger" };
  if (DISABLE_EMAILS) return { to: [], cc: [], results: [], delivered: false, skipped: "disabled" };

  const { to, cc } = await recipientsFor(event, ctx);
  if (!to.length) return { to, cc, results: [], delivered: false, skipped: "no-recipients" };

  const replyTo = spec.replyTo === "desk" ? DESK_EMAIL : "";
  const base = {
    event,
    replyTo,
    requestId: ctx.ar?._id || null,
    proposalId: ctx.proposal?._id || null,
    caseCode: caseCode(ctx.ar),
    customerName: String(ctx.ar?.customerName || ""),
  };

  const results: OutboxResult[] = [];
  if (spec.perRecipient) {
    // Each recipient gets their own decision links.
    results.push(
      ...(await Promise.all(
        to.map((r) => {
          const m = renderApprovalEmail(event, ctx, r);
          return enqueueEmail({ ...base, kind: m.kind, to: [r], subject: m.subject, html: m.html });
        }),
      )),
    );
  } else {
    const m = renderApprovalEmail(event, ctx, to[0]);
    results.push(
      await enqueueEmail({
        ...base,
        kind: m.kind,
        to,
        cc,
        subject: m.subject,
        html: m.html,
        attachments: opts.attachments,
        onSent: opts.onSent,
        onFailed: opts.onFailed,
      }),
    );
  }
  return { to, cc, results, delivered: results.every((r) => r.ok) };
}

/** Fire an event without letting a mail or lookup problem fail the caller. */
export async function notifySafely(event: ApprovalEmailEvent, ctx: EmailCtx, opts: NotifyOpts = {}): Promise<NotifyResult | null> {
  try {
    return await notifyApproval(event, ctx, opts);
  } catch (err: any) {
    console.error("[approval-emails] notify failed", { event, requestId: String(ctx.ar?._id || ""), error: err?.message });
    return null;
  }
}
