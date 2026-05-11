const UserModel = require("../models/userModel");
const UserCompanyModel = require("../models/userCompanyModel");
const CompanyModel = require("../models/companyModel");
const OtpModel = require("../models/otpTypeModel");
const { hashPassword, comparePassword } = require("../utils/password");
const { generateAccessToken, generateRefreshToken } = require("../utils/jwt");
const { sendEmail } = require("../utils/mailer");
const {
    registrationOtpTemplate,
    inviteEmployeeTemplate,
    passwordResetTemplate,
    welcomeTemplate
} = require("../utils/emailTemplates");
const { Role } = require("../enums/roles");
const crypto = require("crypto");

const MAX_FAILED_ATTEMPTS = 5;
const OTP_EXPIRY_MINUTES = 10;
const INVITE_EXPIRY_HOURS = 48;
const RESET_EXPIRY_HOURS = 1;

// ── Username generator ────────────────────────────────────────────────────────
async function generateUsername() {
    const last = await UserCompanyModel.findLastUsername();

    if (!last) return "AA0001";

    const prefix = last.username.slice(0, 2);
    const seq = parseInt(last.username.slice(2), 10);

    if (seq < 9999) {
        return `${prefix}${String(seq + 1).padStart(4, "0")}`;
    }

    const first = prefix.charCodeAt(0);
    const second = prefix.charCodeAt(1);

    if (second < 90) return String.fromCharCode(first) + String.fromCharCode(second + 1) + "0001";
    if (first < 90) return String.fromCharCode(first + 1) + "A0001";

    throw new Error("Username pool exhausted (ZZ9999 reached)");
}

// ── OTP helpers ───────────────────────────────────────────────────────────────
function generateOTP() { return Math.floor(100000 + Math.random() * 900000).toString(); }
function generateSecureToken() { return crypto.randomBytes(32).toString("hex"); }
// ─────────────────────────────────────────────────────────────────────────────

const UserCompanyService = {

    // ── COMPANY REGISTRATION ──────────────────────────────────────────────────
    // Called once from the registration controller.
    // Handles: find-or-create user, create company, link, send OTP.
    async registerCompany(data) {
        try {
            const {
                // user fields
                first_name, last_name, email, phone,
                password,
                // company fields
                company_name, company_code, company_email,
                company_phone, country, timezone, currency, logo_url,
            } = data;

            // 1. Validate password strength
            if (!password || password.length < 8) {
                return { success: false, message: "Password must be at least 8 characters" };
            }

            // 2. Check company_code not taken
            const codeExists = await CompanyModel.findByCode(company_code);
            if (codeExists) {
                return { success: false, message: "Company code already taken" };
            }

            // 3. Find or create user (handles case: same email registers another company)
            const { user, created } = await UserModel.findOrCreate({
                first_name, last_name, email, phone,
            });

            // 4. Create company
            const company = await CompanyModel.create({
                company_name, company_code,
                email: company_email || email,
                phone: company_phone,
                country, timezone, currency, logo_url,
            });

            // 5. Check user isn't already in this company (edge case: race condition)
            const existingLink = await UserCompanyModel.findByUserAndCompany(user.id, company.id);
            if (existingLink) {
                return { success: false, message: "User already linked to this company" };
            }

            // 6. Generate username + hash password
            const username = await generateUsername();
            const password_hash = await hashPassword(password);

            // 7. Link user to company as Admin
            const userCompany = await UserCompanyModel.create({
                user_id: user.id,
                company_id: company.id,
                username,
                password_hash,
                role: String(Role.ADMIN),
                is_invited: false,
            });

            // 8. Generate OTP + store
            const otp = generateOTP();
            const expires_at = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

            await OtpModel.create({
                user_id: user.id,
                company_id: company.id,
                type: "email_verification",
                token: otp,
                expires_at,
            });

            // 9. Send OTP email
            await sendEmail({
                to: email,
                subject: "Verify your email — HRMS",
                html: registrationOtpTemplate({
                    first_name,
                    otp,
                    company_name,
                    expires_minutes: OTP_EXPIRY_MINUTES,
                }),
            });

            return {
                success: true,
                message: "Company registered. OTP sent to email for verification.",
                data: {
                    user_id: user.id,
                    company_id: company.id,
                    username,
                    was_existing_user: !created,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ── VERIFY EMAIL OTP (after registration) ────────────────────────────────
    async verifyEmailOtp(otp, user_id, company_id) {
        try {
            const record = await OtpModel.findByToken(otp);

            if (!record || record.user_id !== user_id || record.type !== "email_verification") {
                return { success: false, message: "Invalid or expired OTP" };
            }

            if (company_id && record.company_id !== company_id) {
                return { success: false, message: "OTP does not match this company" };
            }

            await OtpModel.markVerified(record.id);

            // Fetch user + company + username to send welcome email
            const [user, company, uc] = await Promise.all([
                UserModel.findById(user_id),
                CompanyModel.findById(record.company_id),
                UserCompanyModel.findByUserAndCompany(user_id, record.company_id),
            ]);

            // Send welcome email with username — non-blocking (don't fail verification if email fails)
            sendEmail({
                to: user.email,
                subject: `Welcome to ${company.company_name} — Your login username`,
                html: welcomeTemplate({
                    first_name: user.first_name,
                    company_name: company.company_name,
                    username: uc.username,
                    login_url: `${process.env.FRONTEND_URL}/login`,
                }),
            }).catch(err => console.error("[Mailer] Welcome email failed:", err.message));

            return { success: true, message: "Email verified successfully" };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ── ADMIN ADDS EMPLOYEE ──────────────────────────────────────────────────
    // No password set by admin — employee gets an invite link to set their own.
    async inviteEmployee(data) {
        try {
            const {
                first_name, last_name, email, phone,
                company_id, branch_id = null, role = String(Role.EMPLOYEE),
                invited_by_company_code,
            } = data;

            // 1. Validate role (admin cannot invite another admin via this flow)
            if (role === String(Role.ADMIN)) {
                return { success: false, message: "Cannot invite a user as Admin. Use company registration." };
            }

            // 2. Find or create user
            const { user } = await UserModel.findOrCreate({
                first_name, last_name, email, phone,
            });

            // 3. Check if already linked to this company
            const existingLink = await UserCompanyModel.findByUserAndCompany(user.id, company_id);
            if (existingLink) {
                return { success: false, message: "User is already a member of this company" };
            }

            // 4. Fetch company for name in email
            const company = await CompanyModel.findById(company_id);
            if (!company || !company.is_active) {
                return { success: false, message: "Company not found or inactive" };
            }

            // 5. Generate username (no password yet)
            const username = await generateUsername();

            // 6. Create user_companies row with NULL password_hash
            const userCompany = await UserCompanyModel.create({
                user_id: user.id,
                company_id,
                branch_id,
                username,
                password_hash: null,   // set later via invite link
                role,
                is_invited: true,
            });

            // 7. Generate invite token + store
            const token = generateSecureToken();
            const expires_at = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

            await OtpModel.create({
                user_id: user.id,
                company_id: company.id,
                type: "invite",
                token,
                expires_at,
            });

            // 8. Send invite email
            await sendEmail({
                to: email,
                subject: `You've been added to ${company.company_name} — Set your password`,
                html: inviteEmployeeTemplate({
                    first_name,
                    company_name: company.company_name,
                    username,
                    invite_link: `${process.env.FRONTEND_URL}/set-password?token=${token}`,
                    expires_hours: INVITE_EXPIRY_HOURS,
                }),
            });

            return {
                success: true,
                message: "Employee invited. Password-set link sent to email.",
                data: {
                    user_id: user.id,
                    username,
                    company_id,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ── SET PASSWORD (employee accepts invite) ────────────────────────────────
    async setPasswordFromInvite(token, password) {
        try {
            if (!password || password.length < 8) {
                return { success: false, message: "Password must be at least 8 characters" };
            }

            const record = await OtpModel.findByToken(token);
            if (!record || record.type !== "invite") {
                return { success: false, message: "Invalid or expired invite link" };
            }

            // Find the user_companies row
            const uc = await UserCompanyModel.findByUserAndCompany(record.user_id, record.company_id);
            if (!uc) {
                return { success: false, message: "User company record not found" };
            }

            if (uc.password_hash) {
                return { success: false, message: "Password already set for this company account" };
            }

            const password_hash = await hashPassword(password);

            await UserCompanyModel.setPassword(uc.id, password_hash);
            await OtpModel.markVerified(record.id);

            return {
                success: true,
                message: "Password set successfully. You can now log in.",
                data: {
                    username: uc.username,
                    company_id: uc.company_id,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ── LOGIN ─────────────────────────────────────────────────────────────────
    async login(username, password) {
        try {
            const uc = await UserCompanyModel.findByUsername(username);

            if (!uc) {
                return { success: false, message: "Invalid username or password" };
            }

            // Check user + company membership active
            if (!uc.user_is_active || !uc.is_active) {
                return { success: false, message: "Account is inactive. Contact your administrator." };
            }

            // Check password has been set (employee might not have accepted invite yet)
            if (!uc.password_hash) {
                return { success: false, message: "Password not set. Please check your invite email." };
            }

            // Check account lock
            if (uc.locked_at) {
                return { success: false, message: "Account locked due to too many failed attempts. Reset your password." };
            }

            // Verify password
            const isMatch = await comparePassword(password, uc.password_hash);

            if (!isMatch) {
                const updated = await UserCompanyModel.incrementFailedLogins(uc.id);
                if (updated.failed_login_attempts >= MAX_FAILED_ATTEMPTS) {
                    await UserCompanyModel.lockAccount(uc.id);
                    return { success: false, message: "Account locked due to too many failed attempts. Reset your password." };
                }
                return { success: false, message: "Invalid username or password" };
            }

            // Success — reset failed attempts, issue tokens
            await UserCompanyModel.resetFailedLogins(uc.id);

            const payload = {
                user_id: uc.user_id,
                uc_id: uc.id,
                company_id: uc.company_id,
                branch_id: uc.branch_id,
                role: uc.role,
                username: uc.username,
            };

            const accessToken = generateAccessToken(payload);
            const refreshToken = generateRefreshToken(payload);

            await UserModel.setRefreshToken(uc.user_id, refreshToken);

            return {
                success: true,
                message: "Login successful",
                data: {
                    access_token: accessToken,
                    refresh_token: refreshToken,
                    user: {
                        user_id: uc.user_id,
                        username: uc.username,
                        first_name: uc.first_name,
                        last_name: uc.last_name,
                        email: uc.email,
                        role: uc.role,
                        company_id: uc.company_id,
                        branch_id: uc.branch_id,
                    },
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ── FORGOT PASSWORD ───────────────────────────────────────────────────────
    async forgotPassword(email, company_id) {
        try {
            const user = await UserModel.findByEmail(email);

            // Always return same message to prevent email enumeration
            if (!user) {
                return { success: true, message: "If this account exists, a reset link has been sent" };
            }

            const uc = await UserCompanyModel.findByUserAndCompany(user.id, company_id);
            if (!uc || !uc.is_active) {
                return { success: true, message: "If this account exists, a reset link has been sent" };
            }

            const company = await CompanyModel.findById(company_id);

            const token = generateSecureToken();
            const expires_at = new Date(Date.now() + RESET_EXPIRY_HOURS * 60 * 60 * 1000);

            await OtpModel.create({
                user_id: user.id,
                company_id: company.id,
                type: "password_reset",
                token,
                expires_at,
            });

            await sendEmail({
                to: email,
                subject: "Reset your password — HRMS",
                html: passwordResetTemplate({
                    first_name: user.first_name,
                    company_name: company.company_name,
                    reset_link: `${process.env.FRONTEND_URL}/reset-password?token=${token}`,
                    expires_hours: RESET_EXPIRY_HOURS,
                }),
            });

            return { success: true, message: "If this account exists, a reset link has been sent" };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ── RESET PASSWORD ────────────────────────────────────────────────────────
    async resetPassword(token, newPassword) {
        try {
            if (!newPassword || newPassword.length < 8) {
                return { success: false, message: "Password must be at least 8 characters" };
            }

            const record = await OtpModel.findByToken(token);
            if (!record || record.type !== "password_reset") {
                return { success: false, message: "Invalid or expired reset link" };
            }

            const uc = await UserCompanyModel.findByUserAndCompany(record.user_id, record.company_id);
            if (!uc) {
                return { success: false, message: "Account not found" };
            }

            const password_hash = await hashPassword(newPassword);
            await UserCompanyModel.setPassword(uc.id, password_hash);
            await UserCompanyModel.resetFailedLogins(uc.id);
            await OtpModel.markVerified(record.id);

            return { success: true, message: "Password reset successfully. You can now log in." };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ── MULTI-COMPANY SWITCH ──────────────────────────────────────────────────
    async switchCompany(user_id, target_company_id) {
        try {
            const memberships = await UserCompanyModel.findAllByUserId(user_id);
            const target = memberships.find(m => m.company_id === target_company_id);

            if (!target) {
                return { success: false, message: "User does not belong to this company" };
            }
            if (!target.is_active) {
                return { success: false, message: "Account is inactive in this company" };
            }
            if (!target.password_hash) {
                return { success: false, message: "Password not set for this company. Check your invite email." };
            }

            const payload = {
                user_id,
                uc_id: target.id,
                company_id: target.company_id,
                branch_id: target.branch_id,
                role: target.role,
                username: target.username,
            };

            const accessToken = generateAccessToken(payload);
            const refreshToken = generateRefreshToken(payload);

            await UserModel.setRefreshToken(user_id, refreshToken);

            return {
                success: true,
                message: "Switched company successfully",
                data: {
                    access_token: accessToken,
                    refresh_token: refreshToken,
                    company_id: target.company_id,
                    company_name: target.company_name,
                    role: target.role,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getUserCompanies(user_id) {
        try {
            const result = await UserCompanyModel.findAllByUserId(user_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getCompanyUsers(company_id) {
        try {
            const result = await UserCompanyModel.findAllByCompanyId(company_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deactivateUserFromCompany(id) {
        try {
            const result = await UserCompanyModel.deactivate(id);
            if (!result) return { success: false, message: "Record not found" };
            return { success: true, message: "User removed from company", data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async logout(user_id) {
        try {
            await UserModel.clearRefreshToken(user_id);
            return { success: true, message: "Logged out successfully" };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = UserCompanyService;

//:TODO Once Teambook Reaches 6.7Million users inshallah, implement 3-letter prefix logic in generateUsername() to expand pool from 676k to 175 million usernames.

// async function generateUsername() {
//     const last = await UserCompanyModel.findLastUsername();

//     if (!last) return "AA0001";

//     const username = last.username;

//     // Detect if we're already on 3-letter prefix
//     const isThreeLetter = username.length === 7; // AAA0001
    
//     if (isThreeLetter) {
//         const prefix = username.slice(0, 3);
//         const seq    = parseInt(username.slice(3), 10);

//         if (seq < 9999) return `${prefix}${String(seq + 1).padStart(4, "0")}`;

//         const a = prefix.charCodeAt(0);
//         const b = prefix.charCodeAt(1);
//         const c = prefix.charCodeAt(2);

//         if (c < 90) return String.fromCharCode(a) + String.fromCharCode(b) + String.fromCharCode(c + 1) + "0001";
//         if (b < 90) return String.fromCharCode(a) + String.fromCharCode(b + 1) + "A0001";
//         if (a < 90) return String.fromCharCode(a + 1) + "AA0001";

//         throw new Error("Username pool exhausted (ZZZ9999 reached — 175 million users)");
//     }

//     // 2-letter prefix logic (current)
//     const prefix = username.slice(0, 2);
//     const seq    = parseInt(username.slice(2), 10);

//     if (seq < 9999) return `${prefix}${String(seq + 1).padStart(4, "0")}`;

//     const first  = prefix.charCodeAt(0);
//     const second = prefix.charCodeAt(1);

//     if (second < 90) return String.fromCharCode(first) + String.fromCharCode(second + 1) + "0001";
//     if (first  < 90) return String.fromCharCode(first + 1) + "A0001";

//     // ZZ9999 reached — seamlessly roll over to 3-letter chain
//     return "AAA0001";
// }