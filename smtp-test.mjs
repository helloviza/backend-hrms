import nodemailer from "nodemailer";

const host = process.env.SMTP_HOST;
const port = Number(process.env.SMTP_PORT || 587);
const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";

const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;

if (!host || !user || !pass) {
  console.error("Missing SMTP envs. Need SMTP_HOST, SMTP_USER, SMTP_PASS.");
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host,
  port,
  secure,
  auth: { user, pass },
});

const from =
  process.env.MAIL_FROM_REQUESTS ||
  process.env.MAIL_FROM ||
  user;

const to = process.env.TEST_TO || user; // set TEST_TO in env if you want

const info = await transporter.sendMail({
  from,
  to,
  subject: "PlumTrips HRMS SMTP Test",
  text: "If you received this, SMTP is working.",
});

console.log("✅ SENT:", info.messageId);
