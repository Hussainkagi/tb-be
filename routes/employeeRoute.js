// Get employee by user_id and company_id

const express = require("express");
const router = express.Router({ mergeParams: true });

const EmployeeController = require("../controller/employeeController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager, isEmployee } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// All routes scoped under /api/companies/:company_id/employees


router.get("/user-company/:user_id", verifyToken, validateTenant, isEmployee, EmployeeController.getByUserAndCompany),

    // ─────────────────────────────────────────────
    // ADMIN + MANAGER
    // ─────────────────────────────────────────────
    router.get("/", verifyToken, validateTenant, isManager, EmployeeController.getByCompany);
router.get("/:id", verifyToken, validateTenant, isEmployee, EmployeeController.getById);
router.put("/:id", verifyToken, validateTenant, isManager, EmployeeController.update);
router.patch("/:id/status", verifyToken, validateTenant, isManager, EmployeeController.updateStatus);
router.patch("/:id/deactivate", verifyToken, validateTenant, isAdmin, EmployeeController.deactivate);
router.delete("/:id", verifyToken, validateTenant, isAdmin, EmployeeController.delete);

// ─────────────────────────────────────────────
// NESTED FILTERS
// ─────────────────────────────────────────────
router.get("/branch/:branch_id", verifyToken, validateTenant, isManager, EmployeeController.getByBranch);
router.get("/department/:department_id", verifyToken, validateTenant, isManager, EmployeeController.getByDepartment);

module.exports = router;