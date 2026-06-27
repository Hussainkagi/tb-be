const express = require("express");
const router = express.Router({ mergeParams: true });

const PayrollBreakdownController = require("../controller/payrollBreakdownController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// All routes scoped under /api/companies/:company_id/payrolls
// mergeParams: true gives us company_id from the parent router

// ─────────────────────────────────────────────
// BREAKDOWN — single payroll record
// GET /api/companies/:company_id/payrolls/:id/breakdown
// ─────────────────────────────────────────────
router.get("/:id/breakdown", verifyToken, validateTenant, isManager, PayrollBreakdownController.getByPayrollId);

// ─────────────────────────────────────────────
// BREAKDOWN — all employees in a period
// GET /api/companies/:company_id/payrolls/period/:payroll_period_id/breakdown
// ─────────────────────────────────────────────
router.get("/period/:payroll_period_id/breakdown", verifyToken, validateTenant, isManager, PayrollBreakdownController.getByPeriod);

module.exports = router;