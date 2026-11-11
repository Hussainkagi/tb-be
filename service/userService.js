const UserModel = require("../models/userModel");
const { hashPassword, comparePassword } = require("../utils/password");
const crypto = require("crypto");

// The only fields a user may change on their own record. Everything else
// (email = sign-in identity, is_super_admin, is_active, refresh_token, ...)
// is set by the system, never from a request body.
const USER_EDITABLE_FIELDS = ["first_name", "last_name", "phone"];

/** A user row as it may leave the API: the refresh token is a credential. */
const publicUser = (row) => {
    if (!row) return row;
    const { refresh_token, ...rest } = row;
    return rest;
};

const MAX_FAILED_ATTEMPTS = 5;

const UserService = {
    async createUser(data) {
        try {
            const existing = await UserModel.findByEmail(data.email);
            if (existing) {
                return {
                    success: false,
                    message: "A user with this email already exists",
                };
            }

            const password_hash = await hashPassword(data.password);
            const verificationToken = crypto.randomBytes(32).toString("hex");
            const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

            const result = await UserModel.create({
                ...data,
                password_hash,
                email_verification_token: verificationToken,
                email_verification_expires: verificationExpires,
            });

            // TODO: send verification email with verificationToken

            return {
                success: true,
                message: "User created successfully. Verification email sent.",
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async verifyEmail(token) {
        try {
            const user = await UserModel.findByEmailVerificationToken(token);
            if (!user) {
                return {
                    success: false,
                    message: "Invalid or expired verification token",
                };
            }

            const result = await UserModel.verifyEmail(user.id);
            return {
                success: true,
                message: "Email verified successfully",
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async forgotPassword(email) {
        try {
            const user = await UserModel.findByEmail(email);
            if (!user) {
                // Return success anyway to avoid email enumeration
                return {
                    success: true,
                    message: "If this email exists, a reset link has been sent",
                };
            }

            const resetToken = crypto.randomBytes(32).toString("hex");
            const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1hr

            await UserModel.update(user.id, {
                password_reset_token: resetToken,
                password_reset_expires: resetExpires,
            });

            // TODO: send password reset email with resetToken

            return {
                success: true,
                message: "If this email exists, a reset link has been sent",
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async resetPassword(token, newPassword) {
        try {
            const user = await UserModel.findByPasswordResetToken(token);
            if (!user) {
                return {
                    success: false,
                    message: "Invalid or expired reset token",
                };
            }

            const password_hash = await hashPassword(newPassword);

            await UserModel.update(user.id, {
                password_hash,
                password_reset_token: null,
                password_reset_expires: null,
                failed_login_attempts: 0,
                locked_at: null,
            });

            return {
                success: true,
                message: "Password reset successfully",
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async getUserById(id) {
        try {
            const result = await UserModel.findById(id);
            if (!result) {
                return {
                    success: false,
                    message: "User not found",
                };
            }
            return {
                success: true,
                data: Array.isArray(result) ? result.map(publicUser) : publicUser(result),
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async getAllUsers() {
        try {
            const result = await UserModel.getAll();
            return {
                success: true,
                data: Array.isArray(result) ? result.map(publicUser) : publicUser(result),
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async updateUser(id, data) {
        try {
            const updates = Object.fromEntries(
                Object.entries(data ?? {}).filter(([key]) => USER_EDITABLE_FIELDS.includes(key))
            );
            if (Object.keys(updates).length === 0) {
                return { success: false, message: `Nothing to update. Editable fields: ${USER_EDITABLE_FIELDS.join(", ")}` };
            }

            const result = await UserModel.update(id, updates);
            if (!result) {
                return {
                    success: false,
                    message: "User not found",
                };
            }
            return {
                success: true,
                message: "User updated successfully",
                data: publicUser(result),
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async deleteUser(id) {
        try {
            const result = await UserModel.delete(id);
            if (!result) {
                return {
                    success: false,
                    message: "User not found",
                };
            }
            return {
                success: true,
                message: "User deleted successfully",
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },
};

module.exports = UserService;