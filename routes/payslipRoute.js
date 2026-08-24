const express = require("express");
const router = express.Router({ mergeParams: true });

const PayslipController = require("../controller/payslipController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager, isEmployee } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// All routes scoped under /api/companies/:company_id/payslips

// ─────────────────────────────────────────────
// GENERATE
// ─────────────────────────────────────────────
router.post("/payroll/:payroll_id/generate", verifyToken, validateTenant, isAdmin, PayslipController.generatePayslip);
router.post("/period/:payroll_period_id/generate", verifyToken, validateTenant, isAdmin, PayslipController.generatePayslipsForPeriod);

// ─────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// EMPLOYEE SELF-SERVICE (mobile app)
//
// Mounted BEFORE /:id — "my" would otherwise be captured as a payslip id.
//
// isEmployee here means "any authenticated member of the company", which is
// correct: the handler resolves the employee from the token, so the caller can
// only ever reach their own payslips. Contrast /employee/:employee_id below,
// where the id comes from the URL and therefore needs a real ownership check.
// ─────────────────────────────────────────────

// GET /api/companies/:company_id/payslips/my/available
router.get("/my/available", verifyToken, validateTenant, isEmployee, PayslipController.getMineAvailable);

// GET /api/companies/:company_id/payslips/my?year=2026&month=8
router.get("/my", verifyToken, validateTenant, isEmployee, PayslipController.getMine);

// GET /api/companies/:company_id/payslips/my/:id
router.get("/my/:id", verifyToken, validateTenant, isEmployee, PayslipController.getMineById);

router.get("/:id", verifyToken, validateTenant, isManager, PayslipController.getById);
router.get("/number/:payslip_number", verifyToken, validateTenant, isEmployee, PayslipController.getByNumber);

// ─────────────────────────────────────────────
// NESTED FILTERS
// ─────────────────────────────────────────────
router.get("/payroll/:payroll_id", verifyToken, validateTenant, isManager, PayslipController.getByPayrollId);
router.get("/employee/:employee_id", verifyToken, validateTenant, isEmployee, PayslipController.getByEmployee);
router.get("/period/:payroll_period_id", verifyToken, validateTenant, isManager, PayslipController.getByPeriod);

// ─────────────────────────────────────────────
// UPDATE / DELETE
// ─────────────────────────────────────────────
router.patch("/:id/pdf-url", verifyToken, validateTenant, isAdmin, PayslipController.updatePdfUrl);
router.delete("/:id", verifyToken, validateTenant, isAdmin, PayslipController.delete);

module.exports = router;