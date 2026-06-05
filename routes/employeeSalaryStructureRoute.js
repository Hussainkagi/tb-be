const express = require("express");
const router = express.Router({ mergeParams: true });

const EmployeeSalaryStructureController = require("../controller/employeeSalaryStructureController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");



// ─────────────────────────────────────────────────────────────────────────────
// Routes scoped under:
//   /api/companies/:company_id/employees/:employee_id/salary-structures
// ─────────────────────────────────────────────────────────────────────────────

// Create a new salary structure for an employee (deactivates previous active one)
router.post("/", verifyToken, validateTenant, isAdmin, EmployeeSalaryStructureController.create);

// Get the currently active salary structure for an employee
router.get("/active", verifyToken, validateTenant, isManager, EmployeeSalaryStructureController.getActive);

// Get full salary history for an employee
router.get("/", verifyToken, validateTenant, isManager, EmployeeSalaryStructureController.getHistoryByEmployee);

// Get a specific salary structure by its own id
router.get("/:id", verifyToken, validateTenant, isManager, EmployeeSalaryStructureController.getById);

// Update a specific salary structure
router.put("/:id", verifyToken, validateTenant, isAdmin, EmployeeSalaryStructureController.update);

// Deactivate a specific salary structure (soft disable)
router.patch("/:id/deactivate", verifyToken, validateTenant, isAdmin, EmployeeSalaryStructureController.deactivate);

// Hard delete a specific salary structure
router.delete("/:id", verifyToken, validateTenant, isAdmin, EmployeeSalaryStructureController.delete);

// ─────────────────────────────────────────────────────────────────────────────
// Bulk upload — scoped under:
//   /api/companies/:company_id/salary-structures/bulk-upload
// ─────────────────────────────────────────────────────────────────────────────



module.exports = router;