/**
 * HRMS Email Templates
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
    <p style="color: #a0a0b0; margin: 4px 0 0; font-size: 13px;">HRMS Platform</p>
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
      Your company <strong>${company_name}</strong> has been registered on HRMS.
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
      You have been added to <strong>${company_name}</strong> on the HRMS platform.
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
      <strong>${company_name}</strong> account on HRMS.
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

module.exports = {
    registrationOtpTemplate,
    inviteEmployeeTemplate,
    passwordResetTemplate,
};