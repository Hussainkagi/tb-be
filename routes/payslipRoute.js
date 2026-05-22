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