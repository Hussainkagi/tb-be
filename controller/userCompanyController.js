const UserCompanyService = require("../service/userCompanyService");

const UserCompanyController = {
    // ── COMPANY REGISTRATION ──────────────────────────────────────────────────
    async registerCompany(req, res) {
        try {
            const result = await UserCompanyService.registerCompany(req.body);
            if (result.success) {
                return res.status(201).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // ── VERIFY EMAIL OTP (after registration) ────────────────────────────────
    async verifyEmailOtp(req, res) {
        try {
            const { otp, user_id, company_id } = req.body;
            const result = await UserCompanyService.verifyEmailOtp(
                otp,
                user_id,
                company_id
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // ── LOGIN ─────────────────────────────────────────────────────────────────
    async login(req, res) {
        try {
            const { username, password } = req.body;
            const result = await UserCompanyService.login(username, password);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(401).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // ── LOGOUT ────────────────────────────────────────────────────────────────
    async logout(req, res) {
        try {
            // user_id comes from verified JWT via middleware
            const result = await UserCompanyService.logout(req.user.user_id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // ── INVITE EMPLOYEE ───────────────────────────────────────────────────────
    async inviteEmployee(req, res) {
        try {
            const result = await UserCompanyService.inviteEmployee({
                ...req.body,
                company_id: req.user.company_id,
                invited_by_company_code: req.body.company_code,
            });
            if (result.success) {
                return res.status(201).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // ── BULK INVITE EMPLOYEES (Excel upload) ──────────────────────────────────────
    async bulkInviteEmployees(req, res) {
        try {
            const xlsx = require("xlsx");

            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: "No file uploaded. Send a .xlsx file in the 'file' field.",
                });
            }

            const workbook = xlsx.read(req.file.buffer, { type: "buffer", cellDates: true });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];

            let rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

            // Strip blank rows and the template sample row
            rows = rows.filter(r => {
                const email = String(r.email ?? "").trim();
                const firstName = String(r.first_name ?? "").trim();
                if (!email && !firstName) return false;
                if (email.endsWith("@example.com")) return false;
                return true;
            });

            if (rows.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "The uploaded file contains no data rows.",
                });
            }

            if (rows.length > 500) {
                return res.status(400).json({
                    success: false,
                    message: "Maximum 500 employees per upload. Please split into smaller files.",
                });
            }

            const result = await UserCompanyService.bulkInviteEmployees(rows, req.user.company_id);

            const status =
                result.data.failed > 0 && result.data.succeeded > 0 ? 207
                    : result.data.failed === rows.length ? 422
                        : 200;

            return res.status(status).json(result);

        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // ── SET PASSWORD FROM INVITE ──────────────────────────────────────────────
    async setPasswordFromInvite(req, res) {
        try {
            const { token, password } = req.body;
            const result = await UserCompanyService.setPasswordFromInvite(
                token,
                password
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // ── FORGOT PASSWORD ───────────────────────────────────────────────────────
    async forgotPassword(req, res) {
        try {
            const { username } = req.body;
            const result = await UserCompanyService.forgotPassword(username);
            // Always 200 to prevent email enumeration
            return res.status(200).json(result);
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // ── RESET PASSWORD ────────────────────────────────────────────────────────
    async resetPassword(req, res) {
        try {
            const { token, password } = req.body;
            const result = await UserCompanyService.resetPassword(token, password);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // ── MULTI-COMPANY SWITCH ──────────────────────────────────────────────────
    async switchCompany(req, res) {
        try {
            const result = await UserCompanyService.switchCompany(
                req.user.user_id,
                req.body.company_id
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // ── GET ALL COMPANIES FOR LOGGED-IN USER ──────────────────────────────────
    async getUserCompanies(req, res) {
        try {
            const result = await UserCompanyService.getUserCompanies(
                req.user.user_id
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // ── GET ALL USERS IN COMPANY ──────────────────────────────────────────────
    async getCompanyUsers(req, res) {
        try {
            const result = await UserCompanyService.getCompanyUsers(
                req.params.company_id
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // ── DEACTIVATE USER FROM COMPANY ──────────────────────────────────────────
    async deactivateUserFromCompany(req, res) {
        try {
            const result = await UserCompanyService.deactivateUserFromCompany(
                req.params.id
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // ── UPDATE USER COMPANY ROLE ──────────────────────────────────────────────────
    async updateUserCompanyRole(req, res) {
        try {
            console.log("Updating user company role:", req.body.role);
            const result = await UserCompanyService.updateUserCompanyRole(
                req.params.user_id,
                req.params.company_id,
                req.body.role,
                req.user.role
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

};

module.exports = UserCompanyController;