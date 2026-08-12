const UserModel = require("../models/userModel");
const UserCompanyModel = require("../models/userCompanyModel");
const CompanyModel = require("../models/companyModel");
const OtpModel = require("../models/otpTypeModel");
const { hashPassword, comparePassword } = require("../utils/password");
const { generateAccessToken, generateRefreshToken } = require("../utils/jwt");
const EmployeeModel = require("../models/employeeModel");
const DepartmentModel = require("../models/departmentModel");

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

            const employee = await EmployeeModel.create({
                company_id:company.id,
                user_id: user.id,
                employee_code :`EMP${user.id.replace(/-/g, "").slice(-6).toUpperCase()}`,
                first_name,
                last_name,
                email,
                phone,
                joining_date : new Date().toISOString(),
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
            company_id, role = String(Role.EMPLOYEE),
            branch_id = null,
            department_id = null,
            shift_id = null,
            gender = null,
            date_of_birth = null,
            joining_date = null,
            employment_type = null,
             employee_person_code = null,
            is_remote_job = false,
            // Set from the "make this employee head of department?" prompt on
            // the create-employee screen.
            is_department_head = false,
        } = data;

        // 1. Validate role
        if (role === String(Role.ADMIN)) {
            return { success: false, message: "Cannot invite a user as Admin. Use company registration." };
        }

        // 1b. Head-of-department pre-checks — fail before creating anything
        if (is_department_head) {
            if (!department_id) {
                return { success: false, message: "Cannot mark employee as head of department without a department" };
            }
            const targetDepartment = await DepartmentModel.findById(department_id);
            if (!targetDepartment || targetDepartment.company_id !== company_id) {
                return { success: false, message: "Department not found or does not belong to this company" };
            }
            if (targetDepartment.head_employee_id) {
                return {
                    success: false,
                    message: `"${targetDepartment.department_name}" already has a head of department. Change it from the department settings.`,
                };
            }
        }

        // 2. Find or create user
        const { user } = await UserModel.findOrCreate({
            first_name, last_name, email, phone,
        });

        // 3. Validate employee_code not taken in this company
        const codeExists = await EmployeeModel.findByCode(company_id, `EMP${user.id.replace(/-/g, "").slice(-6).toUpperCase()}`);
        if (codeExists) {
            return { success: false, message: "Employee code already taken in this company" };
        }

        // 4. Check if already linked to this company
        const existingLink = await UserCompanyModel.findByUserAndCompany(user.id, company_id);
        if (existingLink) {
            return { success: false, message: "User is already a member of this company" };
        }

        // 5. Fetch company
        const company = await CompanyModel.findById(company_id);
        if (!company || !company.is_active) {
            return { success: false, message: "Company not found or inactive" };
        }

        // 6. Generate username (no password yet)
        const username = await generateUsername();

        // 7. Create user_companies row with NULL password_hash
        const userCompany = await UserCompanyModel.create({
            user_id: user.id,
            company_id,
            username,
            password_hash: null,
            role,
            is_invited: true,
        });

        // 8. Create employee row and link user_id
        const employee = await EmployeeModel.create({
            company_id,
            branch_id,
            department_id,
            shift_id,
            user_id: user.id,
            employee_code: `EMP${user.id.replace(/-/g, "").slice(-6).toUpperCase()}`,
            first_name,
            last_name,
            email,
            phone,
            gender,
            date_of_birth,
            joining_date,
            employment_type,
            employee_person_code,
            is_remote_job
        });

        // 8b. Make this employee head of their department if asked to, and warn
        //     the caller when the department is left without a head.
        let became_department_head = false;
        let department_needs_head = false;

        if (department_id) {
            const department = await DepartmentModel.findById(department_id);

            if (is_department_head && department && !department.head_employee_id) {
                await DepartmentModel.setHead(department_id, employee.id);
                became_department_head = true;
            }

            // Department now has at least this employee, so a head is required.
            department_needs_head = Boolean(
                department && !department.head_employee_id && !became_department_head
            );
        }

        // 9. Generate invite token + store
        const token = generateSecureToken();
        const expires_at = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

        await OtpModel.create({
            user_id: user.id,
            company_id,
            type: "invite",
            token,
            expires_at,
        });

        // 10. Send invite email
        await sendEmail({
            to: email,
            subject: `You've been added to ${company.company_name} — Set your password`,
            html: inviteEmployeeTemplate({
                first_name,
                company_name: company.company_name,
                username,
                invite_link: `${process.env.FRONTEND_URL}/setup-password?token=${token}`,
                expires_hours: INVITE_EXPIRY_HOURS,
            }),
        });

        return {
            success: true,
            message: became_department_head
                ? "Employee invited and set as head of department. Password-set link sent to email."
                : "Employee invited. Password-set link sent to email.",
            data: {
                user_id: user.id,
                employee_id: employee.id,
                username,
                company_id,
                department_id,
                is_department_head: became_department_head,
                // true → the UI should nudge the admin to pick a head for this department
                department_needs_head,
            },
        };
    } catch (error) {
        return { success: false, message: error.message, error };
    }
},

// ── BULK INVITE EMPLOYEES (Excel upload) ──────────────────────────────────────
// Add this method inside the UserCompanyService object, alongside inviteEmployee.
//
// Reads rows from a parsed Excel file (already converted to JSON array by the
// controller), validates each row, then delegates to the existing inviteEmployee
// logic row-by-row, collecting per-row results so the caller always gets a full
// report instead of an all-or-nothing failure.
//
// Expected row shape (matches the Excel template headers):
//   first_name, last_name, email, phone,
//   gender, role, employment_type, is_remote_job,
//   branch_id, department_id, shift_id,
//   date_of_birth, joining_date
// ---------------------------------------------------------------------------

async bulkInviteEmployees(rows, company_id) {
    const REQUIRED_FIELDS = ["first_name", "last_name", "email", "phone", "gender", "role", "employment_type", "is_remote_job"];
    const VALID_GENDERS   = ["male", "female", "other"];
    const VALID_EMP_TYPES = ["full_time", "part_time", "contract", "intern"];

    const results = {
        total:     rows.length,
        succeeded: 0,
        failed:    0,
        rows:      [],   // per-row outcome — always populated
    };

    for (let i = 0; i < rows.length; i++) {
        const raw       = rows[i];
        const rowNumber = i + 2; // +2: row 1 = header, row 2 = first data row in Excel (row 3 is sample)

        // ── 1. Normalise values ────────────────────────────────────────────
        const row = {
            first_name:      String(raw.first_name      ?? "").trim(),
            last_name:       String(raw.last_name        ?? "").trim(),
            email:           String(raw.email            ?? "").trim().toLowerCase(),
            phone:           String(raw.phone            ?? "").trim(),
            gender:          String(raw.gender           ?? "").trim().toLowerCase(),
            role:            String(raw.role             ?? "").trim(),
            employment_type: String(raw.employment_type  ?? "").trim().toLowerCase(),
            employee_person_code: raw.employee_person_code ? String(raw.employee_person_code).trim() : null,
            is_remote_job:   String(raw.is_remote_job    ?? "false").trim().toLowerCase() === "true",
            is_department_head: String(raw.is_department_head ?? "false").trim().toLowerCase() === "true",
            branch_id:       raw.branch_id     ? String(raw.branch_id).trim()     : null,
            department_id:   raw.department_id ? String(raw.department_id).trim() : null,
            shift_id:        raw.shift_id      ? String(raw.shift_id).trim()      : null,
            joining_date: raw.joining_date
                                            ? new Date(raw.joining_date).toISOString().split("T")[0]
                                            : null,
                                        date_of_birth: raw.date_of_birth
                                            ? new Date(raw.date_of_birth).toISOString().split("T")[0]
                                            : null,
        };

        // ── 2. Required-field validation ──────────────────────────────────
        const missing = REQUIRED_FIELDS.filter(f => !row[f] && row[f] !== false);
        if (missing.length) {
            results.failed++;
            results.rows.push({
                row: rowNumber,
                email: row.email || "(missing)",
                success: false,
                message: `Missing required fields: ${missing.join(", ")}`,
            });
            continue;
        }

        // ── 3. Email format ───────────────────────────────────────────────
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) {
            results.failed++;
            results.rows.push({ row: rowNumber, email: row.email, success: false, message: "Invalid email format" });
            continue;
        }

        // ── 4. Enum validations ───────────────────────────────────────────
        if (!VALID_GENDERS.includes(row.gender)) {
            results.failed++;
            results.rows.push({ row: rowNumber, email: row.email, success: false, message: `Invalid gender. Must be: ${VALID_GENDERS.join(", ")}` });
            continue;
        }

        if (!VALID_EMP_TYPES.includes(row.employment_type)) {
            results.failed++;
            results.rows.push({ row: rowNumber, email: row.email, success: false, message: `Invalid employment_type. Must be: ${VALID_EMP_TYPES.join(", ")}` });
            continue;
        }

        if (row.role === String(Role.ADMIN)) {
            results.failed++;
            results.rows.push({ row: rowNumber, email: row.email, success: false, message: "Cannot bulk-invite a user as Admin" });
            continue;
        }

        // ── 5. Delegate to the single-invite service ──────────────────────
        try {
            const outcome = await this.inviteEmployee({
                ...row,
                company_id,
            });

            if (outcome.success) {
                results.succeeded++;
                results.rows.push({
                    row: rowNumber,
                    email: row.email,
                    success: true,
                    message: outcome.message,
                    data: outcome.data,
                });
            } else {
                results.failed++;
                results.rows.push({
                    row: rowNumber,
                    email: row.email,
                    success: false,
                    message: outcome.message,
                });
            }
        } catch (err) {
            results.failed++;
            results.rows.push({
                row: rowNumber,
                email: row.email,
                success: false,
                message: err.message,
            });
        }
    }

    return {
        success: true,   // the *operation* succeeded even if some rows failed
        message: `Bulk invite complete. ${results.succeeded} succeeded, ${results.failed} failed.`,
        data: results,
    };
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

            const isSuperAdmin = uc.is_super_admin === true;

            const payload = {
                user_id: uc.user_id,
                uc_id: uc.id,
                company_id: uc.company_id,
                branch_id: uc.branch_id,
                role: uc.role,
                username: uc.username,
                is_super_admin: isSuperAdmin,
            };

            const accessToken = generateAccessToken(payload);
            const refreshToken = generateRefreshToken(payload);

            await UserModel.setRefreshToken(uc.user_id, refreshToken);

            // A disabled company does NOT block login — the user must be able to
            // reach the app to see WHY they are locked out. Every write request is
            // rejected downstream by the enforceCompanyActive middleware.
            const companyDisabled = uc.company_is_active === false;

            return {
                success: true,
                message: companyDisabled
                    ? "Login successful, but your company has been disabled by the platform administrator."
                    : "Login successful",
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
                        is_super_admin: isSuperAdmin,
                    },
                    company: {
                        id: uc.company_id,
                        company_name: uc.company_name,
                        company_code: uc.company_code,
                        logo_url: uc.company_logo_url,
                        is_active: uc.company_is_active,
                        is_disabled: companyDisabled,
                        disabled_at: uc.company_disabled_at,
                        disabled_reason: uc.company_disabled_reason,
                    },
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ── FORGOT PASSWORD ───────────────────────────────────────────────────────
    // Uses username — globally unique, maps directly to user + company context.
    // User knows their username from welcome/invite email.
    async forgotPassword(username) {
        try {
            const uc = await UserCompanyModel.findByUsername(username);

            // Always return same message to prevent enumeration
            if (!uc || !uc.is_active) {
                return { success: true, message: "If this account exists, a reset link has been sent" };
            }

            const [user, company] = await Promise.all([
                UserModel.findById(uc.user_id),
                CompanyModel.findById(uc.company_id),
            ]);

            const token = generateSecureToken();
            const expires_at = new Date(Date.now() + RESET_EXPIRY_HOURS * 60 * 60 * 1000);

            await OtpModel.create({
                user_id: uc.user_id,
                company_id: uc.company_id,
                type: "password_reset",
                token,
                expires_at,
            });

            await sendEmail({
                to: user.email,
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

            const user = await UserModel.findById(user_id);
            const isSuperAdmin = user?.is_super_admin === true;

            const payload = {
                user_id,
                uc_id: target.id,
                company_id: target.company_id,
                branch_id: target.branch_id,
                role: target.role,
                username: target.username,
                is_super_admin: isSuperAdmin,
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
                    is_super_admin: isSuperAdmin,
                    company: {
                        id: target.company_id,
                        company_name: target.company_name,
                        is_active: target.company_is_active,
                        is_disabled: target.company_is_active === false,
                        disabled_at: target.company_disabled_at,
                        disabled_reason: target.company_disabled_reason,
                    },
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
    async updateUserCompanyRole(user_id, company_id, role, requester_role) {
        try {
            // 1. Only admins can change roles
            if (requester_role !== String(Role.ADMIN)) {
                return { success: false, message: "Only admins can change user roles" };
            }

            // 2. Validate role value
            const validRoles = Object.values(Role).map(String);
            console.log("Valid roles:", validRoles);
            if (!validRoles.includes(role)) {
                console.log("Invalid role provided:", role);
                return { success: false, message: `Invalid role. Must be one of: ${validRoles.join(", ")}` };
            }

            // 3. Cannot assign Admin role
            if (role === String(Role.ADMIN)) {
                return { success: false, message: "Cannot assign Admin role via this flow" };
            }

            // 4. Fetch existing record by user_id and company_id
            const existing = await UserCompanyModel.findByUserAndCompany(user_id, company_id);
            if (!existing) {
                return { success: false, message: "User company record not found" };
            }

            // 5. No-op guard
            if (existing.role === role) {
                return { success: false, message: "User already has this role" };
            }

            // 6. Update
            const updated = await UserCompanyModel.updateRole(existing.id, role);
            if (!updated) {
                return { success: false, message: "Update failed" };
            }

            return {
                success: true,
                message: "Role updated successfully",
                data: {
                    id:         updated.id,
                    user_id:    updated.user_id,
                    company_id: updated.company_id,
                    role:       updated.role,
                    updated_at: updated.updated_at,
                },
            };
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