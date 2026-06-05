const express = require("express");
const router = express.Router();

const UserCompanyController = require("../controller/userCompanyController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager, isEmployee } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");
const multer = require("multer");

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter(_req, file, cb) {
        const ok = file.mimetype.includes("spreadsheet") || file.originalname.endsWith(".xlsx");
        ok ? cb(null, true) : cb(new Error("Only .xlsx files are accepted"), false);
    },
});

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
// Invite multiple employees via Excel upload
router.post(
    "/companies/:company_id/users/bulk-invite",
    verifyToken,
    validateTenant,
    isManager,
    upload.single("file"),        // multer must come before the controller
    UserCompanyController.bulkInviteEmployees
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


// Update user role in a company (needs both company_id and user_id)
router.patch(
    "/companies/:company_id/users/:user_id/role",
    verifyToken,
    isAdmin,
    UserCompanyController.updateUserCompanyRole
);

// // Download blank bulk-invite Excel template
// router.get(
//     "/companies/bulk-invite/template",
//     verifyToken,
//     isAdmin,
//     (_req, res) => {
//         const xlsx = require("xlsx");

//         const headers = [
//             "first_name", "last_name", "email", "phone",
//             "gender", "role", "employment_type", "is_remote_job",
//             "branch_id", "department_id", "shift_id",
//             "date_of_birth", "joining_date"
//         ];

//         const sampleRow = {
//             first_name: "Hussain",
//             last_name: "Ali",
//             email: "hussain@yourcompany.com",
//             phone: "+971501234567",
//             gender: "male",
//             role: "2",
//             employment_type: "full_time",
//             is_remote_job: "false",
//             branch_id: "",
//             department_id: "",
//             shift_id: "",
//             date_of_birth: "1995-06-15",
//             joining_date: "2025-01-01",
//         };

//         const wb = xlsx.utils.book_new();
//         const ws = xlsx.utils.json_to_sheet([sampleRow], { header: headers });

//         // Column widths
//         ws["!cols"] = [
//             { wch: 14 }, { wch: 14 }, { wch: 28 }, { wch: 18 },
//             { wch: 10 }, { wch: 8 }, { wch: 16 }, { wch: 14 },
//             { wch: 38 }, { wch: 38 }, { wch: 38 }, { wch: 14 }, { wch: 14 },
//         ];

//         // Notes sheet
//         const notes = xlsx.utils.aoa_to_sheet([
//             ["Field", "Required", "Accepted Values"],
//             ["first_name", "Yes", "Text"],
//             ["last_name", "Yes", "Text"],
//             ["email", "Yes", "Valid email address"],
//             ["phone", "Yes", "E.164 format e.g. +971501234567"],
//             ["gender", "Yes", "male | female | other"],
//             ["role", "Yes", "2 = Employee | 3 = Manager | 4 = HR"],
//             ["employment_type", "Yes", "full_time | part_time | contract | intern"],
//             ["is_remote_job", "Yes", "true | false"],
//             ["branch_id", "No", "UUID — leave blank if not applicable"],
//             ["department_id", "No", "UUID — leave blank if not applicable"],
//             ["shift_id", "No", "UUID — leave blank if not applicable"],
//             ["date_of_birth", "No", "YYYY-MM-DD"],
//             ["joining_date", "No", "YYYY-MM-DD"],
//         ]);
//         notes["!cols"] = [{ wch: 18 }, { wch: 10 }, { wch: 45 }];

//         xlsx.utils.book_append_sheet(wb, ws, "Employees");
//         xlsx.utils.book_append_sheet(wb, notes, "Notes");

//         const buffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });

//         res.setHeader("Content-Disposition", 'attachment; filename="bulk_employee_invite_template.xlsx"');
//         res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
//         res.send(buffer);
//     }
// );

module.exports = router;