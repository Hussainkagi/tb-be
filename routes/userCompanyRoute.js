const express = require("express");
const router = express.Router();

const UserCompanyController = require("../controller/userCompanyController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager, isEmployee } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// ─────────────────────────────────────────────
// PUBLIC (no auth)
// ─────────────────────────────────────────────

// Company registration — creates company + admin user in one call
router.post("/auth/register", UserCompanyController.registerCompany);

// OTP verification after registration
router.post("/auth/verify-otp", UserCompanyController.verifyEmailOtp);

// Login with username + password
router.post("/auth/login", UserCompanyController.login);

// Password flows — no token needed (user is locked out)
router.post("/auth/forgot-password", UserCompanyController.forgotPassword);
router.post("/auth/reset-password", UserCompanyController.resetPassword);

// Employee accepts invite and sets password via token link
router.post("/auth/set-password", UserCompanyController.setPasswordFromInvite);

// ─────────────────────────────────────────────
// AUTHENTICATED — ALL ROLES
// ─────────────────────────────────────────────

// Logout (clears refresh token)
router.post("/auth/logout", verifyToken, isEmployee, UserCompanyController.logout);

// Get all companies the logged-in user belongs to (for company switcher UI)
router.get("/auth/my-companies", verifyToken, isEmployee, UserCompanyController.getUserCompanies);

// Switch active company — re-issues JWT for selected company
router.post("/auth/switch-company", verifyToken, isEmployee, UserCompanyController.switchCompany);

// ─────────────────────────────────────────────
// ADMIN + MANAGER — company user management
// ─────────────────────────────────────────────

// Get all users in the logged-in user's company
router.get(
    "/companies/:company_id/users",
    verifyToken,
    validateTenant,
    isManager,
    UserCompanyController.getCompanyUsers
);

// Invite a new employee to the company
router.post(
    "/companies/:company_id/users/invite",
    verifyToken,
    validateTenant,
    isManager,
    UserCompanyController.inviteEmployee
);

// ─────────────────────────────────────────────
// ADMIN ONLY — user membership management
// ─────────────────────────────────────────────

// Deactivate a user from a company (removes access, keeps data)
router.patch(
    "/companies/users/:id/deactivate",
    verifyToken,
    isAdmin,
    UserCompanyController.deactivateUserFromCompany
);

module.exports = router;