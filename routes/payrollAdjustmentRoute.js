const express = require("express");
const router = express.Router({ mergeParams: true });

const PayrollAdjustmentController = require("../controller/payrollAdjustmentController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// All routes scoped under /api/companies/:company_id/payroll-adjustments

// ─────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────
router.post("/", verifyToken, validateTenant, isAdmin, PayrollAdjustmentController.addAdjustment);
router.post("/payroll/:payroll_id/bulk", verifyToken, validateTenant, isAdmin, PayrollAdjustmentController.addAdjustmentsBulk);

// ─────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────
router.get("/:id", verifyToken, validateTenant, isManager, PayrollAdjustmentController.getById);

// ─────────────────────────────────────────────
// NESTED FILTERS
// ─────────────────────────────────────────────
router.get("/payroll/:payroll_id", verifyToken, validateTenant, isManager, PayrollAdjustmentController.getByPayroll);
router.get("/payroll/:payroll_id/type/:adjustment_type", verifyToken, validateTenant, isManager, PayrollAdjustmentController.getByType);

// ─────────────────────────────────────────────
// UPDATE / DELETE
// ─────────────────────────────────────────────
router.put("/:id", verifyToken, validateTenant, isAdmin, PayrollAdjustmentController.update);
router.delete("/payroll/:payroll_id/all", verifyToken, validateTenant, isAdmin, PayrollAdjustmentController.deleteAll);
router.delete("/:id", verifyToken, validateTenant, isAdmin, PayrollAdjustmentController.delete);

module.exports = router;