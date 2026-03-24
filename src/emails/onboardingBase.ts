// apps/backend/src/emails/onboardingBase.ts

function formatName(name?: string): string | null {
  if (!name) return null;

  const clean = String(name).trim();
  if (!clean) return null;

  return clean
    .split(/\s+/)
    .map((part) => {
      const p = part.toLowerCase();
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join(" ");
}

export function emailLayout(params: {
  title: string;
  subtitle: string;
  ctaText: string;
  ctaLink: string;
  expiresAt: Date;
  name?: string;
}) {
  const expiry = params.expiresAt.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const safeName: string | undefined =
  typeof params.name === "string" && params.name.trim()
    ? params.name.trim()
    : undefined;

const displayName = formatName(safeName);


const greeting = displayName
  ? `Hello ${displayName},`
  : "Hello,";


  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${params.title}</title>
</head>

<body style="
  margin:0;
  padding:0;
  background:#020617;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  color:#e5e7eb;
">

  <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
    style="padding:48px 14px; background:#020617;">
    <tr>
      <td align="center">

        <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
          style="
            max-width:600px;
            background:linear-gradient(180deg,#0b1220,#020617);
            border-radius:22px;
            padding:44px 40px;
            box-shadow:0 30px 80px rgba(0,0,0,.55);
          ">

          <!-- LOGO -->
          <tr>
            <td align="center" style="padding-bottom:26px;">
              <img
                src="https://assets.plumtrips.com/email/plumtrips-email-logo.png"
                width="120"
                alt="PlumTrips"
                style="display:block;border:0;outline:none;text-decoration:none;"
              />
            </td>
          </tr>

          <!-- GREETING -->
          <tr>
            <td align="center" style="
              font-size:14px;
              color:#94a3b8;
              padding-bottom:10px;
            ">
              ${greeting}
            </td>
          </tr>

          <!-- TITLE -->
          <tr>
            <td align="center" style="
              font-size:30px;
              font-weight:600;
              line-height:1.25;
              padding-bottom:16px;
              color:#ffffff;
            ">
              ${params.title}
            </td>
          </tr>

          <!-- SUBTITLE -->
          <tr>
            <td align="center" style="
              font-size:16px;
              line-height:1.65;
              color:#c7d2fe;
              padding:0 6px 34px;
            ">
              ${params.subtitle}
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td align="center" style="padding-bottom:36px;">
              <a href="${params.ctaLink}" target="_blank" style="
                display:inline-block;
                padding:16px 42px;
                border-radius:999px;
                background:linear-gradient(90deg,#38bdf8,#8b5cf6);
                color:#020617;
                font-weight:600;
                font-size:15px;
                text-decoration:none;
                box-shadow:0 16px 40px rgba(56,189,248,.45);
              ">
                ${params.ctaText}
              </a>
            </td>
          </tr>

          <!-- EXPIRY -->
          <tr>
            <td align="center" style="
              font-size:13px;
              color:#94a3b8;
              padding-bottom:32px;
            ">
              This invitation expires on
              <strong style="color:#e5e7eb;">${expiry}</strong>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td align="center" style="
              border-top:1px solid rgba(255,255,255,.08);
              padding-top:22px;
              font-size:12px;
              color:#64748b;
            ">
              © ${new Date().getFullYear()} Plumtrips Workspace<br/>
              <span style="opacity:.85;">
                Secure · Calm · Intelligent
              </span>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>
`;
}
