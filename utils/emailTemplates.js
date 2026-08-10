/**
 * TeamBook Email Templates
 * All templates return HTML strings.
 * Used by: userCompanyService.js via utils/mailer.js
 */

const baseStyle = `
  font-family: Arial, sans-serif;
  max-width: 600px;
  margin: 0 auto;
  background: #f9f9f9;
  border-radius: 8px;
  overflow: hidden;
`;

const header = (company_name) => `
  <div style="background: #1a1a2e; padding: 28px 32px;">
    <h1 style="color: #ffffff; margin: 0; font-size: 20px;">${company_name}</h1>
    <p style="color: #a0a0b0; margin: 4px 0 0; font-size: 13px;">TeamBook Platform</p>
  </div>
`;

const footer = () => `
  <div style="background: #f0f0f0; padding: 16px 32px; text-align: center;">
    <p style="color: #888; font-size: 12px; margin: 0;">
      This is an automated message. Please do not reply to this email.
    </p>
  </div>
`;

const button = (label, url) => `
  <a href="${url}"
     style="display:inline-block; background:#1a1a2e; color:#fff;
            padding:12px 28px; border-radius:6px; text-decoration:none;
            font-weight:bold; font-size:15px; margin-top:8px;">
    ${label}
  </a>
`;

// ── 1. REGISTRATION OTP ───────────────────────────────────────────────────────
const registrationOtpTemplate = ({ first_name, otp, company_name, expires_minutes }) => `
<div style="${baseStyle}">
  ${header(company_name)}
  <div style="padding: 32px;">
    <h2 style="color:#1a1a2e; margin-top:0;">Verify your email</h2>
    <p style="color:#333;">Hi ${first_name},</p>
    <p style="color:#333;">
      Your company <strong>${company_name}</strong> has been registered on TeamBook.
      Use the OTP below to verify your email address.
    </p>
    <div style="text-align:center; margin: 32px 0;">
      <div style="display:inline-block; background:#1a1a2e; color:#fff;
                  font-size:36px; font-weight:bold; letter-spacing:12px;
                  padding:16px 32px; border-radius:8px;">
        ${otp}
      </div>
    </div>
    <p style="color:#888; font-size:13px; text-align:center;">
      This OTP expires in <strong>${expires_minutes} minutes</strong>.
      Do not share it with anyone.
    </p>
  </div>
  ${footer()}
</div>
`;

// ── 2. EMPLOYEE INVITE (set password) ─────────────────────────────────────────
const inviteEmployeeTemplate = ({ first_name, company_name, username, invite_link, expires_hours }) => `
<div style="${baseStyle}">
  ${header(company_name)}
  <div style="padding: 32px;">
    <h2 style="color:#1a1a2e; margin-top:0;">You've been added to ${company_name}</h2>
    <p style="color:#333;">Hi ${first_name},</p>
    <p style="color:#333;">
      You have been added to <strong>${company_name}</strong> on the TeamBook platform.
      Your login username is:
    </p>
    <div style="text-align:center; margin: 20px 0;">
      <div style="display:inline-block; background:#f0f0f0; color:#1a1a2e;
                  font-size:24px; font-weight:bold; letter-spacing:4px;
                  padding:12px 32px; border-radius:8px; border: 1px solid #ddd;">
        ${username}
      </div>
    </div>
    <p style="color:#333;">
      Click below to set your password and activate your account.
    </p>
    <div style="text-align:center; margin: 24px 0;">
      ${button("Set My Password", invite_link)}
    </div>
    <p style="color:#888; font-size:13px; text-align:center;">
      This link expires in <strong>${expires_hours} hours</strong>.
      If you did not expect this invitation, please ignore this email.
    </p>
  </div>
  ${footer()}
</div>
`;

// ── 3. PASSWORD RESET ─────────────────────────────────────────────────────────
const passwordResetTemplate = ({ first_name, company_name, reset_link, expires_hours }) => `
<div style="${baseStyle}">
  ${header(company_name)}
  <div style="padding: 32px;">
    <h2 style="color:#1a1a2e; margin-top:0;">Reset your password</h2>
    <p style="color:#333;">Hi ${first_name},</p>
    <p style="color:#333;">
      We received a request to reset your password for your
      <strong>${company_name}</strong> account on TeamBook.
    </p>
    <div style="text-align:center; margin: 24px 0;">
      ${button("Reset My Password", reset_link)}
    </div>
    <p style="color:#888; font-size:13px; text-align:center;">
      This link expires in <strong>${expires_hours} hour${expires_hours > 1 ? "s" : ""}</strong>.
      If you did not request a password reset, you can safely ignore this email.
    </p>
  </div>
  ${footer()}
</div>
`;

const welcomeTemplate = ({ first_name, company_name, username, login_url }) => `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; border-radius: 8px; overflow: hidden;">
 
  <div style="background: #1a1a2e; padding: 28px 32px;">
    <h1 style="color: #ffffff; margin: 0; font-size: 20px;">${company_name}</h1>
    <p style="color: #a0a0b0; margin: 4px 0 0; font-size: 13px;">TeamBook Platform</p>
  </div>
 
  <div style="padding: 32px;">
    <h2 style="color: #1a1a2e; margin-top: 0;">Welcome aboard, ${first_name}! 🎉</h2>
    <p style="color: #333;">
      Your email has been verified and your company <strong>${company_name}</strong>
      is now active on TeamBook.
    </p>
    <p style="color: #333;">Your login username is:</p>
 
    <div style="text-align: center; margin: 28px 0;">
      <div style="display: inline-block; background: #1a1a2e; color: #ffffff;
                  font-size: 28px; font-weight: bold; letter-spacing: 8px;
                  padding: 16px 40px; border-radius: 8px;">
        ${username}
      </div>
      <p style="color: #888; font-size: 12px; margin-top: 10px;">
        This username is unique to your company account. Keep it safe.
      </p>
    </div>
 
    <p style="color: #333;">Use this username along with your password to log in.</p>
 
    <div style="text-align: center; margin: 24px 0;">
      <a href="${login_url}"
         style="display: inline-block; background: #1a1a2e; color: #fff;
                padding: 12px 32px; border-radius: 6px; text-decoration: none;
                font-weight: bold; font-size: 15px;">
        Go to Login
      </a>
    </div>
  </div>
 
  <div style="background: #f0f0f0; padding: 16px 32px; text-align: center;">
    <p style="color: #888; font-size: 12px; margin: 0;">
      This is an automated message. Please do not reply to this email.
    </p>
  </div>
 
</div>
`;

// ── 5. PAYSLIP ────────────────────────────────────────────────────────────────
// Adjustments are itemised rather than folded into a single "deductions"
// figure. A lump sum with no explanation is the number employees query.
const ADJUSTMENT_LABELS = {
  bonus: "Bonus",
  commission: "Commission",
  deduction: "Deduction",
  penalty: "Penalty",
  loan: "Loan repayment",
};

const EARNING_TYPES = ["bonus", "commission"];

const payslipTemplate = ({
  first_name,
  company_name,
  period_name,
  period_start,
  period_end,
  payslip_number,
  currency = "",
  gross_salary,
  overtime_amount = 0,
  overtime_hours = 0,
  base_deduction_amount = 0,
  tax_amount = 0,
  net_salary,
  adjustments = [],
  pdf_url,
}) => {
  const money = (v) =>
    `${currency ? currency + " " : ""}${Number(v || 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  const cell = (align = "left", extra = "") =>
    `padding:9px 0; font-size:14px; text-align:${align}; border-bottom:1px solid #ececec; ${extra}`;

  const sectionHead = (label) => `
    <tr>
      <td colspan="2" style="padding:18px 0 6px; font-size:12px; font-weight:bold;
                             letter-spacing:0.6px; text-transform:uppercase; color:#8a8a9a;">
        ${label}
      </td>
    </tr>`;

  const line = (label, value, note = "") => `
    <tr>
      <td style="${cell("left", "color:#555;")}">
        ${label}${note ? `<div style="color:#999; font-size:12px; margin-top:2px;">${note}</div>` : ""}
      </td>
      <td style="${cell("right", "color:#1a1a2e; white-space:nowrap;")}">${value}</td>
    </tr>`;

  const earnings = adjustments.filter((a) => EARNING_TYPES.includes(a.adjustment_type));
  const deductions = adjustments.filter((a) => !EARNING_TYPES.includes(a.adjustment_type));

  const adjustmentRows = (items) =>
    items
      .map((a) =>
        line(
          a.title || ADJUSTMENT_LABELS[a.adjustment_type] || a.adjustment_type,
          money(a.amount),
          [ADJUSTMENT_LABELS[a.adjustment_type], a.remarks].filter(Boolean).join(" · ")
        )
      )
      .join("");

  return `
<div style="${baseStyle}">
  ${header(company_name)}
  <div style="padding: 32px;">
    <h2 style="color:#1a1a2e; margin-top:0;">Your payslip for ${period_name}</h2>
    <p style="color:#444; font-size:15px; line-height:1.6;">
      Hi ${first_name || "there"}, your salary for
      <strong>${period_start} to ${period_end}</strong> has been processed and paid.
    </p>

    <p style="color:#888; font-size:13px; margin:0 0 8px;">
      Payslip <strong style="color:#555;">${payslip_number}</strong>
    </p>

    <table style="width:100%; border-collapse:collapse; margin:8px 0 24px;">
      ${sectionHead("Earnings")}
      ${line("Gross salary", money(gross_salary))}
      ${Number(overtime_amount) > 0
      ? line("Overtime", money(overtime_amount), `${Number(overtime_hours).toFixed(2)} hours`)
      : ""}
      ${adjustmentRows(earnings)}

      ${sectionHead("Deductions")}
      ${Number(base_deduction_amount) > 0
      ? line("Attendance & leave", money(base_deduction_amount), "Absences, unpaid leave and half days")
      : ""}
      ${Number(tax_amount) > 0 ? line("Tax", money(tax_amount)) : ""}
      ${adjustmentRows(deductions)}
      ${deductions.length === 0 && Number(base_deduction_amount) === 0 && Number(tax_amount) === 0
      ? line("No deductions", money(0))
      : ""}

      <tr>
        <td style="padding:16px 0 0; font-size:16px; font-weight:bold; color:#1a1a2e;">Net pay</td>
        <td style="padding:16px 0 0; font-size:20px; font-weight:bold; text-align:right;
                   color:#1a1a2e; white-space:nowrap;">${money(net_salary)}</td>
      </tr>
    </table>

    ${pdf_url
      ? button("Download payslip", pdf_url)
      : `<p style="color:#666; font-size:14px;">
           A day-by-day breakdown is available on your employee portal.
         </p>`}

    <p style="color:#888; font-size:13px; margin-top:24px;">
      If anything looks wrong, contact your HR team before the next pay cycle.
    </p>
  </div>
  ${footer()}
</div>
`;
};

module.exports = {
  registrationOtpTemplate,
  inviteEmployeeTemplate,
  passwordResetTemplate,
  welcomeTemplate,
  payslipTemplate
};