const express = require("express");
const router = express.Router({ mergeParams: true });

const PayrollController = require("../controller/payrollController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// All routes scoped under /api/companies/:company_id/payrolls

// ─────────────────────────────────────────────
// GENERATE
// ─────────────────────────────────────────────
router.post("/generate", verifyToken, validateTenant, isAdmin, PayrollController.generatePayroll);

// ─────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────
router.get("/", verifyToken, validateTenant, isManager, PayrollController.getByCompany);
router.get("/:id", verifyToken, validateTenant, isManager, PayrollController.getById);

// ─────────────────────────────────────────────
// NESTED FILTERS
// ─────────────────────────────────────────────
router.get("/period/:payroll_period_id", verifyToken, validateTenant, isManager, PayrollController.getByPeriod);
router.get("/employee/:employee_id", verifyToken, validateTenant, isManager, PayrollController.getByEmployee);

// ─────────────────────────────────────────────
// UPDATE / DELETE
// ─────────────────────────────────────────────
router.patch("/:id/status", verifyToken, validateTenant, isAdmin, PayrollController.updateStatus);
router.delete("/:id", verifyToken, validateTenant, isAdmin, PayrollController.delete);

module.exports = router;