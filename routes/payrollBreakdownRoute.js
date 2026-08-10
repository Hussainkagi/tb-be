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

// ─────────────────────────────────────────────
// REPAIR — rebuild the frozen daily-line snapshot
// POST /api/companies/:company_id/payroll-breakdown/:id/rebuild
//
// For payrolls whose rows no longer add up to gross: legacy records from
// before the engine rewrite, and settled runs that /generate refuses to
// touch. Rebuilds the display snapshot only; never alters what was paid.
// ─────────────────────────────────────────────
router.post("/:id/rebuild", verifyToken, validateTenant, isAdmin, PayrollBreakdownController.rebuild);

module.exports = router;