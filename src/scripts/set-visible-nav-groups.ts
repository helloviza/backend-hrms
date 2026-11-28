// apps/backend/src/scripts/set-visible-nav-groups.ts
//
// Set or clear a person's visible Header groups (User.visibleNavGroups) — the
// script wrapper around services/navPreference.service.ts, the same code the
// SUPERADMIN endpoint uses, so the change is validated and audit-logged
// (NavPreferenceAudit, via "script") exactly the same way.
//
// SAFETY
//   - DRY RUN by default: prints the target host, the person, before → after,
//     and writes nothing. --apply writes.
//   - The MONGO_URI host is printed first (never credentials). A host that is
//     not 127.0.0.1 / localhost additionally needs --confirm-host=<that host>.
//   - --actor must be an existing SUPERADMIN user (the endpoint's own rule).
//
// USAGE
//   node --import tsx src/scripts/set-visible-nav-groups.ts \
//     --email=plumbox@plumtrips.com \
//     --groups=travelAnalytics,travelbox,spendbox,helloviza \
//     --actor=imran@plumtrips.com [--apply] [--confirm-host=<host>]
//   ... --clear instead of --groups to remove the restriction.
import mongoose from "mongoose";
import User from "../models/User.js";
import { NAV_GROUP_KEYS } from "../config/navGroups.js";
import { setVisibleNavGroups } from "../services/navPreference.service.js";

const LOCAL = new Set(["127.0.0.1", "localhost"]);

export function mongoHosts(uri: string): string[] {
  const afterScheme = uri.replace(/^mongodb(\+srv)?:\/\//, "");
  const afterCreds = afterScheme.includes("@") ? afterScheme.slice(afterScheme.lastIndexOf("@") + 1) : afterScheme;
  return (afterCreds.split(/[/?]/)[0] || "")
    .split(",")
    .map((h) => h.replace(/:\d+$/, "").trim().toLowerCase())
    .filter(Boolean);
}

export type Args = {
  email: string;
  actor: string;
  groups: string[] | null;
  clear: boolean;
  apply: boolean;
  confirmHost: string | null;
};

export function parseArgs(argv: string[]): { ok: true; args: Args } | { ok: false; error: string } {
  const get = (k: string) => {
    const hit = argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`));
    if (!hit) return undefined;
    return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
  };
  const email = String(get("email") || "").trim().toLowerCase();
  const actor = String(get("actor") || "").trim().toLowerCase();
  const groupsRaw = get("groups");
  const clear = get("clear") !== undefined;
  if (!email) return { ok: false, error: "--email is required" };
  if (!actor) return { ok: false, error: "--actor (a SUPERADMIN's email) is required" };
  if (clear === (groupsRaw !== undefined)) return { ok: false, error: "pass exactly one of --groups=a,b,c or --clear" };
  const groups = clear ? null : String(groupsRaw).split(",").map((s) => s.trim()).filter(Boolean);
  if (!clear && !groups!.length) return { ok: false, error: "--groups is empty (use --clear to remove the restriction)" };
  return {
    ok: true,
    args: { email, actor, groups, clear, apply: argv.includes("--apply"), confirmHost: get("confirm-host") ?? null },
  };
}

const emailQuery = (e: string) => ({ $or: [{ email: e }, { officialEmail: e }] });

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`✖ ${parsed.error}\n  allowed keys: ${NAV_GROUP_KEYS.join(", ")}`);
    process.exit(2);
  }
  const a = parsed.args;
  const uri = process.env.MONGO_URI || "";
  const hosts = mongoHosts(uri);
  console.log(`target MongoDB host(s): ${hosts.join(", ") || "(none — MONGO_URI unset)"}`);
  if (!hosts.length) process.exit(2);
  const remote = hosts.some((h) => !LOCAL.has(h));
  if (remote && a.confirmHost !== hosts.join(",")) {
    console.error(`✖ non-local host: re-run with --confirm-host=${hosts.join(",")} to proceed`);
    process.exit(2);
  }
  console.log(a.apply ? "mode: APPLY (writes)" : "mode: DRY RUN (no writes; add --apply)");

  await mongoose.connect(uri);
  try {
    const actor: any = await User.findOne(emailQuery(a.actor)).select("_id email roles").lean();
    const actorRoles = (actor?.roles || []).map((r: string) => String(r).toUpperCase());
    if (!actor || !actorRoles.includes("SUPERADMIN")) {
      console.error(`✖ actor ${a.actor} is not a SUPERADMIN user in this database`);
      process.exitCode = 2;
      return;
    }
    const users: any[] = await User.find(emailQuery(a.email)).select("_id email workspaceId roles").lean();
    if (users.length !== 1) {
      console.error(`✖ expected exactly one user for ${a.email}, found ${users.length}`);
      process.exitCode = 2;
      return;
    }
    const u = users[0];
    const r = await setVisibleNavGroups({
      userId: String(u._id),
      value: a.groups,
      actor: { id: String(actor._id), email: actor.email },
      via: "script",
      dryRun: !a.apply,
    });
    if ("error" in r) {
      console.error(`✖ ${r.error}`);
      process.exitCode = 2;
      return;
    }
    console.log(`user: ${r.email} (${r.userId}) roles=${(u.roles || []).join(",")} workspace=${u.workspaceId}`);
    console.log(`before: ${JSON.stringify(r.before)}`);
    console.log(`after:  ${JSON.stringify(r.after)}`);
    console.log(!r.changed ? "no change — nothing to write" : a.apply ? "✔ written + audit row created" : "(dry run — not written)");
  } finally {
    await mongoose.disconnect();
  }
}

const invokedDirectly = process.argv[1] && /set-visible-nav-groups\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error("✖", err?.message || err);
    process.exit(1);
  });
}
