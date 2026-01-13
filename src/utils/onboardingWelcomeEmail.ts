import { sendMail } from "./mailer.js";

type RelationshipType = "Employee" | "Vendor" | "Customer";

type WelcomeEmailInput = {
  to: string;
  counterpartyName: string;
  effectiveDate: string;
  relationshipType: RelationshipType;
};

function toTitleCase(name: string): string {
  return String(name || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export async function sendOnboardingWelcomeEmail(
  input: WelcomeEmailInput
) {
  const {
    to,
    counterpartyName,
    effectiveDate,
    relationshipType,
  } = input;

  const displayName = toTitleCase(counterpartyName);

  const subject = "Welcome to Plumtrips — Access Activated";

  const logoUrl =
    "https://plumtrips-assets.s3.amazonaws.com/email/plumtrips-email-logo.png";

  const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width"/>
</head>

<body style="
  margin:0;
  padding:0;
  background:#0a1020;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
">

<table width="100%" cellpadding="0" cellspacing="0" style="padding:48px 14px;">
<tr>
<td align="center">

<table width="680" cellpadding="0" cellspacing="0" style="
  background:linear-gradient(180deg,#0a1020 0%,#0f1b33 100%);
  border-radius:22px;
  overflow:hidden;
  box-shadow:0 40px 120px rgba(0,0,0,0.65);
">

<!-- SYSTEM HEADER -->
<tr>
<td style="padding:34px 42px 32px 42px;">

<table width="100%" cellpadding="0" cellspacing="0">
<tr>
<td align="left">
  <img src="${logoUrl}" alt="Plumtrips"
    height="34"
    style="display:block;margin-bottom:18px;" />
</td>
</tr>
</table>

<div style="
  font-size:13px;
  letter-spacing:1.6px;
  color:#9fb4ff;
  text-transform:uppercase;
">
  Plumtrips Intelligent Systems
</div>

<div style="
  margin-top:10px;
  font-size:30px;
  font-weight:600;
  color:#ffffff;
">
  Access Confirmed
</div>

<div style="
  margin-top:10px;
  font-size:15px;
  color:#b7c7ff;
">
  Your onboarding has been successfully completed
</div>

<div style="
  margin-top:22px;
  display:inline-block;
  padding:7px 16px;
  border-radius:999px;
  font-size:12px;
  letter-spacing:0.7px;
  background:rgba(208,101,73,0.18);
  color:#ff9b84;
">
  ${relationshipType.toUpperCase()} PROFILE ENABLED
</div>

</td>
</tr>

<!-- WHITE INTELLIGENCE ZONE -->
<tr>
<td style="background:#ffffff;padding:44px 42px 46px 42px;">

<p style="margin-top:0;font-size:16px;color:#111;">
  Hello <strong>${displayName}</strong>,
</p>

<p style="font-size:15px;line-height:1.75;color:#333;">
  This message confirms that your onboarding with
  <strong>Plumtrips (Peachmint Trips & Planners Pvt. Ltd.)</strong>
  has been completed and activated as of
  <strong>${effectiveDate}</strong>.
</p>

<table width="100%" cellpadding="0" cellspacing="0" style="
  margin:30px 0 34px 0;
  background:#f7f9fd;
  border-radius:14px;
  border-left:5px solid #00477f;
">
<tr>
<td style="padding:22px 24px;font-size:14.5px;color:#222;">
  You are now recognised within our systems as a
  <strong>${relationshipType}</strong>,
  operating under Plumtrips’ governed, AI-enabled ecosystem.
</td>
</tr>
</table>

<div style="margin-top:8px;">

<div style="margin-bottom:26px;">
  <div style="font-weight:600;color:#00477f;margin-bottom:6px;">
    Agreement Layer
  </div>
  <div style="font-size:14.5px;color:#444;line-height:1.7;">
    This confirmation, together with Plumtrips’ internal policies,
    codes of conduct, and governance framework, forms the complete
    basis of this engagement.
  </div>
</div>

<div style="margin-bottom:26px;">
  <div style="font-weight:600;color:#00477f;margin-bottom:6px;">
    Professional & Ethical Standards
  </div>
  <div style="font-size:14.5px;color:#444;line-height:1.7;">
    All actions, services, and responsibilities are expected to
    meet high standards of integrity, accountability, and judgement.
  </div>
</div>

<div style="margin-bottom:26px;">
  <div style="font-weight:600;color:#00477f;margin-bottom:6px;">
    Data & Intelligence Consent
  </div>
  <div style="font-size:14.5px;color:#444;line-height:1.7;">
    Your information may be securely processed across Plumtrips’
    AI-driven HR, travel, compliance, and analytics systems to
    enable seamless operations.
  </div>
</div>

<div>
  <div style="font-weight:600;color:#00477f;margin-bottom:6px;">
    Confidentiality & Trust
  </div>
  <div style="font-size:14.5px;color:#444;line-height:1.7;">
    All proprietary information accessed within the Plumtrips
    ecosystem remains protected and confidential.
  </div>
</div>

</div>

<p style="margin-top:36px;font-size:15px;color:#333;">
  You are now part of a connected, intelligent travel platform.
  Our systems evolve with your journey.
</p>

<p style="margin-top:30px;font-size:14.5px;color:#111;">
  Regards,<br/><br/>
  <strong style="color:#00477f;">Welcome to Plumtrips</strong><br/>
  Peachmint Trips & Planners Pvt. Ltd.<br/>
  Gurugram, India<br/>
  <a href="mailto:hello@plumtrips.com" style="color:#d06549;text-decoration:none;">
    hello@plumtrips.com
  </a>
  &nbsp;•&nbsp;
  <a href="https://www.plumtrips.com" style="color:#d06549;text-decoration:none;">
    plumtrips.com
  </a>
</p>

</td>
</tr>

<tr>
<td style="
  padding:18px;
  text-align:center;
  font-size:11px;
  color:#8b95c7;
  background:#0a1020;
">
  Generated by Plumtrips AI-powered onboarding systems
</td>
</tr>

</table>

</td>
</tr>
</table>

</body>
</html>
`;

  return sendMail({
    to,
    subject,
    html,
    kind: "WELCOME",
    replyTo: "hello@plumtrips.com",
  });
}
