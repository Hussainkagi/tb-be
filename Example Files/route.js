const express = require("express");
const router = express.Router();

const verifyToken = require("../middleware/verifyToken");
const { authorizeRoles, isAdmin, isManager, isEmployee } = require("../middleware/authorizeRoles");
const isSelfOrAdmin = require("../middleware/isSelfOrAdmin");
const validateTenant = require("../middleware/validateTenant");
const { Role } = require("../enums/roles");

// ─────────────────────────────────────────────
// PUBLIC ROUTES (no auth)
// ─────────────────────────────────────────────
router.post("/auth/login", (req, res) => {
    res.json({ message: "Login endpoint" });
});

router.post("/auth/forgot-password", (req, res) => {
    res.json({ message: "Forgot password endpoint" });
});

// ─────────────────────────────────────────────
// ADMIN ONLY ROUTES
// ─────────────────────────────────────────────

// Using the isAdmin shorthand
router.get("/admin/dashboard", verifyToken, isAdmin, (req, res) => {
    res.json({ message: "Admin dashboard", user: req.user });
});

// Manage all tenants - Admin only
router.get("/tenants", verifyToken, isAdmin, (req, res) => {
    res.json({ message: "List all tenants" });
});

router.post("/tenants", verifyToken, isAdmin, (req, res) => {
    res.json({ message: "Create tenant" });
});

// ─────────────────────────────────────────────
// ADMIN + MANAGER ROUTES
// ─────────────────────────────────────────────

// Using the isManager shorthand (includes Admin)
router.get("/employees", verifyToken, isManager, (req, res) => {
    res.json({ message: "List all employees" });
});

router.post("/employees", verifyToken, isManager, (req, res) => {
    res.json({ message: "Create employee" });
});

router.put("/employees/:id", verifyToken, isManager, (req, res) => {
    res.json({ message: `Update employee ${req.params.id}` });
});

router.delete("/employees/:id", verifyToken, isAdmin, (req, res) => {
    res.json({ message: `Delete employee ${req.params.id}` });
});

// Payroll: Admin + Manager can view/manage
router.get("/payroll", verifyToken, isManager, (req, res) => {
    res.json({ message: "Payroll list" });
});

router.post("/payroll/run", verifyToken, isAdmin, (req, res) => {
    res.json({ message: "Run payroll" });
});

// ─────────────────────────────────────────────
// SELF OR ADMIN ROUTES (employee can access own data)
// ─────────────────────────────────────────────

// Employee can view their own profile; admin/manager can view any
router.get("/employees/:id", verifyToken, isSelfOrAdmin, (req, res) => {
    res.json({ message: `Get employee ${req.params.id}` });
});

// Employee can view their own payslips
router.get("/employees/:id/payslips", verifyToken, isSelfOrAdmin, (req, res) => {
    res.json({ message: `Payslips for employee ${req.params.id}` });
});

// Employee can view their own attendance
router.get("/employees/:id/attendance", verifyToken, isSelfOrAdmin, (req, res) => {
    res.json({ message: `Attendance for employee ${req.params.id}` });
});

// ─────────────────────────────────────────────
// ALL AUTHENTICATED USERS
// ─────────────────────────────────────────────

// Using the isEmployee shorthand (all roles)
router.get("/me", verifyToken, isEmployee, (req, res) => {
    res.json({ message: "Current user profile", user: req.user });
});

router.put("/me/password", verifyToken, isEmployee, (req, res) => {
    res.json({ message: "Change own password" });
});

// Leave requests - any authenticated user can apply
router.post("/leave/apply", verifyToken, isEmployee, (req, res) => {
    res.json({ message: "Apply for leave" });
});

// Leave approval - Admin + Manager only
router.patch("/leave/:id/approve", verifyToken, isManager, (req, res) => {
    res.json({ message: `Approve leave ${req.params.id}` });
});

// ─────────────────────────────────────────────
// MULTI-TENANT ROUTES
// ─────────────────────────────────────────────

router.get(
    "/tenants/:tenantId/employees",
    verifyToken,
    validateTenant,
    isManager,
    (req, res) => {
        res.json({ message: `Employees for tenant ${req.params.tenantId}` });
    }
);

// ─────────────────────────────────────────────
// CUSTOM ROLE COMBO (using authorizeRoles directly)
// ─────────────────────────────────────────────

// Example: only Admin and Employee (skip Manager) - edge case demo
router.get(
    "/announcements",
    verifyToken,
    authorizeRoles(Role.ADMIN, Role.EMPLOYEE),
    (req, res) => {
        res.json({ message: "Announcements" });
    }
);

module.exports = router;