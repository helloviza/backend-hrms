// apps/backend/src/routes/public.partnerTrack.ts
//
// A student's "Track my case" on a partner link, mounted at /api/public next
// to the partner request routes. No login (services/partnerTrack.ts):
//
//   POST /api/public/partner-track/request-code  {code, email, turnstileToken}
//        honeypot → per-IP limiter → link check → Turnstile → the SAME answer
//        whatever happens; a code is emailed only when this link's partner has
//        a case for that email (and the email is under 3 codes an hour)
//   POST /api/public/partner-track/verify        {code, email, otp}
//        per-IP limiter → a 30-minute track token, scoped to the email and
//        this partner
//   GET  /api/public/partner-track/cases?code=   header X-Partner-Track-Token
//        that student's cases with that partner, from the partner tracker's
//        allowlist — no prices, no contact details, no other student or partner
//        — plus each case's customer documents (id, name, type)
//   POST /api/public/partner-track/document-link?code=  header X-Partner-Track-Token
//        {caseNumber, fileId} → a signed 5-minute download path for one of
//        the student's own ticket / voucher / document files
//   GET  /api/public/partner-track/document?code=&t=
//        the file, streamed through the API (attachment, no-store); expired,
//        tampered or another partner's link → 404; a staff-only audit row
//
// An unknown or inactive link is the same 404 as on the request routes.
import { Router, type Request, type Response, type NextFunction } from "express";
import { partnerTrackCasesLimiter, partnerTrackDocumentLimiter, partnerTrackRequestLimiter, partnerTrackVerifyLimiter } from "../middleware/rateLimit.js";
import { createTurnstileGate } from "../middleware/turnstile.js";
import { isEmail } from "../services/approvalItemRules.js";
import { resolveActivePartnerLink } from "../services/partnerIntake.create.js";
import { sendPartnerTrackCode } from "../services/partnerTrack.email.js";
import {
  createStudentFileLink,
  normEmail,
  openStudentFileLink,
  readTrackToken,
  TrackFileError,
  requestTrackCode,
  studentCases,
  TRACK_TOKEN_HEADER,
  TrackCodeError,
  verifyTrackCode,
} from "../services/partnerTrack.js";
import logger from "../utils/logger.js";

const router = Router();
const log = logger.child({ module: "partner-track" });

const NOT_FOUND_BODY = { error: "This link is not available." };
export const REQUEST_CODE_ANSWER = { ok: true, message: "If we have cases for this email, a code has been sent." };

function honeypotGate(req: Request, res: Response, next: NextFunction) {
  const trap = (req.body as any)?.hpField;
  if (typeof trap === "string" && trap.trim()) return res.json(REQUEST_CODE_ANSWER);
  next();
}

/** The link must resolve (before Turnstile, so a bad link costs nothing). */
async function linkGate(req: Request, res: Response, next: NextFunction) {
  try {
    const resolved = await resolveActivePartnerLink((req.body as any)?.code ?? req.query.code);
    if (!resolved) return res.status(404).json(NOT_FOUND_BODY);
    (req as any).partnerLink = resolved;
    next();
  } catch (err) {
    log.error("link check failed", { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: "Something went wrong. Please try again shortly." });
  }
}

const verifyTurnstile = createTurnstileGate("partner-track");

router.post("/partner-track/request-code", honeypotGate, partnerTrackRequestLimiter, linkGate, verifyTurnstile, async (req: Request, res: Response) => {
  const email = normEmail((req.body as any)?.email);
  if (!isEmail(email)) return res.status(400).json({ error: "Enter a valid email address.", code: "INVALID_EMAIL" });
  try {
    const { workspace, partnerName } = (req as any).partnerLink;
    const r = await requestTrackCode({ email, partnerWorkspaceId: workspace._id, customerId: String(workspace.customerId) });
    if (r.outcome === "sent" && r.code) await sendPartnerTrackCode({ to: email, code: r.code, partnerName });
    log.info("track code requested", { outcome: r.outcome });
  } catch (err) {
    log.error("track code request failed", { error: err instanceof Error ? err.message : String(err) });
  }
  // The same answer whether or not a case exists, a code was sent or the email is rate limited.
  return res.json(REQUEST_CODE_ANSWER);
});

router.post("/partner-track/verify", partnerTrackVerifyLimiter, linkGate, async (req: Request, res: Response) => {
  const b: any = req.body || {};
  const email = normEmail(b.email);
  if (!isEmail(email)) return res.status(400).json({ error: "Enter a valid email address.", code: "INVALID_EMAIL" });
  try {
    const { workspace } = (req as any).partnerLink;
    const token = await verifyTrackCode({ email, code: b.otp, partnerWorkspaceId: workspace._id });
    return res.json({ ok: true, token });
  } catch (err) {
    if (err instanceof TrackCodeError) return res.status(400).json({ error: err.message, code: err.code });
    log.error("track verify failed", { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: "Something went wrong. Please try again shortly." });
  }
});

router.get("/partner-track/cases", partnerTrackCasesLimiter, linkGate, async (req: Request, res: Response) => {
  const scope = readTrackToken(req.get(TRACK_TOKEN_HEADER));
  const { workspace } = (req as any).partnerLink;
  // A token from another partner's link reads nothing here.
  if (!scope || scope.partnerWorkspaceId !== String(workspace._id)) {
    return res.status(401).json({ error: "Your session has ended. Enter your email again.", code: "TRACK_TOKEN_INVALID" });
  }
  try {
    const cases = await studentCases(scope, String(workspace.customerId));
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, cases });
  } catch (err) {
    log.error("track cases failed", { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: "Something went wrong. Please try again shortly." });
  }
});

router.post("/partner-track/document-link", partnerTrackDocumentLimiter, linkGate, async (req: Request, res: Response) => {
  const scope = readTrackToken(req.get(TRACK_TOKEN_HEADER));
  const { workspace } = (req as any).partnerLink;
  if (!scope || scope.partnerWorkspaceId !== String(workspace._id)) {
    return res.status(401).json({ error: "Your session has ended. Enter your email again.", code: "TRACK_TOKEN_INVALID" });
  }
  try {
    const b: any = req.body || {};
    const t = await createStudentFileLink(scope, String(workspace.customerId), String(b.caseNumber || ""), String(b.fileId || ""));
    const code = String((req.query.code ?? b.code) || "");
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, path: `/public/partner-track/document?code=${encodeURIComponent(code)}&t=${encodeURIComponent(t)}` });
  } catch (err) {
    if (err instanceof TrackFileError) return res.status(err.status).json({ error: err.message, code: err.code });
    log.error("track document link failed", { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: "Something went wrong. Please try again shortly." });
  }
});

router.get("/partner-track/document", partnerTrackDocumentLimiter, linkGate, async (req: Request, res: Response) => {
  const { workspace } = (req as any).partnerLink;
  try {
    const file = await openStudentFileLink(req.query.t, String(workspace._id), String(workspace.customerId));
    if (!file) return res.status(404).json({ error: "This download link has expired. Open your case again to get a new one.", code: "LINK_INVALID" });
    const { getObjectBuffer } = await import("../utils/s3Upload.js");
    const bytes = await getObjectBuffer(file.s3Key);
    const safeName = file.filename.replace(/[^\w.\- ()]+/g, "_");
    res.setHeader("Content-Type", file.mime);
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.setHeader("Cache-Control", "no-store");
    log.info("track document downloaded");
    return res.send(bytes);
  } catch (err) {
    log.error("track document failed", { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: "Something went wrong. Please try again shortly." });
  }
});

export default router;
