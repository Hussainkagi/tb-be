const express = require("express");
const router = express.Router({ mergeParams: true });

const PayrollPeriodController = require("../controller/payrollPeriodController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// All routes scoped under /api/companies/:company_id/payroll-periods

// ─────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────
router.get("/", verifyToken, validateTenant, isManager, PayrollPeriodController.getByCompany);
router.get("/:id", verifyToken, validateTenant, isManager, PayrollPeriodController.getById);

// ─────────────────────────────────────────────
// NESTED FILTERS
// ─────────────────────────────────────────────
router.get("/status/:status", verifyToken, validateTenant, isManager, PayrollPeriodController.getByStatus);
router.get("/range/search", verifyToken, validateTenant, isManager, PayrollPeriodController.getByDateRange);

// ─────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────
router.post("/", verifyToken, validateTenant, isManager, PayrollPeriodController.create);

// ─────────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────────
router.put("/:id", verifyToken, validateTenant, isManager, PayrollPeriodController.update);
router.patch("/:id/status", verifyToken, validateTenant, isManager, PayrollPeriodController.updateStatus);
router.patch("/:id/process", verifyToken, validateTenant, isManager, PayrollPeriodController.markAsProcessed);
router.patch("/:id/lock", verifyToken, validateTenant, isAdmin, PayrollPeriodController.lock);

// ─────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────
router.delete("/:id", verifyToken, validateTenant, isAdmin, PayrollPeriodController.delete);

module.exports = router;