const express = require("express");
const router = express.Router({ mergeParams: true });

const EmployeeGratuityController = require("../controller/employeeGratuityController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// ─────────────────────────────────────────────────────────────────────────────
// Mounted at /api/companies/:company_id/gratuity
//
// Gratuity figures are payroll-sensitive: Admin only for anything showing an
// amount. The statutory rule presets are public metadata, so Managers can
// read those to render the configuration form.
// ─────────────────────────────────────────────────────────────────────────────

// ── Statutory presets (metadata) ─────────────────────────────────────────────

// Countries with a built-in scheme (AE, IN, SA)
router.get("/rules", verifyToken, validateTenant, isManager,
    EmployeeGratuityController.listRules);

// Preset for one country. Any ISO2 works; countries without a scheme come
// back with is_enabled = false so nothing accrues by accident.
router.get("/rules/:country_code", verifyToken, validateTenant, isManager,
    EmployeeGratuityController.getRule);

// ── Company-wide ─────────────────────────────────────────────────────────────

// Total accrued liability. ?as_of_date=YYYY-MM-DD&branch_id=<uuid>
router.get("/summary", verifyToken, validateTenant, isAdmin,
    EmployeeGratuityController.companySummary);

// ── Per employee ─────────────────────────────────────────────────────────────

// Config + accrued amount. ?as_of_date=YYYY-MM-DD for a projection.
router.get("/employees/:employee_id", verifyToken, validateTenant, isAdmin,
    EmployeeGratuityController.getForEmployee);

// Create or update the config. Omitted fields inherit the country preset.
router.put("/employees/:employee_id", verifyToken, validateTenant, isAdmin,
    EmployeeGratuityController.upsertForEmployee);

router.post("/employees/:employee_id", verifyToken, validateTenant, isAdmin,
    EmployeeGratuityController.upsertForEmployee);

// Remove the override and revert to the country default.
router.delete("/employees/:employee_id", verifyToken, validateTenant, isAdmin,
    EmployeeGratuityController.removeForEmployee);

module.exports = router;
