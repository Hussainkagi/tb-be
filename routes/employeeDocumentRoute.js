const express = require("express");
const router = express.Router({ mergeParams: true });

const EmployeeDocumentController = require("../controller/employeeDocumentController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager, isEmployee } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// All routes scoped under /api/companies/:company_id/employees/:employee_id/documents
// Company-level document routes scoped under /api/companies/:company_id/documents

// ─────────────────────────────────────────────
// EMPLOYEE-SCOPED
// ─────────────────────────────────────────────
router.post("/", verifyToken, validateTenant, isAdmin, EmployeeDocumentController.add);
router.get("/", verifyToken, validateTenant, isManager, EmployeeDocumentController.getByEmployee);
router.get("/:id", verifyToken, validateTenant, isManager, EmployeeDocumentController.getById);
router.put("/:id", verifyToken, validateTenant, isAdmin, EmployeeDocumentController.update);
router.patch("/:id/deactivate", verifyToken, validateTenant, isAdmin, EmployeeDocumentController.deactivate);
router.delete("/:id", verifyToken, validateTenant, isAdmin, EmployeeDocumentController.delete);

router.get("/", verifyToken, validateTenant, isManager, EmployeeDocumentController.getByCompany);

// GET /api/companies/:company_id/documents/expiring?days=30
router.get("/expiring", verifyToken, validateTenant, isManager, EmployeeDocumentController.getExpiringSoon);


module.exports = router;